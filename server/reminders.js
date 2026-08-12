'use strict';

// Owner-managed reminder list — a flexible replacement for the fixed daily/quiet
// WhatsApp triggers. Each reminder is anchored to a COLLECTION (so it works for
// EMAIL too, not only a WhatsApp group) and fires at most `max_total` times over
// its lifetime, spaced by `every_days`, inside an hour `window`, optionally only
// on certain `weekdays` and/or only when the collection has gone quiet
// (`only_if_idle_hours`). Each reminder can go out over email, WhatsApp, or both.
//
// This module is PURE (no I/O). `remindersDue()` takes the reminder list, the
// per-collection send state, and precomputed "now"/activity facts and returns
// which reminders are due right now. Persisting the send state (on the collection)
// and actually delivering (notify / whatsapp) is the caller's job. Keeping the
// scheduling rules here, isolated and pure, makes them exhaustively testable and
// is what prevents another "fires every hour" spam loop.

const DAY_MS = 24 * 3600 * 1000;
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isIntInRange = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

// Jerusalem (or opts.tz) parts of an instant: { date:'YYYY-MM-DD', hour:0..23,
// weekday:0..6 (0=Sun) }. Uses Intl so DST is handled correctly.
function tzParts(nowMs, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(nowMs))) parts[p.type] = p.value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some engines render midnight as '24'
  const weekday = Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, parts.weekday)
    ? WEEKDAY_INDEX[parts.weekday]
    : 0;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour, weekday };
}

// The seed list (used as the settings default). One morning "add words" reminder
// over WhatsApp, at most 3 times total, only when the group's been quiet ~20h —
// a safe, capped default, unlike the old "every day forever" behaviour.
const DEFAULT_REMINDERS = [
  {
    id: 'morning',
    enabled: true,
    text: 'בוקר טוב! יש עוד זמן להוסיף מילים על {honoree}:\n{link}',
    channels: { email: false, whatsapp: true },
    every_days: 1,
    weekdays: null,
    only_if_idle_hours: 20,
    window: [8, 21],
    max_total: 3,
  },
];

// Validate an owner-supplied reminder list. Returns an error message string, or
// null when the whole list is acceptable. Mirrors settings.validateValue's posture
// — a bad write must never reach the scheduler. Kept here as the single source of
// truth so both settings.set() and the admin route can call it.
function validateReminders(list) {
  if (!Array.isArray(list)) return 'reminders must be an array';
  if (list.length > 20) return 'too many reminders (max 20)';
  const ids = new Set();
  for (const r of list) {
    if (!isPlainObject(r)) return 'each reminder must be an object';
    if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(r.id)) {
      return 'reminder id must be lowercase-kebab, 1..31 chars';
    }
    if (ids.has(r.id)) return 'duplicate reminder id: ' + r.id;
    ids.add(r.id);
    if (typeof r.enabled !== 'boolean') return 'reminder.enabled must be a boolean';
    if (typeof r.text !== 'string' || !r.text.trim())
      return 'reminder.text must be a non-empty string';
    const ch = r.channels;
    if (!isPlainObject(ch) || typeof ch.email !== 'boolean' || typeof ch.whatsapp !== 'boolean') {
      return 'reminder.channels must be { email:boolean, whatsapp:boolean }';
    }
    if (!ch.email && !ch.whatsapp) return 'reminder must enable at least one channel';
    if (!Number.isInteger(r.every_days) || r.every_days < 1) {
      return 'reminder.every_days must be an integer >= 1';
    }
    if (!Number.isInteger(r.max_total) || r.max_total < 1) {
      return 'reminder.max_total must be an integer >= 1';
    }
    if (
      !Array.isArray(r.window) ||
      r.window.length !== 2 ||
      !isIntInRange(r.window[0], 0, 23) ||
      !isIntInRange(r.window[1], 1, 24) ||
      r.window[0] >= r.window[1]
    ) {
      return 'reminder.window must be [start,end] with 0<=start<end<=24';
    }
    if (r.weekdays != null) {
      if (!Array.isArray(r.weekdays) || !r.weekdays.every((d) => isIntInRange(d, 0, 6))) {
        return 'reminder.weekdays must be null or an array of integers 0..6';
      }
    }
    if (
      r.only_if_idle_hours != null &&
      (!Number.isInteger(r.only_if_idle_hours) || r.only_if_idle_hours < 1)
    ) {
      return 'reminder.only_if_idle_hours must be null or an integer >= 1';
    }
  }
  return null;
}

// WHEN CHASING STOPS. Two different debts, so two different answers — both pure,
// both applied by every scheduler that chases (see runReminderListScan,
// collectionsDueForReminder and collectionsDueForPaymentReminder).
//
// The rule the owner asked for: an order that is READY has been made and handed
// over, and a list that is CLOSED has its words. Carrying on chasing either is
// asking a customer for something they already gave — and once the deck is at the
// printer, "add a few more words" is worse than noise: it is an offer we cannot
// honour.
//
// A cancelled order is nobody's debt.

// Words. Stopped once the list is closed or expired (the words are in), once the
// deck has gone to the printer or come back ready (too late to add any), or once
// the order is cancelled.
function wordRemindersStopped(c) {
  if (!c) return true;
  if (c.cancelled) return true;
  if (c.status && c.status !== 'open') return true;
  const o = c.order;
  return !!(o && (o.sent_to_print_at || o.ready_at));
}

// Money. Stopped when the order is ready — she has already handed the game over,
// and an automated "you still owe us" after that is hers to send, not ours — or
// when the order is cancelled. NOT stopped by closing the word list: words and
// payment are separate debts, and a buyer can (and often does) finish her words
// before she pays.
function paymentRemindersStopped(c) {
  if (!c) return true;
  if (c.cancelled) return true;
  return !!(c.order && c.order.ready_at);
}

// Which reminders are due for ONE collection right now. Pure.
//   opts.reminders      — the reminder list (settings value)
//   opts.nowMs          — current time in ms
//   opts.tz             — IANA tz (default Asia/Jerusalem)
//   opts.sentState      — { [id]: { count:int, last_at:iso|null } } for THIS collection
//   opts.lastActivityMs — ms of the collection's last word-add (or creation);
//                         used by only_if_idle_hours. When unknown/NaN, the group
//                         is treated as idle (the reminder is allowed).
// Returns [{ id, text, channels:{email,whatsapp} }] — the reminders to send now.
// The caller decides delivery per channel and records the send (bump count +
// last_at) so max_total / every_days advance.
function remindersDue(opts = {}) {
  const list = Array.isArray(opts.reminders) ? opts.reminders : [];
  const nowMs = Number(opts.nowMs);
  if (!Number.isFinite(nowMs)) return [];
  const state = isPlainObject(opts.sentState) ? opts.sentState : {};
  const lastActivityMs = Number(opts.lastActivityMs);
  const { hour, weekday } = tzParts(nowMs, opts.tz);
  const due = [];
  for (const r of list) {
    if (!isPlainObject(r) || !r.enabled) continue;
    const id = String(r.id || '');
    if (!id) continue;

    // Hour window [start,end).
    const win = Array.isArray(r.window) && r.window.length === 2 ? r.window : [0, 24];
    if (hour < win[0] || hour >= win[1]) continue;

    // Specific weekdays (null/empty = any day).
    if (Array.isArray(r.weekdays) && r.weekdays.length && !r.weekdays.includes(weekday)) continue;

    const st = isPlainObject(state[id]) ? state[id] : {};
    const count = Number(st.count) || 0;

    // Lifetime cap PER collection.
    const max = Number.isFinite(r.max_total) ? r.max_total : Infinity;
    if (count >= max) continue;

    // Spacing: at least every_days between sends. A never-sent reminder (no
    // last_at) is due immediately (subject to the window/weekday/idle gates).
    const everyDays = Number.isInteger(r.every_days) && r.every_days >= 1 ? r.every_days : 1;
    const lastAt = st.last_at ? Date.parse(st.last_at) : NaN;
    if (Number.isFinite(lastAt) && nowMs - lastAt < everyDays * DAY_MS) continue;

    // Only when the collection has gone quiet, if configured.
    if (Number.isInteger(r.only_if_idle_hours) && r.only_if_idle_hours > 0) {
      if (Number.isFinite(lastActivityMs)) {
        if (nowMs - lastActivityMs < r.only_if_idle_hours * 3600 * 1000) continue;
      }
      // Unknown activity -> treat as idle (allow), matching the old quiet default.
    }

    const ch = isPlainObject(r.channels) ? r.channels : {};
    due.push({
      id,
      text: String(r.text || ''),
      channels: { email: !!ch.email, whatsapp: !!ch.whatsapp },
    });
  }
  return due;
}

module.exports = {
  DEFAULT_REMINDERS,
  validateReminders,
  remindersDue,
  wordRemindersStopped,
  paymentRemindersStopped,
  tzParts,
};
