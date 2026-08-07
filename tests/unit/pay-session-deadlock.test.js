// @vitest-environment node
// Regression: the checkout DEADLOCKED after an abandoned payment window.
//
// Reported from an Android phone ("the pay button is stuck and never reaches the
// success page"). The real sequence, confirmed from the screen recording:
//   1. buyer presses pay at full price  -> a real PeleCard session is recorded
//   2. the payment window doesn't work for them, so they close it. The server is
//      never told, so that session stays "in flight" for PELECARD_SESSION_TTL_MS
//   3. buyer applies a 100%-off coupon  -> total 0
//   4. buyer presses pay                -> the free path refuses with 409
//      "יש תשלום פתוח — סגרו את חלון התשלום לפני החלת קופון"
//   ...a window they HAD closed, with nothing in the UI able to clear it.
//
// The fix is POST /pay/cancel: closing the window releases the session.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const realFetch = globalThis.fetch;

let app;
let db;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-paylock-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = 'test-admin-key';
  for (const f of ['db.js', 'settings.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/PaymentGW/init')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=tx-1',
            Error: { ErrCode: 0 },
          }),
        };
      }
      if (u.includes('api.resend.com')) return { ok: true, status: 200, text: async () => '{}' };
      throw new Error('unexpected fetch ' + u);
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
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let coupon = 0;
async function freeCoupon() {
  const code = 'FREE' + ++coupon;
  const r = await post('/api/admin/coupons?key=test-admin-key', { code, discount_pct: 100 });
  expect(r.status).toBeLessThan(300);
  return code;
}

beforeEach(() => {
  /* each test makes its own collection */
});

describe('an abandoned payment window must not deadlock the checkout', () => {
  it('REGRESSION: a closed window used to block the 100%-coupon path with 409', async () => {
    const c = db.createCollection('שירה', { email: 'lock@example.com' });
    // 1. real payment started at full price
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    expect(init.status).toBe(200);
    expect(db.getCollection(c.id).order.pelecard.sessions[0].resolved).toBe(false);

    // 2. the buyer closes the payment window — this is what used to be silent.
    const cancelled = await post('/api/collections/' + c.id + '/pay/cancel', {
      owner_token: c.owner_token,
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancelled).toBe(1);

    // 3. + 4. a 100%-off coupon now goes through instead of 409ing.
    const code = await freeCoupon();
    const pay = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
      coupon: code,
    });
    expect(pay.status).toBe(200);
    expect(pay.body).toMatchObject({ free: true, paid: true, total: 0 });
    expect(db.getCollection(c.id).order.paid).toBe(true);
  });

  it('still refuses while a payment window is genuinely open (the guard survives)', async () => {
    const c = db.createCollection('שירה', { email: 'guard@example.com' });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    // No cancel: the window is still open, so a free order must NOT be granted —
    // the buyer could still complete the real charge and be billed for both.
    const code = await freeCoupon();
    const pay = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
      coupon: code,
    });
    expect(pay.status).toBe(409);
    expect(db.getCollection(c.id).order.paid).toBeFalsy();
  });
});

describe('POST /pay/cancel', () => {
  it('requires the owner token', async () => {
    const c = db.createCollection('שירה');
    const r = await post('/api/collections/' + c.id + '/pay/cancel', { owner_token: 'nope' });
    expect(r.status).toBe(403);
  });

  it('is safe to call with nothing in flight, and is idempotent', async () => {
    const c = db.createCollection('שירה');
    const a = await post('/api/collections/' + c.id + '/pay/cancel', {
      owner_token: c.owner_token,
    });
    expect(a.status).toBe(200);
    expect(a.body.cancelled).toBe(0);
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    const b = await post('/api/collections/' + c.id + '/pay/cancel', {
      owner_token: c.owner_token,
    });
    expect(b.body.cancelled).toBe(1);
    const again = await post('/api/collections/' + c.id + '/pay/cancel', {
      owner_token: c.owner_token,
    });
    expect(again.body.cancelled).toBe(0);
  });

  it('leaves a PAID order untouched', async () => {
    const c = db.createCollection('שירה');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    db.markPaid(c.id, { method: 'card', charged_total: 199 });
    const r = await post('/api/collections/' + c.id + '/pay/cancel', {
      owner_token: c.owner_token,
    });
    expect(r.body.cancelled).toBe(0);
  });

  it('does NOT hide the session from a charge that still completes', async () => {
    // Money beats bookkeeping: if PeleCard confirms a charge on a session the
    // buyer had abandoned, the callback must still find it and honour it.
    const c = db.createCollection('שירה');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    const token = db.getCollection(c.id).order.pelecard.sessions[0].token;
    await post('/api/collections/' + c.id + '/pay/cancel', { owner_token: c.owner_token });
    // The token lookup the callback relies on still resolves.
    expect(db.getCollectionByPayToken(token)).toBeTruthy();
    expect(db.getCollectionByPayToken(token).id).toBe(c.id);
  });
});
