// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The guards around Tranzila settlement and its owner alerts:
//   • a report that answers 200 with an error body is a failed sweep;
//   • a charge from a pay window opened before the order changed does not pay it;
//   • a charge whose collection no longer exists is reported;
//   • a refund carrying a paid order's token is not reported;
//   • alerts are delivered per message and use the hourly cap only when sent;
//   • only an open pay window's notify asks for a sweep.
// Tests share one server and run in order.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;

const ENV = {
  PUBLIC_BASE_URL: 'https://test.dugri.example',
  PAYMENT_PROVIDER: 'tranzila',
  PAYMENT_ENV: 'production',
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key',
  TRANZILA_SECRET: 'app-secret',
  TRANZILA_SWEEP_MIN_SPACING_MS: '1',
  TRANZILA_ALERT_RATE_LIMIT: '1',
  TRANZILA_ALERT_CHUNK: '2',
};
const FEE = 39;
const MIN = 60 * 1000;

let app;
let db;
let notify;
let server;
let base;

let report = {};
let reportBody = null;
const reportCalls = [];

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tz-guards-'));
  Object.assign(process.env, ENV);
  for (const k of [
    'PELECARD_TERMINAL',
    'PELECARD_USER',
    'PELECARD_PASSWORD',
    'TRANZILA_HANDSHAKE',
  ]) {
    delete process.env[k];
  }
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
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery']) settings.set('pricing', v + '_enabled', true);
  settings.set('pricing', 'delivery_fee', FEE);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  notify = require(path.join(serverDir, 'notify.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      if (String(url) === 'https://report.tranzila.com/v1/transaction') {
        reportCalls.push(JSON.parse(opts.body));
        const body = reportBody || { transactions: Object.values(report) };
        return { ok: true, status: 200, json: async () => body };
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
  for (const k of Object.keys(ENV)) delete process.env[k];
});

beforeEach(async () => {
  await app.tranzilaSweeper.whenIdle();
  report = {};
  reportBody = null;
  reportCalls.length = 0;
  app.tranzilaAlertSends.length = 0;
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function openPayment(c, body = {}) {
  const r = await post('/api/collections/' + c.id + '/pay/init', {
    owner_token: c.owner_token,
    version: 'pdf',
    ...body,
  });
  expect(r.status).toBe(200);
  return db.getCollection(c.id).order.pelecard.sessions.slice(-1)[0];
}

async function notifyFor(token) {
  await realFetch(base + '/api/payment/tranzila/notify?t=' + token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ index: '1', Response: '000' }).toString(),
  });
  await app.tranzilaSweeper.whenIdle();
}

let nextIndex = 91000;
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

const alertText = (spy) => spy.mock.calls.map(([, lines]) => lines.join('\n')).join('\n');

describe('alert delivery', () => {
  it('a failed attempt uses no hourly slot, and only the messages that arrived are marked sent', async () => {
    const cfg = vi.spyOn(notify, 'isConfigured').mockReturnValue(true);
    const send = vi.spyOn(notify, 'sendSystemAlert');
    try {
      const c = db.createCollection('משלוחי התראות');
      const session = await openPayment(c);
      // Three rows to report, two lines a message: two messages.
      const rows = [charge(session.token, 1), charge(session.token, 2), charge(session.token, 3)];

      // Every message fails: nothing marked, and the single hourly slot unused.
      send.mockResolvedValue(false);
      await app.tranzilaSweeper.sweep();
      expect(send).toHaveBeenCalledTimes(2);
      expect(app.tranzilaAlertSends).toHaveLength(0);
      expect(db.tranzilaSweepState().alert_queue).toHaveLength(3);

      // First message arrives, second fails: only its rows leave the queue.
      send.mockReset();
      send.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await app.tranzilaSweeper.sweep();
      expect(app.tranzilaAlertSends).toHaveLength(1);
      const left = db.tranzilaSweepState().alert_queue.map((q) => q.index);
      expect(left).toHaveLength(1);

      // Next time only the failed message's row goes out — nothing is repeated.
      app.tranzilaAlertSends.length = 0;
      send.mockReset();
      send.mockResolvedValue(true);
      await app.tranzilaSweeper.sweep();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1].join('\n')).toContain(left[0]);
      expect(db.tranzilaSweepState().alert_queue).toEqual([]);
      for (const i of rows) expect(db.tranzilaSweepState().alerted[String(i)]).toBeTruthy();
    } finally {
      send.mockRestore();
      cfg.mockRestore();
    }
  });
});

describe('a Reports reply that is an error body', () => {
  it('keeps last_swept_at, starts the failure clock, and alerts after the threshold', async () => {
    await app.tranzilaSweeper.sweep();
    const st = db.tranzilaSweepState();
    const before = st.last_swept_at;
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      reportBody = { error_code: 401, message: 'No report access' };
      await expect(app.tranzilaSweeper.sweep(before + 1000)).rejects.toThrow(/401/);
      expect(st.last_swept_at).toBe(before);
      expect(st.failing_since).toBe(before + 1000);
      expect(alert).not.toHaveBeenCalled();

      await app.tranzilaSweeper.sweep(before + 16 * MIN).catch(() => {});
      expect(alertText(alert)).toContain('401');

      // Recovers once the report reads again.
      reportBody = null;
      app.tranzilaAlertSends.length = 0;
      await app.tranzilaSweeper.sweep(before + 17 * MIN);
      expect(st.failing_since).toBeUndefined();
    } finally {
      alert.mockRestore();
    }
  });
});

describe('a charge from a pay window opened before the order changed', () => {
  it('does not pay for the changed order, and is reported; the new window still settles it', async () => {
    const c = db.createCollection('הזמנה שהשתנתה');
    const cheap = await openPayment(c);
    expect(cheap.charged_total).toBe(79);
    await post('/api/collections/' + c.id + '/pay/cancel', { owner_token: c.owner_token });
    const address = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    const dearer = await openPayment(c, { version: 'delivery', address });
    expect(dearer.charged_total).toBeGreaterThan(79);

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      const old = charge(cheap.token, 79);
      await app.tranzilaSweeper.sweep();
      expect(db.getCollection(c.id).order.paid).toBe(false);
      const text = alertText(alert);
      expect(text).toContain(String(old));
      expect(text).toContain(db.getCollection(c.id).order_no);
      expect(text).toContain('השתנתה');
      // Both numbers, so the owner can see the gap without opening the store:
      // what was charged (the old window's price) and what the order costs now.
      expect(text).toContain('7900 אגורות');
      expect(text).toContain(String(Math.round(dearer.charged_total * 100)) + ' אגורות');

      charge(dearer.token, dearer.charged_total);
      await app.tranzilaSweeper.sweep();
      const order = db.getCollection(c.id).order;
      expect(order.paid).toBe(true);
      expect(order.version).toBe('delivery');
      expect(order.charged_total).toBe(dearer.charged_total);
    } finally {
      alert.mockRestore();
    }
  });

  it('the same holds when the order is changed directly, with no new pay window', async () => {
    const c = db.createCollection('שונתה ישירות');
    const s = await openPayment(c);
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      charge(s.token, 79);
      await app.tranzilaSweeper.sweep();
      expect(db.getCollection(c.id).order.paid).toBe(false);
      expect(alertText(alert)).toContain('השתנתה');
    } finally {
      alert.mockRestore();
    }
  });
});

describe('a charge whose collection no longer exists', () => {
  it('is reported on production', async () => {
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      // This environment's token shape, but no session in the store for it.
      const index = charge('dp' + 'ab12'.repeat(4), 79);
      await app.tranzilaSweeper.sweep();
      expect(alertText(alert)).toContain(String(index));
      expect(alertText(alert)).toContain('נמחקה');
    } finally {
      alert.mockRestore();
    }
  });
});

describe('a refund of a paid order', () => {
  it('is not reported, though it carries the order token', async () => {
    const c = db.createCollection('זיכוי');
    const s = await openPayment(c);
    charge(s.token, 79);
    await app.tranzilaSweeper.sweep();
    expect(db.getCollection(c.id).order.paid).toBe(true);

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      for (const t of ['CREDIT', 'CANCEL', 'REFUTE']) charge(s.token, 79, { txn_type: t });
      await app.tranzilaSweeper.sweep();
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });

  it('nor is a money-back type this build does not know by name', async () => {
    const c = db.createCollection('זיכוי בשם אחר');
    const s = await openPayment(c);
    charge(s.token, 79);
    await app.tranzilaSweeper.sweep();
    expect(db.getCollection(c.id).order.paid).toBe(true);

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      for (const t of ['REFUND', 'VOID']) charge(s.token, 79, { txn_type: t });
      await app.tranzilaSweeper.sweep();
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });

  // The other half of that rule, and the dangerous half. Ignoring an unknown type
  // is only safe once the purchase is PAID. verifyTransaction settles 'DEBIT'
  // alone, and the string a normal iframe charge reports is unconfirmed until the
  // staging test — so if it turns out to be 'SALE', every single payment would
  // fail verification and be swallowed here, the buyer charged and the order
  // unpaid with nobody told. It has to be reported.
  it('but an unknown type on an UNPAID purchase is still reported', async () => {
    const cfg = vi.spyOn(notify, 'isConfigured').mockReturnValue(true);
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      const c = db.createCollection('סוג לא מוכר על הזמנה שלא שולמה');
      const s = await openPayment(c);
      charge(s.token, 79, { txn_type: 'SALE' });
      await app.tranzilaSweeper.sweep();

      const col = db.getCollection(c.id);
      expect(col.order.paid).toBe(false);
      expect(alert).toHaveBeenCalled();
      expect(alertText(alert)).toContain(String(col.order_no || col.id));
    } finally {
      alert.mockRestore();
      cfg.mockRestore();
    }
  });
});

// An admin edit prices exactly like the buyer's own path now. It used to re-price
// only when the version or the copy count changed, to protect a charge in flight
// from a moving total — but the fee and the total no longer take part in the price
// key, so there is nothing to protect, and the guard only left the two paths
// disagreeing: the admin table could show a total the server would never charge.
describe('an admin edit while a charge is on its way', () => {
  it('re-prices like the buyer path, still settles, and tells the owner the fee moved', async () => {
    const settings = require(path.join(serverDir, 'settings.js'));
    const c = db.createCollection('תיקון כתובת');
    const address = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    const s = await openPayment(c, { version: 'delivery', address });

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    settings.set('pricing', 'delivery_fee', FEE + 20);
    try {
      db.adminUpdateOrder(c.id, { address: { ...address, street: 'הרצל 12' } });
      const order = db.getCollection(c.id).order;
      expect(order.delivery_fee).toBe(FEE + 20);
      expect(order.address.street).toBe('הרצל 12');

      // The charge the buyer already made is still correct for the window it was
      // made in, so it settles — and because the order's total no longer equals
      // what the card was charged, the owner is told.
      charge(s.token, s.charged_total);
      await app.tranzilaSweeper.sweep();
      expect(db.getCollection(c.id).order.paid).toBe(true);
      expect(alertText(alert)).toContain(db.getCollection(c.id).order_no);
    } finally {
      alert.mockRestore();
      settings.set('pricing', 'delivery_fee', FEE);
    }
  });
});

// The amount is already checked exactly, against that window's own
// `charged_total`, so the purchase key only has to answer "is this still the same
// thing being bought?". A delivery fee that moved either way leaves the purchase
// alone, so a verified charge must still settle — refusing it would mean the money
// taken and the order left unpaid. And because `setOrder` keeps pricing from live
// settings, the checkout screen and the charge stay the same number throughout;
// holding the stored fee still instead is what would have driven them apart.
//
// SETTLING IS ONLY HALF OF IT. The order is marked paid with a `total` that no
// longer equals what the card was charged, so the owner has to be told — she is
// the one who decides whether to collect or refund the difference. The fee each
// window quoted is kept on its session as data (`fee_at_init`) for exactly this,
// never in the key, so it informs without ever refusing.
describe('a fee change while the buyer is paying', () => {
  const address = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };

  it('settles a charge from a window opened before the fee rose, and reports it', async () => {
    const settings = require(path.join(serverDir, 'settings.js'));
    const c = db.createCollection('דמי משלוח עלו באמצע תשלום');
    const s = await openPayment(c, { version: 'delivery', address });

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    settings.set('pricing', 'delivery_fee', FEE + 20);
    try {
      // The buyer fixes the address with the window still open: the order
      // re-prices from live settings, exactly as the screen does.
      db.setOrder(c.id, c.owner_token, {
        version: 'delivery',
        address: { ...address, street: 'הרצל 12' },
      });
      expect(db.getCollection(c.id).order.delivery_fee).toBe(FEE + 20);

      // The charge from the window opened BEFORE the rise still pays for it.
      const index = charge(s.token, s.charged_total);
      await app.tranzilaSweeper.sweep();
      const order = db.getCollection(c.id).order;
      expect(order.paid).toBe(true);

      // Told once, naming the order, what was charged and what it costs now.
      expect(alert).toHaveBeenCalledTimes(1);
      const text = alertText(alert);
      expect(text).toContain(String(index));
      expect(text).toContain(db.getCollection(c.id).order_no);
      expect(text).toContain(Math.round(s.charged_total * 100) + ' אגורות');
      expect(text).toContain(Math.round(order.total * 100) + ' אגורות');
    } finally {
      alert.mockRestore();
      settings.set('pricing', 'delivery_fee', FEE);
    }
  });

  it('and one opened before the fee dropped, also reported', async () => {
    const settings = require(path.join(serverDir, 'settings.js'));
    settings.set('pricing', 'delivery_fee', FEE + 20);
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      const c = db.createCollection('דמי משלוח ירדו באמצע תשלום');
      const s = await openPayment(c, { version: 'delivery', address });

      settings.set('pricing', 'delivery_fee', FEE);
      db.setOrder(c.id, c.owner_token, { version: 'delivery', address });
      expect(db.getCollection(c.id).order.delivery_fee).toBe(FEE);

      charge(s.token, s.charged_total);
      await app.tranzilaSweeper.sweep();
      expect(db.getCollection(c.id).order.paid).toBe(true);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alertText(alert)).toContain(db.getCollection(c.id).order_no);
    } finally {
      alert.mockRestore();
      settings.set('pricing', 'delivery_fee', FEE);
    }
  });

  // The one that keeps the alert worth reading. Every ordinary payment settles
  // with the fee it was quoted, so if THIS fired too, the real ones would be
  // buried in a stream of notices about nothing.
  it('but an unchanged fee settles silently', async () => {
    const c = db.createCollection('דמי משלוח לא השתנו');
    const s = await openPayment(c, { version: 'delivery', address });

    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      charge(s.token, s.charged_total);
      await app.tranzilaSweeper.sweep();
      expect(db.getCollection(c.id).order.paid).toBe(true);
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });

  // Every pay/init refreshes the session clock, so a freeze keyed on "a window was
  // opened recently" would have held the old fee for as long as the buyer kept
  // re-opening the modal — indefinitely, past any TTL. Live pricing cannot.
  it('and re-opening the modal never pins an old price', async () => {
    const settings = require(path.join(serverDir, 'settings.js'));
    const c = db.createCollection('פתיחה חוזרת של חלון התשלום');
    await openPayment(c, { version: 'delivery', address });

    settings.set('pricing', 'delivery_fee', FEE + 20);
    try {
      await openPayment(c, { version: 'delivery', address });
      const order = db.getCollection(c.id).order;
      expect(order.delivery_fee).toBe(FEE + 20);
      expect(order.total).toBe(order.unit_price * (order.quantity || 1) + FEE + 20);
    } finally {
      settings.set('pricing', 'delivery_fee', FEE);
    }
  });
});

describe('which notifies ask for a sweep', () => {
  it('a recent window does, even after the buyer closed it; one past the TTL does not', async () => {
    const open = await openPayment(db.createCollection('חלון פתוח'));
    await notifyFor(open.token);
    expect(reportCalls).toHaveLength(1);

    // The close beacon lands before the notify — the ordinary successful payment,
    // because on Tranzila the order is still unpaid when the window closes. The
    // charge must still settle at once, not wait for the periodic sweep.
    reportCalls.length = 0;
    const closedCol = db.createCollection('חלון שנסגר');
    const closed = await openPayment(closedCol);
    await post('/api/collections/' + closedCol.id + '/pay/cancel', {
      owner_token: closedCol.owner_token,
    });
    expect(db.getCollection(closedCol.id).order.pelecard.sessions.slice(-1)[0].resolved).toBe(true);
    charge(closed.token, 79);
    await notifyFor(closed.token);
    expect(reportCalls).toHaveLength(1);
    expect(db.getCollection(closedCol.id).order.paid).toBe(true);

    reportCalls.length = 0;
    const staleCol = db.createCollection('חלון ישן');
    const stale = await openPayment(staleCol);
    db.getCollection(staleCol.id).order.pelecard.sessions.slice(-1)[0].initiated_at = new Date(
      Date.now() - 60 * MIN
    ).toISOString();
    expect(stale.token).toBeTruthy();
    await notifyFor(stale.token);
    expect(reportCalls).toHaveLength(0);
  });
});
