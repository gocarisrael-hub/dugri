'use strict';

// wa-guard.js — the REACHOUT circuit breaker for the WhatsApp bot.
//
// Background (this module exists because of a real incident): on 2026-07-27 the
// bot's WhatsApp number was banned. The cause was not message VOLUME inside
// groups — it was REACHOUT: creating groups that add a number which never
// messaged us, and DMing buyers cold. WhatsApp restricted the account
// (`429 … account_reachout_restricted`), then deauthorized the channel (401),
// then dropped it to QR. Crucially, messaging into EXISTING groups kept working
// the whole time. That asymmetry is the design of this module:
//
//   • REACHOUT operations (create-group-with-participants, DM a cold number) are
//     gated: they stop on the first restriction signal and are capped per day.
//   • IN-GROUP operations (a send to a "…@g.us" chat) are NEVER gated. They were
//     never the problem, and blocking them would silently break live orders.
//
// The breaker is STICKY and persisted: once tripped it stays tripped across
// restarts until the owner clears it from the admin page. That is deliberate —
// the incident notes record that retrying into an account restriction is what
// escalates a temporary restriction into a permanent ban, and an auto-reset
// timer would do exactly that unattended.
//
// Same persistence posture as server/wa-state.js: an in-memory object loaded at
// boot, written atomically (tmp + rename) under DATA_DIR, and every helper is
// synchronous and NEVER throws — a failed disk write is swallowed and the
// in-memory state stays authoritative. A guard that throws on the send path
// would be worse than no guard.
const fs = require('fs');
const path = require('path');
const { tzParts } = require('./reminders');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'whatsapp-guard.json');

// How many reachouts per Jerusalem day before the cap holds the rest back. A
// deliberately small number: real order volume is a handful a day, so this only
// ever bites on a runaway loop, a backlog replay, or a second instance sharing
// the channel — exactly the shapes that burn a number. Owner-overridable via
// settings (wa.reachout_daily_max); the env var is the deploy-time floor.
const DEFAULT_DAILY_MAX = Number(process.env.WHAPI_DAILY_REACHOUT_MAX || 5);

// Substrings that mark a response as an ACCOUNT RESTRICTION rather than an
// ordinary rate limit. The difference is everything: a bare 429 ("too many
// requests") means wait, while a 429 whose details read
// "account_reachout_restricted" means WhatsApp has restricted this NUMBER from
// contacting people — no amount of waiting or retrying helps, and retrying makes
// it worse. Matched case-insensitively against the flattened error body.
const RESTRICTION_MARKERS = [
  'reachout',
  'restrict',
  'banned',
  'blocked',
  'not_authorized',
  'unauthorized',
  'spam',
];

function emptyState() {
  return { version: 1, tripped: false, tripped_at: null, reason: '', day: '', count: 0 };
}

let _state = load();
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const s = emptyState();
      s.tripped = !!raw.tripped;
      s.tripped_at = raw.tripped_at || null;
      s.reason = String(raw.reason || '');
      s.day = String(raw.day || '');
      s.count = Number(raw.count) || 0;
      return s;
    }
  } catch {
    /* missing / unreadable — start clean */
  }
  return emptyState();
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(_state, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {
    /* best-effort persistence — the in-memory state stays authoritative */
  }
}

// The Jerusalem calendar day for `at`, used to key the daily counter. Israel
// time (not UTC) so the cap resets when the owner's day does. Never throws.
function dayKey(at) {
  const ms = at == null ? Date.now() : Number(at);
  try {
    return tzParts(Number.isFinite(ms) ? ms : Date.now()).date;
  } catch {
    return '';
  }
}

// Roll the counter over when the calendar day changed. Called on every read and
// write of the count so a stale day can never leak yesterday's total into today.
function rollDay(at) {
  const today = dayKey(at);
  if (_state.day !== today) {
    _state.day = today;
    _state.count = 0;
    return true;
  }
  return false;
}

// The owner-configured daily cap, falling back to the env/default. Read through
// the settings module lazily (NOT at require time) so a settings write takes
// effect without a restart, and injectable for tests. A missing/garbage value
// falls back rather than throwing — this runs on the send path.
function dailyMax(opts = {}) {
  const store = opts.settings || require('./settings');
  try {
    const v = store.get('wa', 'reachout_daily_max');
    if (Number.isInteger(v) && v >= 0) return v;
  } catch {
    /* fall through to the default */
  }
  return Number.isInteger(DEFAULT_DAILY_MAX) && DEFAULT_DAILY_MAX >= 0 ? DEFAULT_DAILY_MAX : 5;
}

// Trip the breaker: all reachout stops until the owner clears it. Idempotent —
// re-tripping keeps the ORIGINAL reason and timestamp, because the first signal
// is the diagnostic one (the later 401/QR are downstream symptoms of it).
function trip(reason, at) {
  if (_state.tripped) return snapshot();
  _state.tripped = true;
  _state.tripped_at = new Date(at == null ? Date.now() : at).toISOString();
  _state.reason = String(reason == null ? '' : reason).slice(0, 300);
  save();
  console.error(
    '[wa-guard] REACHOUT BREAKER TRIPPED — no new groups or cold DMs will be sent. ' +
      'Reason: ' +
      _state.reason +
      '. Messaging into existing groups is unaffected. Clear it from the admin page ' +
      'only after confirming with WhatsApp that the number is in good standing.'
  );
  return snapshot();
}

// Clear the breaker (owner action from the admin page) and start the day's count
// fresh, so a clear is a genuine reset rather than a resume into a spent budget.
function clear(at) {
  _state.tripped = false;
  _state.tripped_at = null;
  _state.reason = '';
  _state.day = dayKey(at);
  _state.count = 0;
  save();
  return snapshot();
}

// A non-secret view of the breaker for the admin UI and the status endpoint.
function snapshot(opts = {}) {
  const at = opts.now;
  const today = dayKey(at);
  const count = _state.day === today ? _state.count : 0;
  const max = dailyMax(opts);
  return {
    tripped: _state.tripped,
    trippedAt: _state.tripped_at,
    reason: _state.reason,
    day: today,
    count,
    max,
    remaining: Math.max(0, max - count),
  };
}

// May we perform ONE reachout right now? Returns { ok:true } or { ok:false,
// reason } where reason is 'tripped' (breaker open — owner must clear) or
// 'daily_cap' (budget spent, resets at midnight Israel time). Pure-ish: reads
// state and rolls the day, never sends anything.
function canReachOut(opts = {}) {
  if (_state.tripped) {
    return { ok: false, reason: 'tripped', detail: _state.reason, trippedAt: _state.tripped_at };
  }
  const at = opts.now;
  if (rollDay(at)) save();
  const max = dailyMax(opts);
  if (_state.count >= max) {
    return { ok: false, reason: 'daily_cap', detail: 'daily reachout cap reached', max };
  }
  return { ok: true };
}

// Record that one reachout was ATTEMPTED. Called on attempt (not on success) —
// a delivered-but-not-ok response is exactly the shape that burned us before, so
// the budget must be spent by the attempt itself, never by its reported result.
function recordReachout(at) {
  rollDay(at);
  _state.count = (Number(_state.count) || 0) + 1;
  save();
  return _state.count;
}

// Flatten the interesting parts of a Whapi error body to one lowercase string we
// can scan for restriction markers. Only the error fields — never the whole
// payload, which can echo participant phone numbers into logs.
function errorText(data) {
  if (!data || typeof data !== 'object') return '';
  const err = data.error && typeof data.error === 'object' ? data.error : null;
  const parts = [
    err ? err.details : '',
    err ? err.message : '',
    err ? err.code : '',
    typeof data.error === 'string' ? data.error : '',
    typeof data.message === 'string' ? data.message : '',
    typeof data.status === 'string' ? data.status : '',
  ];
  return parts
    .map((p) => (typeof p === 'string' ? p : p == null ? '' : JSON.stringify(p)))
    .join(' ')
    .toLowerCase();
}

// Classify one Whapi result (the { ok, status, data, error } shape whapiRequest
// returns). Returns:
//   'restricted' — an account restriction / deauthorization: TRIP the breaker.
//   'ratelimit'  — a bare 429: back off, but do NOT trip (it is not a ban).
//   'ok'         — anything else, including ordinary failures and timeouts.
// A transport error (no HTTP status) is never a restriction — a DNS blip must
// not disarm the bot.
function classify(result) {
  if (!result || result.ok) return 'ok';
  if (result.skipped) return 'ok';
  const status = Number(result.status) || 0;
  const text = errorText(result.data);
  const marked = RESTRICTION_MARKERS.some((m) => text.includes(m));
  // 401/403 mean the channel is no longer authorized to act — the second stage
  // of the ban signature. Trip regardless of body text.
  if (status === 401 || status === 403) return 'restricted';
  // A 429 is only a restriction when its details SAY so. Whapi sends the
  // machine-readable cause in error.details ("account_reachout_restricted");
  // a plain "too many requests" is an ordinary rate limit.
  if (status === 429) return marked ? 'restricted' : 'ratelimit';
  // Any other status whose body explicitly names a ban/block/restriction.
  if (status && marked) return 'restricted';
  return 'ok';
}

// Inspect a Whapi result and trip the breaker if it carries a restriction
// signal. Safe to call on EVERY response, including in-group sends and health
// probes — the restriction usually shows up on the reachout call, but catching
// it anywhere is strictly better. Returns the classification. Never throws.
function noteResult(result, context) {
  try {
    const verdict = classify(result);
    if (verdict === 'restricted') {
      const status = (result && result.status) || 0;
      const detail = errorText(result && result.data).trim();
      trip(
        (context ? context + ': ' : '') + 'whapi ' + status + (detail ? ' — ' + detail : ''),
        Date.now()
      );
    }
    return verdict;
  } catch {
    return 'ok';
  }
}

// Is this chat id a GROUP (so a send to it is in-group traffic, not a reachout)?
// WhatsApp group ids end with "@g.us". Anything else — a bare phone, a
// "…@s.whatsapp.net" JID — is a 1:1 chat and therefore a reachout.
function isGroupChat(to) {
  return String(to == null ? '' : to)
    .trim()
    .endsWith('@g.us');
}

module.exports = {
  canReachOut,
  recordReachout,
  noteResult,
  classify,
  trip,
  clear,
  snapshot,
  isGroupChat,
  dailyMax,
  _file: FILE,
  DEFAULT_DAILY_MAX,
  RESTRICTION_MARKERS,
};
