'use strict';

// sms.js — the SMS OUTBOX, for an SMS gateway app running on the owner's own
// Android phone.
//
// WHY AN OUTBOX AND NOT A SEND. The phone sits on home wifi behind a router: it
// has no public address, so the server cannot call it. It calls the server —
// polls this outbox, sends whatever is waiting from its own SIM, and reports
// back. That inverts the direction and is the whole reason this design works
// without port forwarding, a tunnel, or a third party's cloud in the middle.
//
// It also means a message can sit here for a while: the phone might be asleep,
// off, or off wifi. Two consequences, both handled below:
//   • EXPIRY. "המשחק מוכן" delivered four days late is worse than not sent — it
//     reads as a business that lost track. A message not collected within its
//     window is dropped, and says so, rather than going out stale.
//   • LEASE, not delete-on-read. A poll marks a message as taken; the phone
//     confirms after the SIM accepts it. A poll that never comes back (the app
//     was killed mid-send) returns the message to the queue when the lease runs
//     out, so a message is never silently lost by being read once.
//
// AT-LEAST-ONCE, deliberately. A confirmation lost on the way back means one
// message sent twice; a message dropped means a customer never told her game is
// ready. Of the two, the duplicate is the one to prefer — but `dedupe_key` makes
// it rare: one key per (order, event), so a second enqueue for the same event is
// a no-op while the first is still pending or already sent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'sms-outbox.json');

// How long a message may wait for the phone before it is not worth sending.
const DEFAULT_TTL_MS = 12 * 3600 * 1000;
// How long a polled message stays "taken" before it returns to the queue.
const LEASE_MS = 5 * 60 * 1000;
// The queue is a store on a volume, not a mail server: bound it so a phone that
// never comes back cannot grow the file without limit. Oldest DONE messages go
// first; pending ones are never evicted by this.
const MAX_KEPT = 500;
// SMS is charged and read by a person; a runaway template must not become a
// multi-part novel.
const MAX_TEXT = 480;

let _store = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && Array.isArray(raw.messages)) return { messages: raw.messages };
  } catch {
    /* missing or corrupt — an empty queue is the safe start */
  }
  return { messages: [] };
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
    return true;
  } catch (e) {
    console.warn('[sms] save failed:', e && e.message ? e.message : e);
    return false;
  }
}

// An Israeli mobile in the form a phone's SMS app dials: local 0XXXXXXXXX. The
// gateway sends from a SIM in Israel, so local is the form that always works —
// +972 does too, but only if the app normalises it, and not every one does.
function ilMobile(phone) {
  const digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (!digits) return '';
  let s = digits;
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('972')) s = '0' + s.slice(3).replace(/^0+/, '');
  else if (!s.startsWith('0')) s = '0' + s;
  // A plausible IL mobile only: 05X + 7 more. A landline or junk soft-fails to
  // '' so the queue never holds a message that cannot be delivered.
  return /^05\d{8}$/.test(s) ? s : '';
}

// Queue one message. Returns the record, or null when there is nothing to send
// (no usable number, empty text) or when this (order, event) is already queued or
// done — the dedupe that keeps a double-press from double-texting a customer.
function enqueue({ to, text, event, collection_id, ttlMs, now } = {}) {
  const phone = ilMobile(to);
  const body = String(text == null ? '' : text)
    .trim()
    .slice(0, MAX_TEXT);
  if (!phone || !body) return null;
  const at = Number.isFinite(now) ? now : Date.now();
  const dedupe = collection_id && event ? String(collection_id) + ':' + String(event) : '';
  if (dedupe && _store.messages.some((m) => m.dedupe_key === dedupe && m.state !== 'failed')) {
    return null;
  }
  const msg = {
    id: crypto.randomUUID(),
    to: phone,
    text: body,
    event: String(event || 'manual'),
    collection_id: collection_id || null,
    dedupe_key: dedupe || null,
    state: 'pending',
    created_at: new Date(at).toISOString(),
    expires_at: new Date(at + (Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS)).toISOString(),
    taken_at: null,
    sent_at: null,
    error: null,
    attempts: 0,
  };
  _store.messages.push(msg);
  prune();
  save();
  return msg;
}

// Expire what waited too long, and return anything whose lease ran out to the
// queue. Called on every read so the queue is always answered from a current
// view, with no timer to keep alive.
function reconcile(now) {
  const at = Number.isFinite(now) ? now : Date.now();
  let changed = false;
  for (const m of _store.messages) {
    if (m.state === 'pending' || m.state === 'taken') {
      if (Date.parse(m.expires_at) <= at) {
        m.state = 'expired';
        m.error = 'לא נאסף בזמן — לא נשלח';
        changed = true;
        continue;
      }
    }
    if (m.state === 'taken' && Date.parse(m.taken_at || 0) + LEASE_MS <= at) {
      // The phone took it and never came back — it may or may not have sent. Back
      // to the queue: a duplicate SMS beats a customer who was never told.
      m.state = 'pending';
      m.taken_at = null;
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}

// Keep the file bounded, dropping the oldest FINISHED messages first.
function prune() {
  if (_store.messages.length <= MAX_KEPT) return;
  const done = (m) => m.state === 'sent' || m.state === 'failed' || m.state === 'expired';
  const finished = _store.messages
    .filter(done)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const drop = new Set();
  let over = _store.messages.length - MAX_KEPT;
  for (const m of finished) {
    if (over <= 0) break;
    drop.add(m.id);
    over -= 1;
  }
  if (drop.size) _store.messages = _store.messages.filter((m) => !drop.has(m.id));
}

// What the phone should send now. Leases each one — a second poll (the app
// restarting, two phones by mistake) will not hand out the same message again
// until the lease expires.
function claim({ limit = 10, now } = {}) {
  const at = Number.isFinite(now) ? now : Date.now();
  reconcile(at);
  const out = [];
  for (const m of _store.messages) {
    if (out.length >= limit) break;
    if (m.state !== 'pending') continue;
    m.state = 'taken';
    m.taken_at = new Date(at).toISOString();
    m.attempts += 1;
    out.push({ id: m.id, to: m.to, text: m.text });
  }
  if (out.length) save();
  return out;
}

// The phone's report. `ok:false` marks it failed WITH the reason, which is what
// the owner needs to see (no credit, no SIM, blocked number) — it is not retried,
// because a failure the SIM reported is not a transport hiccup.
function ack(id, { ok = true, error, now } = {}) {
  const at = Number.isFinite(now) ? now : Date.now();
  const m = _store.messages.find((x) => x.id === id);
  if (!m) return null;
  if (ok) {
    m.state = 'sent';
    m.sent_at = new Date(at).toISOString();
    m.error = null;
  } else {
    m.state = 'failed';
    m.error = String(error || 'שליחה נכשלה').slice(0, 200);
  }
  save();
  return m;
}

// Newest first, for the admin. `pending` counts what is still owed a customer.
// Both readers take `now` for the same reason every writer does: they reconcile
// first (expiring and un-leasing), so a test that injects a clock has to be able
// to inject it here too — otherwise the read silently expires everything the test
// just queued at its own pretend time.
function list({ limit = 50, now } = {}) {
  reconcile(now);
  return _store.messages
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
}

function counts(now) {
  reconcile(now);
  const out = { pending: 0, taken: 0, sent: 0, failed: 0, expired: 0 };
  for (const m of _store.messages) if (out[m.state] != null) out[m.state] += 1;
  return out;
}

// When the phone last asked for work. The one number that says whether the
// gateway is alive — a queue with pending messages and a poll from two days ago
// is a phone that is off, not a server that is broken.
let _lastPollAt = null;
function markPolled(now) {
  _lastPollAt = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
}
function lastPollAt() {
  return _lastPollAt;
}

function _reset() {
  _store = { messages: [] };
  _lastPollAt = null;
  save();
}

module.exports = {
  ilMobile,
  enqueue,
  claim,
  ack,
  list,
  counts,
  reconcile,
  markPolled,
  lastPollAt,
  LEASE_MS,
  DEFAULT_TTL_MS,
  MAX_TEXT,
  _reset,
};
