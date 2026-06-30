// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boot the real Express app with PeleCard credentials set so the pay routes are
// live, but stub global fetch so no request ever reaches the real gateway.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// Captured before any stubbing so the test's own HTTP client keeps using the
// real fetch even while the server's global fetch is mocked.
const realFetch = globalThis.fetch;

let app;
let db;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pay-'));
  process.env.PELECARD_TERMINAL = '0962475';
  process.env.PELECARD_USER = 'webuser';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  // Make sure freshly-evaluated copies pick up the env above.
  for (const f of ['db.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));

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
});

function stubInit(response) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response })
  );
}

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('POST /api/collections/:id/pay/init', () => {
  it('returns the iframe url and stores the confirmation key', async () => {
    const c = db.createCollection('בדיקת תשלום');
    stubInit({
      URL: 'https://gateway20.pelecard.biz/PaymentGW?transactionId=tx-1',
      ConfirmationKey: 'CK-AAA',
      Error: { ErrCode: 0 },
    });

    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });

    expect(r.status).toBe(200);
    expect(r.body.url).toContain('transactionId=tx-1');
    expect(r.body.total).toBe(79);
    expect(db.getCollection(c.id).order.pelecard.confirmation_keys).toContain('CK-AAA');
  });

  it('does not re-open (or wipe) an order that is already paid', async () => {
    const c = db.createCollection('כבר שולם');
    stubInit({ URL: 'u', ConfirmationKey: 'CK-PAID', Error: { ErrCode: 0 } });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    db.markPaid(c.id, { method: 'pelecard', transactionId: 'tx-paid' });

    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(r.status).toBe(409);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true); // not wiped
    expect(order.paid_transaction_id).toBe('tx-paid');
  });

  it('accumulates confirmation keys across repeated inits (same version)', async () => {
    const c = db.createCollection('שתי פתיחות');
    stubInit({ URL: 'u', ConfirmationKey: 'CK-FIRST', Error: { ErrCode: 0 } });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    stubInit({ URL: 'u', ConfirmationKey: 'CK-SECOND', Error: { ErrCode: 0 } });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    const keys = db.getCollection(c.id).order.pelecard.confirmation_keys;
    expect(keys).toEqual(['CK-FIRST', 'CK-SECOND']);
  });

  it('rejects a wrong owner token', async () => {
    const c = db.createCollection('בדיקה');
    stubInit({ URL: 'x', ConfirmationKey: 'k', Error: { ErrCode: 0 } });
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: 'nope',
      version: 'pdf',
    });
    expect(r.status).toBe(403);
  });
});

describe('POST /api/payment/callback', () => {
  it('marks the order paid on a valid, matching callback', async () => {
    const c = db.createCollection('בדיקת קולבק');
    stubInit({ URL: 'u', ConfirmationKey: 'CK-OK', Error: { ErrCode: 0 } });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });

    const r = await post('/api/payment/callback', {
      PelecardStatusCode: '000',
      ParamX: c.id,
      ConfirmationKey: 'CK-OK',
      TotalX100: 7900,
      PelecardTransactionId: 'tx-77',
    });

    expect(r.status).toBe(200);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.paid_method).toBe('pelecard');
    expect(order.paid_transaction_id).toBe('tx-77');
  });

  it('does NOT mark paid when the confirmation key does not match', async () => {
    const c = db.createCollection('בדיקת זיוף');
    stubInit({ URL: 'u', ConfirmationKey: 'CK-REAL', Error: { ErrCode: 0 } });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });

    const r = await post('/api/payment/callback', {
      PelecardStatusCode: '000',
      ParamX: c.id,
      ConfirmationKey: 'CK-FORGED',
      TotalX100: 7900,
    });

    expect(r.status).toBe(200); // always 200 so PeleCard stops retrying
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('does NOT mark paid when no init handshake was recorded (forged from a public id)', async () => {
    // Attacker knows only the public collection id; there is an order but no
    // recorded ConfirmationKey, so a forged success callback must be rejected.
    const c = db.createCollection('זיוף ללא מפתח');
    db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: { street: 'a', city: 'b', postal: '1' },
    });

    const r = await post('/api/payment/callback', {
      PelecardStatusCode: '000',
      ParamX: c.id,
      TotalX100: 19900,
    });

    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('honors the FIRST session key when the owner opened the modal twice', async () => {
    const c = db.createCollection('שתי פתיחות קולבק');
    stubInit({ URL: 'u', ConfirmationKey: 'CK-A', Error: { ErrCode: 0 } });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    stubInit({ URL: 'u', ConfirmationKey: 'CK-B', Error: { ErrCode: 0 } });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });

    // PeleCard's callback carries the FIRST session's key — still valid.
    const r = await post('/api/payment/callback', {
      PelecardStatusCode: '000',
      ParamX: c.id,
      ConfirmationKey: 'CK-A',
      TotalX100: 7900,
    });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(true);
  });
});
