// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boot the real Express app with PeleCard credentials set so the pay routes are
// live, but stub global fetch so no request reaches the real gateway. The stub
// routes by URL: /PaymentGW/init and /PaymentGW/GetTransaction get separate,
// per-test responses.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// Captured before stubbing so the test's own HTTP client keeps the real fetch.
const realFetch = globalThis.fetch;

let app;
let db;
let notify;
let server;
let base;

// Per-test control of the mocked gateway responses.
let nextInit = null;
let nextGetTx = null; // object to return, or 'THROW' to simulate a transport error

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pay-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  for (const f of ['db.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  // The charge path now gates on per-version enable flags (only pickup is on by
  // default). This suite pays for pdf/delivery, so enable every version for this
  // test's data dir (fresh settings bound to the temp DATA_DIR, then persisted).
  delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  notify = require(path.join(serverDir, 'notify.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/PaymentGW/init')) return jsonRes(nextInit);
      if (u.includes('/PaymentGW/GetTransaction')) {
        if (nextGetTx === 'THROW') throw new Error('network');
        return jsonRes(nextGetTx);
      }
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
    URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=tx-1',
    Error: { ErrCode: 0 },
  };
  nextGetTx = null;
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(urlPath) {
  const res = await realFetch(base + urlPath);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function tokenOf(id) {
  return db.getCollection(id).order.pelecard.sessions[0].token;
}

describe('POST /api/collections/:id/pay/init', () => {
  it('returns the iframe url and records a ParamX token', async () => {
    const c = db.createCollection('בדיקת תשלום');
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(r.status).toBe(200);
    expect(r.body.url).toContain('transactionId=tx-1');
    expect(r.body.total).toBe(79);
    const sessions = db.getCollection(c.id).order.pelecard.sessions;
    expect(sessions.length).toBe(1);
    expect(sessions[0].token.length).toBeLessThanOrEqual(19);
  });

  it('rejects a wrong owner token', async () => {
    const c = db.createCollection('בדיקה');
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: 'nope',
      version: 'pdf',
    });
    expect(r.status).toBe(403);
  });

  it('does not re-open (or wipe) an order that is already paid', async () => {
    const c = db.createCollection('כבר שולם');
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
    expect(db.getCollection(c.id).order.paid).toBe(true);
    expect(db.getCollection(c.id).order.paid_transaction_id).toBe('tx-paid');
  });

  it('accumulates ParamX tokens across repeated inits (same version)', async () => {
    const c = db.createCollection('שתי פתיחות');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(db.getCollection(c.id).order.pelecard.sessions.length).toBe(2);
  });
});

describe('POST /api/payment/callback', () => {
  it('verifies via GetTransaction and marks the order paid', async () => {
    const c = db.createCollection('בדיקת קולבק');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '000',
        AdditionalDetailsParamX: token,
        DebitTotal: 7900,
        DebitApproveNumber: '86-001-006',
      },
    };

    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(200);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.paid_method).toBe('pelecard');
    expect(order.paid_transaction_id).toBe('tx-1');
    expect(order.paid_approval_no).toBe('86-001-006');
  });

  // EMAIL IS NOT THE ONLY CHANNEL. This notice is sent, not enqueued, so if the
  // email send fails — a Resend 5xx, or RESEND_API_KEY/NOTIFY_TO unset on this
  // environment — the fallback is its only second chance. Every other owner
  // escalation in index.js falls back to WhatsApp; this one now does too.
  //
  // WHAPI_OWNER_WA is unset in this suite, so `alertOwnerViaWhatsApp` takes its
  // no-channel branch and logs OWNER ESCALATION NOT DELIVERED — which is the
  // observable proof that the fallback was reached at all.
  it('falls back off email when the send reports failure', async () => {
    const settings = require(path.join(serverDir, 'settings.js'));
    const c = db.createCollection('נפילת אימייל');
    const addr = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: addr,
    });
    const charged = init.body.total;
    const token = tokenOf(c.id);
    const feeWas = db.getCollection(c.id).order.delivery_fee;

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(false);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    settings.set('pricing', 'delivery_fee', feeWas + 20);
    try {
      db.adminUpdateOrder(c.id, { address: { ...addr, street: 'הרצל 7' } });
      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-fallback',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-011',
        },
      };
      const r = await post('/api/payment/callback', {
        ResultData: { TransactionId: 'tx-fallback' },
      });
      expect(r.status).toBe(200);
      expect(db.getCollection(c.id).order.paid).toBe(true);
      expect(alert).toHaveBeenCalled();

      // The fallback runs in a .then AFTER the callback answers, so let the
      // microtask queue drain before asserting on it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const escalated = logged.mock.calls
        .map((args) => args.map((a) => String(a)).join(' '))
        .join('\n');
      expect(escalated).toContain('OWNER ESCALATION NOT DELIVERED');
      expect(escalated).toContain('דמי המשלוח השתנו');
    } finally {
      logged.mockRestore();
      alert.mockRestore();
      settings.set('pricing', 'delivery_fee', feeWas);
    }
  });

  // A NOTIFICATION MUST NEVER UNMAKE A SETTLE. By the time the notice runs the
  // money has cleared and the order is already marked paid, so anything throwing
  // on the way to telling the owner would answer the provider with a failure and
  // prompt a retry — over a message. A SYNCHRONOUS throw is the case that matters:
  // `sendSystemAlert` catches its own rejections internally, so the async path is
  // already safe and only a sync throw could escape.
  it('still settles when the fee-moved notice itself throws', async () => {
    const settings = require(path.join(serverDir, 'settings.js'));
    const c = db.createCollection('התראה שנכשלת');
    const addr = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: addr,
    });
    const charged = init.body.total;
    const token = tokenOf(c.id);
    const feeWas = db.getCollection(c.id).order.delivery_fee;

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockImplementation(() => {
      throw new Error('notify exploded');
    });
    settings.set('pricing', 'delivery_fee', feeWas + 20);
    try {
      db.adminUpdateOrder(c.id, { address: { ...addr, street: 'הרצל 9' } });
      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-boom',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-010',
        },
      };

      const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-boom' } });
      // The provider is answered, and the payment stands.
      expect(r.status).toBe(200);
      const order = db.getCollection(c.id).order;
      expect(order.paid).toBe(true);
      expect(order.charged_total).toBe(charged);
      expect(order.paid_transaction_id).toBe('tx-boom');
      expect(alert).toHaveBeenCalled();
    } finally {
      alert.mockRestore();
      settings.set('pricing', 'delivery_fee', feeWas);
    }
  });

  // PELECARD IS WHAT PRODUCTION CHARGES WITH, so the fee-moved notice has to
  // reach the owner from this callback too — not only from the Tranzila sweep.
  // The case is reachable on the admin path: an unpaid delivery order with a pay
  // modal open, the owner raises the fee and fixes a typo, `adminUpdateOrder`
  // re-prices, and the in-flight charge then settles at the old amount. Without
  // the notice the order is marked paid with `total` != `charged_total` and
  // nobody is told.
  it('reports a fee that moved under an in-flight charge', async () => {
    const settings = require(path.join(serverDir, 'settings.js'));
    const c = db.createCollection('דמי משלוח זזו באמצע');
    const addr = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: addr,
    });
    expect(init.status).toBe(200);
    const charged = init.body.total;
    const token = tokenOf(c.id);
    const feeWas = db.getCollection(c.id).order.delivery_fee;

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    settings.set('pricing', 'delivery_fee', feeWas + 20);
    try {
      db.adminUpdateOrder(c.id, { address: { ...addr, street: 'הרצל 12' } });
      expect(db.getCollection(c.id).order.delivery_fee).toBe(feeWas + 20);

      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-fee',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-009',
        },
      };
      const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-fee' } });
      expect(r.status).toBe(200);

      // Settles — the charge was correct for the window it was made in.
      const order = db.getCollection(c.id).order;
      expect(order.paid).toBe(true);
      expect(order.charged_total).toBe(charged);
      // ...and she is told, on PeleCard, with the fee move and the shortfall.
      const subjects = alert.mock.calls.map(([subject]) => subject);
      expect(subjects).toContain('שולם, אבל דמי המשלוח השתנו בינתיים');
      const text = alert.mock.calls.map(([, lines]) => lines.join('\n')).join('\n');
      expect(text).toContain(db.getCollection(c.id).order_no);
      expect(text).toContain(feeWas + ' ₪ ← ' + (feeWas + 20) + ' ₪');
    } finally {
      alert.mockRestore();
      settings.set('pricing', 'delivery_fee', feeWas);
    }
  });

  // THE PURCHASE ITSELF CHANGED under an in-flight charge — she edited the unpaid
  // order while the buyer's window was open. PeleCard verifies the charge against
  // THAT window's amount and nothing else, so before this it settled silently: the
  // order marked fully paid at the old price, no notice anywhere.
  //
  // The charge is still correct for the window it was made in, so it settles — the
  // alternative is money taken and the order left unpaid, which is the failure
  // class #620 spent twelve rounds removing. It settles AND she is told.
  it('reports a purchase that changed under an in-flight charge', async () => {
    const c = db.createCollection('הזמנה ששונתה באמצע');
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    expect(init.status).toBe(200);
    const charged = init.body.total;
    const token = tokenOf(c.id);

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      db.adminUpdateOrder(c.id, { quantity: 3 });
      const repriced = db.getCollection(c.id).order;
      expect(repriced.total).toBe(charged * 3);

      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-qty',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-012',
        },
      };
      const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-qty' } });
      expect(r.status).toBe(200);

      // Settles at what was actually charged.
      const order = db.getCollection(c.id).order;
      expect(order.paid).toBe(true);
      expect(order.charged_total).toBe(charged);

      // ...and she is TOLD, with both numbers and the shortfall. This is the
      // assertion that fails today: the settle is silent.
      expect(alert).toHaveBeenCalled();
      const text = alert.mock.calls.map(([, lines]) => lines.join('\n')).join('\n');
      expect(text).toContain(db.getCollection(c.id).order_no);
      expect(text).toContain(String(charged));
      expect(text).toContain(String(order.total));
      // WHAT changed, not merely that something did. Without this the copies
      // branch of describePurchaseChange can be removed with the suite still
      // green, and the notice would say the order changed while listing nothing.
      expect(text).toContain('מספר עותקים: 1 ← 3');
    } finally {
      alert.mockRestore();
    }
  });

  // THE NEGATIVE THAT KEEPS THE ALERT WORTH READING. Every ordinary payment
  // settles with the purchase it was quoted for, so if this fired too the real
  // ones would be buried in notices about nothing.
  it('stays silent when the purchase did not change', async () => {
    const c = db.createCollection('הזמנה רגילה');
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    const charged = init.body.total;
    const token = tokenOf(c.id);

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-plain',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-013',
        },
      };
      const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-plain' } });
      expect(r.status).toBe(200);
      expect(db.getCollection(c.id).order.paid).toBe(true);
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });

  // THE NUMBER SHE ACTS ON. `charged_total` is POST-discount and `order.total` is
  // PRE-discount, so subtracting one from the other is coupon-blind — and this
  // file already says so: feeMoveOnSettle's comment explains that exact trap and
  // is why the fee notice reports the fee delta instead. At 50% on a 199 ₪ pickup
  // the buyer pays 100; edit copies 1->2 and the order is 398 pre-coupon but 199
  // to this buyer, so the gap is 99 — not the 298 a total-minus-charged reading
  // gives. Telling her to collect three times the real gap, on the one message
  // whose whole job is the gap, is worse than not sending it.
  it('states the shortfall after the coupon, not the pre-discount gap', async () => {
    expect(db.createCoupon({ code: 'HALFX', discount_pct: 50 }).code).toBe('HALFX');
    const c = db.createCollection('קופון והזמנה ששונתה');
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
      coupon: 'HALFX',
    });
    expect(init.status).toBe(200);
    const charged = init.body.charged; // 100 — what the card is actually asked for
    expect(charged).toBe(Math.round(init.body.total / 2));
    const token = tokenOf(c.id);

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      db.adminUpdateOrder(c.id, { quantity: 2 });
      const order = db.getCollection(c.id).order;
      const expectedNow = Math.round(order.total / 2); // the coupon still applies

      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-coupon-changed',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-017',
        },
      };
      const r = await post('/api/payment/callback', {
        ResultData: { TransactionId: 'tx-coupon-changed' },
      });
      expect(r.status).toBe(200);
      expect(db.getCollection(c.id).order.paid).toBe(true);

      const text = alert.mock.calls.map(([, lines]) => lines.join('\n')).join('\n');
      // Assert the LINE, not that the numbers appear somewhere: the old test
      // checked only that `charged` and `total` were present as substrings, which
      // is exactly why a wrong shortfall was invisible.
      expect(text).toContain('חסרים ' + (expectedNow - charged) + ' ₪');
      expect(text).not.toContain('חסרים ' + (order.total - charged) + ' ₪');
    } finally {
      alert.mockRestore();
    }
  });

  // THE COUPON DISCOUNTS THE GAME AND NEVER THE POSTAGE, which is the half of the
  // formula a pickup order cannot prove: with fee 0, `round(total × (1−pct))` and
  // `round((total−fee) × (1−pct)) + fee` are the same number. On a delivery order
  // they differ by the discount taken off the fee, and this is precisely the case
  // feeMoveOnSettle's comment describes — a 50% code on a 238 ₪ order charged 139,
  // not 119. The negative assertions are the point: a simpler formula passes the
  // pickup test and fails this one.
  it('keeps the postage out of the discount when the order has a delivery fee', async () => {
    const settings = require(path.join(serverDir, 'settings.js'));
    // This suite's settings store defaults `delivery_fee` to 0 (the registry in
    // settings.js), so a "delivery" order here carries no postage at all and both
    // formulas below would agree — the test would pass while proving nothing.
    // Give it a real fee, and put it back afterwards.
    settings.set('pricing', 'delivery_fee', 40);
    expect(db.createCoupon({ code: 'HALFY', discount_pct: 50 }).code).toBe('HALFY');
    const c = db.createCollection('קופון עם משלוח');
    const addr = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: addr,
      coupon: 'HALFY',
    });
    expect(init.status).toBe(200);
    const charged = init.body.charged;
    const token = tokenOf(c.id);

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      db.adminUpdateOrder(c.id, { quantity: 2 });
      const order = db.getCollection(c.id).order;
      // Read the fee the CODE will see, after the re-price, not a stale snapshot.
      const fee = order.delivery_fee;
      expect(fee).toBeGreaterThan(0); // otherwise this test proves nothing
      // pay/init's own formula, over the order as it stands now.
      const expectedNow = Math.round((order.total - fee) * 0.5) + fee;
      const naiveWholeTotal = Math.round(order.total * 0.5); // fee discounted too
      const naivePreDiscount = order.total - charged; // the coupon-blind reading

      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-coupon-delivery',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-020',
        },
      };
      const r = await post('/api/payment/callback', {
        ResultData: { TransactionId: 'tx-coupon-delivery' },
      });
      expect(r.status).toBe(200);
      expect(db.getCollection(c.id).order.paid).toBe(true);

      const text = alert.mock.calls.map(([, lines]) => lines.join('\n')).join('\n');
      expect(text).toContain('חסרים ' + (expectedNow - charged) + ' ₪');
      // Neither wrong formula may produce the same line.
      expect(expectedNow).not.toBe(naiveWholeTotal);
      expect(text).not.toContain('חסרים ' + (naiveWholeTotal - charged) + ' ₪');
      expect(text).not.toContain('חסרים ' + naivePreDiscount + ' ₪');
    } finally {
      alert.mockRestore();
      // Put the fee back to the registry default, or it leaks into every test
      // after this one in the file — silently, since they read it live.
      settings.set('pricing', 'delivery_fee', 0);
    }
  });

  // ONE CHARGE, ONE MESSAGE. A fee move and a purchase change can both be true of
  // a single settle; two notices about one charge is its own noise problem. The
  // `else if` that guarantees this is held by nothing today — splitting it into
  // two independent `if`s passes the whole suite.
  it('sends exactly one notice when the fee moved AND the purchase changed', async () => {
    const settings = require(path.join(serverDir, 'settings.js'));
    const c = db.createCollection('גם דמי משלוח וגם עותקים');
    const addr = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: addr,
    });
    expect(init.status).toBe(200);
    const charged = init.body.total;
    const token = tokenOf(c.id);
    const feeWas = db.getCollection(c.id).order.delivery_fee;

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    settings.set('pricing', 'delivery_fee', feeWas + 20);
    try {
      db.adminUpdateOrder(c.id, { quantity: 2 });
      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-both',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-018',
        },
      };
      const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-both' } });
      expect(r.status).toBe(200);
      expect(db.getCollection(c.id).order.paid).toBe(true);

      // Exactly one, and it is the general notice carrying BOTH facts.
      expect(alert).toHaveBeenCalledTimes(1);
      const [subject, lines] = alert.mock.calls[0];
      expect(subject).toBe('שולם, אבל ההזמנה השתנתה בינתיים');
      const text = lines.join('\n');
      expect(text).toContain('מספר עותקים: 1 ← 2');
      expect(text).toContain('דמי המשלוח: ' + feeWas + ' ₪ ← ' + (feeWas + 20) + ' ₪');
    } finally {
      alert.mockRestore();
      settings.set('pricing', 'delivery_fee', feeWas);
    }
  });

  // A SESSION FROM BEFORE #620 CARRIES NO price_key, and the guard that returns
  // null for it is load-bearing exactly at the deploy boundary: without it every
  // settle of an in-flight pre-deploy session would be reported as a changed
  // purchase. Every session the suite creates has a key, so nothing pinned it.
  it('claims nothing when the session predates the price key', async () => {
    const c = db.createCollection('סשן ישן בלי מפתח');
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    const charged = init.body.total;
    const token = tokenOf(c.id);

    // Sessions are live references (verified), so this really is a keyless
    // session by the time the callback reads it.
    const session = db.getCollection(c.id).order.pelecard.sessions.find((s) => s.token === token);
    delete session.price_key;

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      db.adminUpdateOrder(c.id, { quantity: 3 });
      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-nokey',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-019',
        },
      };
      const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-nokey' } });
      expect(r.status).toBe(200);
      // It still settles — the charge was right for its window.
      expect(db.getCollection(c.id).order.paid).toBe(true);
      // ...but nothing is claimed about a change we cannot see.
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });

  // THE ESCALATION, on the notice that carries the most money of the two. Email
  // answering false is not hypothetical: a Resend 5xx, or RESEND_API_KEY/NOTIFY_TO
  // unset on this environment, at the exact moment a changed purchase settles.
  // This notice is sent, not enqueued, so WhatsApp is the only second chance it
  // gets — and the `.catch()` that stops it unmaking the settle would swallow a
  // broken escalation without a sound. The fee notice above has this cover; the
  // expression is identical, so the only thing that makes it true here is a test.
  it('escalates the purchase-changed notice off email when the send reports failure', async () => {
    const c = db.createCollection('הזמנה ששונתה והאימייל נפל');
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    const charged = init.body.total;
    const token = tokenOf(c.id);

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(false);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      db.adminUpdateOrder(c.id, { quantity: 4 });
      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-qty-fallback',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-014',
        },
      };
      const r = await post('/api/payment/callback', {
        ResultData: { TransactionId: 'tx-qty-fallback' },
      });
      expect(r.status).toBe(200);
      expect(db.getCollection(c.id).order.paid).toBe(true);
      expect(alert).toHaveBeenCalled();

      // The fallback runs in a .then AFTER the callback answers, so let the
      // microtask queue drain before asserting on it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const escalated = logged.mock.calls
        .map((args) => args.map((a) => String(a)).join(' '))
        .join('\n');
      expect(escalated).toContain('OWNER ESCALATION NOT DELIVERED');
      expect(escalated).toContain('ההזמנה השתנתה');
    } finally {
      logged.mockRestore();
      alert.mockRestore();
    }
  });

  // A NOTIFICATION MUST NEVER UNMAKE A SETTLE — the same rule the fee notice is
  // held to, and the reason this notice is wrapped at all. By the time it runs the
  // money has cleared and the order is already marked paid, so a SYNCHRONOUS throw
  // on the way to telling her would answer PeleCard with a failure and invite a
  // retry, over a message. Only a sync throw can escape: `sendSystemAlert` catches
  // its own rejections internally.
  it('still settles when the purchase-changed notice itself throws', async () => {
    const c = db.createCollection('התראת שינוי שנכשלת');
    const init = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
    });
    const charged = init.body.total;
    const token = tokenOf(c.id);

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockImplementation(() => {
      throw new Error('notify exploded');
    });
    try {
      db.adminUpdateOrder(c.id, { quantity: 5 });
      nextGetTx = {
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-qty-boom',
          ShvaResult: '000',
          AdditionalDetailsParamX: token,
          DebitTotal: Math.round(charged * 100),
          DebitApproveNumber: '86-001-015',
        },
      };
      const r = await post('/api/payment/callback', {
        ResultData: { TransactionId: 'tx-qty-boom' },
      });
      // The provider is answered, and the payment stands.
      expect(r.status).toBe(200);
      const order = db.getCollection(c.id).order;
      expect(order.paid).toBe(true);
      expect(order.charged_total).toBe(charged);
      expect(order.paid_transaction_id).toBe('tx-qty-boom');
      expect(alert).toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });

  it('does NOT mark paid when SHVA did not approve the charge (ShvaResult != 000)', async () => {
    const c = db.createCollection('לא אושר');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '004',
        AdditionalDetailsParamX: token,
        DebitTotal: 7900,
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('still correlates a delivery payment after the order is re-set (token preserved)', async () => {
    const c = db.createCollection('משלוח');
    const addr = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    // First init (delivery), then a second init that re-sets the same order.
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: addr,
    });
    const firstToken = db.getCollection(c.id).order.pelecard.sessions[0].token;
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: addr,
    });
    // The first session's token must have survived the re-set.
    expect(db.getCollection(c.id).order.pelecard.sessions.map((s) => s.token)).toContain(
      firstToken
    );

    // Completing payment on the FIRST session still marks the order paid.
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-d',
        ShvaResult: '000',
        AdditionalDetailsParamX: firstToken,
        DebitTotal: 19900,
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-d' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(true);
  });

  it('does NOT mark paid when GetTransaction reports a foreign/unknown token (forgery)', async () => {
    const c = db.createCollection('זיוף');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-x',
        ShvaResult: '000',
        AdditionalDetailsParamX: 'someoneelsetoken',
        DebitTotal: 7900,
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-x' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('does NOT mark paid when the charged amount does not match', async () => {
    const c = db.createCollection('סכום שגוי');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '000',
        AdditionalDetailsParamX: token,
        DebitTotal: 100,
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('does NOT mark paid on a non-success transaction status', async () => {
    const c = db.createCollection('סטטוס שגוי');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '004',
      ResultData: { TransactionId: 'tx-1', AdditionalDetailsParamX: token, DebitTotal: 7900 },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('returns 502 (for a PeleCard retry) when verification transiently fails', async () => {
    const c = db.createCollection('כשל זמני');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    nextGetTx = 'THROW';
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(502);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('ignores a callback with no TransactionId', async () => {
    const r = await post('/api/payment/callback', { ResultData: {} });
    expect(r.status).toBe(200);
  });

  it('still creates the order + marks paid even when the notify send rejects', async () => {
    const c = db.createCollection('כשל מייל');
    // Email is configured but the owner send REJECTS. Notifications now fire at
    // ORDER CREATION (pay/init), fire-and-forget — both the order creation and the
    // later payment must succeed regardless of the failing send.
    const cfg = vi.spyOn(notify, 'isConfigured').mockReturnValue(true);
    const spy = vi.spyOn(notify, 'sendOrderPaid').mockRejectedValue(new Error('smtp down'));
    const initRes = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(initRes.status).toBe(200); // order created despite the rejecting send
    expect(spy).toHaveBeenCalledTimes(1); // fired once, at order creation
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-mail',
        ShvaResult: '000',
        AdditionalDetailsParamX: token,
        DebitTotal: 7900,
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-mail' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // NOT re-sent on payment
    spy.mockRestore();
    cfg.mockRestore();
  });
});

describe('POST /api/collections/:id/close (idempotent, single notify)', () => {
  it('rejects a wrong/absent owner token with 403', async () => {
    const c = db.createCollection('סגירה');
    const r = await post('/api/collections/' + c.id + '/close', { owner_token: 'nope' });
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).status).toBe('open');
  });

  it('a repeated close returns 200 but fires sendOrderFinished only on the real transition', async () => {
    const c = db.createCollection('סגירה כפולה');
    // Email configured so the route attempts a send; count sends across closes.
    const cfg = vi.spyOn(notify, 'isConfigured').mockReturnValue(true);
    const spy = vi.spyOn(notify, 'sendOrderFinished').mockResolvedValue(true);

    const first = await post('/api/collections/' + c.id + '/close', {
      owner_token: c.owner_token,
    });
    expect(first.status).toBe(200);
    expect(db.getCollection(c.id).status).toBe('closed');
    expect(spy).toHaveBeenCalledTimes(1);

    // Second close (double-click/retry): still 200, but NO second email.
    const second = await post('/api/collections/' + c.id + '/close', {
      owner_token: c.owner_token,
    });
    expect(second.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    cfg.mockRestore();
  });
});

describe('publicView gender', () => {
  it("exposes the honoree gender from createCollection ('male'/'female'/null)", async () => {
    const c = db.createCollection('שירה', { gender: 'female' });
    const r = await get('/api/collections/' + c.id);
    expect(r.status).toBe(200);
    expect(r.body.gender).toBe('female');

    const c2 = db.createCollection('בלי מגדר');
    const r2 = await get('/api/collections/' + c2.id);
    expect(r2.body.gender).toBe(null);
  });
});
