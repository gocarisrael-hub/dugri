// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// What a buyer holding their OWN session token can do to POST
// /api/payment/tranzila/notify with other buyers' (sequential, guessable)
// transaction indexes and invented tokens — with every limit set small so each
// cap is reachable in a test. The limits are shared across the whole file, so
// the tests run IN ORDER and each one's budget is counted in its comment.
//
//   alerts: 3 an hour · per real token: 3 · limiter keys: 5 · lookups: 16/min
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
  TRANZILA_LOOKUP_RETRY_MS: '0',
  TRANZILA_ALERT_RATE_LIMIT: '3',
  TRANZILA_NOTIFY_RATE_LIMIT: '3',
  TRANZILA_NOTIFY_RATE_MAX_KEYS: '5',
  TRANZILA_LOOKUP_RATE_LIMIT: '16',
};

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
  for (const f of ['db.js', 'pelecard.js', 'tranzila.js', 'settings.js', 'notify.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  settings.set('pricing', 'pdf_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  const app = require(path.join(serverDir, 'index.js'));
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
// An approved report row for 79 ₪; `token` undefined leaves the token field out.
function charge(token, over = {}) {
  const index = nextIndex++;
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

describe("the owner alert cannot be silenced or pre-empted with other buyers' indexes", () => {
  // budget: 1 alert, 2 lookups
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
    expect(db.getCollection(victim.c.id).order.paid).toBe(false);
  });

  // budget: 2 alerts (reaching the cap of 3), 5 lookups
  it('a foreign-token charge posted repeatedly alerts nobody and uses none of the cap', async () => {
    const other = await openSession('קונה אחרת');
    const attacker = await openSession('מציפה');
    const theirs = charge(other.token);
    for (let i = 0; i < 3; i++) {
      expect(await notifyForm(attacker.token, theirs)).toBe(200);
    }
    expect(alert).not.toHaveBeenCalled();
    expect(db.getCollection(attacker.c.id).order.paid).toBe(false);

    // Two genuine faults afterwards (charges with no token field at all) are both
    // reported: with the cap at 3 and one alert already spent above, the second
    // would be dropped had the foreign posts counted.
    for (const name of ['שדה חסר א', 'שדה חסר ב']) {
      const s = await openSession(name);
      expect(await notifyForm(s.token, charge(undefined))).toBe(200);
    }
    expect(alert).toHaveBeenCalledTimes(2);
  });
});

describe('the notify limits', () => {
  // budget: 3 lookups
  it("invented tokens get no bucket, so they cannot reset a real token's limit", async () => {
    const real = await openSession('מוגבלת');
    for (let i = 0; i < 3; i++) expect(await notifyForm(real.token, 990000 + i)).toBe(502);
    expect(await notifyForm(real.token, 990010)).toBe(429);

    // More invented tokens than the limiter holds keys (5). Were they given
    // buckets, the real token's would be evicted and its limit start over.
    for (let i = 0; i < 8; i++) {
      expect(await notifyForm('invented' + String(i).padStart(10, '0'), 1)).toBe(200);
    }
    reportCalls.length = 0;
    expect(await notifyForm(real.token, 990011)).toBe(429);
    expect(reportCalls).toHaveLength(0);
  });

  // budget: the remaining 6 lookups, then 429
  it('caps Reports API lookups across all tokens, answering 429 without calling Tranzila', async () => {
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      const s = await openSession('גלובלי ' + i);
      const before = reportCalls.length;
      const status = await notifyForm(s.token, 980000 + i);
      statuses.push(status);
      if (status === 429) expect(reportCalls.length).toBe(before);
    }
    // Each post came from a fresh token, each well under its own limit of 3.
    expect(statuses.slice(0, 6)).toEqual([502, 502, 502, 502, 502, 502]);
    expect(statuses.slice(6)).toEqual([429, 429, 429, 429]);
  });
});
