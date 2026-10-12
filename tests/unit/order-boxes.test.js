// @vitest-environment node
// HOW SEVERAL PRINTED COPIES TRAVEL: a box each, or all in one box.
//
// The owner's rule: copies of a printed game go out one box per copy by default —
// a sticker per box, an HFD booking per box, and (for delivery) the shipping fee
// per box. The buyer may tick "all copies in one box", and then it is one box,
// one sticker, one booking and one fee. An order placed BEFORE the choice existed
// carries no `one_box` at all: its FULFILMENT is a box per copy (N stickers, N
// bookings), but its MONEY is what it was sold at — the fee once, nothing
// re-prices it.
//
// Every place that prices shipping goes through db.deliveryFeeFor (boxesFor);
// every place that counts boxes to pack goes through db.orderBoxes. The HFD
// bookings themselves are held in hfd-routes.test.js.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
let dataDir;

const FEE = 39;
const PRICE = 199;
const ADDRESS = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-boxes-'));
  process.env.DATA_DIR = dataDir;
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = 'test-admin-key';
  delete process.env.RESEND_API_KEY;
  for (const f of ['db.js', 'settings.js', 'notify.js', 'pelecard.js', 'hfd.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  settings.set('pricing', 'pickup_price', PRICE);
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
  if (server) server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  settings.set('pricing', 'delivery_fee', FEE);
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function patchAdmin(id, body) {
  const res = await realFetch(base + '/api/admin/collections/' + id + '?key=test-admin-key', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// An order written before the box choice existed: the field is simply absent.
function legacy(c) {
  delete db.getCollection(c.id).order.one_box;
  return c;
}

describe('the rule itself', () => {
  it('only an explicit false splits the copies into boxes', () => {
    expect(db.boxesFor(3, false)).toBe(3);
    expect(db.boxesFor(3, true)).toBe(1);
    expect(db.boxesFor(3, undefined)).toBe(1);
    expect(db.boxesFor(1, false)).toBe(1);
  });

  it('the fee is per box for a delivery, and nothing for anything else', () => {
    expect(db.deliveryFeeFor('delivery', 3, false)).toBe(FEE * 3);
    expect(db.deliveryFeeFor('delivery', 3, true)).toBe(FEE);
    expect(db.deliveryFeeFor('delivery', 3, undefined)).toBe(FEE);
    expect(db.deliveryFeeFor('pickup', 3, false)).toBe(0);
    expect(db.deliveryFeeFor('pdf', 3, false)).toBe(0);
  });

  it('orderTotal without a box choice is the old arithmetic, fee once', () => {
    expect(db.orderTotal('delivery', 5)).toBe(PRICE * 5 + FEE);
    expect(db.orderTotal('delivery', 5, undefined, false)).toBe(PRICE * 5 + FEE * 5);
    expect(db.orderTotal('delivery', 5, undefined, true)).toBe(PRICE * 5 + FEE);
  });

  it('only a printed order has boxes', () => {
    expect(db.orderBoxes({ version: 'pickup', quantity: 3, one_box: false })).toBe(3);
    expect(db.orderBoxes({ version: 'delivery', quantity: 3, one_box: true })).toBe(1);
    // An order from before the choice is PACKED a box per copy…
    expect(db.orderBoxes({ version: 'delivery', quantity: 3 })).toBe(3);
    // …while its fee stays once (boxesFor, above).
    expect(db.boxesFor(3, undefined)).toBe(1);
    expect(db.orderBoxes({ version: 'pdf', quantity: 3, one_box: false })).toBe(0);
    expect(db.orderBoxes(null)).toBe(0);
  });
});

describe('placing an order (setOrder)', () => {
  it('a NEW multi-copy order defaults to a box per copy, and a fee per box', () => {
    const c = db.createCollection('ברירת מחדל');
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 3,
    });
    expect(o.one_box).toBe(false);
    expect(o.delivery_fee).toBe(FEE * 3);
    expect(o.total).toBe(PRICE * 3 + FEE * 3);
  });

  it('all in one box: the fee once', () => {
    const c = db.createCollection('קופסה אחת');
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 3,
      one_box: true,
    });
    expect(o.one_box).toBe(true);
    expect(o.delivery_fee).toBe(FEE);
    expect(o.total).toBe(PRICE * 3 + FEE);
  });

  it('a single copy is one box whatever the flag says', () => {
    const c = db.createCollection('עותק אחד');
    const o = db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS });
    expect(o.delivery_fee).toBe(FEE);
    expect(o.total).toBe(PRICE + FEE);
  });

  it('ignores a box choice that is not a real boolean', () => {
    const c = db.createCollection('ערך מוזר');
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 2,
      one_box: 'yes',
    });
    // Not stated → the new-order default.
    expect(o.one_box).toBe(false);
    expect(o.delivery_fee).toBe(FEE * 2);
  });

  it('changing the copy count re-prices the boxes with it', () => {
    const c = db.createCollection('עוד עותק');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 2 });
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 4,
    });
    expect(o.one_box).toBe(false);
    expect(o.delivery_fee).toBe(FEE * 4);
    expect(o.total).toBe(PRICE * 4 + FEE * 4);
  });

  it('a re-submit that does not mention the boxes keeps the choice', () => {
    const c = db.createCollection('שומר בחירה');
    db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 3,
      one_box: true,
    });
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: { ...ADDRESS, street: 'אלנבי 2' },
    });
    expect(o.one_box).toBe(true);
    expect(o.delivery_fee).toBe(FEE);
  });

  it('an order from BEFORE the choice keeps one box and the fee once on a re-submit', () => {
    const c = db.createCollection('הזמנה ותיקה');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 3 });
    legacy(c);
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 3,
    });
    expect(o.one_box).toBeUndefined();
    expect(o.delivery_fee).toBe(FEE);
    expect(o.total).toBe(PRICE * 3 + FEE);
  });

  it('switching pickup -> delivery prices the boxes the pickup was packed in', () => {
    const c = db.createCollection('איסוף למשלוח');
    db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 3 });
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 3,
    });
    expect(o.delivery_fee).toBe(FEE * 3);
  });
});

// The charge pay/init sends to the card is held in coupon-delivery.test.js (it has
// the stubbed gateway): separate boxes, every fee charged whole.
describe('the order routes and the public view', () => {
  it('the /order route takes the choice and answers with the box count', async () => {
    const c = db.createCollection('ראוט הזמנה');
    const sep = await post('/api/collections/' + c.id + '/order', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: ADDRESS,
      quantity: 3,
      one_box: false,
    });
    expect(sep.status).toBe(200);
    expect(sep.body).toMatchObject({
      delivery_fee: FEE * 3,
      total: PRICE * 3 + FEE * 3,
      one_box: false,
      boxes: 3,
    });
    const one = await post('/api/collections/' + c.id + '/order', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: ADDRESS,
      quantity: 3,
      one_box: true,
    });
    expect(one.body).toMatchObject({
      delivery_fee: FEE,
      total: PRICE * 3 + FEE,
      one_box: true,
      boxes: 1,
    });
  });

  it('the public view carries the choice, null for an order from before it', async () => {
    const c = db.createCollection('תצוגה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 2 });
    let v = await realFetch(base + '/api/collections/' + c.id).then((r) => r.json());
    expect(v.order).toMatchObject({ one_box: false, boxes: 2 });
    legacy(c);
    v = await realFetch(base + '/api/collections/' + c.id).then((r) => r.json());
    // No stated choice, packed a box per copy.
    expect(v.order).toMatchObject({ one_box: null, boxes: 2 });
  });
});

describe('the admin edit', () => {
  it('flipping the box choice on an UNPAID delivery re-prices it', async () => {
    const c = db.createCollection('עריכת מנהלת');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 3 });
    const r = await patchAdmin(c.id, { order: { one_box: true } });
    expect(r.status).toBe(200);
    let o = db.getCollection(c.id).order;
    expect(o.one_box).toBe(true);
    expect(o.delivery_fee).toBe(FEE);
    expect(o.total).toBe(PRICE * 3 + FEE);
    await patchAdmin(c.id, { order: { one_box: false } });
    o = db.getCollection(c.id).order;
    expect(o.delivery_fee).toBe(FEE * 3);
    expect(o.total).toBe(PRICE * 3 + FEE * 3);
  });

  it('a copy-count edit keeps the boxes in step', () => {
    const c = db.createCollection('מנהלת עותקים');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 2 });
    const o = db.adminUpdateOrder(c.id, { quantity: 5 });
    expect(o.delivery_fee).toBe(FEE * 5);
    expect(o.total).toBe(PRICE * 5 + FEE * 5);
  });

  it('a version edit pickup -> delivery prices per box (and an old order once)', () => {
    const c = db.createCollection('מנהלת גרסה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 3 });
    let o = db.adminUpdateOrder(c.id, { version: 'delivery', address: ADDRESS });
    expect(o.delivery_fee).toBe(FEE * 3);
    const old = db.createCollection('מנהלת גרסה ותיקה');
    db.setOrder(old.id, old.owner_token, { version: 'pickup', quantity: 3 });
    legacy(old);
    o = db.adminUpdateOrder(old.id, { version: 'delivery', address: ADDRESS });
    expect(o.one_box).toBeUndefined();
    expect(o.delivery_fee).toBe(FEE);
  });

  it('on a PAID order the choice changes but the money does not', () => {
    const c = db.createCollection('שולם');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 3 });
    const before = { ...db.getCollection(c.id).order };
    db.markPaid(c.id, { method: 'pelecard', charged_total: before.total });
    const o = db.adminUpdateOrder(c.id, { one_box: true });
    expect(o.one_box).toBe(true);
    expect(o.delivery_fee).toBe(before.delivery_fee);
    expect(o.total).toBe(before.total);
    // …and it is what the stickers and the courier now read.
    expect(db.orderBoxes(o)).toBe(1);
  });

  it('an edit that does not mention the boxes leaves an old order without a choice', () => {
    const c = db.createCollection('לא נוגעים');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 3 });
    legacy(c);
    const o = db.adminUpdateOrder(c.id, { address: { ...ADDRESS, street: 'יפו 3' } });
    expect(o.one_box).toBeUndefined();
    expect(o.delivery_fee).toBe(FEE);
  });
});

describe('the receipt says how it is packed', () => {
  it('names the box count and the whole shipping charge', () => {
    const notify = require(path.join(serverDir, 'notify.js'));
    const c = db.createCollection('קבלה', { email: 'buyer@example.com' });
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS, quantity: 3 });
    const msg = notify.buildPaidMessage(db.getCollection(c.id), 'https://dugri.example', {});
    expect(msg.text).toContain('קופסאות: 3');
    expect(msg.text).toContain('דמי משלוח: ' + FEE * 3);
  });

  it('an order from before the choice: a box per copy, the fee it paid', () => {
    const notify = require(path.join(serverDir, 'notify.js'));
    const c = db.createCollection('קבלה ותיקה', { email: 'buyer@example.com' });
    db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: ADDRESS,
      quantity: 3,
      one_box: true,
    });
    legacy(c);
    const msg = notify.buildPaidMessage(db.getCollection(c.id), 'https://dugri.example', {});
    expect(msg.text).toContain('קופסאות: 3');
    expect(msg.text).toContain('דמי משלוח: ' + FEE);
  });

  it('a pickup in separate boxes says so too — there is no fee, but there are boxes', () => {
    const notify = require(path.join(serverDir, 'notify.js'));
    const c = db.createCollection('קבלה איסוף', { email: 'buyer@example.com' });
    db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 2 });
    const msg = notify.buildPaidMessage(db.getCollection(c.id), 'https://dugri.example', {});
    expect(msg.text).toContain('קופסאות: 2');
    expect(msg.text).not.toContain('דמי משלוח');
  });
});

describe('stickers: one per box', () => {
  const pickup = (boxes) => ({
    id: 'p' + boxes,
    kind: 'pickup',
    boxes,
    label: { title: 'איסוף', order_no: 'DG-1' },
  });

  it('a pickup in three boxes is three labels, marked 1/3, 2/3, 3/3', () => {
    const entries = app.stickerEntries([pickup(3)], new Map());
    expect(entries).toEqual([
      { title: 'איסוף', order_no: 'DG-1', box: '1/3' },
      { title: 'איסוף', order_no: 'DG-1', box: '2/3' },
      { title: 'איסוף', order_no: 'DG-1', box: '3/3' },
    ]);
  });

  it('one box is one label with no mark — exactly as before', () => {
    expect(app.stickerEntries([pickup(1)], new Map())).toEqual([
      { title: 'איסוף', order_no: 'DG-1' },
    ]);
  });

  it('the batch counts each real order’s boxes', () => {
    function produced(quantity, oneBox, title) {
      const c = db.createCollection('שירה', { custom_title: title });
      db.setOrder(c.id, c.owner_token, {
        version: 'pickup',
        quantity,
        ...(oneBox === undefined ? {} : { one_box: oneBox }),
      });
      db.markPaid(c.id, { method: 'pelecard' });
      db.setProduction(c.id, { state: 'generated', pages: 208 });
      db.setProductionReleased(c.id, true);
      return c;
    }
    produced(3, false, 'שלוש נפרדות');
    produced(3, true, 'שלוש ביחד');
    const old = produced(3, false, 'ותיקה');
    legacy(old);
    const byTitle = (t) => app.stickerBatch().find((e) => e.label.title === t);
    expect(byTitle('שלוש נפרדות').boxes).toBe(3);
    expect(byTitle('שלוש ביחד').boxes).toBe(1);
    // From before the choice: a label per copy (its fee was charged once).
    expect(byTitle('ותיקה').boxes).toBe(3);
  });
});
