// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// A restart or deploy between answering Tranzila's notify with 200 and settling
// the payment. The pending check lives on the pay session in the store, so a
// fresh process — the store read back from disk, every in-memory structure gone
// — still retries it, settles it, or tells the owner.
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
};
const MODULES = [
  'db.js',
  'pelecard.js',
  'tranzila.js',
  'tranzila-reconcile.js',
  'payment-client-ip.js',
  'settings.js',
  'notify.js',
  'index.js',
];

let report = {};
let server;
let base;

// Boot (or re-boot) the whole server from the files in DATA_DIR.
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
        const body = JSON.parse(opts.body);
        const rows =
          body.transaction_index == null
            ? Object.values(report)
            : report[body.transaction_index]
              ? [report[body.transaction_index]]
              : [];
        return { ok: true, status: 200, json: async () => ({ transactions: rows }) };
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
});

async function openAndLag(db, name, index) {
  const c = db.createCollection(name);
  const init = await realFetch(base + '/api/collections/' + c.id + '/pay/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_token: c.owner_token, version: 'pdf' }),
  });
  expect(init.status).toBe(200);
  const token = db.getCollection(c.id).order.pelecard.sessions.slice(-1)[0].token;
  // The notify arrives before the report has the charge: answered 200, kept.
  const res = await realFetch(base + '/api/payment/tranzila/notify?t=' + token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ index: String(index), Response: '000' }).toString(),
  });
  expect(res.status).toBe(200);
  return { c, token };
}

const row = (index, token) => ({
  index,
  amount: 7900,
  currency: '1',
  processor_response_code: '000',
  txn_type: 'DEBIT',
  authorization_number: 'A' + index,
  user_defined_1: token,
});

describe('a restart between the 200 and settlement', () => {
  it('the stored check is retried by the new process and settles the order', async () => {
    let { db } = await boot();
    const { c, token } = await openAndLag(db, 'לפני הפריסה', 81001);
    expect(db.getCollection(c.id).order.pelecard.sessions.slice(-1)[0].pending_check).toMatchObject(
      { index: '81001', open_at_first: true }
    );

    const next = await boot();
    db = next.db;
    expect(db.getCollection(c.id).order.paid).toBe(false);
    report[81001] = row(81001, token);
    await next.app.tranzilaReconciler.runDue(Date.now() + 60 * 60 * 1000);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.paid_method).toBe('tranzila');
    expect(order.pelecard.sessions.slice(-1)[0].pending_check).toBeUndefined();
  });

  it('the new process sweeps from the stored check and settles it without a lookup by index', async () => {
    let { db } = await boot();
    const { c, token } = await openAndLag(db, 'סריקה אחרי פריסה', 81002);
    const next = await boot();
    db = next.db;
    report[81002] = row(81002, token);
    const out = await next.app.tranzilaReconciler.sweep();
    expect(out.settled).toBe(1);
    expect(db.getCollection(c.id).order.paid).toBe(true);
  });

  it('a check still unsettled alerts the owner from the new process, naming the order', async () => {
    let { db } = await boot();
    const { c, token } = await openAndLag(db, 'עדיין לא שולם', 81003);
    const next = await boot();
    db = next.db;
    const alert = vi.spyOn(next.notify, 'sendSystemAlert').mockResolvedValue(true);
    try {
      await next.app.tranzilaReconciler.runDue(Date.now() + 11 * 60 * 1000);
      expect(alert).toHaveBeenCalledTimes(1);
      const text = alert.mock.calls[0][1].join('\n');
      expect(text).toContain(db.getCollection(c.id).order_no || c.id);
      expect(text).not.toContain(token);
      expect(db.getCollection(c.id).order.paid).toBe(false);
    } finally {
      alert.mockRestore();
    }
  });
});
