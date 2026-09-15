// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// server/tranzila-reconcile.js on its own, over an in-memory stand-in for the
// store: the env-limit parser, one stored check per session, fair retries,
// single-flight passes, the stale alert from stored state (across a restart),
// and the row-driven sweep.
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
    expect(israelDate(Date.parse('2026-09-15T22:30:00Z'))).toBe('2026-09-16');
  });
});

const T0 = Date.parse('2026-09-16T10:00:00Z');
const MIN = 60 * 1000;

// sessions: token -> { paid, pending }. The same object across "restarts".
function makeStore(sessions) {
  return {
    list: () =>
      [...sessions]
        .filter(([, s]) => !s.paid && s.pending)
        .map(([token, s]) => ({ token, pending: s.pending })),
    get: (token) => (sessions.has(token) ? { pending: sessions.get(token).pending } : null),
    set: (token, p) => {
      sessions.get(token).pending = p;
    },
    save: vi.fn(),
  };
}

function harness({ tokens = [], txs = {}, ...over } = {}) {
  const sessions = over.sessions || new Map(tokens.map((t) => [t, { paid: false, pending: null }]));
  const store = makeStore(sessions);
  const deps = {
    store,
    lookup: vi.fn(async (index) => txs[index] || null),
    listRecent: vi.fn(async () => Object.values(txs)),
    tokenCandidates: (tx) => [tx.token],
    isSettled: (token) => !sessions.has(token) || sessions.get(token).paid,
    handle: vi.fn(async (token, tx) => {
      if (tx.token !== token) return 'rejected';
      sessions.get(token).paid = true;
      return 'settled';
    }),
    alertStale: vi.fn(),
    retryDelaysMs: [1000, 2000, 4000],
    alertAfterMs: 10 * MIN,
    maxLookupsPerRun: 20,
    now: () => T0,
  };
  Object.assign(deps, over);
  delete deps.sessions;
  return { r: createReconciler(deps), deps, sessions, store, txs };
}

describe('recording a pending check', () => {
  it('is stored on the session and saved at once', () => {
    const { r, sessions, store } = harness({ tokens: ['tokA'] });
    expect(r.recordPending('tokA', '101', { openAtFirst: true, at: T0 })).toBe(true);
    expect(sessions.get('tokA').pending).toMatchObject({
      index: '101',
      since: T0,
      open_at_first: true,
      attempts: 0,
    });
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('keeps one check per session: the newest index, but not rewritten more than once per 10 s', () => {
    const { r, sessions } = harness({ tokens: ['tokB'] });
    r.recordPending('tokB', '1', { at: T0 });
    expect(r.recordPending('tokB', '2', { at: T0 + 1000 })).toBe(false);
    expect(sessions.get('tokB').pending.index).toBe('1');
    expect(r.recordPending('tokB', '3', { at: T0 + 11000 })).toBe(true);
    const p = sessions.get('tokB').pending;
    expect(p.index).toBe('3');
    // The first notify's moment is kept, so the alert clock is not reset.
    expect(p.since).toBe(T0);
  });

  it('records nothing for an unknown or already-paid session', () => {
    const { r, sessions } = harness({ tokens: ['tokC'] });
    sessions.get('tokC').paid = true;
    expect(r.recordPending('tokC', '5')).toBe(false);
    expect(r.recordPending('nobody', '5')).toBe(false);
  });
});

describe('retry passes', () => {
  it('re-check on the backoff and settle once the transaction appears', async () => {
    const { r, deps, sessions, txs } = harness({ tokens: ['tokD'] });
    r.recordPending('tokD', '9', { at: T0 });
    await r.runDue(T0 + 500);
    expect(deps.lookup).not.toHaveBeenCalled();
    await r.runDue(T0 + 1000);
    expect(deps.lookup).toHaveBeenCalledTimes(1);
    expect(sessions.get('tokD').pending.attempts).toBe(1);
    await r.runDue(T0 + 2500);
    expect(deps.lookup).toHaveBeenCalledTimes(1);
    txs['9'] = { index: '9', token: 'tokD' };
    await r.runDue(T0 + 3000);
    expect(sessions.get('tokD').paid).toBe(true);
    expect(sessions.get('tokD').pending).toBe(null);
  });

  it('are fair: every session gets a turn before any gets a second, whatever came first', async () => {
    const attackers = Array.from({ length: 12 }, (_, i) => 'att' + i);
    const { r, deps, txs } = harness({ tokens: [...attackers, 'victim'], maxLookupsPerRun: 5 });
    attackers.forEach((t, i) => r.recordPending(t, 'junk' + i, { at: T0 + i }));
    r.recordPending('victim', 'real', { at: T0 + 100 });
    txs.real = { index: 'real', token: 'victim' };

    const at = T0 + 60 * MIN;
    await r.runDue(at);
    await r.runDue(at);
    await r.runDue(at);
    const looked = deps.lookup.mock.calls.map((c) => c[0]);
    expect(looked).toContain('real');
    const beforeVictim = looked.slice(0, looked.indexOf('real'));
    expect(new Set(beforeVictim).size).toBe(beforeVictim.length);
  });

  it('never overlap: a pass still waiting on a hung lookup makes the next one a no-op', async () => {
    let release;
    const hang = new Promise((resolve) => (release = resolve));
    const { r, deps, sessions } = harness({ tokens: ['tokE'], lookup: vi.fn(() => hang) });
    r.recordPending('tokE', '7', { at: T0 });

    const first = r.runDue(T0 + 1000);
    expect(await r.runDue(T0 + 16000)).toEqual({ skipped: true });
    expect(deps.lookup).toHaveBeenCalledTimes(1);
    expect(sessions.get('tokE').pending.attempts).toBe(0);

    release(null);
    await first;
    expect(sessions.get('tokE').pending.attempts).toBe(1);
  });

  it('a lookup that throws counts as one attempt, like one that found nothing', async () => {
    const { r, sessions } = harness({
      tokens: ['tokF'],
      lookup: vi.fn().mockRejectedValue(new Error('timeout')),
    });
    r.recordPending('tokF', '8', { at: T0 });
    await r.runDue(T0 + 1000);
    expect(sessions.get('tokF').pending.attempts).toBe(1);
  });

  it('pass the stored open-at-first state to the decision', async () => {
    const { r, deps, txs } = harness({ tokens: ['tokG'] });
    r.recordPending('tokG', '12', { openAtFirst: true, at: T0 });
    txs['12'] = { index: '12', token: 'someoneElse' };
    await r.runDue(T0 + 1000);
    expect(deps.handle).toHaveBeenCalledWith('tokG', txs['12'], { openAtFirst: true });
  });
});

describe('the stale alert', () => {
  it('fires once, grouped, from the stored state — also after a restart', async () => {
    const sessions = new Map([
      ['tokH', { paid: false, pending: null }],
      ['tokI', { paid: false, pending: null }],
    ]);
    const before = harness({ sessions });
    before.r.recordPending('tokH', '21', { at: T0 });
    before.r.recordPending('tokI', '22', { at: T0 });

    // A restart: a brand-new reconciler over the same store.
    const after = harness({ sessions });
    await after.r.runDue(T0 + 9 * MIN);
    expect(after.deps.alertStale).not.toHaveBeenCalled();
    await after.r.runDue(T0 + 10 * MIN);
    expect(after.deps.alertStale).toHaveBeenCalledTimes(1);
    expect(after.deps.alertStale.mock.calls[0][0].sort()).toEqual(['tokH', 'tokI']);
    await after.r.runDue(T0 + 30 * MIN);
    expect(after.deps.alertStale).toHaveBeenCalledTimes(1);
  });

  it('a check the retries gave up on is kept until it has alerted, then removed', async () => {
    const { r, deps, sessions } = harness({ tokens: ['tokJ'], alertAfterMs: 60 * MIN });
    r.recordPending('tokJ', '30', { at: T0 });
    for (const t of [1000, 3000, 7000]) await r.runDue(T0 + t);
    expect(sessions.get('tokJ').pending.gave_up).toBe(true);
    await r.runDue(T0 + 60 * MIN);
    expect(deps.alertStale).toHaveBeenCalledWith(['tokJ']);
    expect(sessions.get('tokJ').pending).toBe(null);
  });
});

describe('the sweep', () => {
  it('matches rows to sessions by token, however many other sessions exist', async () => {
    const many = Array.from({ length: 500 }, (_, i) => 'other' + i);
    const { r, deps, sessions, txs } = harness({ tokens: [...many, 'quiet'] });
    txs.q = { index: 'q', token: 'quiet' };
    const out = await r.sweep(T0);
    expect(deps.listRecent).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ rows: 1, settled: 1 });
    expect(sessions.get('quiet').paid).toBe(true);
  });

  it('asks for the Israel dates from the oldest pending check (capped at 7 days) to today', async () => {
    const { r, deps } = harness({ tokens: ['old', 'older'] });
    r.recordPending('old', '1', { at: T0 - 26 * 60 * MIN });
    await r.sweep(T0);
    expect(deps.listRecent).toHaveBeenLastCalledWith({
      startDate: israelDate(T0 - 26 * 60 * MIN),
      endDate: israelDate(T0),
    });
    r.recordPending('older', '2', { at: T0 - 30 * 24 * 60 * MIN });
    await r.sweep(T0);
    expect(deps.listRecent).toHaveBeenLastCalledWith({
      startDate: israelDate(T0 - 7 * 24 * 60 * MIN),
      endDate: israelDate(T0),
    });
  });

  it('with no pending check, looks back the 2 h window', async () => {
    const { r, deps } = harness({ tokens: ['x'] });
    await r.sweep(T0);
    expect(deps.listRecent).toHaveBeenCalledWith({
      startDate: israelDate(T0 - 120 * MIN),
      endDate: israelDate(T0),
    });
  });

  it('still alerts for stored checks when the Reports API is down, and reports the failure', async () => {
    const { r, deps } = harness({
      tokens: ['tokK'],
      listRecent: vi.fn().mockRejectedValue(new Error('down')),
    });
    r.recordPending('tokK', '40', { at: T0 });
    await expect(r.sweep(T0 + 11 * MIN)).rejects.toThrow('down');
    expect(deps.alertStale).toHaveBeenCalledWith(['tokK']);
  });

  it('does not re-decide a row it already decided', async () => {
    const { r, deps, txs } = harness({ tokens: ['tokL'] });
    txs.l = { index: 'l', token: 'tokL' };
    deps.handle.mockResolvedValue('rejected');
    await r.sweep(T0);
    await r.sweep(T0 + MIN);
    expect(deps.handle).toHaveBeenCalledTimes(1);
  });

  it('never overlaps itself', async () => {
    let release;
    const { r, deps } = harness({
      tokens: ['tokM'],
      listRecent: vi.fn(() => new Promise((resolve) => (release = resolve))),
    });
    const first = r.sweep(T0);
    expect(await r.sweep(T0)).toEqual({ skipped: true });
    expect(deps.listRecent).toHaveBeenCalledTimes(1);
    release([]);
    await first;
  });
});
