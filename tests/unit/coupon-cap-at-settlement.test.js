// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// A coupon's LAST redemption spent twice. The cap is checked at pay/init, so two
// buyers who both opened a pay window before either paid each get the discount
// quoted; the charges then land one after the other. By then the money has
// moved, and the owner's decision (2026-10-15) is to honour it SILENTLY: the
// second order is marked paid with its discount like the first, the use count
// simply goes past the cap, and nobody is alerted. This pins that through the
// real Tranzila settle path, so a cap check added at settlement later has to
// change this test, and with it that decision.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;
const ENV = {
  PUBLIC_BASE_URL: 'https://test.dugri.example',
  PAYMENT_PROVIDER: 'tranzila',
  PAYMENT_ENV: 'production',
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key',
  TRANZILA_SECRET: 'app-secret',
};

const report = {};
let server;
let base;
let db;
let app;
let notify;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-coupon-cap-'));
  Object.assign(process.env, ENV);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (String(url) === 'https://report.tranzila.com/v1/transaction') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ transactions: Object.values(report) }),
        };
      }
      throw new Error('unexpected fetch ' + url);
    })
  );
  const settings = require(path.join(serverDir, 'settings.js'));
  settings.set('pricing', 'pdf_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  notify = require(path.join(serverDir, 'notify.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (server) await new Promise((r) => server.close(r));
  for (const k of Object.keys(ENV)) delete process.env[k];
});

async function openWithCoupon(name, code) {
  const c = db.createCollection(name);
  const init = await realFetch(base + '/api/collections/' + c.id + '/pay/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_token: c.owner_token, version: 'pdf', coupon: code }),
  });
  expect(init.status).toBe(200);
  return { id: c.id, session: db.getCollection(c.id).order.pelecard.sessions.slice(-1)[0] };
}

const row = (index, session) => ({
  index,
  amount: Math.round(Number(session.charged_total) * 100),
  currency: '1',
  processor_response_code: '000',
  txn_type: 'DEBIT',
  tranmode: 'A',
  authorization_number: 'A' + index,
  user_defined_1: session.token,
});

describe('a capped coupon redeemed past its cap at settlement', () => {
  it('both charges settle with the discount, the count passes the cap, and nobody is alerted', async () => {
    db.createCoupon({ code: 'LAST1', discount_pct: 50, max_uses: 1 });
    // Both windows open while the one remaining use is still free.
    const a = await openWithCoupon('הראשונה', 'LAST1');
    const b = await openWithCoupon('השנייה', 'LAST1');
    expect(db.getCouponByCode('LAST1').uses).toBe(0);
    expect(b.session.discount_pct).toBe(50);

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    report[95001] = row(95001, a.session);
    await app.tranzilaSweeper.sweep();
    expect(db.getCouponByCode('LAST1').uses).toBe(1);
    // The cap is now reached: a new buyer is refused at pay/init…
    expect(db.validateCoupon('LAST1')).toMatchObject({ valid: false, reason: 'used_up' });

    // …but the charge already taken in the second window is honoured.
    report[95002] = row(95002, b.session);
    await expect(app.tranzilaSweeper.sweep()).resolves.toMatchObject({ settled: 1 });
    const second = db.getCollection(b.id).order;
    expect(second.paid).toBe(true);
    expect(second.coupon).toBe('LAST1');
    expect(second.discount_pct).toBe(50);
    expect(second.charged_total).toBe(Number(b.session.charged_total));
    expect(db.getCouponByCode('LAST1').uses).toBe(2);

    // Silently: no owner alert, nothing queued for one.
    expect(alert).not.toHaveBeenCalled();
    expect(db.tranzilaSweepState().alert_queue).toEqual([]);
  });
});
