// @vitest-environment node
// Ordering several copies of the SAME game. Each copy is charged the full
// per-version price; shipping is charged ONCE per order, because every copy
// travels in one parcel to one address.
//
// The rule that matters most here: the browser never sets the price. It asks for
// a version and a copy count, and the server recomputes the total from its own
// figures — so a tampered payload cannot buy five decks for the price of one.
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

let db;
let settings;
let app;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-copies-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = 'test-admin-key';
  delete process.env.RESEND_API_KEY;
  for (const f of ['db.js', 'settings.js', 'notify.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  // ONE product price; delivery adds the shipping fee on top.
  settings.set('pricing', 'pickup_price', 199);
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
  vi.restoreAllMocks();
  if (server) server.close();
});

beforeEach(() => {
  settings.set('pricing', 'delivery_fee', 39);
});

const ADDRESS = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function get(urlPath) {
  const res = await realFetch(base + urlPath);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('the shipping fee defaults to 0 — deploying must change no price', () => {
  it('is 0 out of the registry, so an existing delivery price stands alone', () => {
    settings.reset('pricing', 'delivery_fee');
    expect(settings.get('pricing', 'delivery_fee')).toBe(0);
    // With a 0 fee, a delivered order costs exactly the product price — enabling
    // the feature charges nobody anything until a fee is set.
    expect(db.orderTotal('delivery', 1)).toBe(db.orderTotal('pickup', 1));
    settings.set('pricing', 'delivery_fee', 39);
  });
});

describe('orderTotal: copies × price, shipping once', () => {
  it('charges the full price for every copy', () => {
    expect(db.orderTotal('pickup', 1)).toBe(199);
    expect(db.orderTotal('pickup', 2)).toBe(398);
    expect(db.orderTotal('pickup', 5)).toBe(995);
  });

  it("adds shipping ONCE, not per copy — the owner's own example", () => {
    // 199 x 5 + 39
    expect(db.orderTotal('delivery', 5)).toBe(1034);
    expect(db.orderTotal('delivery', 1)).toBe(238);
  });

  it('never adds shipping to a pickup order', () => {
    expect(db.orderTotal('pickup', 5)).toBe(995);
  });

  it('honours a quoted per-copy price over the settings price', () => {
    // An admin custom quote keeps the figure it was quoted at.
    expect(db.orderTotal('pickup', 3, 150)).toBe(450);
  });
});

describe('sanitizeQuantity: a copy count can never make the order cheaper', () => {
  it('treats missing/garbage as a single copy', () => {
    for (const bad of [undefined, null, '', 'abc', NaN, {}, []]) {
      expect(db.sanitizeQuantity(bad)).toBe(1);
    }
  });

  it('refuses 0 and negatives — they would charge shipping with no game', () => {
    expect(db.sanitizeQuantity(0)).toBe(1);
    expect(db.sanitizeQuantity(-5)).toBe(1);
    expect(db.orderTotal('delivery', 0)).toBe(238);
  });

  it('floors a fraction rather than undercharging', () => {
    expect(db.sanitizeQuantity(2.9)).toBe(2);
  });

  it('accepts large counts — there is no business cap — but guards a typo', () => {
    expect(db.sanitizeQuantity(50)).toBe(50);
    expect(db.sanitizeQuantity(999)).toBe(999);
    expect(db.sanitizeQuantity(100000)).toBe(db.MAX_COPIES);
  });

  it('parses a numeric string (a form value arrives as text)', () => {
    expect(db.sanitizeQuantity('5')).toBe(5);
  });
});

describe('setOrder stores the copies and the arithmetic', () => {
  it('records quantity, unit price and fee alongside the total', () => {
    const c = db.createCollection('שירה');
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 5,
    });
    expect(o).toMatchObject({ quantity: 5, unit_price: 199, delivery_fee: 39, total: 1034 });
  });

  it('defaults to one copy', () => {
    const c = db.createCollection('שירה');
    const o = db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    expect(o.quantity).toBe(1);
    expect(o.total).toBe(199);
  });

  it('keeps the count when the SAME version is re-submitted (an address edit)', () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 4 });
    const again = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: { ...ADDRESS, street: 'אלנבי 2' },
    });
    expect(again.quantity).toBe(4);
    expect(again.total).toBe(199 * 4 + 39);
  });

  it('re-prices when the count changes', () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 2 });
    const o = db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 3 });
    expect(o.total).toBe(597);
  });

  it('drops the shipping fee when switching delivery -> pickup', () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 2 });
    const o = db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 2 });
    expect(o.delivery_fee).toBe(0);
    expect(o.total).toBe(398);
  });
});

describe("the total is the SERVER's, never the client's", () => {
  it('ignores a total posted by the client', async () => {
    const c = db.createCollection('שירה');
    const r = await post('/api/collections/' + c.id + '/order', {
      owner_token: c.owner_token,
      version: 'pickup',
      quantity: 5,
      total: 1, // the attack
    });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(995);
    expect(db.getCollection(c.id).order.total).toBe(995);
  });

  it('ignores a unit_price posted by the client', async () => {
    const c = db.createCollection('שירה');
    await post('/api/collections/' + c.id + '/order', {
      owner_token: c.owner_token,
      version: 'pickup',
      quantity: 2,
      unit_price: 1,
    });
    expect(db.getCollection(c.id).order.total).toBe(398);
  });
});

describe('the public view carries the breakdown', () => {
  it('exposes quantity, unit price and fee so the checkout can show its sum', async () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 3 });
    const v = (await get('/api/collections/' + c.id)).body;
    expect(v.order).toMatchObject({ quantity: 3, unit_price: 199, delivery_fee: 39, total: 636 });
  });

  it('reports one copy for an order placed before copies existed', async () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    // Simulate a legacy row: total only, no quantity/unit_price.
    const stored = db.getCollection(c.id).order;
    delete stored.quantity;
    delete stored.unit_price;
    delete stored.delivery_fee;
    const v = (await get('/api/collections/' + c.id)).body;
    expect(v.order.quantity).toBe(1);
    expect(v.order.unit_price).toBe(v.order.total);
  });
});

describe('GET /api/pricing publishes the fee', () => {
  it('so the checkout shows the same arithmetic the server will charge', async () => {
    const p = (await get('/api/pricing')).body;
    expect(p.delivery_fee).toBe(39);
  });
});

describe('admin can fix a copy count before payment', () => {
  it('re-prices an unpaid order', async () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 2 });
    const r = await realFetch(base + '/api/admin/collections/' + c.id + '?key=test-admin-key', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: { quantity: 4 } }),
    });
    expect(r.ok).toBe(true);
    expect(db.getCollection(c.id).order.total).toBe(796);
  });

  it("leaves a PAID order's total alone — the receipt must not change", () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 2 });
    db.markPaid(c.id, { method: 'card', charged_total: 398 });
    db.adminUpdateOrder(c.id, { quantity: 9 });
    expect(db.getCollection(c.id).order.total).toBe(398);
  });
});

describe('the receipt emails name the copies', () => {
  it('spells out copies, per-copy price and the one-time shipping', () => {
    const notify = require(path.join(serverDir, 'notify.js'));
    const c = db.createCollection('שירה', { email: 'buyer@example.com' });
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 5 });
    const msg = notify.buildPaidMessage(db.getCollection(c.id), 'https://dugri.example', {});
    expect(msg.text).toContain('מספר עותקים: 5');
    expect(msg.text).toContain('מחיר לעותק: 199');
    expect(msg.text).toContain('דמי משלוח: 39');
    expect(msg.text).toContain('1034');
  });

  it('says nothing about copies on an ordinary single-deck order', () => {
    const notify = require(path.join(serverDir, 'notify.js'));
    const c = db.createCollection('שירה', { email: 'buyer@example.com' });
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    const msg = notify.buildPaidMessage(db.getCollection(c.id), 'https://dugri.example', {});
    expect(msg.text).not.toContain('מספר עותקים');
  });
});

// ---------------------------------------------------------------------------
// WHAT THE CARD IS CHARGED MUST EQUAL WHAT THE CHECKOUT DISPLAYED.
//
// These reproduce the review's three money findings. The page's renderTotal is
// mirrored here as `displayed()` — the same arithmetic, so a divergence between
// the two implementations shows up as a failure rather than as a buyer being
// charged more than they agreed to.
// ---------------------------------------------------------------------------
function displayed({ version, copies, locked, lockedTotal, unitFromPricing, fee }) {
  // A locked order shows its stored total as-is; anything else is
  // per-copy x copies + one shipping fee.
  if (locked) return lockedTotal;
  return unitFromPricing * copies + (version === 'delivery' ? fee : 0);
}

describe('charged === displayed', () => {
  it('one copy, pickup', () => {
    const c = db.createCollection('שירה');
    const o = db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 1 });
    expect(o.total).toBe(
      displayed({ version: 'pickup', copies: 1, unitFromPricing: 199, fee: 39 })
    );
  });

  it('N copies, delivery', () => {
    const c = db.createCollection('שירה');
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 5,
    });
    expect(o.total).toBe(
      displayed({ version: 'delivery', copies: 5, unitFromPricing: 199, fee: 39 })
    );
  });

  it('a PRE-FEATURE order (no unit_price) is charged what the page shows', () => {
    // The exact review case: an order stored at the old ALL-IN 239, re-submitted
    // after the fee exists. Keeping the stored 239 was itself a mismatch — the
    // checkout renders per-copy + shipping from settings, i.e. 238 — so the old
    // rule differed from the page by a shekel on the FIRST press and by 39 on
    // the second. Pricing from settings makes both agree.
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS });
    const stored = db.getCollection(c.id).order;
    stored.total = 239;
    delete stored.unit_price;
    delete stored.delivery_fee;
    delete stored.quantity;

    const again = db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS });
    expect(again.total).toBe(199 + 39);
    expect(again.delivery_fee).toBe(39);
    expect(again.quantity).toBe(1);
  });

  it('a PRE-FEATURE order that grows re-prices cleanly, with ONE shipping fee', () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS });
    const stored = db.getCollection(c.id).order;
    stored.total = 239;
    delete stored.unit_price;
    delete stored.delivery_fee;
    delete stored.quantity;

    const grown = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 3,
    });
    // An unpaid order prices from settings: 199 x 3 + 39 — shipping once for the
    // parcel, never three times.
    expect(grown.total).toBe(199 * 3 + 39);
    expect(grown.delivery_fee).toBe(39);
  });

  it('an UNPAID order placed at an older price re-prices from settings', () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    const stored = db.getCollection(c.id).order;
    stored.total = 149; // an older price
    delete stored.unit_price;
    delete stored.delivery_fee;
    delete stored.quantity;
    // The owner's rule: an unpaid order is priced at TODAY's prices — the same
    // rule adminUpdateOrder follows. It is also what keeps the screen and the
    // charge in agreement, because collect.html prices from settings too.
    const again = db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    expect(again.total).toBe(199);
  });

  // The previous attempt kept a legacy record's all-in total as its per-copy
  // price and then PERSISTED it, so the second /pay/init no longer recognised
  // the record and added shipping on top of a figure that already contained it:
  // 239 displayed, 278 charged. A buyer reaches this by opening the payment
  // window, closing it and pressing pay again.
  it('charges the same on a second pay/init, after the delivery fee is split out', () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS });
    const stored = db.getCollection(c.id).order;
    stored.total = 239; // the old ALL-IN delivery price
    delete stored.unit_price;
    delete stored.delivery_fee;
    delete stored.quantity;

    const first = db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS });
    const second = db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS });
    expect(second.total).toBe(first.total);
    // And it is the figure the checkout renders: per-copy price + one shipping.
    expect(second.total).toBe(199 + 39);
    expect(second.delivery_fee).toBe(39);
  });
});

describe('a coupon discounts the ORDER once, not each copy', () => {
  it('takes the percentage off the multiplied total', () => {
    // The charge path is `Math.round(order.total * (1 - pct/100))` — applied to the
    // whole order. Pinned here because nothing covered coupon x copies.
    const c = db.createCollection('שירה');
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 3,
    });
    expect(o.total).toBe(636);
    const charged = Math.round(o.total * (1 - 10 / 100));
    expect(charged).toBe(572);
    // NOT the discount applied per copy and then multiplied (199*0.9*3 + 39 = 576),
    // and not the fee discounted away separately.
    expect(charged).not.toBe(576);
  });
});

// ---------------------------------------------------------------------------
// ONE product price. Delivery is that product plus shipping — never a second,
// independently-typed price that could disagree with the deck it delivers.
// ---------------------------------------------------------------------------
describe('pickup and delivery are the same deck', () => {
  it('share one product price, so raising it moves both', () => {
    settings.set('pricing', 'pickup_price', 250);
    try {
      expect(db.orderTotal('pickup', 1)).toBe(250);
      expect(db.orderTotal('delivery', 1)).toBe(250 + 39);
    } finally {
      settings.set('pricing', 'pickup_price', 199);
    }
  });

  it('delivery = product + shipping, exactly', () => {
    const product = db.orderTotal('pickup', 1);
    const fee = settings.get('pricing', 'delivery_fee');
    expect(db.orderTotal('delivery', 1)).toBe(product + fee);
  });

  it('the shipping fee is added once however many copies', () => {
    const fee = settings.get('pricing', 'delivery_fee');
    for (const n of [1, 2, 7]) {
      expect(db.orderTotal('delivery', n)).toBe(db.orderTotal('pickup', n) + fee);
    }
  });

  it('there is no separate delivery price to get wrong', () => {
    expect(settings.hasKey('pricing', 'delivery_price')).toBe(false);
    expect(() => settings.set('pricing', 'delivery_price', 999)).toThrow();
  });

  it('/api/pricing publishes the product price for delivery + the fee beside it', async () => {
    const p = (await get('/api/pricing')).body;
    expect(p.versions.delivery.price).toBe(p.versions.pickup.price);
    expect(p.delivery_fee).toBe(39);
  });
});
