// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The Tranzila money path end to end, with PAYMENT_PROVIDER=tranzila: pay/init
// hands out Tranzila's iframe; a notify only asks for a sweep; the sweep reads the
// terminal's rows (the Reports API, stubbed here) and settles a session only from
// a genuine, matching, unspent row — the order, a coupon order, a shipping
// upgrade — and tells the owner about approved rows that do not settle.
//
// PeleCard credentials are set as well, on purpose: the switch must win over a
// configured PeleCard, and a PeleCard session must not be settleable through
// Tranzila.
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
  PAYMENT_ENV: 'production',
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key',
  TRANZILA_SECRET: 'app-secret',
  // Every notify in this file may start its own sweep.
  TRANZILA_SWEEP_MIN_SPACING_MS: '1',
  // Several tests here raise alerts on purpose.
  TRANZILA_ALERT_RATE_LIMIT: '100',
};
const FEE = 39;

let app;
let db;
let settings;
let notify;
let server;
let base;

// Report rows by index; the stub answers a date-range query with all of them.
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
  for (const f of [
    'db.js',
    'pelecard.js',
    'tranzila.js',
    'tranzila-sweep.js',
    'settings.js',
    'notify.js',
    'index.js',
  ]) {
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
        const rows = Object.values(report);
        return jsonRes({ transactions: rows, rows: rows.length });
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

beforeEach(async () => {
  await app.tranzilaSweeper.whenIdle();
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

// Tranzila posts its notify as a form. Waits for any sweep it started.
async function notifyForm(query, fields) {
  const res = await realFetch(base + '/api/payment/tranzila/notify?' + query, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const out = { status: res.status, body: await res.json().catch(() => ({})) };
  await app.tranzilaSweeper.whenIdle();
  return out;
}

let nextIndex = 5000;
// An approved debit row of `nis` carrying `token`.
function charge(token, nis, over = {}) {
  const index = nextIndex++;
  report[index] = {
    index,
    amount: Math.round(nis * 100),
    currency: '1',
    processor_response_code: '000',
    txn_type: 'DEBIT',
    tranmode: 'A',
    authorization_number: 'A' + index,
    ...(token ? { user_defined_1: token } : {}),
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

const notifyFor = (token, index = 1, extra = {}) =>
  notifyForm('t=' + token, { index: String(index), Response: '000', ...extra });

function spyAlerts() {
  return vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
}
const alertText = (spy) => spy.mock.calls.map(([, lines]) => lines.join('\n')).join('\n');

describe('choosing the provider', () => {
  it('advertises card payment and opens a Tranzila iframe with an environment-tagged token', async () => {
    const c = db.createCollection('טרנזילה');
    const view = await realFetch(base + '/api/collections/' + c.id).then((x) => x.json());
    expect(view.card_enabled).toBe(true);

    const { r, session } = await openPayment(c);
    expect(r.status).toBe(200);
    const u = new URL(r.body.url);
    expect(u.origin + u.pathname).toBe('https://directng.tranzila.com/fxptest/iframenew.php');
    expect(u.searchParams.get('sum')).toBe('79.00');
    expect(session.token).toMatch(/^dp[0-9a-f]{16}$/);
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

describe('a notify asks for a sweep; the sweep settles from real rows', () => {
  it('marks the order paid from the row the terminal reports', async () => {
    const c = db.createCollection('שולם בטרנזילה');
    const { session } = await openPayment(c);
    const index = charge(session.token, 79);

    const r = await notifyFor(session.token, index);
    expect(r.status).toBe(200);
    expect(reportCalls).toHaveLength(1);
    expect(reportCalls[0].transaction_index).toBeUndefined();
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.paid_method).toBe('tranzila');
    expect(order.paid_transaction_id).toBe(String(index));
    expect(order.paid_approval_no).toBe('A' + index);
    expect(order.charged_total).toBe(79);
    expect(order.pelecard.sessions[0].resolved).toBe(true);
  });

  it('asks Tranzila for the Israel dates from the last sweep, minus the overlap, to today', async () => {
    const { israelDate } = require(path.join(serverDir, 'tranzila-sweep.js'));
    await app.tranzilaSweeper.sweep();
    const last = db.tranzilaSweepState().last_swept_at;
    reportCalls.length = 0;
    const now = last + 1000;
    await app.tranzilaSweeper.sweep(now);
    expect(reportCalls[0].transaction_start_date).toBe(israelDate(last - 60 * 60 * 1000));
    expect(reportCalls[0].transaction_end_date).toBe(israelDate(now));
  });

  it('is idempotent across repeated notifies and sweeps', async () => {
    const c = db.createCollection('פעמיים');
    const { session } = await openPayment(c);
    charge(session.token, 79);
    await notifyFor(session.token);
    const paidAt = db.getCollection(c.id).order.paid_at;
    await app.tranzilaSweeper.sweep();
    expect(db.getCollection(c.id).order.paid_at).toBe(paidAt);
  });

  it("a notify on another buyer's token cannot claim that buyer's charge: the row pays its own session", async () => {
    const victim = db.createCollection('קונה אמיתית');
    const attacker = db.createCollection('מתחזה');
    const v = await openPayment(victim);
    const a = await openPayment(attacker);
    const index = charge(v.session.token, 79);

    expect((await notifyFor(a.session.token, index)).status).toBe(200);
    expect(db.getCollection(attacker.id).order.paid).toBe(false);
    expect(db.getCollection(victim.id).order.paid).toBe(true);
  });

  it('never spends one transaction on two purchases', async () => {
    const c1 = db.createCollection('ראשונה');
    const c2 = db.createCollection('שנייה');
    const s1 = (await openPayment(c1)).session;
    const s2 = (await openPayment(c2)).session;
    // A pathological row that carries BOTH tokens.
    charge(s1.token, 79, { user_defined_2: s2.token });
    await notifyFor(s1.token);
    await notifyFor(s2.token);
    const paid = [db.getCollection(c1.id).order.paid, db.getCollection(c2.id).order.paid];
    expect(paid.filter(Boolean)).toHaveLength(1);
  });

  it('a row whose report lags the notify is settled by the next sweep', async () => {
    const c = db.createCollection('עוד לא בדוח');
    const { session } = await openPayment(c);
    expect((await notifyFor(session.token)).status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
    charge(session.token, 79);
    await app.tranzilaSweeper.sweep();
    expect(db.getCollection(c.id).order.paid).toBe(true);
  });

  it('a notify while the Reports API is down still answers 200, and nothing is marked paid', async () => {
    const c = db.createCollection('דוח למטה');
    const { session } = await openPayment(c);
    charge(session.token, 79);
    reportThrows = true;
    expect((await notifyFor(session.token)).status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
    reportThrows = false;
    await app.tranzilaSweeper.sweep();
    expect(db.getCollection(c.id).order.paid).toBe(true);
  });

  it('the sweep settles a session whose notify never arrived', async () => {
    const c = db.createCollection('בלי הודעה');
    const { session } = await openPayment(c);
    charge(session.token, 79);
    const r = await app.tranzilaSweeper.sweep();
    expect(r.settled).toBeGreaterThanOrEqual(1);
    expect(db.getCollection(c.id).order.paid).toBe(true);
  });

  it('asks for nothing on a declined notify, an unknown token, a missing token, or a PeleCard session', async () => {
    const c = db.createCollection('לא בודקים');
    const { session } = await openPayment(c);
    await notifyFor(session.token, 1, { Response: '004' });
    await notifyForm('t=dp0000000000000000', { index: '1' });
    await notifyForm('', { index: '1' });

    const pc = db.createCollection('פלאקארד');
    db.setOrder(pc.id, pc.owner_token, { version: 'pdf' });
    db.recordPaymentInit(pc.id, {
      paramToken: 'peletoken123',
      transactionId: 'pc-1',
      charged_total: 79,
    });
    await notifyFor('peletoken123');
    expect(reportCalls).toHaveLength(0);
  });

  it('a session that already paid asks for no sweep', async () => {
    const c = db.createCollection('כבר שולם');
    const { session } = await openPayment(c);
    charge(session.token, 79);
    await notifyFor(session.token);
    expect(db.getCollection(c.id).order.paid).toBe(true);
    reportCalls.length = 0;
    await notifyFor(session.token);
    expect(reportCalls).toHaveLength(0);
  });
});

describe('approved rows that do not settle reach the owner', () => {
  it('an authorization-only hold never marks the order paid or spends the coupon, and is reported once', async () => {
    db.createCoupon({ code: 'TZHOLD', discount_pct: 50 });
    const c = db.createCollection('החזקה בלבד');
    const { session } = await openPayment(c, { coupon: 'TZHOLD' });
    const alert = spyAlerts();
    try {
      const hold = charge(session.token, 40, { txn_type: 'VERIFY', tranmode: 'V' });
      const j5 = charge(session.token, 40, { txn_type: 'J5' });
      const unknown = charge(session.token, 40, { txn_type: undefined });
      await notifyFor(session.token);

      const order = db.getCollection(c.id).order;
      expect(order.paid).toBe(false);
      expect(db.getCouponByCode('TZHOLD').uses || 0).toBe(0);
      expect(alert).toHaveBeenCalledTimes(1);
      const text = alertText(alert);
      for (const i of [hold, j5, unknown]) expect(text).toContain(String(i));
      expect(text).toContain(db.getCollection(c.id).order_no);
      expect(text).not.toContain(session.token);

      await notifyFor(session.token);
      await app.tranzilaSweeper.sweep();
      expect(alert).toHaveBeenCalledTimes(1);
      expect(db.tranzilaSweepState().alerted[String(hold)]).toBeTruthy();
    } finally {
      alert.mockRestore();
    }
  });

  it('a wrong amount is reported and not marked paid', async () => {
    const c = db.createCollection('סכום אחר');
    const { session } = await openPayment(c);
    const alert = spyAlerts();
    try {
      const index = charge(session.token, 1);
      await notifyFor(session.token);
      expect(db.getCollection(c.id).order.paid).toBe(false);
      expect(alertText(alert)).toContain(String(index));
    } finally {
      alert.mockRestore();
    }
  });

  it('a second charge on a purchase that is already paid is reported', async () => {
    const c = db.createCollection('חיוב כפול');
    const { session } = await openPayment(c);
    const first = charge(session.token, 79);
    await notifyFor(session.token);
    expect(db.getCollection(c.id).order.paid_transaction_id).toBe(String(first));
    const alert = spyAlerts();
    try {
      const second = charge(session.token, 79);
      await app.tranzilaSweeper.sweep();
      const text = alertText(alert);
      expect(text).toContain(String(second));
      expect(text).not.toContain(String(first) + ' ');
      expect(text).toContain(db.getCollection(c.id).order_no);
    } finally {
      alert.mockRestore();
    }
  });

  it('on production, an approved debit carrying no session token is reported', async () => {
    const alert = spyAlerts();
    try {
      const index = charge(undefined, 79);
      await app.tranzilaSweeper.sweep();
      expect(alertText(alert)).toContain(String(index));
      expect(alertText(alert)).toContain('dugri_token');
    } finally {
      alert.mockRestore();
    }
  });

  // Not only a DEBIT. Only DEBIT settles, and the string a normal iframe charge
  // reports is unconfirmed until the staging test, so a row typed anything else
  // with nothing to match it against is precisely the one nobody can account for.
  // Gating these two branches on 'DEBIT' swallowed it — charged, not settled, not
  // reported — the same failure as an unknown type on an unpaid purchase.
  it('and so is one typed something this build does not recognise', async () => {
    const alert = spyAlerts();
    try {
      const noToken = charge(undefined, 79, { txn_type: 'SALE' });
      // This environment's token, but its session is gone with the collection —
      // the orphan branch, which carried the same DEBIT-only gate.
      const c = db.createCollection('עסקה יתומה בסוג לא מוכר');
      const { session } = await openPayment(c);
      const orphan = charge(session.token, 79, { txn_type: 'SALE' });
      db.deleteCollection(c.id);

      await app.tranzilaSweeper.sweep();
      const text = alertText(alert);
      expect(text).toContain(String(noToken));
      expect(text).toContain(String(orphan));
    } finally {
      alert.mockRestore();
    }
  });

  // Pointed at an UNPAID purchase on purpose. A refund with no session at all is
  // silent either way — the `env === 'p'` branches would ignore it regardless —
  // so that version of this test guarded nothing. On an unpaid purchase the early
  // return at the top of decideTranzilaRow is load-bearing: without it the row
  // reaches the unknown-type branch, where `matches.every(paid)` is false, and
  // alerts the owner about a "second charge" that is really her own refund.
  it('but a money-back type on an UNPAID purchase stays silent', async () => {
    const alert = spyAlerts();
    try {
      const c = db.createCollection('זיכוי על הזמנה שלא שולמה');
      const { session } = await openPayment(c);
      for (const t of ['CREDIT', 'CANCEL', 'REFUTE', 'REVERSAL']) {
        charge(session.token, 79, { txn_type: t });
      }
      await app.tranzilaSweeper.sweep();
      expect(db.getCollection(c.id).order.paid).toBe(false);
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });

  it('on staging, the same untagged row is not reported (production owns those)', async () => {
    process.env.PAYMENT_ENV = 'staging';
    const alert = spyAlerts();
    try {
      charge(undefined, 79);
      await app.tranzilaSweeper.sweep();
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
      process.env.PAYMENT_ENV = 'production';
    }
  });

  it('a row tagged for the other environment is neither settled nor reported', async () => {
    const c = db.createCollection('סביבה אחרת');
    const { session } = await openPayment(c);
    const alert = spyAlerts();
    try {
      // The same session, but the token as staging would have minted it.
      const stagingToken = 'ds' + session.token.slice(2);
      charge(stagingToken, 79);
      await app.tranzilaSweeper.sweep();
      expect(db.getCollection(c.id).order.paid).toBe(false);
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });

  it('a declined row reports nothing', async () => {
    const c = db.createCollection('נדחה בלי התראה');
    const { session } = await openPayment(c);
    const alert = spyAlerts();
    try {
      charge(session.token, 79, { processor_response_code: '033' });
      await app.tranzilaSweeper.sweep();
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
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

// The buyer pays, then closes the modal before the row reaches the report:
// pay/cancel marks the session resolved while the purchase is still unpaid. A
// session is looked up by its token whatever its resolved state and skipped only
// once its PURCHASE is paid, so the sweep still decides that charge in full.
describe('a payment window closed before the row reached the report', () => {
  it('a verified charge on the released session settles it, and counts the coupon once', async () => {
    db.createCoupon({ code: 'TZCLOSED', discount_pct: 50 });
    const c = db.createCollection('נסגר לפני הדוח');
    const { session } = await openPayment(c, { coupon: 'TZCLOSED' });
    await post('/api/collections/' + c.id + '/pay/cancel', { owner_token: c.owner_token });
    const released = db.getCollection(c.id).order.pelecard.sessions.slice(-1)[0];
    expect(released.resolved).toBe(true);
    expect(db.getCollection(c.id).order.paid).toBe(false);

    const index = charge(session.token, 40);
    await app.tranzilaSweeper.sweep();
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.paid_transaction_id).toBe(String(index));
    expect(order.charged_total).toBe(40);
    expect(order.coupon).toBe('TZCLOSED');
    expect(db.getCouponByCode('TZCLOSED').uses).toBe(1);

    await app.tranzilaSweeper.sweep();
    expect(db.getCouponByCode('TZCLOSED').uses).toBe(1);
  });

  it('a charge on the released session that fails verification does not settle, and is reported', async () => {
    const c = db.createCollection('נסגר וסכום שגוי');
    const { session } = await openPayment(c);
    await post('/api/collections/' + c.id + '/pay/cancel', { owner_token: c.owner_token });
    expect(db.getCollection(c.id).order.pelecard.sessions.slice(-1)[0].resolved).toBe(true);

    const alert = spyAlerts();
    try {
      const index = charge(session.token, 1);
      await app.tranzilaSweeper.sweep();
      expect(db.getCollection(c.id).order.paid).toBe(false);
      const text = alertText(alert);
      expect(text).toContain(String(index));
      expect(text).toContain(db.getCollection(c.id).order_no);
      expect(text).not.toContain(session.token);
    } finally {
      alert.mockRestore();
    }
  });
});

describe('coupons through Tranzila', () => {
  it('charges the discounted amount, settles against it, and counts the use once', async () => {
    expect(db.createCoupon({ code: 'TZHALF', discount_pct: 50 }).error).toBeUndefined();
    const c = db.createCollection('חצי מחיר');
    const { r, session } = await openPayment(c, { coupon: 'TZHALF' });
    expect(r.body.charged).toBe(40);
    expect(new URL(r.body.url).searchParams.get('sum')).toBe('40.00');

    charge(session.token, 79);
    await notifyFor(session.token);
    expect(db.getCollection(c.id).order.paid).toBe(false);

    charge(session.token, 40);
    await notifyFor(session.token);
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
    charge(session.token, total);
    await notifyFor(session.token);
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

    charge(session.token, FEE);
    await notifyFor(session.token);
    const order = db.getCollection(c.id).order;
    expect(order.shipping.paid).toBe(true);
    expect(order.shipping.paid_method).toBe('tranzila');
    expect(order.version).toBe('delivery');
  });

  // The upgrade stays STRICT where the order path is now tolerant, and the
  // difference is deliberate: for an order the delivery fee is incidental to what
  // is being bought, but for an upgrade the fee IS the purchase, so its key and
  // its identity are the same thing. Re-staging re-quotes at the live fee, so a
  // charge from the old quote is refused and reported rather than settling the
  // upgrade at a fee the current staging does not reflect.
  it('a stale upgrade session does not settle a re-staged upgrade, and is reported', async () => {
    const c = db.createCollection('שדרוג משלוח שתומחר מחדש');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    db.markPaid(c.id, { method: 'tranzila', transactionId: '2', charged_total: 199 });
    const address = { street: 'הרצל 12', city: 'תל אביב', postal: '6100000' };
    const init = { owner_token: c.owner_token, address };

    expect((await post('/api/collections/' + c.id + '/shipping/init', init)).status).toBe(200);
    const stale = db.getCollection(c.id).order.shipping.pelecard.sessions.slice(-1)[0];
    expect(stale.charged_total).toBe(FEE);

    const alert = spyAlerts();
    try {
      // The owner re-prices shipping, and the buyer re-stages the upgrade — which
      // re-reads the live fee, so it can never bill yesterday's number.
      settings.set('pricing', 'delivery_fee', FEE + 20);
      expect((await post('/api/collections/' + c.id + '/shipping/init', init)).status).toBe(200);
      expect(db.getCollection(c.id).order.shipping.fee).toBe(FEE + 20);

      // The charge from the FIRST quote arrives late.
      const index = charge(stale.token, FEE);
      await notifyFor(stale.token);

      const order = db.getCollection(c.id).order;
      expect(order.shipping.paid).toBeFalsy();
      expect(order.version).toBe('pickup');
      const text = alertText(alert);
      // REFUSED, never settled-with-notice. `fee_at_init` must not soften this
      // path: for an upgrade the fee IS the key, so a moved fee changes the key
      // and the row is refused before the fee comparison is ever reached. The
      // alert therefore says the purchase changed, not that a fee moved — this
      // needle appears only in the `fee_changed` wording, never in `order_changed`.
      expect(text).not.toContain('סומנה כשולמה עבור הזמנה');
      expect(text).toContain(String(index));
      expect(text).toContain(db.getCollection(c.id).order_no);
      expect(text).toContain('השתנתה');
      // What that window quoted, and what the upgrade costs now — `now` reads
      // shipping.fee for this kind, not the order total.
      expect(text).toContain(FEE * 100 + ' אגורות');
      expect(text).toContain((FEE + 20) * 100 + ' אגורות');
    } finally {
      alert.mockRestore();
      // Shared server across this file: a leaked fee would re-price later tests.
      settings.set('pricing', 'delivery_fee', FEE);
    }
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
