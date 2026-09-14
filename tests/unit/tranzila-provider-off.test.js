// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// PAYMENT_PROVIDER=tranzila with a Tranzila credential missing must turn card
// payment OFF — never quietly open PeleCard, which is fully configured here on
// purpose. A staging test that silently ran on the old provider would prove
// nothing about the new one.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;

const ENV = {
  PELECARD_TERMINAL: '0962210',
  PELECARD_USER: 'peletest',
  PELECARD_PASSWORD: 'secret',
  PUBLIC_BASE_URL: 'https://test.dugri.example',
  PAYMENT_PROVIDER: 'tranzila',
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key',
};

let db;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tz-off-'));
  Object.assign(process.env, ENV);
  delete process.env.TRANZILA_SECRET;
  for (const f of ['db.js', 'pelecard.js', 'tranzila.js', 'settings.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom']) {
    settings.set('pricing', v + '_enabled', true);
  }
  settings.set('pricing', 'delivery_fee', 39);
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

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('PAYMENT_PROVIDER=tranzila without TRANZILA_SECRET', () => {
  it('does not advertise card payment', async () => {
    const c = db.createCollection('בלי סוד');
    const view = await realFetch(base + '/api/collections/' + c.id).then((r) => r.json());
    expect(view.card_enabled).toBe(false);
  });

  it('refuses pay/init with 503 and opens no session on either provider', async () => {
    const c = db.createCollection('בלי סוד תשלום');
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(r.status).toBe(503);
    const order = db.getCollection(c.id).order;
    expect(order && order.pelecard && order.pelecard.sessions).toBeFalsy();
  });

  it('refuses shipping/init with 503', async () => {
    const c = db.createCollection('בלי סוד משלוח');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    db.markPaid(c.id, { method: 'pelecard', transactionId: 'x', charged_total: 199 });
    const r = await post('/api/collections/' + c.id + '/shipping/init', {
      owner_token: c.owner_token,
      address: { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' },
    });
    expect(r.status).toBe(503);
  });
});
