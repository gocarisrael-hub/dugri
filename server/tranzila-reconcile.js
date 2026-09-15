// Tranzila payments the notify could not settle on the spot, and the ones whose
// notify never came.
//
// Nothing in Tranzila's documentation says a notify that got a non-200 is sent
// again, so server/index.js never relies on it. For a real Tranzila session the
// notify is always answered 200, and whatever could not be checked right then
// (the lookup cap was full, the session's budget was spent, the report did not
// have the transaction yet, the Reports API failed) is recorded here and
// re-checked by the server on a backoff. A sweep reads the terminal's recent
// transactions for sessions that are still unpaid, which also covers a notify
// that never arrived at all. A session still unsettled after a while is reported
// to the owner, grouped into one alert per pass.
//
// In memory, like every limiter in this server: a restart forgets the pending
// list, and the sweep — which reads the sessions from the store — covers that.
//
// Everything that touches the store, Tranzila or the owner is injected, so the
// timing rules can be tested on their own (tests/unit/tranzila-reconcile.test.js).

// A limit read from the environment: a positive finite number, or the default.
// `Number('abc')` is NaN and `0` would refuse everything, so neither may stand.
function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The calendar date in Israel, which is how the Reports API files transactions.
function israelDate(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

const DEFAULT_RETRY_DELAYS_MS = [15e3, 30e3, 60e3, 120e3, 240e3, 480e3];

function createReconciler({
  lookup, // async (index) => tx | null; throws on a transport error
  listRecent, // async ({ startDate, endDate }) => tx[]
  candidates, // (atMs) => [{ token, initiatedAt }], unpaid sessions worth sweeping
  carries, // (tx, token) => boolean, the transaction carries this session's token
  isSettled, // (token) => boolean, the purchase is paid or the session is gone
  handle, // async (token, tx) => 'settled' | 'rejected' | 'used' | 'gone'
  alertStale, // (tokens) => void, ONE grouped owner alert for this pass
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  alertAfterMs = 10 * 60 * 1000,
  maxIndexesPerSession = 3,
  maxSessions = 1000,
  maxLookupsPerRun = 20,
  now = Date.now,
} = {}) {
  // token -> { firstSeen, alerted, unanswered, indexes: Map(index -> { attempts, nextAt }) }
  const pending = new Map();

  // A notify we could not check. Per session only a few indexes are kept, so a
  // buyer inventing indexes under their own token cannot grow this without bound.
  function recordPending(token, index, at = now()) {
    if (!token || index == null || index === '') return false;
    let p = pending.get(token);
    if (!p) {
      if (pending.size >= maxSessions) pending.delete(pending.keys().next().value);
      p = { firstSeen: at, alerted: false, unanswered: false, indexes: new Map() };
      pending.set(token, p);
    }
    const key = String(index);
    if (p.indexes.has(key)) return true;
    if (p.indexes.size >= maxIndexesPerSession) return false;
    p.indexes.set(key, { attempts: 0, nextAt: at + retryDelaysMs[0] });
    return true;
  }

  // Re-check every pending index that is due, within a per-pass lookup budget.
  // A transaction that comes back is decided by `handle` exactly as the notify
  // would have decided it, and leaves the list whatever the outcome; one that
  // still is not there waits for the next delay, and is given up after the last.
  async function runDue(at = now()) {
    let budget = maxLookupsPerRun;
    const stale = [];
    for (const [token, p] of [...pending]) {
      if (isSettled(token)) {
        pending.delete(token);
        continue;
      }
      for (const [index, e] of [...p.indexes]) {
        if (e.nextAt > at || budget <= 0) continue;
        budget -= 1;
        let tx = null;
        try {
          tx = await lookup(index);
        } catch {
          tx = null;
        }
        if (tx) {
          await handle(token, tx);
          p.indexes.delete(index);
          if (isSettled(token)) break;
          continue;
        }
        e.attempts += 1;
        if (e.attempts >= retryDelaysMs.length) {
          p.indexes.delete(index);
          p.unanswered = true;
        } else {
          e.nextAt = at + retryDelaysMs[e.attempts];
        }
      }
      if (isSettled(token)) {
        pending.delete(token);
        continue;
      }
      // Worth a person only while something is still unchecked or was never
      // found: indexes that came back and were decided (rejected, already used)
      // have already said what they are.
      const open = p.indexes.size > 0 || p.unanswered;
      if (open && !p.alerted && at - p.firstSeen >= alertAfterMs) {
        p.alerted = true;
        stale.push(token);
      }
      if (p.indexes.size === 0 && (p.alerted || !p.unanswered)) pending.delete(token);
    }
    if (stale.length) alertStale(stale);
    return { stale: stale.length, pending: pending.size };
  }

  // One Reports API call for every unpaid session worth sweeping: the terminal's
  // transactions from the earliest session's date to today, matched to sessions
  // by the token each carries.
  async function sweep(at = now()) {
    const list = (candidates(at) || []).filter((c) => c && c.token && !isSettled(c.token));
    if (!list.length) return { checked: 0, settled: 0 };
    const earliest = Math.min(...list.map((c) => c.initiatedAt || at));
    const rows = await listRecent({ startDate: israelDate(earliest), endDate: israelDate(at) });
    let settled = 0;
    for (const c of list) {
      for (const tx of rows || []) {
        if (isSettled(c.token)) break;
        if (!carries(tx, c.token)) continue;
        if ((await handle(c.token, tx)) === 'settled') settled += 1;
      }
    }
    return { checked: list.length, settled };
  }

  return { recordPending, runDue, sweep, _pending: pending };
}

module.exports = { createReconciler, positiveNumber, israelDate, DEFAULT_RETRY_DELAYS_MS };
