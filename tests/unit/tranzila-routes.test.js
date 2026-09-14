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
  TRANZILA_LOOKUP_RETRY_MS: '0',
};
const FEE = 39;

let app;
let db;
let settings;
let server;
let base;

// Report rows by index; an index missing from here is "not in the report yet".
let report = {};
let reportThrows = false;
const reportCalls = [];

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

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      const u = String(url);
      if (u === 'https://report.tranzila.com/v1/transaction') {
        if (reportThrows) throw new Error('network');
        const body = JSON.parse(opts.body);
        reportCalls.push(body);
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

  it('asks Tranzila to retry (502) when the report does not have it yet or is down', async () => {
    const c = db.createCollection('עוד לא בדוח');
    const { session } = await openPayment(c);
    const missing = await notifyFor(session.token, 999999);
    expect(missing.status).toBe(502);
    reportThrows = true;
    const down = await notifyFor(session.token, 999998);
    expect(down.status).toBe(502);
    expect(db.getCollection(c.id).order.paid).toBe(false);
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
