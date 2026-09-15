// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// What a buyer holding their OWN session tokens can do to POST
// /api/payment/tranzila/notify with other buyers' (sequential, guessable)
// transaction indexes, no-token indexes and invented tokens — with every limit
// set small so each cap is reachable in a test. The limits are shared across the
// whole file, so the tests run IN ORDER and each one's budget is in its comment.
//
//   alerts: 5 an hour · free lookups: 1 per session · per real token: 3
//   limiter keys: 5 · global lookups: 16 a minute
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;

const ENV = {
  PUBLIC_BASE_URL: 'https://test.dugri.example',
  PAYMENT_PROVIDER: 'tranzila',
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key',
  TRANZILA_SECRET: 'app-secret',
  TRANZILA_ALERT_RATE_LIMIT: '5',
  TRANZILA_FREE_LOOKUPS: '1',
  TRANZILA_NOTIFY_RATE_LIMIT: '3',
  TRANZILA_NOTIFY_RATE_MAX_KEYS: '5',
  TRANZILA_LOOKUP_RATE_LIMIT: '16',
};

let app;
let db;
let notify;
let server;
let base;
let alert;

let report = {};
const reportCalls = [];

const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj });

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tz-abuse-'));
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
    'tranzila-reconcile.js',
    'settings.js',
    'notify.js',
    'index.js',
  ]) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  settings.set('pricing', 'pdf_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  notify = require(path.join(serverDir, 'notify.js'));
  alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      if (String(url) === 'https://report.tranzila.com/v1/transaction') {
        const body = JSON.parse(opts.body);
        reportCalls.push(body);
        const r = report[body.transaction_index];
        return jsonRes({ transactions: r ? [r] : [], rows: r ? 1 : 0 });
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
  alert.mockRestore();
  vi.unstubAllGlobals();
  if (server) server.close();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

beforeEach(() => {
  alert.mockClear();
  reportCalls.length = 0;
});

async function notifyForm(token, index) {
  const res = await realFetch(base + '/api/payment/tranzila/notify?t=' + token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ index: String(index), Response: '000' }).toString(),
  });
  return res.status;
}

async function openSession(name) {
  const c = db.createCollection(name);
  const res = await realFetch(base + '/api/collections/' + c.id + '/pay/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_token: c.owner_token, version: 'pdf' }),
  });
  expect(res.status).toBe(200);
  const sessions = db.getCollection(c.id).order.pelecard.sessions;
  return { c, token: sessions[sessions.length - 1].token };
}

let nextIndex = 70000;
// An approved 79 ₪ report row at `index`; `token` undefined leaves the token out.
function rowAt(index, token, over = {}) {
  report[index] = {
    index,
    amount: 7900,
    currency: '1',
    processor_response_code: '000',
    txn_type: 'DEBIT',
    authorization_number: 'A' + index,
    ...(token ? { user_defined_1: token } : {}),
    ...over,
  };
  return index;
}
const charge = (token, over) => rowAt(nextIndex++, token, over);

const paid = (s) => db.getCollection(s.c.id).order.paid;

describe("the owner alert cannot be silenced, pre-empted or flooded with other buyers' indexes", () => {
  // alerts 1 · global lookups 0 (both lookups are each session's free one)
  it("posting a real order's index first with a foreign token does not stop that order's alert", async () => {
    const victim = await openSession('הזמנה אמיתית');
    const attacker = await openSession('מקדימה');
    // The victim's own approved charge of the wrong kind: a genuine alert case.
    const hold = charge(victim.token, { txn_type: 'VERIFY', tranmode: 'V' });

    expect(await notifyForm(attacker.token, hold)).toBe(200);
    expect(alert).not.toHaveBeenCalled();

    expect(await notifyForm(victim.token, hold)).toBe(200);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].join('\n')).toContain(
      db.getCollection(victim.c.id).order_no || victim.c.id
    );
    expect(paid(victim)).toBe(false);
  });

  // alerts 2 (total 3) · global lookups 2
  it('a foreign-token charge posted repeatedly alerts nobody and uses none of the cap', async () => {
    const other = await openSession('קונה אחרת');
    const attacker = await openSession('מציפה');
    const theirs = charge(other.token);
    for (let i = 0; i < 3; i++) expect(await notifyForm(attacker.token, theirs)).toBe(200);
    expect(alert).not.toHaveBeenCalled();
    expect(paid(attacker)).toBe(false);

    // Two genuine faults afterwards (charges with no token field) both alert.
    for (const name of ['שדה חסר א', 'שדה חסר ב']) {
      const s = await openSession(name);
      expect(await notifyForm(s.token, charge(undefined))).toBe(200);
    }
    expect(alert).toHaveBeenCalledTimes(2);
  });

  // alerts 2 (total 5, the cap) · global lookups 0
  it('one no-token index posted under five of your own tokens is one alert, and a later genuine fault still alerts', async () => {
    // A no-token approved index anyone can find: a staging charge on the shared
    // terminal, a refund, a 10-agorot charge with the token dropped.
    const loose = charge(undefined, { amount: 10 });
    for (let i = 0; i < 5; i++) {
      const own = await openSession('אסימון ' + i);
      expect(await notifyForm(own.token, loose)).toBe(200);
    }
    expect(alert).toHaveBeenCalledTimes(1);

    const genuine = await openSession('תקלה אמיתית');
    expect(await notifyForm(genuine.token, charge(undefined))).toBe(200);
    expect(alert).toHaveBeenCalledTimes(2);
  });
});

describe('the notify limits', () => {
  // global lookups 5 (total 7)
  it("invented tokens get no bucket, so they cannot reset a real token's budget", async () => {
    const real = await openSession('מוגבלת');
    // 1 free + 3 from its budget: four lookups, each answered 200 and kept pending.
    for (let i = 0; i < 4; i++) expect(await notifyForm(real.token, 990000 + i)).toBe(200);
    expect(reportCalls).toHaveLength(4);
    expect(await notifyForm(real.token, 990010)).toBe(200);
    expect(reportCalls).toHaveLength(4);

    // More invented tokens than the limiter holds keys (5). Were they given
    // buckets, the real token's would be evicted and its budget start over.
    for (let i = 0; i < 8; i++) {
      expect(await notifyForm('invented' + String(i).padStart(10, '0'), 1)).toBe(200);
    }
    expect(await notifyForm(real.token, 990011)).toBe(200);
    expect(reportCalls).toHaveLength(4);
  });

  // fills the global cap
  it('with the lookup cap held full, a genuine notify is answered 200, costs its session nothing, and settles on the retry', async () => {
    const { notifyRate, lookupRate } = app.tranzilaLimits;
    while (lookupRate.ok('all'));

    const victim = await openSession('נפגעת');
    const index = nextIndex++;
    // First notify: the session's free lookup is made even with the cap full; the
    // report does not have the charge yet, so it waits as pending.
    expect(await notifyForm(victim.token, index)).toBe(200);
    expect(reportCalls).toHaveLength(1);
    // Tranzila (or anyone) posting it again while the cap is full: all 200, no
    // lookup, and none of the victim session's own budget spent.
    for (let i = 0; i < 4; i++) expect(await notifyForm(victim.token, index)).toBe(200);
    expect(reportCalls).toHaveLength(1);
    expect(notifyRate._buckets.get(victim.token)).toBeUndefined();
    expect(paid(victim)).toBe(false);

    // The charge lands in the report; the server's own retry settles it.
    rowAt(index, victim.token);
    await app.tranzilaReconciler.runDue(Date.now() + 60 * 60 * 1000);
    expect(paid(victim)).toBe(true);

    // And a different session's first notify is still looked up and settled at
    // once, cap or no cap.
    const other = await openSession('ראשונה בתור');
    expect(await notifyForm(other.token, charge(other.token))).toBe(200);
    expect(paid(other)).toBe(true);
  });
});
