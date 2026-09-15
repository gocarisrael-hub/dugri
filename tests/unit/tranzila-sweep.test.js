// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// server/tranzila-sweep.js on its own: the persisted sweep window and overlap,
// the throttled state write, the alert queue (flagged only once delivered, never
// trimmed), sweep-failure and recovery alerts, single-flight, the notify
// debounce and the adaptive cadence.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { createSweeper, positiveNumber, israelDate } = require(
  path.join(__dirname, '..', '..', 'server', 'tranzila-sweep.js')
);

const T0 = Date.parse('2026-09-16T10:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe('positiveNumber (limit env values)', () => {
  it('keeps a positive finite number and falls back for anything else', () => {
    expect(positiveNumber('7', 3)).toBe(7);
    for (const bad of ['abc', '0', '-4', 'Infinity', '', undefined, null, NaN]) {
      expect(positiveNumber(bad, 60)).toBe(60);
    }
  });
});

describe('israelDate', () => {
  it('uses the Israel calendar day, not UTC', () => {
    expect(israelDate(Date.parse('2026-09-15T22:30:00Z'))).toBe('2026-09-16');
  });
});

// A harness over an in-memory state object (the same object survives a
// "restart": build a second sweeper over it).
function harness(over = {}) {
  const st = over.st || {};
  const timers = [];
  const deps = {
    state: { get: () => st, save: vi.fn() },
    listRows: vi.fn(async () => []),
    decide: vi.fn(() => ({ outcome: 'ignored' })),
    deliver: vi.fn(async () => true),
    hasRecentUnpaid: vi.fn(() => false),
    now: () => T0,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    onError: vi.fn(),
    ...over,
  };
  delete deps.st;
  return { s: createSweeper(deps), deps, st, timers };
}

describe('the sweep window', () => {
  it('reads from the persisted last sweep minus the overlap, to today', async () => {
    const { s, deps } = harness({ st: { last_swept_at: T0 - 5 * MIN } });
    await s.sweep(T0);
    expect(deps.listRows).toHaveBeenCalledWith({
      startDate: israelDate(T0 - 5 * MIN - HOUR),
      endDate: israelDate(T0),
    });
  });

  it('with no last sweep, reads the bootstrap window; never more than 30 days back', async () => {
    const first = harness();
    await first.s.sweep(T0);
    expect(first.deps.listRows).toHaveBeenCalledWith({
      startDate: israelDate(T0 - 48 * HOUR),
      endDate: israelDate(T0),
    });
    const ancient = harness({ st: { last_swept_at: T0 - 400 * 24 * HOUR } });
    await ancient.s.sweep(T0);
    expect(ancient.deps.listRows).toHaveBeenCalledWith({
      startDate: israelDate(T0 - 30 * 24 * HOUR),
      endDate: israelDate(T0),
    });
  });

  it('settles a charge whose row appears after a sweep, though it is older than that sweep', async () => {
    // Just after Israeli midnight: the last sweep ran at 00:05, the charge was
    // made at 23:58 the day before, and its row only shows up afterwards.
    const lastSweep = Date.parse('2026-09-15T21:05:00Z'); // 00:05 Israel, 16 Sep
    const chargedAt = Date.parse('2026-09-15T20:58:00Z'); // 23:58 Israel, 15 Sep
    const rows = [];
    const settled = [];
    const { s } = harness({
      st: { last_swept_at: lastSweep },
      // A date-aware report: only rows filed within the requested dates.
      listRows: vi.fn(async ({ startDate, endDate }) =>
        rows.filter((r) => r.date >= startDate && r.date <= endDate)
      ),
      decide: (tx) => {
        settled.push(tx.index);
        return { outcome: 'settled' };
      },
    });
    rows.push({ index: '901', date: israelDate(chargedAt) });
    await s.sweep(lastSweep + 10 * MIN);
    expect(settled).toEqual(['901']);
  });
});

describe('writing the state', () => {
  it('a quiet sweep writes at most every 10 minutes; one that settles or queues writes at once', async () => {
    const { s, deps, st } = harness({ st: { last_saved_at: T0 - MIN } });
    await s.sweep(T0);
    expect(deps.state.save).not.toHaveBeenCalled();
    expect(st.last_swept_at).toBe(T0);

    await s.sweep(T0 + 11 * MIN);
    expect(deps.state.save).toHaveBeenCalledTimes(1);

    deps.decide.mockReturnValue({ outcome: 'settled' });
    deps.listRows.mockResolvedValue([{ index: '1' }]);
    await s.sweep(T0 + 12 * MIN);
    expect(deps.state.save).toHaveBeenCalledTimes(2);
  });

  it('does not advance last_swept_at when the terminal could not be read', async () => {
    const { s, st } = harness({
      st: { last_swept_at: T0 - MIN },
      listRows: vi.fn().mockRejectedValue(new Error('down')),
    });
    await expect(s.sweep(T0)).rejects.toThrow('down');
    expect(st.last_swept_at).toBe(T0 - MIN);
  });
});

describe('the alert queue', () => {
  const rowAlert = (index) => ({ index, kind: 'unverified', orders: ['DG-1'] });

  it('queues each alerting row once and marks it reported only after delivery', async () => {
    const { s, deps, st } = harness({
      listRows: vi.fn(async () => [{ index: '11' }, { index: '12' }]),
      decide: vi.fn((tx) => ({ outcome: 'rejected', alert: rowAlert(tx.index) })),
      deliver: vi.fn(async () => false),
    });
    await s.sweep(T0);
    expect(st.alert_queue.map((q) => q.index)).toEqual(['11', '12']);
    expect(st.alerted).toEqual({});

    // Still undelivered: nothing is queued twice.
    await s.sweep(T0 + MIN);
    expect(st.alert_queue).toHaveLength(2);

    deps.deliver.mockResolvedValue(true);
    await s.sweep(T0 + 2 * MIN);
    expect(st.alert_queue).toEqual([]);
    expect(Object.keys(st.alerted).sort()).toEqual(['11', '12']);

    // Reported rows are not reported again.
    await s.sweep(T0 + 3 * MIN);
    expect(deps.deliver).toHaveBeenCalledTimes(3);
  });

  it('sends every queued item in one batch, however many, without trimming', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ index: String(i) }));
    const { s, deps } = harness({
      listRows: vi.fn(async () => many),
      decide: vi.fn((tx) => ({ outcome: 'rejected', alert: rowAlert(tx.index) })),
    });
    await s.sweep(T0);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.deliver.mock.calls[0][0]).toHaveLength(2500);
  });

  it('a queue that was not delivered survives a restart and goes out from the new process', async () => {
    const st = {};
    const before = harness({
      st,
      listRows: vi.fn(async () => [{ index: '21' }]),
      decide: vi.fn((tx) => ({ outcome: 'rejected', alert: rowAlert(tx.index) })),
      deliver: vi.fn(async () => false),
    });
    await before.s.sweep(T0);
    const after = harness({ st });
    await after.s.sweep(T0 + MIN);
    expect(after.deps.deliver).toHaveBeenCalledWith([expect.objectContaining({ index: '21' })]);
    expect(st.alerted['21']).toBe(T0 + MIN);
  });

  it('queued alerts still go out when the terminal cannot be read', async () => {
    const { s, deps } = harness({
      st: { alert_queue: [{ index: '31', kind: 'unmatched' }], alerted: {} },
      listRows: vi.fn().mockRejectedValue(new Error('down')),
    });
    await expect(s.sweep(T0)).rejects.toThrow();
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });
});

describe('sweeps that keep failing', () => {
  it('one alert after 15 minutes of failure, not one per sweep, and a recovery note after', async () => {
    const { s, deps, st } = harness({ listRows: vi.fn().mockRejectedValue(new Error('down')) });
    for (let m = 0; m <= 30; m++) await s.sweep(T0 + m * MIN).catch(() => {});
    const sent = deps.deliver.mock.calls.flatMap((c) => c[0]);
    expect(sent.filter((i) => i.kind === 'sweep_failing')).toHaveLength(1);
    expect(sent[0]).toMatchObject({ since: T0, error: 'down' });

    deps.listRows.mockResolvedValue([]);
    await s.sweep(T0 + 31 * MIN);
    const after = deps.deliver.mock.calls.flatMap((c) => c[0]);
    expect(after.filter((i) => i.kind === 'sweep_recovered')).toHaveLength(1);
    expect(st.failing_since).toBeUndefined();
  });

  it('repeats the failure alert at most every 3 hours while it goes on', async () => {
    const { s, deps } = harness({ listRows: vi.fn().mockRejectedValue(new Error('down')) });
    for (let m = 0; m <= 7 * 60; m += 5) await s.sweep(T0 + m * MIN).catch(() => {});
    const failing = deps.deliver.mock.calls
      .flatMap((c) => c[0])
      .filter((i) => i.kind === 'sweep_failing');
    expect(failing).toHaveLength(3);
  });

  it('a short blip the owner was never told about sends no recovery note', async () => {
    const { s, deps } = harness({ listRows: vi.fn().mockRejectedValueOnce(new Error('blip')) });
    await s.sweep(T0).catch(() => {});
    await s.sweep(T0 + MIN);
    expect(deps.deliver).not.toHaveBeenCalled();
  });
});

describe('scheduling', () => {
  it('never overlaps: a sweep requested while one runs waits and starts nothing new', async () => {
    let release;
    const { s, deps } = harness({
      listRows: vi.fn(() => new Promise((r) => (release = r))),
    });
    const first = s.sweep(T0);
    const second = s.sweep(T0);
    release([]);
    expect(await second).toEqual({ skipped: true });
    await first;
    expect(deps.listRows).toHaveBeenCalledTimes(1);
  });

  it('a burst of notify requests schedules one sweep, spaced from the last one', async () => {
    let clock = T0;
    const { s, deps, timers } = harness({ now: () => clock, minSpacingMs: 10000 });
    await s.sweep(T0);
    clock = T0 + 2000;
    for (let i = 0; i < 500; i++) s.request();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(8000);
    clock = T0 + 10000;
    timers[0].fn();
    await s.whenIdle();
    expect(deps.listRows).toHaveBeenCalledTimes(2);
  });

  it('sweeps every minute while a buyer may be paying, every 10 minutes otherwise', async () => {
    const { s, deps } = harness();
    await s.tick(T0);
    await s.tick(T0 + 5 * MIN);
    expect(deps.listRows).toHaveBeenCalledTimes(1);
    deps.hasRecentUnpaid.mockReturnValue(true);
    await s.tick(T0 + 5 * MIN);
    expect(deps.listRows).toHaveBeenCalledTimes(2);
    await s.tick(T0 + 5 * MIN + 30000);
    expect(deps.listRows).toHaveBeenCalledTimes(2);
  });
});
