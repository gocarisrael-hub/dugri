// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// A Tranzila pay/init mints a pay session token on every call, and those tokens
// are what the notify, its retries and its limits are keyed by — so it is limited
// per client and per collection. The client key must not be something the client
// writes (X-Forwarded-For's left side). PeleCard is not limited. Small limits
// here; the tests run in order (budgets in the comments).
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;

const ENV = {
  PUBLIC_BASE_URL: 'https://test.dugri.example',
  PAYMENT_PROVIDER: 'tranzila',
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key',
  TRANZILA_SECRET: 'app-secret',
  PELECARD_TERMINAL: '0962210',
  PELECARD_USER: 'peletest',
  PELECARD_PASSWORD: 'secret',
  PAY_INIT_RATE_LIMIT_COLLECTION: '3',
  PAY_INIT_RATE_LIMIT_IP: '8',
  PAYMENT_PROXY_HOPS: '1',
};

let db;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-payinit-rate-'));
  Object.assign(process.env, ENV);
  for (const f of ['db.js', 'pelecard.js', 'tranzila.js', 'settings.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  settings.set('pricing', 'pdf_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  const app = require(path.join(serverDir, 'index.js'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (String(url).includes('/PaymentGW/init')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ URL: 'https://gw.example/PaymentGW?transactionId=pc', Error: {} }),
        };
      }
      throw new Error('unexpected fetch ' + url);
    })
  );
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (server) server.close();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

async function payInit(c, { ownerToken = c.owner_token, headers = {} } = {}) {
  const res = await realFetch(base + '/api/collections/' + c.id + '/pay/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ owner_token: ownerToken, version: 'pdf' }),
  });
  return res.status;
}

describe('pay/init rate limits (Tranzila)', () => {
  // local client budget: 6 of 8
  it("limits one collection, and a stranger's refused tries do not spend its budget", async () => {
    const c = db.createCollection('מוגבלת לאוסף');
    expect(await payInit(c, { ownerToken: 'not-the-owner' })).toBe(403);
    expect(await payInit(c, { ownerToken: 'not-the-owner' })).toBe(403);
    for (let i = 0; i < 3; i++) expect(await payInit(c)).toBe(200);
    expect(await payInit(c)).toBe(429);
    expect(db.getCollection(c.id).order.pelecard.sessions).toHaveLength(3);
  });

  // local client budget: 8 of 8, then refused
  it('limits one client across collections', async () => {
    expect(await payInit(db.createCollection('אוסף ב'))).toBe(200);
    expect(await payInit(db.createCollection('אוסף ג'))).toBe(200);
    const blocked = db.createCollection('אוסף ד');
    expect(await payInit(blocked)).toBe(429);
    expect(db.getCollection(blocked.id).order).toBeFalsy();
  });

  // a separate client (203.0.113.50) behind the proxy: 8 allowed, then refused
  it('a client rotating random X-Forwarded-For values still shares one bucket', async () => {
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      const spoof = `${10 + i}.${i}.${i * 3}.${200 - i}`;
      statuses.push(
        await payInit(db.createCollection('מתחפשת ' + i), {
          headers: { 'X-Forwarded-For': spoof + ', 203.0.113.50' },
        })
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 429, 429]);
  });
});

describe('pay/init with PeleCard', () => {
  it('is not limited: the Tranzila limits do not change the default provider', async () => {
    const saved = process.env.PAYMENT_PROVIDER;
    delete process.env.PAYMENT_PROVIDER;
    try {
      const c = db.createCollection('פלאקארד בלי הגבלה');
      for (let i = 0; i < 12; i++) expect(await payInit(c)).toBe(200);
    } finally {
      process.env.PAYMENT_PROVIDER = saved;
    }
  });
});
