// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// server/tranzila-reconcile.js on its own: the env-limit parser, and the retry /
// sweep / stale-alert timing, with the store, Tranzila and the owner injected.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { createReconciler, positiveNumber, israelDate } = require(
  path.join(__dirname, '..', '..', 'server', 'tranzila-reconcile.js')
);

describe('positiveNumber (limit env values)', () => {
  it('keeps a positive finite number', () => {
    expect(positiveNumber('7', 3)).toBe(7);
    expect(positiveNumber('2.5', 3)).toBe(2.5);
    expect(positiveNumber(12, 3)).toBe(12);
  });

  it('falls back to the default for anything else — never no limit, never refuse-all', () => {
    for (const bad of ['abc', '0', '-4', 'Infinity', '', '   ', undefined, null, NaN]) {
      expect(positiveNumber(bad, 60)).toBe(60);
    }
  });
});

describe('israelDate', () => {
  it('uses the Israel calendar day, not UTC', () => {
    // 22:30 UTC on 15 Sep is already 16 Sep in Israel (UTC+3 in September).
    expect(israelDate(Date.parse('2026-09-15T22:30:00Z'))).toBe('2026-09-16');
  });
});

const T0 = Date.parse('2026-09-16T10:00:00Z');

function harness(over = {}) {
  const settled = new Set();
  const txs = {};
  const deps = {
    lookup: vi.fn(async (index) => txs[index] || null),
    listRecent: vi.fn(async () => Object.values(txs)),
    candidates: vi.fn(() => []),
    carries: (tx, token) => tx.token === token,
    isSettled: (token) => settled.has(token),
    handle: vi.fn(async (token, tx) => {
      if (tx.token !== token) return 'rejected';
      settled.add(token);
      return 'settled';
    }),
    alertStale: vi.fn(),
    retryDelaysMs: [1000, 2000, 4000],
    alertAfterMs: 10 * 60 * 1000,
    now: () => T0,
    ...over,
  };
  return { r: createReconciler(deps), deps, txs, settled };
}

describe('pending retries', () => {
  it('re-checks on the backoff and settles once the transaction appears', async () => {
    const { r, deps, txs, settled } = harness();
    expect(r.recordPending('tokA', '101')).toBe(true);

    await r.runDue(T0 + 500); // not due yet
    expect(deps.lookup).not.toHaveBeenCalled();

    await r.runDue(T0 + 1000); // first retry: still not in the report
    expect(deps.lookup).toHaveBeenCalledTimes(1);

    await r.runDue(T0 + 2500); // next is due at +3000
    expect(deps.lookup).toHaveBeenCalledTimes(1);

    txs['101'] = { index: '101', token: 'tokA' };
    await r.runDue(T0 + 3000);
    expect(deps.handle).toHaveBeenCalledWith('tokA', txs['101']);
    expect(settled.has('tokA')).toBe(true);
    expect(r._pending.size).toBe(0);
  });

  it('keeps only a few indexes per session', () => {
    const { r } = harness();
    expect(r.recordPending('tokB', '1')).toBe(true);
    expect(r.recordPending('tokB', '2')).toBe(true);
    expect(r.recordPending('tokB', '3')).toBe(true);
    expect(r.recordPending('tokB', '4')).toBe(false);
    expect(r.recordPending('tokB', '2')).toBe(true);
  });

  it('drops a session that got paid some other way without looking anything up', async () => {
    const { r, deps, settled } = harness();
    r.recordPending('tokC', '5');
    settled.add('tokC');
    await r.runDue(T0 + 60 * 60 * 1000);
    expect(deps.lookup).not.toHaveBeenCalled();
    expect(r._pending.size).toBe(0);
  });

  it('a lookup that throws is retried like one that found nothing', async () => {
    const { r, deps, txs } = harness({
      lookup: vi.fn().mockRejectedValueOnce(new Error('down')),
    });
    r.recordPending('tokD', '9');
    await r.runDue(T0 + 1000);
    txs['9'] = { index: '9', token: 'tokD' };
    deps.lookup.mockImplementation(async (i) => txs[i] || null);
    await r.runDue(T0 + 3000);
    expect(deps.handle).toHaveBeenCalledTimes(1);
  });
});

describe('the stale alert', () => {
  it('alerts once, grouping every session still unsettled after the wait', async () => {
    const { r, deps } = harness();
    r.recordPending('tokE', '11');
    r.recordPending('tokF', '12');
    await r.runDue(T0 + 9 * 60 * 1000);
    expect(deps.alertStale).not.toHaveBeenCalled();
    await r.runDue(T0 + 10 * 60 * 1000);
    expect(deps.alertStale).toHaveBeenCalledTimes(1);
    expect(deps.alertStale.mock.calls[0][0].sort()).toEqual(['tokE', 'tokF']);
    await r.runDue(T0 + 30 * 60 * 1000);
    expect(deps.alertStale).toHaveBeenCalledTimes(1);
  });

  it('does not alert when every index came back and was decided', async () => {
    const { r, deps, txs } = harness();
    txs['13'] = { index: '13', token: 'someoneElse' };
    r.recordPending('tokG', '13');
    await r.runDue(T0 + 11 * 60 * 1000);
    expect(deps.handle).toHaveBeenCalledWith('tokG', txs['13']);
    expect(deps.alertStale).not.toHaveBeenCalled();
    expect(r._pending.size).toBe(0);
  });
});

describe('the sweep', () => {
  it('reads the terminal once and settles each session from the row carrying its token', async () => {
    const { r, deps, txs, settled } = harness({
      candidates: vi.fn(() => [
        { token: 'tokH', initiatedAt: Date.parse('2026-09-15T21:30:00Z') },
        { token: 'tokI', initiatedAt: T0 },
      ]),
    });
    txs.a = { index: 'a', token: 'tokH' };
    txs.b = { index: 'b', token: 'nobody' };
    const out = await r.sweep(T0);
    expect(deps.listRecent).toHaveBeenCalledTimes(1);
    // From the earliest session's Israel date (00:30 on the 16th) to today.
    expect(deps.listRecent).toHaveBeenCalledWith({
      startDate: '2026-09-16',
      endDate: '2026-09-16',
    });
    expect(out).toEqual({ checked: 2, settled: 1 });
    expect(settled.has('tokH')).toBe(true);
    expect(settled.has('tokI')).toBe(false);
    expect(deps.handle).toHaveBeenCalledTimes(1);
  });

  it('makes no call at all when nothing is unpaid', async () => {
    const { r, deps } = harness();
    expect(await r.sweep(T0)).toEqual({ checked: 0, settled: 0 });
    expect(deps.listRecent).not.toHaveBeenCalled();
  });
});
