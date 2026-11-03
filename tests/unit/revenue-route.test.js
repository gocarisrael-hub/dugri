// @vitest-environment node
// GET /api/admin/revenue and PUT /api/admin/revenue/charges/:index — the owner's
// monthly revenue page, against a stubbed Tranzila Reports API.
//
// Owner key only (the staff key is refused like on every money route), never
// cached by a browser, the report read once per finished month, and the copies
// the owner types for a B2B charge kept across a restart.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const realFetch = globalThis.fetch;

const OWNER = 'rev-owner-key';
const STAFF = 'rev-staff-key';
const ENV = {
  ADMIN_KEY: OWNER,
  STAFF_KEY: STAFF,
  PAYMENT_ENV: 'production',
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key',
  TRANZILA_SECRET: 'app-secret',
};

// The current and previous Israel months, so the stubbed rows fall inside the
// range the route reads whatever day the suite runs.
const ilMonth = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
const NOW = ilMonth(new Date());
const PREV = (() => {
  const [y, m] = NOW.split('-').map(Number);
  return m === 1 ? y - 1 + '-12' : y + '-' + String(m - 1).padStart(2, '0');
})();

let app;
let db;
let server;
let base;
let reportDown = false;
const reportCalls = [];
// Rows as the Reports API returns them (raw), filtered by the asked date range.
let rows = [];

const raw = (index, date, amountAgorot, extra = {}) => ({
  index,
  transaction_date: date,
  transaction_time: '12:00:00',
  amount: amountAgorot,
  currency: '1',
  processor_response_code: '000',
  txn_type: 'DEBIT',
  tranmode: 'A',
  payment_plan: 1,
  ...extra,
});

function loadServer() {
  for (const f of ['settings.js', 'db.js', 'tranzila.js', 'revenue.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
}

async function listen() {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-rev-'));
  Object.assign(process.env, ENV);
  process.env.REVENUE_TRANZILA_FROM = PREV;
  // One site order, paid through Tranzila as transaction 7001, in the store file
  // itself so it is there again after every restart below.
  fs.writeFileSync(
    path.join(process.env.DATA_DIR, 'dugri-data.json'),
    JSON.stringify({
      collections: [
        {
          id: 'rev1',
          order_no: 'DG-9001',
          created_at: new Date().toISOString(),
          order: {
            paid: true,
            paid_at: new Date().toISOString(),
            paid_method: 'tranzila',
            paid_transaction_id: '7001',
            charged_total: 478,
            total: 478,
            quantity: 2,
          },
        },
      ],
      words: [],
    })
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      if (String(url) !== 'https://report.tranzila.com/v1/transaction') {
        throw new Error('unexpected fetch ' + url);
      }
      if (reportDown) throw new Error('network');
      const body = JSON.parse(opts.body);
      reportCalls.push(body.transaction_start_date + '..' + body.transaction_end_date);
      const list = rows.filter(
        (r) =>
          r.transaction_date >= body.transaction_start_date &&
          r.transaction_date <= body.transaction_end_date
      );
      return { ok: true, status: 200, json: async () => ({ transactions: list }) };
    })
  );
  loadServer();
  await listen();
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (server) server.close();
  for (const k of Object.keys(ENV)) delete process.env[k];
  delete process.env.REVENUE_TRANZILA_FROM;
});

beforeEach(() => {
  reportDown = false;
  reportCalls.length = 0;
});

const get = (key) => realFetch(base + '/api/admin/revenue' + (key ? '?key=' + key : ''));
const put = (index, body, key = OWNER) =>
  realFetch(base + '/api/admin/revenue/charges/' + index + '?key=' + key, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the revenue route', () => {
  it('owner only: no key and the staff key are refused', async () => {
    expect((await get()).status).toBe(403);
    const staff = await get(STAFF);
    expect(staff.status).toBe(403);
    expect((await staff.json()).reason).toBe('staff');
    expect((await put('1', { copies: 1 }, STAFF)).status).toBe(403);
  });

  it('returns the months, matched and unmatched, and is never cached', async () => {
    rows = [
      raw(7001, NOW + '-01', 47800, { user_defined_10: 'dp00000000000000aa' }),
      raw(7002, NOW + '-02', 150000),
      raw(7003, NOW + '-02', 4000, { txn_type: '', tranmode: 'C7001' }),
      raw(7004, PREV + '-15', 200, { user_defined_10: 'ds00000000000000bb' }),
      raw(7005, NOW + '-03', 27900, { processor_response_code: '141' }),
    ];
    const res = await get(OWNER);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    const cur = body.months.find((m) => m.month === NOW);
    expect(cur).toMatchObject({
      revenue: 478 + 1500 - 40,
      charges: 2,
      refunds: 1,
      orders: 2,
      site_orders: 1,
      copies: 2,
      b2b_charges: 1,
      b2b_unfilled: 1,
      sources: ['tranzila'],
    });
    expect(body.unmatched.map((u) => u.index)).toEqual(['7002']);
    expect(body.excluded.map((x) => [x.index, x.reason])).toEqual([['7004', 'other_env']]);
    expect(body.tranzila).toMatchObject({ configured: true, error: null, from: PREV });
    expect(body.totals.b2b_unfilled).toBe(1);
  });

  it('reads a finished month once, the current month again only after the TTL', async () => {
    await get(OWNER);
    // The previous test already read both; the finished month stays cached unless
    // it ended within the last day (then it is re-read until it is final).
    expect(reportCalls.filter((c) => c.startsWith(NOW))).toEqual([]);
    const day = Number(
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(8, 10)
    );
    if (day >= 3) expect(reportCalls).toEqual([]);
  });

  it('a failed report is said out loud, not read as an empty terminal', async () => {
    // A fresh process: nothing cached.
    server.close();
    loadServer();
    await listen();
    reportDown = true;
    const body = await (await get(OWNER)).json();
    expect(body.tranzila.error).toMatch(/network/);
    // The Tranzila-paid site order is still counted, from the store.
    expect(body.months.find((m) => m.month === NOW)).toMatchObject({
      orders: 1,
      copies: 2,
      sources: ['orders'],
    });
  });

  it('the copies the owner enters count, and survive a restart', async () => {
    const r = await put('7002', { copies: 12 });
    expect(r.status).toBe(200);
    expect((await r.json()).entry).toMatchObject({ copies: 12 });
    server.close();
    loadServer();
    await listen();
    const body = await (await get(OWNER)).json();
    const cur = body.months.find((m) => m.month === NOW);
    expect(cur).toMatchObject({ copies: 14, b2b_copies: 12, b2b_unfilled: 0 });
    expect(body.unmatched[0]).toMatchObject({ index: '7002', copies: 12 });
    // Cleared again with null.
    await put('7002', { copies: null });
    expect(db.revenueOverrides()['7002']).toBeUndefined();
  });

  it('refuses a bad index or a bad entry', async () => {
    expect((await put('abc', { copies: 1 })).status).toBe(400);
    expect((await put('7002', { copies: -3 })).status).toBe(400);
    expect((await put('7002', {})).status).toBe(400);
  });
});
