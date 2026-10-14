// @vitest-environment node
//
// ONE CHARGE FORMULA, WRITTEN TWICE. pay/init computes what to charge, and
// expectedChargeNow (server/index.js) recomputes it so the purchase-changed notice
// can state a post-coupon figure. Until this file, only a comment on each side
// bound them, so a change to one would have let the notice quietly report a wrong
// number on the one message whose whole job is the number.
//
// This drives the REAL pay/init over a table (pickup and delivery, one box and a
// box each, no coupon, odd percentages, 100%) on odd prices so the rounding is
// exercised, and asserts that expectedChargeNow, given the order and the session
// pay/init stored, lands on exactly the amount PeleCard was asked for. Expected
// values are never derived here from a third copy of the formula.
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
const ADMIN_KEY = 'test-admin-key';
// Odd on purpose: a 50% code on 197 is 98.5, where the rounding shows.
const PICKUP_PRICE = 197;
const FEE = 39;
const ADDRESS = { street: 'הרצל 5', city: 'תל אביב', postal: '6100000', apartment: '3' };

let app;
let db;
let server;
let base;
let lastInitTotal = null; // agorot POSTed to /PaymentGW/init

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-charge-binding-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['db.js', 'pelecard.js', 'settings.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery']) settings.set('pricing', v + '_enabled', true);
  settings.set('pricing', 'pickup_price', PICKUP_PRICE);
  settings.set('pricing', 'delivery_fee', FEE);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      if (String(url).includes('/PaymentGW/init')) {
        lastInitTotal = JSON.parse(opts.body).Total;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=tx-1',
            Error: { ErrCode: 0 },
          }),
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
});

beforeEach(() => {
  lastInitTotal = null;
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const PCTS = [null, 50, 15, 33, 100];
const SHAPES = [
  { version: 'pickup', quantity: 1 },
  { version: 'pickup', quantity: 3 },
  { version: 'delivery', quantity: 1 },
  { version: 'delivery', quantity: 3, one_box: true },
  { version: 'delivery', quantity: 3, one_box: false },
];
const CASES = SHAPES.flatMap((s) => PCTS.map((pct) => ({ ...s, pct })));

describe('pay/init and expectedChargeNow agree on what to charge', () => {
  beforeAll(async () => {
    for (const pct of PCTS.filter(Boolean)) {
      const r = await post('/api/admin/coupons?key=' + ADMIN_KEY, {
        code: 'BIND' + pct,
        discount_pct: pct,
      });
      expect(r.status).toBe(201);
    }
  });

  it.each(CASES)('$version ×$quantity one_box=$one_box coupon=$pct%', async (k) => {
    const c = db.createCollection('קשירה ' + Math.random());
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: k.version,
      address: k.version === 'delivery' ? ADDRESS : undefined,
      quantity: k.quantity,
      ...(k.one_box === undefined ? {} : { one_box: k.one_box }),
      ...(k.pct ? { coupon: 'BIND' + k.pct } : {}),
    });
    expect(r.status).toBe(200);
    const order = db.getCollection(c.id).order;

    if (r.body.free) {
      // The free path opens no card session: a real zero, which only a full code
      // on a fee-less order can reach.
      expect(k.pct).toBe(100);
      expect(order.delivery_fee || 0).toBe(0);
      expect(app.expectedChargeNow(order, { discount_pct: k.pct })).toBe(0);
      expect(lastInitTotal).toBeNull();
      return;
    }

    const sessions = order.pelecard.sessions;
    const session = sessions[sessions.length - 1];
    // What the gateway was asked for, what pay/init answered and stored, and what
    // the notice would compute: one number.
    expect(lastInitTotal).toBe(r.body.charged * 100);
    expect(Number(session.charged_total)).toBe(r.body.charged);
    expect(app.expectedChargeNow(order, session)).toBe(r.body.charged);
  });

  it('covers the cases that make a drift visible', () => {
    // A table that silently lost its rounding or 100%-delivery rows would still
    // pass; these are the rows that tell the two groupings apart.
    expect(CASES.some((k) => k.version === 'delivery' && k.pct === 100)).toBe(true);
    expect(((PICKUP_PRICE * 50) / 100) % 1).toBe(0.5);
  });
});
