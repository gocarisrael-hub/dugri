// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// A restart or deploy between a charge and its settlement. Nothing about a
// payment waits in memory: the sweep reads the terminal's rows since the
// persisted last sweep, and the undelivered alert queue is persisted too. A
// fresh process — the store read back from disk, every module reloaded — picks
// both up.
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
};
const MODULES = [
  'db.js',
  'pelecard.js',
  'tranzila.js',
  'tranzila-sweep.js',
  'payment-client-ip.js',
  'settings.js',
  'notify.js',
  'index.js',
];

let report = {};
const reportCalls = [];
let server;
let base;

async function boot() {
  if (server) await new Promise((r) => server.close(r));
  for (const f of MODULES) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  settings.set('pricing', 'pdf_enabled', true);
  const db = require(path.join(serverDir, 'db.js'));
  const app = require(path.join(serverDir, 'index.js'));
  const notify = require(path.join(serverDir, 'notify.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
  return { db, app, notify };
}

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tz-restart-'));
  Object.assign(process.env, ENV);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      if (String(url) === 'https://report.tranzila.com/v1/transaction') {
        reportCalls.push(JSON.parse(opts.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ transactions: Object.values(report) }),
        };
      }
      throw new Error('unexpected fetch ' + url);
    })
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise((r) => server.close(r));
  for (const k of Object.keys(ENV)) delete process.env[k];
});

beforeEach(() => {
  report = {};
  reportCalls.length = 0;
});

async function open(db, name) {
  const c = db.createCollection(name);
  const init = await realFetch(base + '/api/collections/' + c.id + '/pay/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_token: c.owner_token, version: 'pdf' }),
  });
  expect(init.status).toBe(200);
  return { c, token: db.getCollection(c.id).order.pelecard.sessions.slice(-1)[0].token };
}

const row = (index, token, over = {}) => ({
  index,
  amount: 7900,
  currency: '1',
  processor_response_code: '000',
  txn_type: 'DEBIT',
  tranmode: 'A',
  authorization_number: 'A' + index,
  user_defined_1: token,
  ...over,
});

describe('a restart', () => {
  it('the new process reads rows from the persisted last sweep and settles a charge made before it', async () => {
    const { israelDate } = require(path.join(serverDir, 'tranzila-sweep.js'));
    let { db, app } = await boot();
    const { c, token } = await open(db, 'לפני הפריסה');
    await app.tranzilaSweeper.sweep();
    const lastSwept = db.tranzilaSweepState().last_swept_at;
    expect(lastSwept).toBeTruthy();

    const next = await boot();
    db = next.db;
    expect(db.tranzilaSweepState().last_swept_at).toBe(lastSwept);
    report[81001] = row(81001, token);
    reportCalls.length = 0;
    await next.app.tranzilaSweeper.sweep();
    expect(reportCalls[0].transaction_start_date).toBe(israelDate(lastSwept - 60 * 60 * 1000));
    expect(db.getCollection(c.id).order.paid).toBe(true);
  });

  it('an alert that could not be delivered before the restart goes out from the new process', async () => {
    let { db, app, notify } = await boot();
    const { c, token } = await open(db, 'התראה שלא נשלחה');
    report[81002] = row(81002, token, { amount: 100 });
    // Email configured but failing, no WhatsApp: the alert cannot go out.
    const cfg = vi.spyOn(notify, 'isConfigured').mockReturnValue(true);
    const down = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(false);
    await app.tranzilaSweeper.sweep();
    expect(down).toHaveBeenCalled();
    expect(db.tranzilaSweepState().alert_queue.map((q) => q.index)).toContain('81002');
    cfg.mockRestore();
    down.mockRestore();

    const next = await boot();
    db = next.db;
    expect(db.tranzilaSweepState().alert_queue.map((q) => q.index)).toContain('81002');
    const sent = vi.spyOn(next.notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      await next.app.tranzilaSweeper.sweep();
      const text = sent.mock.calls.map(([, lines]) => lines.join('\n')).join('\n');
      expect(text).toContain('81002');
      expect(text).toContain(db.getCollection(c.id).order_no);
      expect(db.tranzilaSweepState().alert_queue).toEqual([]);
      // …and is not sent again by the process after that.
      const third = await boot();
      const again = vi.spyOn(third.notify, 'sendSystemAlert').mockResolvedValue(true);
      await third.app.tranzilaSweeper.sweep();
      expect(again).not.toHaveBeenCalled();
      again.mockRestore();
    } finally {
      sent.mockRestore();
    }
  });
});
