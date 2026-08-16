// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// SHE PICKED PICKUP, THE PARTY MOVED, AND NOW SHE WANTS IT SENT.
//
// A paid order is immutable to public callers — setOrder refuses outright, and
// that refusal is the only thing between a paid order and a client re-posting a
// cheaper version. So adding delivery afterwards is its OWN small purchase: the
// shipping fee, charged once, on its own PeleCard session. Only when that charge
// lands does the order converge onto the shape it would have had if she had
// ticked delivery at checkout — which is what lets the orders table, the emails
// and the press run know nothing about upgrades at all.
//
// What this file holds:
//   • when the upgrade is on offer, and the five reasons it is not
//   • that the charge re-checks every one of them (the page and the payment are
//     minutes apart, and the collection can close in between)
//   • that a paid upgrade turns the order into a delivery order, exactly once
//   • that ONE callback serves both purchases without confusing them
//
// Boots the app with PeleCard credentials live and a stubbed gateway, the same
// way pelecard-routes.test.js does.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;

let app;
let db;
let settings;
let server;
let base;

let nextInit = null;
let nextGetTx = null;

const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj });

// The shipping fee this suite charges. Deliberately not the default: the default
// is 0, which is what keeps the whole feature dark until the owner sets a real
// figure (a 0₪ card charge is not a thing, and free delivery has nothing to buy).
const FEE = 39;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-ship-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  for (const f of ['db.js', 'pelecard.js', 'settings.js', 'notify.js', 'index.js']) {
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

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/PaymentGW/init')) return jsonRes(nextInit);
      if (u.includes('/PaymentGW/GetTransaction')) return jsonRes(nextGetTx);
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

beforeEach(() => {
  nextInit = {
    URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=ship-tx',
    Error: { ErrCode: 0 },
  };
  nextGetTx = null;
  settings.set('pricing', 'delivery_fee', FEE);
  settings.set('pricing', 'delivery_enabled', true);
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const ADDRESS = { street: 'הרצל 12', city: 'תל אביב', postal: '6100000', apartment: '4' };

// A collection with a PAID pickup order — the state the upgrade exists for.
function paidPickup(name = 'משדרגת') {
  const c = db.createCollection(name);
  db.setOrder(c.id, c.owner_token, { version: 'pickup' });
  db.markPaid(c.id, { method: 'pelecard', transactionId: 'tx-base', charged_total: 199 });
  return c;
}

function shipToken(id) {
  return db.getCollection(id).order.shipping.pelecard.sessions.slice(-1)[0].token;
}

describe('when delivery is on offer, and when it is not', () => {
  it('is offered on a paid pickup order, at the fee the owner set', () => {
    const c = paidPickup();
    const up = db.shippingUpgrade(c.id);
    expect(up.offered).toBe(true);
    expect(up.fee).toBe(FEE);
    expect(up.paid).toBe(false);
  });

  it('is not offered before the order is paid — the checkout is where delivery is a tick', () => {
    const c = db.createCollection('טרם שולם');
    expect(db.shippingUpgrade(c.id).offered).toBe(false);
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    expect(db.shippingUpgrade(c.id)).toMatchObject({ offered: false, reason: 'no paid order' });
  });

  it('is not offered on a digital order — there is nothing to post', () => {
    const c = db.createCollection('דיגיטלי');
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id, { method: 'pelecard' });
    expect(db.shippingUpgrade(c.id)).toMatchObject({ offered: false, reason: 'digital' });
  });

  it('is not offered on an order that is already being delivered', () => {
    const c = db.createCollection('כבר משלוח');
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address: ADDRESS });
    db.markPaid(c.id, { method: 'pelecard' });
    expect(db.shippingUpgrade(c.id)).toMatchObject({ offered: false, reason: 'already delivery' });
  });

  it('is not offered once the collection is CLOSED — the deck is at the printer', () => {
    const c = paidPickup('נסגרה');
    db.closeCollection(c.id, c.owner_token);
    expect(db.shippingUpgrade(c.id)).toMatchObject({ offered: false, reason: 'closed' });
  });

  it('is not offered when there is no fee to charge, or delivery is switched off', () => {
    const c = paidPickup('בלי תעריף');
    settings.set('pricing', 'delivery_fee', 0);
    expect(db.shippingUpgrade(c.id)).toMatchObject({ offered: false, reason: 'unavailable' });
    settings.set('pricing', 'delivery_fee', FEE);
    settings.set('pricing', 'delivery_enabled', false);
    expect(db.shippingUpgrade(c.id)).toMatchObject({ offered: false, reason: 'unavailable' });
  });

  it('rides along in the OWNER’s view of her collection, and nobody else’s', async () => {
    const c = paidPickup('בתשובה');
    const owner = await realFetch(
      base + '/api/collections/' + c.id + '?k=' + encodeURIComponent(c.owner_token)
    ).then((r) => r.json());
    expect(owner.shipping_upgrade).toMatchObject({ offered: true, fee: FEE });
    const guest = await realFetch(base + '/api/collections/' + c.id).then((r) => r.json());
    expect(guest.shipping_upgrade).toBeUndefined();
  });
});

describe('staging the upgrade', () => {
  it('needs a real address — street, city and postal', () => {
    const c = paidPickup();
    expect(db.startShippingUpgrade(c.id, c.owner_token, {})).toEqual({
      error: 'address required',
    });
    expect(
      db.startShippingUpgrade(c.id, c.owner_token, { address: { street: 'הרצל 12' } })
    ).toEqual({ error: 'address required' });
    expect(db.getCollection(c.id).order.shipping).toBeUndefined();
  });

  it('stores the address and the fee it will charge', () => {
    const c = paidPickup();
    const sh = db.startShippingUpgrade(c.id, c.owner_token, { address: ADDRESS });
    expect(sh.fee).toBe(FEE);
    expect(sh.address).toMatchObject({ street: 'הרצל 12', city: 'תל אביב', postal: '6100000' });
    expect(sh.paid).toBe(false);
  });

  it('re-reads the fee, so a price change between the offer and the charge bills today’s', () => {
    const c = paidPickup();
    db.startShippingUpgrade(c.id, c.owner_token, { address: ADDRESS });
    settings.set('pricing', 'delivery_fee', 55);
    expect(db.startShippingUpgrade(c.id, c.owner_token, { address: ADDRESS }).fee).toBe(55);
  });

  it('refuses a wrong owner token, and refuses once the collection is closed', () => {
    const c = paidPickup();
    expect(db.startShippingUpgrade(c.id, 'nope', { address: ADDRESS })).toEqual({
      error: 'forbidden',
    });
    db.closeCollection(c.id, c.owner_token);
    expect(db.startShippingUpgrade(c.id, c.owner_token, { address: ADDRESS })).toEqual({
      error: 'closed',
    });
  });
});

describe('when the upgrade is paid, the order BECOMES a delivery order', () => {
  it('carries the version, the address, the fee and the new total', () => {
    const c = paidPickup();
    const before = db.getCollection(c.id).order.total;
    db.startShippingUpgrade(c.id, c.owner_token, { address: ADDRESS });
    expect(db.markShippingPaid(c.id, { method: 'pelecard', charged_total: FEE })).toBe(true);
    const order = db.getCollection(c.id).order;
    expect(order.version).toBe('delivery');
    expect(order.address).toMatchObject({ street: 'הרצל 12' });
    expect(order.delivery_fee).toBe(FEE);
    expect(order.total).toBe(before + FEE);
    // What she has actually paid us, across both transactions.
    expect(order.charged_total).toBe(199 + FEE);
    // …and the record of how it got there, for the owner reconciling two charges.
    expect(order.shipping.paid).toBe(true);
    expect(order.shipping.charged_total).toBe(FEE);
  });

  it('is idempotent — a callback delivered twice does not charge the total twice', () => {
    const c = paidPickup();
    db.startShippingUpgrade(c.id, c.owner_token, { address: ADDRESS });
    db.markShippingPaid(c.id, { method: 'pelecard', charged_total: FEE });
    const after = db.getCollection(c.id).order.total;
    expect(db.markShippingPaid(c.id, { method: 'pelecard', charged_total: FEE })).toBe(false);
    expect(db.getCollection(c.id).order.total).toBe(after);
  });

  it('stops being on offer once it is bought', () => {
    const c = paidPickup();
    db.startShippingUpgrade(c.id, c.owner_token, { address: ADDRESS });
    db.markShippingPaid(c.id, { method: 'pelecard', charged_total: FEE });
    expect(db.shippingUpgrade(c.id)).toMatchObject({ offered: false, reason: 'paid', paid: true });
  });
});

describe('POST /api/collections/:id/shipping/init', () => {
  it('opens a card payment for the FEE, on its own session', async () => {
    const c = paidPickup();
    const r = await post('/api/collections/' + c.id + '/shipping/init', {
      owner_token: c.owner_token,
      address: ADDRESS,
    });
    expect(r.status).toBe(200);
    expect(r.body.url).toContain('transactionId=ship-tx');
    expect(r.body.charged).toBe(FEE);
    const order = db.getCollection(c.id).order;
    // Its own list — the order's own sessions are untouched, because the two
    // charges are different amounts and each callback verifies against its own.
    expect(order.shipping.pelecard.sessions).toHaveLength(1);
    expect(order.shipping.pelecard.sessions[0].charged_total).toBe(FEE);
    expect(order.pelecard).toBeFalsy();
  });

  it('refuses a wrong owner token', async () => {
    const c = paidPickup();
    const r = await post('/api/collections/' + c.id + '/shipping/init', {
      owner_token: 'nope',
      address: ADDRESS,
    });
    expect(r.status).toBe(403);
  });

  it('refuses without a usable address', async () => {
    const c = paidPickup();
    const r = await post('/api/collections/' + c.id + '/shipping/init', {
      owner_token: c.owner_token,
      address: { city: 'תל אביב' },
    });
    expect(r.status).toBe(400);
  });

  it('refuses once the collection has CLOSED, even mid-checkout', async () => {
    const c = paidPickup();
    db.closeCollection(c.id, c.owner_token);
    const r = await post('/api/collections/' + c.id + '/shipping/init', {
      owner_token: c.owner_token,
      address: ADDRESS,
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('closed');
  });

  it('refuses a second charge once delivery is already bought', async () => {
    const c = paidPickup();
    db.startShippingUpgrade(c.id, c.owner_token, { address: ADDRESS });
    db.markShippingPaid(c.id, { method: 'pelecard', charged_total: FEE });
    const r = await post('/api/collections/' + c.id + '/shipping/init', {
      owner_token: c.owner_token,
      address: ADDRESS,
    });
    expect(r.status).toBe(409);
  });

  it('refuses on an order that was never paid', async () => {
    const c = db.createCollection('לא שולם');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    const r = await post('/api/collections/' + c.id + '/shipping/init', {
      owner_token: c.owner_token,
      address: ADDRESS,
    });
    expect(r.status).toBe(400);
  });
});

describe('one callback, two kinds of purchase', () => {
  it('a shipping token marks the SHIPPING paid, verified against the fee', async () => {
    const c = paidPickup();
    await post('/api/collections/' + c.id + '/shipping/init', {
      owner_token: c.owner_token,
      address: ADDRESS,
    });
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'ship-tx',
        ShvaResult: '000',
        AdditionalDetailsParamX: shipToken(c.id),
        DebitTotal: FEE * 100,
        DebitApproveNumber: '86-001-009',
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'ship-tx' } });
    expect(r.status).toBe(200);
    const order = db.getCollection(c.id).order;
    expect(order.shipping.paid).toBe(true);
    expect(order.shipping.paid_transaction_id).toBe('ship-tx');
    expect(order.version).toBe('delivery');
  });

  it('a charge for the wrong amount is refused, exactly like an order charge', async () => {
    const c = paidPickup();
    await post('/api/collections/' + c.id + '/shipping/init', {
      owner_token: c.owner_token,
      address: ADDRESS,
    });
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'ship-tx',
        ShvaResult: '000',
        AdditionalDetailsParamX: shipToken(c.id),
        // A single agora short of the fee: the verification is on the amount,
        // not on the fact that a transaction happened.
        DebitTotal: FEE * 100 - 1,
      },
    };
    await post('/api/payment/callback', { ResultData: { TransactionId: 'ship-tx' } });
    const order = db.getCollection(c.id).order;
    expect(order.shipping.paid).toBeFalsy();
    expect(order.version).toBe('pickup');
  });

  it('the ORDER’s own payment is untouched by any of this', async () => {
    const c = db.createCollection('תשלום רגיל');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    const token = db.getCollection(c.id).order.pelecard.sessions[0].token;
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '000',
        AdditionalDetailsParamX: token,
        DebitTotal: db.getCollection(c.id).order.total * 100,
        DebitApproveNumber: '86-001-001',
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(200);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.version).toBe('pickup');
    expect(order.shipping).toBeUndefined();
  });
});
