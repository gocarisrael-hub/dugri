// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The stale-session alert through the real server: a Tranzila pay window whose
// purchase is still unpaid 30 minutes on, with nothing settled since, reaches
// the owner once, saying it can mean an abandoned checkout OR a charge the
// reports never showed. Production only; a settled charge ends the streak.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;
const MIN = 60 * 1000;

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
let server;
let base;

// A fresh store and fresh modules for every test.
async function boot() {
  if (server) await new Promise((r) => server.close(r));
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tz-stale-'));
  for (const f of MODULES) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  settings.set('pricing', 'pdf_enabled', true);
  const db = require(path.join(serverDir, 'db.js'));
  const app = require(path.join(serverDir, 'index.js'));
  const notify = require(path.join(serverDir, 'notify.js'));
  const sweep = require(path.join(serverDir, 'tranzila-sweep.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
  const sent = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
  return { db, app, sent, sweep };
}

beforeAll(() => {
  Object.assign(process.env, ENV);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (String(url) === 'https://report.tranzila.com/v1/transaction') {
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
  vi.restoreAllMocks();
  if (server) await new Promise((r) => server.close(r));
  for (const k of Object.keys(ENV)) delete process.env[k];
});

beforeEach(() => {
  report = {};
  process.env.PAYMENT_ENV = 'production';
});

async function open(db, name) {
  const c = db.createCollection(name);
  const init = await realFetch(base + '/api/collections/' + c.id + '/pay/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_token: c.owner_token, version: 'pdf' }),
  });
  expect(init.status).toBe(200);
  const fresh = db.getCollection(c.id);
  return { c: fresh, token: fresh.order.pelecard.sessions.slice(-1)[0].token };
}

const row = (index, token) => ({
  index,
  amount: 7900,
  currency: '1',
  processor_response_code: '000',
  txn_type: 'DEBIT',
  tranmode: 'A',
  authorization_number: 'A' + index,
  user_defined_1: token,
});

const staleLines = (sent) =>
  sent.mock.calls.flatMap(([, lines]) => lines).filter((l) => l.includes('חלון תשלום'));

describe('a Tranzila pay window that aged out unpaid', () => {
  it('reaches the owner once, by order number, with both readings and the My Tranzila line', async () => {
    const { db, app, sent, sweep } = await boot();
    const t0 = Date.now();
    await app.tranzilaSweeper.sweep(t0);
    const { c } = await open(db, 'נטוש');
    await app.tranzilaSweeper.sweep(t0 + 20 * MIN);
    expect(staleLines(sent)).toEqual([]);

    await app.tranzilaSweeper.sweep(t0 + 32 * MIN);
    const lines = staleLines(sent);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(c.order_no);
    expect(lines[0]).toContain('לא סיימו לשלם');
    expect(lines[0]).toContain('dugri_token');
    const body = sent.mock.calls[0][1];
    expect(body[body.length - 1]).toBe(sweep.FOOTER_MONEY);
    // Not repeated by the next pass.
    await app.tranzilaSweeper.sweep(t0 + 40 * MIN);
    expect(staleLines(sent)).toHaveLength(1);
  });

  it('says nothing when a charge settled after the window opened: the reports work', async () => {
    const { db, app, sent } = await boot();
    const t0 = Date.now();
    await app.tranzilaSweeper.sweep(t0);
    await open(db, 'נטוש');
    const paid = await open(db, 'שילם');
    report[91001] = row(91001, paid.token);
    await app.tranzilaSweeper.sweep(t0 + MIN);
    expect(db.getCollection(paid.c.id).order.paid).toBe(true);
    await app.tranzilaSweeper.sweep(t0 + 35 * MIN);
    expect(staleLines(sent)).toEqual([]);
  });

  it('is off on staging, whose windows are test checkouts', async () => {
    process.env.PAYMENT_ENV = 'staging';
    const { db, app, sent } = await boot();
    const t0 = Date.now();
    await app.tranzilaSweeper.sweep(t0);
    await open(db, 'בדיקה');
    await app.tranzilaSweeper.sweep(t0 + 35 * MIN);
    expect(staleLines(sent)).toEqual([]);
  });
});

describe('db.unpaidProviderSessionsBetween', () => {
  it('one entry per unpaid purchase, by its newest window; paid, other-provider and still-open ones left out', async () => {
    const { db } = await boot();
    const iso = (ms) => new Date(ms).toISOString();
    const t = Date.parse('2026-10-01T10:00:00Z');
    const mk = (name, sessions, over = {}) => {
      const c = db.createCollection(name);
      const live = db.getCollection(c.id);
      live.order = { paid: false, pelecard: { sessions }, ...over };
      return live;
    };
    const s = (provider, at) => ({ provider, initiated_at: iso(at) });
    const twice = mk('פעמיים', [s('tranzila', t + MIN), s('tranzila', t + 2 * MIN)]);
    mk('שולם', [s('tranzila', t + MIN)], { paid: true });
    mk('פלאקארד', [s('pelecard', t + MIN)]);
    // An older window inside the range, but a newer one still open after it.
    mk('עדיין פתוח', [s('tranzila', t + MIN), s('tranzila', t + 20 * MIN)]);
    const ship = mk('משלוח', [], {
      paid: true,
      shipping: { paid: false, pelecard: { sessions: [s('tranzila', t + 3 * MIN)] } },
    });
    const got = db.unpaidProviderSessionsBetween('tranzila', t, t + 10 * MIN);
    expect(got).toEqual([
      { order: String(twice.order_no), initiated_at: iso(t + 2 * MIN) },
      { order: ship.order_no + ' (משלוח)', initiated_at: iso(t + 3 * MIN) },
    ]);
  });
});
