// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The Tranzila money path end to end, with PAYMENT_PROVIDER=tranzila: pay/init
// hands out Tranzila's iframe, the notify is verified against the Reports API
// (stubbed here) and only a genuine, matching, unspent charge marks anything
// paid — the order, a coupon order, or a shipping upgrade.
//
// PeleCard credentials are set as well, on purpose: the switch must win over a
// configured PeleCard, and a PeleCard session must not be settleable through
// Tranzila's notify.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;

const ENV = {
  PELECARD_TERMINAL: '0962210',
  PELECARD_USER: 'peletest',
  PELECARD_PASSWORD: 'secret',
  PUBLIC_BASE_URL: 'https://test.dugri.example',
  PAYMENT_PROVIDER: 'tranzila',
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key',
  TRANZILA_SECRET: 'app-secret',
  TRANZILA_NOTIFY_RATE_LIMIT: '6',
  // Several tests here produce approved-but-unverified charges on purpose; the
  // production cap of 5 owner alerts an hour would silence the later ones.
  TRANZILA_ALERT_RATE_LIMIT: '50',
  // This file makes dozens of lookups within a minute; the global lookup cap has
  // its own tests in tranzila-notify-abuse.test.js.
  TRANZILA_LOOKUP_RATE_LIMIT: '1000',
};
const FEE = 39;

let app;
let db;
let settings;
let notify;
let server;
let base;

// Report rows by index; an index missing from here is "not in the report yet".
let report = {};
let reportThrows = false;
const reportCalls = [];
// PeleCard's GetTransaction answer, for the cross-provider test.
let nextPeleTx = null;

const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj });

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tz-'));
  Object.assign(process.env, ENV);
  delete process.env.TRANZILA_HANDSHAKE;
  for (const f of ['db.js', 'pelecard.js', 'tranzila.js', 'settings.js', 'notify.js', 'index.js']) {
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

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('/PaymentGW/GetTransaction')) return jsonRes(nextPeleTx);
      if (u === 'https://report.tranzila.com/v1/transaction') {
        if (reportThrows) throw new Error('network');
        const body = JSON.parse(opts.body);
        reportCalls.push(body);
        // A date-range query (the sweep) gets every row; an index query, one.
        if (body.transaction_index == null) {
          const rows = Object.values(report);
          return jsonRes({ transactions: rows, rows: rows.length });
        }
        const r = report[body.transaction_index];
        return jsonRes({ transactions: r ? [r] : [], rows: r ? 1 : 0 });
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
  for (const k of Object.keys(ENV)) delete process.env[k];
});

beforeEach(() => {
  report = {};
  reportThrows = false;
  reportCalls.length = 0;
  nextPeleTx = null;
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Tranzila posts its notify as a form.
async function notifyForm(query, fields) {
  const res = await realFetch(base + '/api/payment/tranzila/notify?' + query, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let nextIndex = 5000;
// A report row for an approved debit of `nis` carrying `token`.
function charge(token, nis, over = {}) {
  const index = nextIndex++;
  report[index] = {
    index,
    amount: Math.round(nis * 100),
    currency: '1',
    processor_response_code: '000',
    txn_type: 'DEBIT',
    authorization_number: 'A' + index,
    user_defined_1: token,
    ...over,
  };
  return index;
}

async function openPayment(c, body = {}) {
  const r = await post('/api/collections/' + c.id + '/pay/init', {
    owner_token: c.owner_token,
    version: 'pdf',
    ...body,
  });
  const sessions = db.getCollection(c.id).order.pelecard.sessions;
  return { r, session: sessions[sessions.length - 1] };
}

const notifyFor = (token, index, extra = {}) =>
  notifyForm('t=' + token, { index: String(index), Response: '000', ...extra });

describe('choosing the provider', () => {
  it('advertises card payment and opens a Tranzila iframe, not PeleCard', async () => {
    const c = db.createCollection('טרנזילה');
    const view = await realFetch(base + '/api/collections/' + c.id).then((x) => x.json());
    expect(view.card_enabled).toBe(true);

    const { r, session } = await openPayment(c);
    expect(r.status).toBe(200);
    const u = new URL(r.body.url);
    expect(u.origin + u.pathname).toBe('https://directng.tranzila.com/fxptest/iframenew.php');
    expect(u.searchParams.get('sum')).toBe('79.00');
    expect(u.searchParams.get('dugri_token')).toBe(session.token);
    expect(u.searchParams.get('notify_url_address')).toBe(
      'https://test.dugri.example/api/payment/tranzila/notify?t=' + session.token
    );
    expect(u.searchParams.get('success_url_address')).toBe(
      'https://test.dugri.example/pay-done.html'
    );
    expect(session.provider).toBe('tranzila');
    expect(session.transaction_id).toBe(null);
  });
});

describe('POST /api/payment/tranzila/notify', () => {
  it('marks the order paid once the report confirms the charge', async () => {
    const c = db.createCollection('שולם בטרנזילה');
    const { session } = await openPayment(c);
    const index = charge(session.token, 79);

    const r = await notifyFor(session.token, index);
    expect(r.status).toBe(200);
    expect(reportCalls).toEqual([{ terminal_name: 'fxptest', transaction_index: index }]);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.paid_method).toBe('tranzila');
    expect(order.paid_transaction_id).toBe(String(index));
    expect(order.paid_approval_no).toBe('A' + index);
    expect(order.charged_total).toBe(79);
    expect(order.pelecard.sessions[0].resolved).toBe(true);
  });

  it('is idempotent when Tranzila calls twice', async () => {
    const c = db.createCollection('פעמיים');
    const { session } = await openPayment(c);
    const index = charge(session.token, 79);
    await notifyFor(session.token, index);
    const paidAt = db.getCollection(c.id).order.paid_at;
    const again = await notifyFor(session.token, index);
    expect(again.status).toBe(200);
    expect(db.getCollection(c.id).order.paid_at).toBe(paidAt);
  });

  it("does not let a checkout claim another buyer's charge by its index", async () => {
    const victim = db.createCollection('קונה אמיתית');
    const attacker = db.createCollection('מתחזה');
    const v = await openPayment(victim);
    const a = await openPayment(attacker);
    // The victim's genuine 79 ₪ charge, same amount the attacker's order costs.
    const index = charge(v.session.token, 79);

    const forged = await notifyFor(a.session.token, index);
    expect(forged.status).toBe(200);
    expect(db.getCollection(attacker.id).order.paid).toBe(false);

    // …and the victim's own notify still pays for the victim.
    await notifyFor(v.session.token, index);
    expect(db.getCollection(victim.id).order.paid).toBe(true);
  });

  it('never spends one transaction on two purchases', async () => {
    const c1 = db.createCollection('ראשונה');
    const c2 = db.createCollection('שנייה');
    const s1 = (await openPayment(c1)).session;
    const s2 = (await openPayment(c2)).session;
    // A pathological row that carries BOTH tokens.
    const index = charge(s1.token, 79, { user_defined_2: s2.token });
    await notifyFor(s1.token, index);
    await notifyFor(s2.token, index);
    expect(db.getCollection(c1.id).order.paid).toBe(true);
    expect(db.getCollection(c2.id).order.paid).toBe(false);
  });

  it('does not mark paid when the charged amount differs from the session', async () => {
    const c = db.createCollection('סכום אחר');
    const { session } = await openPayment(c);
    const index = charge(session.token, 1);
    await notifyFor(session.token, index);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('does not mark paid on a declined charge, and skips the lookup when the notify says so', async () => {
    const c = db.createCollection('נדחה');
    const { session } = await openPayment(c);
    const declined = charge(session.token, 79, { processor_response_code: '004' });
    await notifyFor(session.token, declined);
    expect(db.getCollection(c.id).order.paid).toBe(false);

    reportCalls.length = 0;
    await notifyFor(session.token, declined, { Response: '004' });
    expect(reportCalls).toHaveLength(0);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  // Nothing says Tranzila retries a non-200, so a notify that cannot be checked
  // right now is answered 200 and re-checked by the server.
  it('answers 200 when the report lags or is down, and settles on the server-side retry', async () => {
    const c = db.createCollection('עוד לא בדוח');
    const { session } = await openPayment(c);
    const index = nextIndex++;
    expect((await notifyFor(session.token, index)).status).toBe(200);
    reportThrows = true;
    expect((await notifyFor(session.token, index)).status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);

    reportThrows = false;
    report[index] = {
      index,
      amount: 7900,
      currency: '1',
      processor_response_code: '000',
      txn_type: 'DEBIT',
      authorization_number: 'A' + index,
      user_defined_1: session.token,
    };
    await app.tranzilaReconciler.runDue(Date.now() + 60 * 60 * 1000);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.paid_transaction_id).toBe(String(index));
  });

  it('the sweep settles a session whose notify never arrived', async () => {
    const c = db.createCollection('בלי הודעה');
    const { session } = await openPayment(c);
    charge(session.token, 79);
    reportCalls.length = 0;
    const r = await app.tranzilaReconciler.sweep();
    expect(r.settled).toBeGreaterThanOrEqual(1);
    expect(reportCalls).toHaveLength(1);
    expect(reportCalls[0].transaction_index).toBeUndefined();
    expect(db.getCollection(c.id).order.paid).toBe(true);
    expect(db.getCollection(c.id).order.paid_method).toBe('tranzila');
  });

  it('a pending payment still unsettled after the wait alerts the owner once', async () => {
    const c = db.createCollection('ממתין זמן רב');
    const { session } = await openPayment(c);
    expect((await notifyFor(session.token, nextIndex++)).status).toBe(200);
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      await app.tranzilaReconciler.runDue(Date.now() + 11 * 60 * 1000);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][1].join('\n')).toContain(db.getCollection(c.id).order_no || c.id);
      expect(alert.mock.calls[0][1].join('\n')).not.toContain(session.token);
      await app.tranzilaReconciler.runDue(Date.now() + 30 * 60 * 1000);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(db.getCollection(c.id).order.paid).toBe(false);
    } finally {
      alert.mockRestore();
    }
  });

  it('ignores an unknown token, a missing index, and a PeleCard session', async () => {
    expect((await notifyForm('t=nosuchtoken', { index: '1' })).status).toBe(200);
    expect((await notifyForm('', { index: '1' })).status).toBe(200);

    const c = db.createCollection('פלאקארד');
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.recordPaymentInit(c.id, {
      paramToken: 'peletoken123',
      transactionId: 'pc-1',
      charged_total: 79,
    });
    const index = charge('peletoken123', 79);
    await notifyFor('peletoken123', index);
    expect(db.getCollection(c.id).order.paid).toBe(false);
    expect(reportCalls).toHaveLength(0);
  });
});

describe('pending checks decided later', () => {
  it('a no-token charge found on a retry after the buyer closed the window still alerts', async () => {
    const c = db.createCollection('נסגר החלון');
    const { session } = await openPayment(c);
    const index = nextIndex++;
    // The notify arrives while the window is open; the report does not have it yet.
    expect((await notifyFor(session.token, index)).status).toBe(200);
    await post('/api/collections/' + c.id + '/pay/cancel', { owner_token: c.owner_token });
    expect(db.getCollection(c.id).order.pelecard.sessions.slice(-1)[0].resolved).toBe(true);
    // The charge lands in the report without its token (a misconfigured field).
    report[index] = {
      index,
      amount: 7900,
      currency: '1',
      processor_response_code: '000',
      txn_type: 'DEBIT',
      authorization_number: 'A' + index,
    };
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      await app.tranzilaReconciler.runDue(Date.now() + 60 * 1000);
      expect(alert.mock.calls.some(([, lines]) => lines.join('\n').includes(String(index)))).toBe(
        true
      );
      expect(db.getCollection(c.id).order.paid).toBe(false);
    } finally {
      alert.mockRestore();
    }
  });

  it('the sweep asks Tranzila for the Israel dates from the oldest pending check to today', async () => {
    const { israelDate } = require(path.join(serverDir, 'tranzila-reconcile.js'));
    const c = db.createCollection('טווח תאריכים');
    const { session } = await openPayment(c);
    expect((await notifyFor(session.token, nextIndex++)).status).toBe(200);
    reportCalls.length = 0;
    const now = Date.now();
    await app.tranzilaReconciler.sweep(now);
    const q = reportCalls.find((b) => b.transaction_index == null);
    // Every pending check here is minutes old, so the 2 h window is the earlier bound.
    expect(q.transaction_start_date).toBe(israelDate(now - 2 * 60 * 60 * 1000));
    expect(q.transaction_end_date).toBe(israelDate(now));
  });
});

describe('a buyer who edits the payment page', () => {
  it('an authorization-only hold (J5) never marks the order paid or spends the coupon', async () => {
    db.createCoupon({ code: 'TZHOLD', discount_pct: 50 });
    const c = db.createCollection('החזקה בלבד');
    const { session } = await openPayment(c, { coupon: 'TZHOLD' });
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      // Approved, shekels, the right amount, the right token — and no money.
      const hold = charge(session.token, 40, { txn_type: 'VERIFY', tranmode: 'V' });
      await notifyFor(session.token, hold);
      const j5 = charge(session.token, 40, { txn_type: 'J5' });
      await notifyFor(session.token, j5);
      const unknown = charge(session.token, 40, { txn_type: undefined });
      await notifyFor(session.token, unknown);

      const order = db.getCollection(c.id).order;
      expect(order.paid).toBe(false);
      expect(db.getCouponByCode('TZHOLD').uses || 0).toBe(0);
      // Each approved-but-unverified charge reaches the owner, once per index.
      expect(alert).toHaveBeenCalledTimes(3);
      await notifyFor(session.token, hold);
      expect(alert).toHaveBeenCalledTimes(3);
      const [subject, lines] = alert.mock.calls[0];
      expect(subject).toMatch(/טרנזילה/);
      expect(lines.join('\n')).toContain(String(hold));
      expect(lines.join('\n')).not.toContain(session.token);
    } finally {
      alert.mockRestore();
    }
  });

  it('an approved charge with no token field alerts the owner and is not marked paid', async () => {
    const c = db.createCollection('בלי שדה אסימון');
    const { session } = await openPayment(c);
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      const index = charge(session.token, 79, { user_defined_1: undefined });
      await notifyFor(session.token, index);
      expect(db.getCollection(c.id).order.paid).toBe(false);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][1].join('\n')).toMatch(/לא$/m);
    } finally {
      alert.mockRestore();
    }
  });

  it('a declined charge does not alert anyone', async () => {
    const c = db.createCollection('נדחה בלי התראה');
    const { session } = await openPayment(c);
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      await notifyFor(session.token, charge(session.token, 79, { processor_response_code: '033' }));
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });
});

describe('notify abuse', () => {
  it('past its free lookups and its budget a token is answered 200 and kept pending, with no lookup', async () => {
    const c = db.createCollection('הצפה');
    const { session } = await openPayment(c);
    // 3 free lookups, then the per-token budget of 6.
    for (let i = 0; i < 9; i++) {
      expect((await notifyFor(session.token, 900000 + i)).status).toBe(200);
    }
    expect(reportCalls).toHaveLength(9);
    reportCalls.length = 0;
    const limited = await notifyFor(session.token, 900099);
    expect(limited.status).toBe(200);
    expect(limited.body.pending).toBe(true);
    expect(reportCalls).toHaveLength(0);
  });

  it('a session that already paid never looks anything up again', async () => {
    const c = db.createCollection('כבר שולם אין בדיקה');
    const { session } = await openPayment(c);
    const index = charge(session.token, 79);
    await notifyFor(session.token, index);
    expect(db.getCollection(c.id).order.paid).toBe(true);
    reportCalls.length = 0;
    const again = await notifyFor(session.token, 123456);
    expect(again.status).toBe(200);
    expect(reportCalls).toHaveLength(0);
  });

  it('the PeleCard callback refuses a session Tranzila opened, even when PeleCard reports it paid', async () => {
    const c = db.createCollection('פלאקארד מול טרנזילה');
    const { session } = await openPayment(c);
    nextPeleTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'pc-cross',
        ShvaResult: '000',
        AdditionalDetailsParamX: session.token,
        DebitTotal: 7900,
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'pc-cross' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });
});

describe('coupons through Tranzila', () => {
  it('charges the discounted amount, verifies against it, and counts the use once', async () => {
    expect(db.createCoupon({ code: 'TZHALF', discount_pct: 50 }).error).toBeUndefined();
    const c = db.createCollection('חצי מחיר');
    const { r, session } = await openPayment(c, { coupon: 'TZHALF' });
    expect(r.body.charged).toBe(40);
    expect(new URL(r.body.url).searchParams.get('sum')).toBe('40.00');

    // The full price is not what this session costs, so it does not verify.
    await notifyFor(session.token, charge(session.token, 79));
    expect(db.getCollection(c.id).order.paid).toBe(false);

    await notifyFor(session.token, charge(session.token, 40));
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.coupon).toBe('TZHALF');
    expect(order.charged_total).toBe(40);
    expect(db.getCouponByCode('TZHALF').uses).toBe(1);
  });

  it('refuses the free-coupon path while a Tranzila window is open, until it is closed', async () => {
    db.createCoupon({ code: 'TZFREE', discount_pct: 100 });
    const c = db.createCollection('חינם אחרי פתיחה');
    await openPayment(c);
    const blocked = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
      coupon: 'TZFREE',
    });
    expect(blocked.status).toBe(409);

    await post('/api/collections/' + c.id + '/pay/cancel', { owner_token: c.owner_token });
    const free = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
      coupon: 'TZFREE',
    });
    expect(free.status).toBe(200);
    expect(free.body.free).toBe(true);
  });
});

describe('delivery through Tranzila', () => {
  it('a delivery order is charged with the fee and marked paid', async () => {
    const c = db.createCollection('משלוח בטרנזילה');
    const address = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    const { r, session } = await openPayment(c, { version: 'delivery', address });
    expect(r.status).toBe(200);
    const total = db.getCollection(c.id).order.total;
    expect(r.body.charged).toBe(total);
    await notifyFor(session.token, charge(session.token, total));
    expect(db.getCollection(c.id).order.paid).toBe(true);
  });

  it('a shipping upgrade on a paid order settles on its own session and amount', async () => {
    const c = db.createCollection('שדרוג משלוח');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    db.markPaid(c.id, { method: 'tranzila', transactionId: '1', charged_total: 199 });
    const address = { street: 'הרצל 12', city: 'תל אביב', postal: '6100000' };
    const r = await post('/api/collections/' + c.id + '/shipping/init', {
      owner_token: c.owner_token,
      address,
    });
    expect(r.status).toBe(200);
    expect(new URL(r.body.url).searchParams.get('sum')).toBe(FEE + '.00');
    const session = db.getCollection(c.id).order.shipping.pelecard.sessions.slice(-1)[0];
    expect(session.provider).toBe('tranzila');

    await notifyFor(session.token, charge(session.token, FEE));
    const order = db.getCollection(c.id).order;
    expect(order.shipping.paid).toBe(true);
    expect(order.shipping.paid_method).toBe('tranzila');
    expect(order.version).toBe('delivery');
  });
});

describe('POST /pay-done.html', () => {
  it("turns Tranzila's POST return into a GET of the same page", async () => {
    const res = await realFetch(base + '/pay-done.html?error=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'Response=004&index=1',
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/pay-done.html?error=1');
  });
});

describe('buyer details reach the payment page', () => {
  it("pay/init sends the order's email and phone to Tranzila", async () => {
    const c = db.createCollection('עם פרטים', { email: 'buyer@example.com', phone: '0501234567' });
    const { r } = await openPayment(c);
    const q = new URL(r.body.url).searchParams;
    expect(q.get('email')).toBe('buyer@example.com');
    expect(q.get('phone')).toBe('0501234567');
  });
});

describe('GET /.well-known/apple-developer-merchantid-domain-association', () => {
  it("serves Tranzila's Apple Pay domain file byte for byte, not the homepage", async () => {
    const res = await realFetch(
      base + '/.well-known/apple-developer-merchantid-domain-association'
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const expected = fs.readFileSync(
      path.join(serverDir, 'apple-pay', 'apple-developer-merchantid-domain-association'),
      'utf8'
    );
    const body = await res.text();
    expect(body).toBe(expected);
    expect(body).not.toMatch(/<html/i);
  });
});
