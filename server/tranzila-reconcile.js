// Tranzila payments the notify could not settle on the spot, and the ones whose
// notify never came.
//
// Nothing in Tranzila's documentation says a notify that got a non-200 is sent
// again, so server/index.js never relies on it. For a real Tranzila session the
// notify is always answered 200, and whatever could not be checked right then
// (the lookup cap was full, the session's budget was spent, the report did not
// have the transaction yet, the Reports API failed) becomes a PENDING CHECK:
//
//   • stored ON the pay session in the store, never only in memory, so a restart
//     or deploy between answering Tranzila and settling loses nothing;
//   • one per session (the newest index), so throwaway sessions cannot pile up
//     entries, and retried fairly — least recently tried first, one lookup per
//     session per pass — so no session's backlog delays another's;
//   • reported to the owner once it is still unpaid alertAfterMs after the first
//     notify, from the stored state, whether the retries or the sweep got
//     anywhere or not.
//
// The sweep reads the terminal's recent transactions and matches each row to a
// session by the token it carries — row-driven, so it does not depend on how
// many sessions exist — reaching back to the oldest pending check.
//
// A pass never overlaps itself: a retry pass or sweep still running when the
// next tick comes makes that tick a no-op, so a slow Reports API cannot stack up
// lookups or burn attempts.
//
// Everything that touches the store, Tranzila or the owner is injected, so the
// rules can be tested on their own (tests/unit/tranzila-reconcile.test.js).

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
  // { list() -> [{ token, pending }] for UNPAID sessions with a check (live objects),
  //   get(token) -> { pending } for a real session, else null,
  //   set(token, pending | null) without saving, save() }
  store,
  lookup, // async (index) => tx | null; throws on a transport error or timeout
  listRecent, // async ({ startDate, endDate }) => tx[]
  tokenCandidates, // (tx) => string[], values on the row shaped like a session token
  isSettled, // (token) => boolean, the purchase is paid or the session is gone
  handle, // async (token, tx, { openAtFirst }) => 'settled' | 'rejected' | 'used' | 'gone'
  alertStale, // (tokens) => void, ONE grouped owner alert
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  alertAfterMs = 10 * 60 * 1000,
  maxLookupsPerRun = 20,
  sweepWindowMs = 2 * 60 * 60 * 1000,
  maxLookbackMs = 7 * 24 * 60 * 60 * 1000,
  replaceAfterMs = 10 * 1000,
  now = Date.now,
} = {}) {
  let retrying = false;
  let sweeping = false;
  // Rows the sweep has already decided for a session, so a rejected row is not
  // re-decided (and re-logged) on every sweep. Bounded.
  const decided = new Set();
  function rememberDecided(key) {
    decided.add(key);
    if (decided.size > 5000) decided.delete(decided.values().next().value);
  }

  // A notify we could not check. `openAtFirst` is whether the session could
  // still belong to a live pay window when the notify FIRST arrived; kept, so a
  // later decision judges the charge by that moment and not by the retry's.
  function recordPending(token, index, { openAtFirst = null, at = now() } = {}) {
    if (!token || index == null || index === '' || isSettled(token)) return false;
    const known = store.get(token);
    if (!known) return false;
    const key = String(index);
    const prev = known.pending;
    if (prev && prev.index === key) return true;
    // The newest index replaces the old one, but at most once per
    // replaceAfterMs: alternating invented indexes must not become a store write
    // per request.
    if (prev && at - (prev.replaced_at || 0) < replaceAfterMs) return false;
    store.set(token, {
      index: key,
      since: prev ? prev.since : at,
      open_at_first: prev ? prev.open_at_first : openAtFirst,
      attempts: 0,
      next_at: at + retryDelaysMs[0],
      last_try_at: prev ? prev.last_try_at || 0 : 0,
      alerted: prev ? !!prev.alerted : false,
      gave_up: false,
      replaced_at: at,
    });
    store.save();
    return true;
  }

  // The notify decided a transaction on the spot: the session's pending check
  // goes if it was for that index, or the purchase is now paid.
  function resolveNotified(token, index) {
    const known = store.get(token);
    if (!known || !known.pending) return;
    if (isSettled(token) || known.pending.index === String(index)) {
      store.set(token, null);
      store.save();
    }
  }

  // Every stored check still unpaid alertAfterMs after its first notify, not yet
  // reported. Marks them reported.
  function takeStale(at) {
    const stale = [];
    for (const { token, pending } of store.list()) {
      if (pending.alerted || isSettled(token)) continue;
      if (at - pending.since >= alertAfterMs) {
        pending.alerted = true;
        stale.push(token);
      }
    }
    return stale;
  }

  async function runDue(at = now()) {
    if (retrying) return { skipped: true };
    retrying = true;
    try {
      const due = store
        .list()
        .filter((e) => !isSettled(e.token) && !e.pending.gave_up && e.pending.next_at <= at)
        .sort(
          (a, b) =>
            (a.pending.last_try_at || 0) - (b.pending.last_try_at || 0) ||
            a.pending.since - b.pending.since
        )
        .slice(0, maxLookupsPerRun);
      for (const { token, pending } of due) {
        pending.last_try_at = at;
        let tx = null;
        try {
          tx = await lookup(pending.index);
        } catch {
          tx = null;
        }
        const live = store.get(token);
        // Cleared, or replaced by a newer index, while the lookup was out.
        if (!live || live.pending !== pending) continue;
        if (tx) {
          await handle(token, tx, { openAtFirst: pending.open_at_first });
          store.set(token, null);
          continue;
        }
        pending.attempts += 1;
        if (pending.attempts >= retryDelaysMs.length) pending.gave_up = true;
        else pending.next_at = at + retryDelaysMs[pending.attempts];
      }
      const stale = takeStale(at);
      // A check the retries gave up on stays until it has been reported.
      for (const { token, pending } of store.list()) {
        if (pending.gave_up && pending.alerted) store.set(token, null);
      }
      if (due.length || stale.length) store.save();
      if (stale.length) alertStale(stale);
      return { looked: due.length, stale: stale.length };
    } finally {
      retrying = false;
    }
  }

  async function sweep(at = now()) {
    if (sweeping) return { skipped: true };
    sweeping = true;
    try {
      const oldest = store
        .list()
        .filter((e) => !isSettled(e.token))
        .map((e) => e.pending.since);
      const from = Math.max(at - maxLookbackMs, Math.min(at - sweepWindowMs, ...oldest));
      let rows = [];
      let failure = null;
      try {
        rows = (await listRecent({ startDate: israelDate(from), endDate: israelDate(at) })) || [];
      } catch (e) {
        failure = e;
      }
      let settled = 0;
      let changed = false;
      for (const tx of rows) {
        for (const token of tokenCandidates(tx) || []) {
          const key = tx.index + ':' + token;
          if (decided.has(key) || isSettled(token)) continue;
          const known = store.get(token);
          if (!known) continue;
          const pending = known.pending;
          const outcome = await handle(token, tx, {
            openAtFirst: pending ? pending.open_at_first : null,
          });
          rememberDecided(key);
          if (outcome === 'settled') settled += 1;
          if (pending && (isSettled(token) || pending.index === String(tx.index))) {
            store.set(token, null);
            changed = true;
          }
        }
      }
      // Reported even when the Reports API is down: the stored checks say what is
      // still unpaid, and that does not need Tranzila to answer.
      const stale = takeStale(at);
      if (changed || stale.length) store.save();
      if (stale.length) alertStale(stale);
      if (failure) throw failure;
      return { rows: rows.length, settled };
    } finally {
      sweeping = false;
    }
  }

  return { recordPending, resolveNotified, runDue, sweep };
}

module.exports = { createReconciler, positiveNumber, israelDate, DEFAULT_RETRY_DELAYS_MS };
