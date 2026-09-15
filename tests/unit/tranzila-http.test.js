// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// server/tranzila.js talking to Tranzila: a call that hangs is aborted instead
// of holding a notify or a pass open, and the sweep's listing follows full pages.
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

describe('a Tranzila call that never answers', () => {
  it('is aborted after TRANZILA_HTTP_TIMEOUT_MS', async () => {
    fetchMock.mockImplementation(
      (url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const started = Date.now();
    await expect(tz.getTransaction('1696')).rejects.toThrow('aborted');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe('listTransactions', () => {
  it('follows full pages and stops at the first short one', async () => {
    const page = (n, from) =>
      Array.from({ length: n }, (_, i) => ({
        index: from + i,
        amount: 100,
        currency: '1',
        processor_response_code: '000',
        txn_type: 'DEBIT',
      }));
    fetchMock
      .mockResolvedValueOnce(ok({ transactions: page(1000, 1) }))
      .mockResolvedValueOnce(ok({ transactions: page(3, 1001) }));
    const rows = await tz.listTransactions({ startDate: '2026-09-15', endDate: '2026-09-16' });
    expect(rows).toHaveLength(1003);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      page: 2,
      page_results: 1000,
    });
  });
});
