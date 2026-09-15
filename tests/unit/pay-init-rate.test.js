// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// pay/init mints a pay session token on every call, and those tokens are what
// the Tranzila notify, its retries and its limits are keyed by — so it is
// limited per client IP and per collection. Small limits here; the tests share
// one IP and run in order (budgets in the comments).
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
  PAY_INIT_RATE_LIMIT_COLLECTION: '3',
  PAY_INIT_RATE_LIMIT_IP: '8',
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
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

async function payInit(c, ownerToken = c.owner_token) {
  const res = await realFetch(base + '/api/collections/' + c.id + '/pay/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_token: ownerToken, version: 'pdf' }),
  });
  return res.status;
}

describe('pay/init rate limits', () => {
  // IP budget: 6 of 8
  it("limits one collection, and a stranger's refused tries do not spend its budget", async () => {
    const c = db.createCollection('מוגבלת לאוסף');
    expect(await payInit(c, 'not-the-owner')).toBe(403);
    expect(await payInit(c, 'not-the-owner')).toBe(403);
    for (let i = 0; i < 3; i++) expect(await payInit(c)).toBe(200);
    expect(await payInit(c)).toBe(429);
    expect(db.getCollection(c.id).order.pelecard.sessions).toHaveLength(3);
  });

  // IP budget: 8 of 8, then refused
  it('limits one client IP across collections', async () => {
    expect(await payInit(db.createCollection('אוסף ב'))).toBe(200);
    expect(await payInit(db.createCollection('אוסף ג'))).toBe(200);
    const blocked = db.createCollection('אוסף ד');
    expect(await payInit(blocked)).toBe(429);
    expect(db.getCollection(blocked.id).order).toBeFalsy();
  });
});
