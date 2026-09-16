// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// What a buyer holding real session tokens can do to POST
// /api/payment/tranzila/notify: invented indexes, floods, their own and other
// buyers' tokens. A notify only asks for a sweep, so none of it creates lookups,
// per-session state, store writes or alerts — only real rows do.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;

const SPACING = 200;
const ENV = {
  PUBLIC_BASE_URL: 'https://test.dugri.example',
  PAYMENT_PROVIDER: 'tranzila',
  PAYMENT_ENV: 'production',
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key',
  TRANZILA_SECRET: 'app-secret',
  TRANZILA_SWEEP_MIN_SPACING_MS: String(SPACING),
  TRANZILA_ALERT_RATE_LIMIT: '2',
  TRANZILA_ALERT_CHUNK: '10',
};

let app;
let db;
let notify;
let server;
let base;

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
    'tranzila-sweep.js',
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

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      if (String(url) === 'https://report.tranzila.com/v1/transaction') {
        reportCalls.push(JSON.parse(opts.body));
        const rows = Object.values(report);
        return jsonRes({ transactions: rows });
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
  reportCalls.length = 0;
});

function postNotify(token, index) {
  return realFetch(base + '/api/payment/tranzila/notify?t=' + token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ index: String(index), Response: '000' }).toString(),
  });
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
function charge(token, over = {}) {
  const index = nextIndex++;
  report[index] = {
    index,
    amount: 7900,
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

describe('a flood of notifies', () => {
  it('causes no store writes and at most one sweep per spacing interval', async () => {
    const s = await openSession('מוצפת');
    // A recent sweep, so the state is fresh and nothing is due to be written.
    await app.tranzilaSweeper.sweep();
    reportCalls.length = 0;
    const writes = vi.spyOn(fs, 'writeFileSync');
    try {
      const started = Date.now();
      await Promise.all(Array.from({ length: 300 }, (_, i) => postNotify(s.token, 900000 + i)));
      await app.tranzilaSweeper.whenIdle();
      const elapsed = Date.now() - started;
      expect(writes).not.toHaveBeenCalled();
      expect(reportCalls.length).toBeLessThanOrEqual(1 + Math.ceil(elapsed / SPACING));
      expect(db.getCollection(s.c.id).order.pelecard.sessions.slice(-1)[0]).not.toHaveProperty(
        'pending_check'
      );
    } finally {
      writes.mockRestore();
    }
  });

  it('invented indexes and tokens settle nothing and alert nobody', async () => {
    const s = await openSession('אינדקסים מומצאים');
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      for (let i = 0; i < 20; i++) await postNotify(s.token, 123456 + i);
      for (let i = 0; i < 20; i++) await postNotify('dp' + String(i).padStart(16, '0'), 1);
      await app.tranzilaSweeper.whenIdle();
      expect(db.getCollection(s.c.id).order.paid).toBe(false);
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });
});

describe('owner alerts', () => {
  it('held back by the cap, every queued row stays queued — none trimmed — and all go out once allowed', async () => {
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      // Use up the cap: two batches sent in the last hour (the limit here).
      app.tranzilaAlertSends.push(Date.now(), Date.now());
      const s = await openSession('תור התראות');
      const indexes = Array.from({ length: 25 }, () => charge(s.token, { amount: 1 }));
      await app.tranzilaSweeper.sweep();
      expect(alert).not.toHaveBeenCalled();
      expect(db.tranzilaSweepState().alert_queue.map((q) => q.index)).toEqual(
        expect.arrayContaining(indexes.map(String))
      );

      app.tranzilaAlertSends.length = 0;
      await app.tranzilaSweeper.sweep();
      // 25 lines in chunks of 10: three messages, one batch against the cap.
      expect(alert).toHaveBeenCalledTimes(3);
      const text = alert.mock.calls.map(([, lines]) => lines.join('\n')).join('\n');
      for (const i of indexes) expect(text).toContain(String(i));
      expect(text).toContain(db.getCollection(s.c.id).order_no);
      expect(db.tranzilaSweepState().alert_queue).toEqual([]);
    } finally {
      alert.mockRestore();
    }
  });

  it("another buyer's token on a row cannot make that buyer's payment alert for someone else", async () => {
    const victim = await openSession('קונה');
    const attacker = await openSession('מתחזה');
    const alert = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      charge(victim.token);
      await postNotify(attacker.token, 1);
      await app.tranzilaSweeper.whenIdle();
      expect(db.getCollection(victim.c.id).order.paid).toBe(true);
      expect(db.getCollection(attacker.c.id).order.paid).toBe(false);
      expect(alert).not.toHaveBeenCalled();
    } finally {
      alert.mockRestore();
    }
  });
});
