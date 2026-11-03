// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// THE OWNER'S "ADD DELIVERY" LINK, for an order already closed for production.
//
// A pickup customer asks, after her collection has closed, to have the game sent.
// The owner makes a link from the orders table at a price she can change; the
// customer pays on a public page found by the link's own token; the payment
// settles through the SAME shipping branch of settleVerifiedPayment as the
// buyer's own upgrade (server/stores/delivery-link.js); and the courier is booked
// automatically through the SAME function as the admin's שלח ל-HFD button.
//
// PeleCard and HFD are both fakes: PeleCard's gateway by URL, HFD by its host.
// Nothing here can reach a real courier or a real card.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
const HFD_HOST = 'https://api.hfd.example';
const FEE = 39;
const BASE_URL = 'https://test.dugri.example';

let app;
let db;
let settings;
let notify;
let server;
let base;
let realFetch;

let nextInit;
let nextGetTx;
let hfdAnswer;
let hfdCalls;
let alerts;

const jsonRes = (obj) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => obj,
});

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dlink-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = BASE_URL;
  process.env.HFD_TOKEN = 'test-token';
  process.env.HFD_CLIENT_NUMBER = '4242';
  process.env.HFD_BASE_URL = HFD_HOST + '/rest/v2';
  for (const f of ['db.js', 'pelecard.js', 'settings.js', 'notify.js', 'hfd.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom']) {
    settings.set('pricing', v + '_enabled', true);
  }
  settings.set('pricing', 'delivery_fee', FEE);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  notify = require(path.join(serverDir, 'notify.js'));

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(HFD_HOST)) {
      hfdCalls.push({ url: u, init });
      return hfdAnswer(u, init);
    }
    if (u.includes('/PaymentGW/init')) return jsonRes(nextInit);
    if (u.includes('/PaymentGW/GetTransaction')) return jsonRes(nextGetTx);
    if (u.includes('pelecard')) throw new Error('unexpected pelecard fetch ' + u);
    return realFetch(url, init);
  };

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  if (server) server.close();
});

beforeEach(() => {
  nextInit = {
    URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=dl-tx',
    Error: { ErrCode: 0 },
  };
  nextGetTx = null;
  hfdCalls = [];
  hfdAnswer = () => jsonRes({ shipmentNumber: 987654, randNumber: 'r-1' });
  alerts = [];
  vi.restoreAllMocks();
  vi.spyOn(notify, 'sendSystemAlert').mockImplementation(async (subject, lines) => {
    alerts.push({ subject, lines });
    return true;
  });
  settings.set('pricing', 'delivery_fee', FEE);
});

async function call(method, urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const admin = (id) => '/api/admin/collections/' + id + '/delivery-link?key=' + ADMIN_KEY;

const ADDRESS = { street: 'הרצל 12', city: 'תל אביב', postal: '6100000', apartment: '4' };
const PHONE = '052-123-4567';

// A PAID pickup order whose collection is CLOSED and whose deck is built and
// released — the "הופקו — לשליחה לדפוס" pile the sticker sheet prints from.
function closedPaidPickup({ name = 'נועה', copies = 1, oneBox, coupon } = {}) {
  const c = db.createCollection(name, { phone: '0501111111', email: 'b@example.com' });
  db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: copies, one_box: oneBox });
  const order = db.getCollection(c.id).order;
  const charged = coupon ? Math.round(order.total * (1 - coupon / 100)) : order.total;
  db.markPaid(c.id, {
    method: 'pelecard',
    transactionId: 'tx-base-' + c.id,
    charged_total: charged,
    coupon: coupon ? 'HALF' : null,
    discount_pct: coupon || null,
  });
  db.closeCollection(c.id, c.owner_token);
  db.setProduction(c.id, { state: 'generated', pages: 208 });
  db.setProductionReleased(c.id, true);
  return db.getCollection(c.id);
}

const linkToken = (id) => db.getCollection(id).order.shipping.link.token;
const sessionToken = (id) =>
  db.getCollection(id).order.shipping.pelecard.sessions.slice(-1)[0].token;

// The customer opens the link, fills it, the card goes through, PeleCard calls back.
async function payLink(id, { amount, txId = 'dl-tx' } = {}) {
  const t = linkToken(id);
  const r = await call('POST', '/api/delivery-link/' + t + '/pay', {
    address: ADDRESS,
    phone: PHONE,
  });
  expect(r.status).toBe(200);
  nextGetTx = {
    StatusCode: '000',
    ResultData: {
      TransactionId: txId,
      ShvaResult: '000',
      AdditionalDetailsParamX: sessionToken(id),
      DebitTotal: amount * 100,
      DebitApproveNumber: '8601009',
    },
  };
  return call('POST', '/api/payment/callback', { ResultData: { TransactionId: txId } });
}

// The courier booking runs off the settle path; give it its turn.
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('who may get a link', () => {
  it('a paid pickup order closed for production — default price from settings, per box', async () => {
    const c = closedPaidPickup({ copies: 2, oneBox: false });
    const r = await call('GET', admin(c.id));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ eligible: true, default_fee: FEE * 2, boxes: 2, link: null });
  });

  it('is refused while the collection is open, unpaid, digital, or already delivery', async () => {
    const open = db.createCollection('פתוח');
    db.setOrder(open.id, open.owner_token, { version: 'pickup' });
    db.markPaid(open.id, { method: 'pelecard', charged_total: 199 });
    expect(db.deliveryLinkState(open.id)).toMatchObject({ eligible: false, reason: 'open' });

    const unpaid = db.createCollection('לא שולם');
    db.setOrder(unpaid.id, unpaid.owner_token, { version: 'pickup' });
    db.closeCollection(unpaid.id, unpaid.owner_token);
    expect(db.deliveryLinkState(unpaid.id).reason).toBe('no paid order');

    const pdf = db.createCollection('דיגיטלי');
    db.setOrder(pdf.id, pdf.owner_token, { version: 'pdf' });
    db.markPaid(pdf.id, { method: 'pelecard', charged_total: 99 });
    db.closeCollection(pdf.id, pdf.owner_token);
    expect(db.deliveryLinkState(pdf.id).reason).toBe('digital');

    const r = await call('POST', admin(open.id), { amount: 39 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('open');
  });

  it('is owner-only: no key, no link', async () => {
    const c = closedPaidPickup();
    const r = await call('POST', '/api/admin/collections/' + c.id + '/delivery-link', {
      amount: 39,
    });
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).order.shipping).toBeUndefined();
  });
});

describe('create, replace, cancel', () => {
  it('creates a link at the amount she set, with a URL on PUBLIC_BASE_URL and its own token', async () => {
    const c = closedPaidPickup();
    const r = await call('POST', admin(c.id), { amount: 30 });
    expect(r.status).toBe(201);
    const t = linkToken(c.id);
    expect(t).toMatch(/^[A-Za-z0-9_-]{24}$/);
    // Not the managing link: the owner token is nowhere in it.
    expect(r.body.url).toBe(BASE_URL + '/add-delivery.html?t=' + t);
    expect(r.body.url).not.toContain(c.owner_token);
    expect(r.body.link).toMatchObject({ amount: 30, paid: false, cancelled_at: null });
    // The amount IS the charge's fee.
    expect(db.getCollection(c.id).order.shipping.fee).toBe(30);
  });

  it('refuses a non-integer, zero or absurd amount', async () => {
    const c = closedPaidPickup();
    for (const amount of [0, -5, 12.5, 'abc', 100000]) {
      const r = await call('POST', admin(c.id), { amount });
      expect(r.status).toBe(400);
    }
    expect(db.getCollection(c.id).order.shipping).toBeUndefined();
  });

  it('a new link REPLACES the old one: the old token stops resolving at once', async () => {
    const c = closedPaidPickup();
    await call('POST', admin(c.id), { amount: 39 });
    const first = linkToken(c.id);
    await call('POST', admin(c.id), { amount: 25 });
    const second = linkToken(c.id);
    expect(second).not.toBe(first);
    expect((await call('GET', '/api/delivery-link/' + first)).status).toBe(404);
    const pub = await call('GET', '/api/delivery-link/' + second);
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ amount: 25, paid: false, payable: true });
  });

  it('cancelling an unpaid link kills it; the customer cannot pay on it', async () => {
    const c = closedPaidPickup();
    await call('POST', admin(c.id), { amount: 39 });
    const t = linkToken(c.id);
    const r = await call('DELETE', admin(c.id));
    expect(r.status).toBe(200);
    expect(r.body.link.cancelled_at).toBeTruthy();
    expect((await call('GET', '/api/delivery-link/' + t)).status).toBe(404);
    const pay = await call('POST', '/api/delivery-link/' + t + '/pay', {
      address: ADDRESS,
      phone: PHONE,
    });
    expect(pay.status).toBe(404);
  });

  it('a paid link cannot be cancelled or replaced', async () => {
    const c = closedPaidPickup();
    await call('POST', admin(c.id), { amount: 39 });
    await payLink(c.id, { amount: 39 });
    await settle();
    expect((await call('DELETE', admin(c.id))).status).toBe(409);
    const again = await call('POST', admin(c.id), { amount: 20 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('paid');
  });
});

describe('the customer page', () => {
  it('shows only the order number, the honoree and the amount — no contact details', async () => {
    const c = closedPaidPickup({ name: 'מיכל' });
    await call('POST', admin(c.id), { amount: 39 });
    const r = await call('GET', '/api/delivery-link/' + linkToken(c.id));
    expect(r.body).toMatchObject({
      order_ref: c.order_no,
      honoree: 'מיכל',
      amount: 39,
      paid: false,
      payable: true,
      card_enabled: true,
    });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('0501111111');
    expect(text).not.toContain('b@example.com');
    expect(text).not.toContain(c.owner_token);
  });

  it('an invented token is a 404, not a scan hit', async () => {
    expect((await call('GET', '/api/delivery-link/nope')).status).toBe(404);
    expect((await call('GET', '/api/delivery-link/' + 'A'.repeat(24))).status).toBe(404);
  });

  it('pay requires the address and a mobile phone, as the checkout does', async () => {
    const c = closedPaidPickup();
    await call('POST', admin(c.id), { amount: 39 });
    const t = linkToken(c.id);
    const noAddr = await call('POST', '/api/delivery-link/' + t + '/pay', {
      address: { street: 'הרצל 1' },
      phone: PHONE,
    });
    expect(noAddr).toMatchObject({ status: 400, body: { error: 'address required' } });
    const badPhone = await call('POST', '/api/delivery-link/' + t + '/pay', {
      address: ADDRESS,
      phone: '123',
    });
    expect(badPhone).toMatchObject({ status: 400, body: { error: 'phone required' } });
  });

  it('opens a card window for exactly the link amount, on the order’s shipping record', async () => {
    const c = closedPaidPickup();
    await call('POST', admin(c.id), { amount: 27 });
    const r = await call('POST', '/api/delivery-link/' + linkToken(c.id) + '/pay', {
      address: ADDRESS,
      phone: PHONE,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ charged: 27 });
    const sh = db.getCollection(c.id).order.shipping;
    expect(sh.address).toMatchObject({ ...ADDRESS, phone: '0521234567' });
    const s = sh.pelecard.sessions.slice(-1)[0];
    expect(s).toMatchObject({ charged_total: 27, price_key: 'shipping|27', fee_at_init: 27 });
  });
});

describe('a verified payment', () => {
  it('converts the order to delivery, records the extra charge and keeps the original intact', async () => {
    const c = closedPaidPickup();
    const before = db.getCollection(c.id).order;
    const baseTotal = before.total;
    const baseCharged = before.charged_total;
    await call('POST', admin(c.id), { amount: 35 });
    const r = await payLink(c.id, { amount: 35 });
    expect(r.status).toBe(200);
    await settle();
    const order = db.getCollection(c.id).order;
    expect(order.version).toBe('delivery');
    expect(order.address).toMatchObject({ ...ADDRESS, phone: '0521234567' });
    // The original charge untouched…
    expect(order.paid_transaction_id).toBe('tx-base-' + c.id);
    // …the add-on its own charge, on the shipping record…
    expect(order.shipping).toMatchObject({
      paid: true,
      charged_total: 35,
      paid_transaction_id: 'dl-tx',
      paid_method: 'pelecard',
    });
    expect(order.shipping.paid_at).toBeTruthy();
    expect(order.shipping.link.token).toBeTruthy();
    // …and the order's totals: what she has paid us across both, the fee as
    // what the add-on cost.
    expect(order.delivery_fee).toBe(35);
    expect(order.total).toBe(baseTotal + 35);
    expect(order.charged_total).toBe(baseCharged + 35);
  });

  it('a coupon order: the add-on adds exactly its amount, and commission stays on game money', async () => {
    const c = closedPaidPickup({ coupon: 50 });
    const baseCharged = db.getCollection(c.id).order.charged_total;
    await call('POST', admin(c.id), { amount: 39 });
    await payLink(c.id, { amount: 39 });
    await settle();
    const order = db.getCollection(c.id).order;
    expect(order.charged_total).toBe(baseCharged + 39);
    // charged_total − delivery_fee is the percent base (commissionFor): the game
    // money the buyer paid, with the postage out of it — unchanged by the add-on.
    expect(order.charged_total - order.delivery_fee).toBe(baseCharged);
  });

  it('the revenue ledger counts the add-on once, in charged_total', async () => {
    const c = closedPaidPickup();
    const baseCharged = db.getCollection(c.id).order.charged_total;
    await call('POST', admin(c.id), { amount: 39 });
    await payLink(c.id, { amount: 39 });
    await settle();
    const order = db.getCollection(c.id).order;
    expect(order.charged_total).toBe(baseCharged + 39);
    expect(order.shipping.charged_total).toBe(39);
  });

  it('books HFD automatically, once, for every box — and the customer page shows paid', async () => {
    const c = closedPaidPickup({ copies: 2, oneBox: false });
    await call('POST', admin(c.id), { amount: 78 });
    let n = 0;
    hfdAnswer = () => jsonRes({ shipmentNumber: 500 + ++n, randNumber: 'r-' + n });
    await payLink(c.id, { amount: 78 });
    await settle();
    expect(hfdCalls.filter((x) => x.url.includes('/shipments/create'))).toHaveLength(2);
    const order = db.getCollection(c.id).order;
    expect(db.hfdShipments(order).map((r) => String(r.shipment_number))).toEqual(['501', '502']);
    expect(order.shipping.link.hfd_auto.ok).toBe(true);
    expect(order.shipping.link.hfd_auto.shipments.map(String)).toEqual(['501', '502']);
    // The courier gets the phone she typed, not the buyer's.
    const payload = JSON.parse(hfdCalls[0].init.body);
    expect(payload.telFirst).toBe('0521234567');
    // One owner alert, naming the order and the booking.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain('HFD');
    expect(alerts[0].lines.join('\n')).toContain(c.order_no);
    expect(alerts[0].lines.join('\n')).toContain('501, 502');
    const pub = await call('GET', '/api/delivery-link/' + linkToken(c.id));
    expect(pub.body).toMatchObject({ paid: true, payable: false });
    expect(pub.body.address.city).toBe('תל אביב');
  });

  it('a duplicate / replayed callback books nothing more and alerts nothing more', async () => {
    const c = closedPaidPickup();
    await call('POST', admin(c.id), { amount: 39 });
    await payLink(c.id, { amount: 39 });
    await settle();
    const r = await call('POST', '/api/payment/callback', {
      ResultData: { TransactionId: 'dl-tx' },
    });
    expect(r.status).toBe(200);
    await settle();
    expect(hfdCalls.filter((x) => x.url.includes('/shipments/create'))).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    const order = db.getCollection(c.id).order;
    // …and the add-on is not counted twice.
    expect(order.charged_total).toBe(199 + 39);
  });

  it('the single-use link cannot be paid twice', async () => {
    const c = closedPaidPickup();
    await call('POST', admin(c.id), { amount: 39 });
    await payLink(c.id, { amount: 39 });
    await settle();
    const r = await call('POST', '/api/delivery-link/' + linkToken(c.id) + '/pay', {
      address: ADDRESS,
      phone: PHONE,
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('already paid');
  });

  it('HFD refuses: the payment stays settled, the owner is told why, and the manual button retries', async () => {
    const c = closedPaidPickup();
    await call('POST', admin(c.id), { amount: 39 });
    hfdAnswer = () => jsonRes({ errorMessage: 'עיר לא מוכרת' });
    await payLink(c.id, { amount: 39 });
    await settle();
    let order = db.getCollection(c.id).order;
    expect(order.shipping.paid).toBe(true);
    expect(order.version).toBe('delivery');
    expect(order.shipping.link.hfd_auto).toMatchObject({ ok: false, error: 'hfd refused' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain('HFD לא פתחה');
    const text = alerts[0].lines.join('\n');
    expect(text).toContain(c.order_no);
    expect(text).toContain('עיר לא מוכרת');
    expect(text).toContain('שלח ל-HFD');
    // The retry: the owner's button books what is missing.
    hfdAnswer = () => jsonRes({ shipmentNumber: 777, randNumber: 'r-7' });
    const retry = await call('POST', '/api/admin/collections/' + c.id + '/hfd?key=' + ADMIN_KEY);
    expect(retry.status).toBe(200);
    order = db.getCollection(c.id).order;
    expect(db.hfdShipments(order).some((r) => String(r.shipment_number) === '777')).toBe(true);
  });

  it('HFD throws: still settled, still alerted', async () => {
    const c = closedPaidPickup();
    await call('POST', admin(c.id), { amount: 39 });
    hfdAnswer = () => {
      throw new Error('ECONNRESET');
    };
    await payLink(c.id, { amount: 39 });
    await settle();
    const order = db.getCollection(c.id).order;
    expect(order.shipping.paid).toBe(true);
    expect(order.shipping.link.hfd_auto.ok).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].lines.join('\n')).toContain(c.order_no);
  });

  it('a wrong amount settles nothing and books nothing', async () => {
    const c = closedPaidPickup();
    await call('POST', admin(c.id), { amount: 39 });
    await payLink(c.id, { amount: 38 });
    await settle();
    const order = db.getCollection(c.id).order;
    expect(order.shipping.paid).toBeFalsy();
    expect(order.version).toBe('pickup');
    expect(hfdCalls).toHaveLength(0);
  });

  it('the buyer’s own upgrade (not via a link) still books nothing automatically', async () => {
    const c = db.createCollection('פתוח עדיין', { phone: '0501111111' });
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    db.markPaid(c.id, { method: 'pelecard', charged_total: 199 });
    await call('POST', '/api/collections/' + c.id + '/shipping/init', {
      owner_token: c.owner_token,
      address: ADDRESS,
    });
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'own-tx',
        ShvaResult: '000',
        AdditionalDetailsParamX: sessionToken(c.id),
        DebitTotal: FEE * 100,
        DebitApproveNumber: '8601010',
      },
    };
    await call('POST', '/api/payment/callback', { ResultData: { TransactionId: 'own-tx' } });
    await settle();
    expect(db.getCollection(c.id).order.version).toBe('delivery');
    expect(hfdCalls).toHaveLength(0);
  });
});

describe('the sticker sheet', () => {
  it('a converted order leaves the self-pickup stickers and joins the pile as a delivery', async () => {
    const c = closedPaidPickup({ name: 'מדבקה' });
    const mine = () => app.stickerBatch().find((e) => e.id === c.id);
    expect(mine().kind).toBe('pickup');
    expect(app.pickupStickerOrders().some((s) => s.order_no === c.order_no)).toBe(true);
    await call('POST', admin(c.id), { amount: 39 });
    await payLink(c.id, { amount: 39 });
    await settle();
    expect(mine()).toMatchObject({ kind: 'delivery', shipment_number: '987654', missing_boxes: 0 });
    expect(app.pickupStickerOrders().some((s) => s.order_no === c.order_no)).toBe(false);
  });
});
