// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// server/tranzila.js talking to Tranzila: a call that hangs is aborted instead
// of holding a sweep open; the report listing follows every page, throws past
// its hard limit, and treats an error body as an error, never as "no rows".
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, '..', '..', 'server', 'tranzila.js');

const ENV = {
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key',
  TRANZILA_SECRET: 'app-secret',
  TRANZILA_HTTP_TIMEOUT_MS: '40',
};

let tz;
let fetchMock;

beforeAll(() => {
  Object.assign(process.env, ENV);
  delete require.cache[require.resolve(modPath)];
  tz = require(modPath);
});

afterAll(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  delete require.cache[require.resolve(modPath)];
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
const page = (n, from) =>
  Array.from({ length: n }, (_, i) => ({
    index: from + i,
    amount: 100,
    currency: '1',
    processor_response_code: '000',
    txn_type: 'DEBIT',
  }));
const range = { startDate: '2026-09-15', endDate: '2026-09-16' };

describe('a Tranzila call that never answers', () => {
  it('is aborted after TRANZILA_HTTP_TIMEOUT_MS', async () => {
    fetchMock.mockImplementation(
      (url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const started = Date.now();
    await expect(tz.listTransactions(range)).rejects.toThrow('aborted');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe('listTransactions paging', () => {
  it('follows full pages and stops at the first short one', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ transactions: page(1000, 1) }))
      .mockResolvedValueOnce(ok({ transactions: page(3, 1001) }));
    const rows = await tz.listTransactions(range);
    expect(rows).toHaveLength(1003);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      page: 2,
      page_results: 1000,
    });
  });

  it('throws past its hard page limit instead of dropping the oldest rows', async () => {
    fetchMock.mockImplementation(async () => ok({ transactions: page(1000, 1) }));
    await expect(tz.listTransactions(range)).rejects.toThrow(/more than/);
    expect(fetchMock).toHaveBeenCalledTimes(200);
  });
});

describe('a report that answers HTTP 200 with an error', () => {
  it('throws on an error code, with the code and message, rather than returning no rows', async () => {
    fetchMock.mockResolvedValueOnce(ok({ error_code: 20003, message: 'No report permission' }));
    await expect(tz.listTransactions(range)).rejects.toThrow(/20003.*No report permission/);
  });

  it('throws when transactions is present but unreadable', async () => {
    fetchMock.mockResolvedValueOnce(ok({ transactions: 'none' }));
    await expect(tz.listTransactions(range)).rejects.toThrow(/not a list/);
  });

  // Which shape a day with no charges comes back in is unconfirmed until the
  // staging test. Failing closed on it would stop every sweep on the first quiet
  // night, so a reply with no error and no transactions is an empty day.
  it('reads a reply with no error and no transactions as an empty day, not a failure', async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    expect(await tz.listTransactions(range)).toEqual([]);
    fetchMock.mockResolvedValueOnce(ok({ transactions: null }));
    expect(await tz.listTransactions(range)).toEqual([]);
    fetchMock.mockResolvedValueOnce(ok({ error_code: 0, message: 'no transactions found' }));
    expect(await tz.listTransactions(range)).toEqual([]);
  });

  it('throws on an error on a later page too', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ transactions: page(1000, 1) }))
      .mockResolvedValueOnce(ok({ error_code: 500, message: 'busy' }));
    await expect(tz.listTransactions(range)).rejects.toThrow(/500/);
  });

  it('accepts error_code 0 with an empty list as a real empty report', async () => {
    fetchMock.mockResolvedValueOnce(ok({ error_code: 0, transactions: [] }));
    expect(await tz.listTransactions(range)).toEqual([]);
  });
});
