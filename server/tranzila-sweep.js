// Settles Tranzila payments from the only thing that proves a charge: the
// terminal's own transaction rows in the Reports API.
//
// Tranzila's notify is unsigned and nothing documents it being retried, so it
// decides nothing. A notify for a real, unpaid session only ASKS for a sweep
// (server/index.js), and the sweep does all the work:
//
//   • it reads every row since the last sweep (a persisted `last_swept_at`,
//     minus an overlap), following every page;
//   • each row is matched to a pay session by the token it carries, verified
//     (DEBIT allowlist, amount, currency, token) and settled idempotently;
//   • an approved row that does not settle — a hold, a wrong amount, a second
//     charge on a paid purchase, or a debit carrying no session token at all — is
//     queued for the owner. The queue and the set of indexes already reported are
//     persisted, and an index is marked reported only once an alert has really
//     gone out, so a restart or a full alert cap loses nothing.
//
// Invented indexes are not rows, so a flood of notifies creates no lookups, no
// per-session state and no alerts: at most one sweep per `minSpacingMs`.
// Restart safety is `last_swept_at` plus the overlap; there is no queue of
// per-payment work to lose.
//
// Everything that touches the store, Tranzila or the owner is injected, so the
// rules can be tested on their own (tests/unit/tranzila-sweep.test.js).

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

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function createSweeper({
  // { get() -> live { last_swept_at, last_saved_at, alerted: {index: ms}, alert_queue: [] },
  //   save() }
  state,
  listRows, // async ({ startDate, endDate }) => tx[]; throws on failure
  decide, // (tx) => { outcome: 'settled' | 'used' | 'ignored' | 'rejected', alert? }
  deliver, // async (items) => true only when the owner was really told
  hasRecentUnpaid, // (atMs) => an unpaid Tranzila session was opened recently
  // How far before the last sweep the next one reads again: report lag, clock
  // skew between us and Tranzila, and the Israel-date boundary (the Reports query
  // is by date) must all fit inside it.
  overlapMs = HOUR,
  bootstrapMs = 2 * DAY,
  // Sweeps that keep failing mean nothing settles: tell the owner once they have
  // failed for this long, again at most every failRepeatMs, and once recovered.
  failAlertAfterMs = 15 * MIN,
  failRepeatMs = 3 * HOUR,
  maxLookbackMs = 30 * DAY,
  minSpacingMs = 10 * 1000,
  activeEveryMs = MIN,
  idleEveryMs = 10 * MIN,
  saveEveryMs = 10 * MIN,
  keepAlertedMs = 90 * DAY,
  now = Date.now,
  setTimer = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t.unref) t.unref();
    return t;
  },
  onError = (e) => console.error('[tranzila] sweep failed: ' + ((e && e.message) || e)),
} = {}) {
  let running = null;
  let lastStartedAt = 0;
  let wanted = false;
  let timer = null;
  let firing = null;

  function stateNow() {
    const st = state.get();
    if (!st.alerted || typeof st.alerted !== 'object') st.alerted = {};
    if (!Array.isArray(st.alert_queue)) st.alert_queue = [];
    return st;
  }

  // Send everything queued. Marked reported, and removed from the queue, only
  // when the owner was actually told; otherwise it stays for the next sweep.
  async function flush(at) {
    const st = stateNow();
    if (!st.alert_queue.length) return false;
    const batch = st.alert_queue.slice();
    let delivered = false;
    try {
      delivered = await deliver(batch);
    } catch {
      delivered = false;
    }
    if (!delivered) return false;
    for (const item of batch) st.alerted[item.index] = at;
    st.alert_queue = st.alert_queue.filter((q) => !batch.includes(q));
    for (const [index, when] of Object.entries(st.alerted)) {
      if (at - Number(when) > keepAlertedMs) delete st.alerted[index];
    }
    state.save();
    return true;
  }

  // A sweep that could not read the terminal. Persisted, so the clock survives a
  // restart; one alert once it has lasted failAlertAfterMs, then at most one per
  // failRepeatMs while it goes on.
  function noteFailure(st, at, e) {
    if (!st.failing_since) {
      st.failing_since = at;
      state.save();
    }
    const since = Number(st.failing_since);
    if (at - since < failAlertAfterMs) return;
    if (st.failure_alerted_at && at - Number(st.failure_alerted_at) < failRepeatMs) return;
    st.failure_alerted_at = at;
    st.alert_queue.push({
      kind: 'sweep_failing',
      index: 'sweep-failing-' + at,
      since,
      error: String((e && e.message) || e).slice(0, 200),
      queued_at: at,
    });
    state.save();
  }

  // The first sweep that works again after a failure the owner was told about.
  function noteRecovery(st, at) {
    if (!st.failing_since) return;
    const since = Number(st.failing_since);
    const told = !!st.failure_alerted_at;
    delete st.failing_since;
    delete st.failure_alerted_at;
    if (told) {
      st.alert_queue.push({
        kind: 'sweep_recovered',
        index: 'sweep-recovered-' + at,
        since,
        queued_at: at,
      });
    }
    state.save();
  }

  async function run(at) {
    lastStartedAt = at;
    const st = stateNow();
    try {
      const since = st.last_swept_at ? Number(st.last_swept_at) - overlapMs : at - bootstrapMs;
      const from = Math.max(at - maxLookbackMs, Math.min(since, at));
      let rows;
      try {
        rows = (await listRows({ startDate: israelDate(from), endDate: israelDate(at) })) || [];
      } catch (e) {
        noteFailure(st, at, e);
        throw e;
      }
      noteRecovery(st, at);
      let settled = 0;
      let queued = 0;
      for (const tx of rows) {
        const d = decide(tx) || {};
        if (d.outcome === 'settled') settled += 1;
        if (d.alert) {
          const index = String(tx.index);
          if (!st.alerted[index] && !st.alert_queue.some((q) => q.index === index)) {
            st.alert_queue.push({ ...d.alert, index, queued_at: at });
            queued += 1;
          }
        }
      }
      st.last_swept_at = at;
      // A quiet sweep writes the store at most every saveEveryMs: last_swept_at
      // is a lower bound, and the overlap covers what an older value misses.
      if (settled || queued || !st.last_saved_at || at - Number(st.last_saved_at) >= saveEveryMs) {
        st.last_saved_at = at;
        state.save();
      }
      return { rows: rows.length, settled, queued };
    } finally {
      // Queued alerts go out even when Tranzila could not be read this time.
      await flush(at);
    }
  }

  // One sweep at a time. A call while one runs waits for it and does not start
  // another.
  async function sweep(at = now()) {
    if (running) {
      await running.catch(() => {});
      return { skipped: true };
    }
    running = run(at);
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  async function fire() {
    timer = null;
    if (!wanted) return;
    if (running) await running.catch(() => {});
    const wait = lastStartedAt + minSpacingMs - now();
    if (wait > 0) {
      schedule(wait);
      return;
    }
    wanted = false;
    try {
      await sweep(now());
    } catch (e) {
      onError(e);
    }
    if (wanted) schedule(Math.max(0, lastStartedAt + minSpacingMs - now()));
  }

  function schedule(wait) {
    if (timer) return;
    timer = setTimer(() => {
      firing = fire().finally(() => {
        firing = null;
      });
    }, wait);
  }

  // A notify's request: at most one sweep starts per minSpacingMs however many
  // arrive, and a request during a sweep is served by the next one.
  function request() {
    wanted = true;
    schedule(Math.max(0, lastStartedAt + minSpacingMs - now()));
  }

  // The periodic cadence: often while a buyer may be paying, rarely otherwise.
  function tick(at = now()) {
    const every = hasRecentUnpaid(at) ? activeEveryMs : idleEveryMs;
    if (running || at - lastStartedAt < every) return Promise.resolve({ skipped: true });
    return sweep(at);
  }

  // For tests: resolves once no sweep is running, firing or scheduled.
  async function whenIdle() {
    for (let i = 0; i < 10000; i++) {
      if (running) await running.catch(() => {});
      else if (firing) await firing;
      else if (timer) await new Promise((r) => setTimeout(r, 2));
      else return;
    }
  }

  return { sweep, request, tick, whenIdle };
}

module.exports = { createSweeper, positiveNumber, israelDate };
