// @vitest-environment node
//
// A COUPON BUYS A GAME, NOT POSTAGE.
//
// The discount used to come off order.total, which already includes the
// one-time delivery fee, so a 50% code halved the courier's charge and a 100%
// code shipped a parcel for nothing. The percentage now comes off the game money
// only (unit price × copies) and the fee is added back whole — the same base
// commissionFor has always used.
//
// Every number here is asserted at the gateway (the agorot PeleCard is actually
// asked for), because that is the only figure that becomes money.
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
const FEE = 39;
const ADDRESS = { street: 'הרצל 5', city: 'תל אביב', postal: '6100000', apartment: '3' };

let app;
let db;
let server;
let base;
let lastInitTotal = null; // agorot POSTed to /PaymentGW/init

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-coupon-delivery-'));
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

async function coupon(code, pct) {
  const r = await post('/api/admin/coupons?key=' + ADMIN_KEY, { code, discount_pct: pct });
  expect([201, 400]).toContain(r.status);
}

async function payWith(version, code, quantity = 1) {
  const c = db.createCollection('קופון ' + version + Math.random());
  const r = await post('/api/collections/' + c.id + '/pay/init', {
    owner_token: c.owner_token,
    version,
    address: version === 'delivery' ? ADDRESS : undefined,
    quantity,
    coupon: code,
  });
  return { r, order: db.getCollection(c.id).order };
}

describe('a coupon on a delivery order', () => {
  it('discounts the game and charges the delivery fee in full', async () => {
    await coupon('HALFGAME', 50);
    const { r, order } = await payWith('delivery', 'HALFGAME');
    expect(r.status).toBe(200);
    expect(order.delivery_fee).toBe(FEE);
    const game = order.total - FEE;
    const expected = Math.round(game * 0.5) + FEE;
    expect(r.body.charged).toBe(expected);
    expect(lastInitTotal).toBe(expected * 100);
    // The regression, stated as a number: the old formula halved the fee too.
    expect(r.body.charged).not.toBe(Math.round(order.total * 0.5));
  });

  it('keeps the fee whole across several copies — it is charged once, and never discounted', async () => {
    await coupon('HALFGAME', 50);
    const { r, order } = await payWith('delivery', 'HALFGAME', 3);
    expect(order.quantity).toBe(3);
    const expected = Math.round(order.unit_price * 3 * 0.5) + FEE;
    expect(r.body.charged).toBe(expected);
    expect(lastInitTotal).toBe(expected * 100);
  });

  // THE BEHAVIOUR CHANGE. The game is free; the parcel is not. So this is a card
  // payment for the fee alone, not the free/skip-PeleCard path — and nothing is
  // marked paid until that fee actually arrives.
  it('a 100% code leaves the delivery fee to pay by card, and is not a free order', async () => {
    await coupon('ALLGAME', 100);
    const { r, order } = await payWith('delivery', 'ALLGAME');
    expect(r.status).toBe(200);
    expect(r.body.free).toBeUndefined();
    expect(r.body.charged).toBe(FEE);
    expect(lastInitTotal).toBe(FEE * 100);
    expect(order.paid).toBe(false);
    // The session remembers the code, so the callback verifies the fee alone.
    const s0 = order.pelecard.sessions[0];
    expect(s0.charged_total).toBe(FEE);
    expect(s0.coupon).toBe('ALLGAME');
  });
});

describe('orders with nothing to ship are unchanged', () => {
  it('a 100% code on a pickup order is still free, with no card at all', async () => {
    await coupon('ALLGAME', 100);
    const { r, order } = await payWith('pickup', 'ALLGAME');
    expect(r.body).toMatchObject({ free: true, paid: true, total: 0 });
    expect(lastInitTotal).toBeNull();
    expect(order.paid).toBe(true);
    expect(order.charged_total).toBe(0);
  });

  it('a partial code on a pickup order discounts the whole price, as before', async () => {
    await coupon('HALFGAME', 50);
    const { r, order } = await payWith('pickup', 'HALFGAME');
    expect(order.delivery_fee || 0).toBe(0);
    expect(r.body.charged).toBe(Math.round(order.total * 0.5));
  });

  it('no code charges the full total, fee included', async () => {
    const { r, order } = await payWith('delivery', undefined);
    expect(r.body.charged).toBe(order.total);
    expect(lastInitTotal).toBe(order.total * 100);
  });
});
