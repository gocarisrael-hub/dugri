// whatsapp.js — Whapi Cloud (hosted WhatsApp gateway) HTTP module.
//
// DORMANT until armed, exactly like server/pelecard.js and server/notify.js:
// the env vars are read once at require time, isConfigured() gates every network
// call, and with no env set every impure call is a no-op that returns a soft
// failure (it never even touches fetch). Merging this module changes NOTHING in
// production until WHATSAPP_ENABLED + WHAPI_TOKEN are set.
//
// Two kinds of exports:
//   • Impure Whapi REST calls — createGroup / sendMessage / getInviteLink — the
//     ONLY network part. Each carries `Authorization: Bearer <WHAPI_TOKEN>`, JSON
//     bodies, an AbortController timeout, and is fully fail-soft: a non-2xx, a
//     thrown/network error, or being unconfigured NEVER throws — it returns
//     { ok:false, ... }. The fetch implementation is injectable (opts.fetchImpl)
//     so unit tests stub the network with zero real traffic (same shape as
//     server/content-import.js).
//   • Pure helpers — splitWords / parseWebhook / buildTriggerMessage /
//     groupsDueForNudge — no network, injectable dependencies (settings module,
//     now-time), so the webhook handler and the (next-PR) scheduler in index.js
//     have testable building blocks. The scheduling loop itself lives in index.js.
//
// Implemented against the documented Whapi Cloud REST API (base
// https://gate.whapi.cloud): POST /groups (create group), POST /messages/text
// (send text), GET /groups/{GroupID}/invite (group invite code). Webhook payloads
// per Whapi's "incoming webhooks format" docs: a `messages` array for message
// events and a `groups_participants` array (action:"add") for member-added events.
const settings = require('./settings');

// --- config (read once at require time — dormant until set) -------------------
const WHAPI_TOKEN = process.env.WHAPI_TOKEN || '';
const BASE_URL = (process.env.WHAPI_BASE_URL || 'https://gate.whapi.cloud').replace(/\/+$/, '');
const WHAPI_WEBHOOK_SECRET = process.env.WHAPI_WEBHOOK_SECRET || '';
const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED || '';

// Abort a stalled Whapi request instead of hanging a fire-and-forget send.
const REQUEST_TIMEOUT_MS = 10000;
// splitWords hard cap — a single inbound message never contributes more than this
// many candidate words to a collection (defence against a paste-bomb).
const MAX_WORDS = 500;
// WhatsApp public group-invite links have this fixed prefix; we build the full
// link from the invite_code Whapi returns when it doesn't hand back a full link.
const INVITE_LINK_PREFIX = 'https://chat.whatsapp.com/';

// An env flag is "on" unless it's explicitly a falsey spelling. Set-but-empty and
// the usual off spellings ('0'/'false'/'no'/'off') count as OFF so a stray
// WHATSAPP_ENABLED= never half-arms the bot.
function truthyEnv(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
}

// Armed only when the bot is enabled AND we have a token AND a base URL. Every
// impure call short-circuits to a soft failure otherwise, so the module is inert
// until the owner sets the env on the service. NOTE: the webhook secret is NOT
// part of the send-gate on purpose (outbound sends don't need it) — but an armed
// bot with no secret can receive nothing (see warnIfPartiallyConfigured).
function isConfigured() {
  return Boolean(truthyEnv(WHATSAPP_ENABLED) && WHAPI_TOKEN && BASE_URL);
}

// Warn (once) at startup when the bot is armed for SENDING (enabled + token) but
// WHAPI_WEBHOOK_SECRET is missing: verifyWebhookSecret then rejects every inbound
// request, so words never flow in even though the bot looks configured — a silent
// failure the owner would otherwise struggle to diagnose. Same posture as
// notify.js's warnIfPartiallyConfigured. NEVER logs the token or secret value.
let _partialConfigWarned = false;
function warnIfPartiallyConfigured() {
  if (_partialConfigWarned) return;
  if (truthyEnv(WHATSAPP_ENABLED) && WHAPI_TOKEN && !WHAPI_WEBHOOK_SECRET) {
    _partialConfigWarned = true;
    console.warn(
      '[whatsapp] enabled with a token but WHAPI_WEBHOOK_SECRET is missing — ' +
        'inbound webhooks will be rejected and no words can be collected. ' +
        'Set WHAPI_WEBHOOK_SECRET to receive messages.'
    );
  }
}
warnIfPartiallyConfigured();

// Is a webhook request's `?secret=` the configured one? Constant-time compare so
// the secret can't be recovered by timing. Returns false when the secret isn't
// configured (a dormant bot accepts no webhook). Kept here so the route stays a
// thin caller.
function verifyWebhookSecret(provided) {
  const expected = WHAPI_WEBHOOK_SECRET;
  if (!expected) return false;
  const a = Buffer.from(String(provided == null ? '' : provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- impure: the ONLY network layer (fail-soft, never throws) -----------------
// One thin, mockable request helper. Reads the injected fetchImpl (tests) or the
// global fetch (Node 20). Always resolves to { ok, status?, data?, error? } — it
// swallows every transport error and non-2xx so callers never need try/catch.
async function whapiRequest(method, path, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) return { ok: false, error: 'no fetch implementation available' };
  const controller = new AbortController();
  let timer;
  try {
    const headers = {
      Authorization: 'Bearer ' + WHAPI_TOKEN,
      Accept: 'application/json',
    };
    const init = { method, headers, signal: controller.signal };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetchImpl(BASE_URL + path, init);
    const data = res && typeof res.json === 'function' ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) {
      return {
        ok: false,
        status: res ? res.status : 0,
        error: 'whapi http ' + (res && res.status),
        data,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Create a WhatsApp group. `participants` is an array of WhatsApp ids / phone
// numbers (WhatsApp may silently drop some for anti-spam — the caller handles the
// privacy-block fallback). Returns { ok:true, groupId, data } or a soft failure.
// A no-op ({ ok:false, skipped:true }) when unconfigured — no fetch happens.
async function createGroup(subject, participants, opts = {}) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'not configured' };
  const body = {
    subject: String(subject == null ? '' : subject),
    participants: Array.isArray(participants) ? participants.map((p) => String(p)) : [],
  };
  const r = await whapiRequest('POST', '/groups', { body, fetchImpl: opts.fetchImpl });
  if (!r.ok) return r;
  const data = r.data || {};
  const groupId = data.id || data.group_id || (data.group && data.group.id) || null;
  return { ok: true, groupId, data };
}

// Send a text message to a chat / group. `to` is a chat id — a group id
// (e.g. "1203...@g.us") or a phone-number chat id. Returns { ok:true, sent,
// messageId, data } or a soft failure. No-op when unconfigured.
async function sendMessage(to, text, opts = {}) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'not configured' };
  const body = { to: String(to == null ? '' : to), body: String(text == null ? '' : text) };
  const r = await whapiRequest('POST', '/messages/text', { body, fetchImpl: opts.fetchImpl });
  if (!r.ok) return r;
  const data = r.data || {};
  const messageId = (data.message && data.message.id) || data.id || null;
  return { ok: true, sent: data.sent !== false, messageId, data };
}

// Fetch a group's invite link. Whapi returns an invite_code (and sometimes a full
// link); we always return a full inviteLink, building it from the code when
// needed. Returns { ok:true, inviteCode, inviteLink, data } or a soft failure.
// No-op when unconfigured.
async function getInviteLink(groupId, opts = {}) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'not configured' };
  // Whapi expects the RAW group id in the path — e.g. "120363xxxx@g.us" — and does
  // NOT decode a percent-encoded "@" (the `@g.us` suffix is a literal part of the
  // id per its docs, pattern ^[\d-]{10,31}@g\.us$). encodeURIComponent would turn
  // "@" into "%40" and 404. The id is well-formed (digits + "@g.us"), so no path
  // segment needs escaping; pass it through, only trimmed.
  const id = String(groupId == null ? '' : groupId).trim();
  const r = await whapiRequest('GET', '/groups/' + id + '/invite', { fetchImpl: opts.fetchImpl });
  if (!r.ok) return r;
  const data = r.data || {};
  const code = data.invite_code || data.code || null;
  const link = data.invite_link || (code ? INVITE_LINK_PREFIX + code : null);
  return { ok: true, inviteCode: code, inviteLink: link, data };
}

// --- pure helpers (no network) ------------------------------------------------

// Split an inbound message into candidate words. Words are separated by NEWLINES
// and COMMAS only — NOT spaces — because a single word can be multiple space-
// separated tokens ("Tel Aviv", "בדיחה פנימית"). Each piece is trimmed; empties
// are dropped; exact duplicates are removed (first occurrence wins, order kept);
// the result is capped at MAX_WORDS so a paste-bomb can't flood a collection.
function splitWords(text) {
  if (text == null) return [];
  const parts = String(text).split(/[\r\n,]+/);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const word = part.trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

// Normalize a raw participant entry (Whapi sends either a bare id string or an
// object { id, name?, rank? }) to { id, name }. Returns null when there is no id.
function normalizeParticipant(p) {
  if (typeof p === 'string') {
    const id = p.trim();
    return id ? { id, name: '' } : null;
  }
  if (p && typeof p === 'object') {
    const id = String(p.id || p.wa_id || '').trim();
    if (!id) return null;
    return { id, name: String(p.name || p.pushname || '') };
  }
  return null;
}

// Normalize a Whapi inbound webhook into ALL of its actionable events, so the
// (next-PR) webhook handler can iterate them — a single Whapi POST can batch
// several messages AND a participant-add in the same body. Returns:
//   { events: [ ...NormalizedEvent ] }
// where each NormalizedEvent is one of:
//   { kind:'participants_added', groupId, added:[{id,name}], id }  // a friend joined
//   { kind:'message', groupId, from, fromName, text, id }          // a GROUP text msg
// `id` is a stable event id used by the handler for at-least-once de-dupe (the
// Whapi message id; for a participant add, Whapi's id or a synthesized one). It
// may be '' when the payload omits it — such events are simply not deduped.
// Anything not actionable is simply omitted (never emitted as an event), so an
// empty/unknown/self-only body yields { events: [] }. Guarantees for the handler:
//   • WhatsApp-specific filtering happens HERE, once — the handler just switches
//     on `kind`. Our own outgoing (from_me), non-text, and empty-body messages are
//     dropped; only `groups_participants` action:"add" becomes participants_added.
//   • A message is only surfaced when its chat id is a GROUP id (ends with
//     "@g.us"). A 1:1 DM to the bot ("…@s.whatsapp.net" / a phone) is NOT word
//     input and is dropped — otherwise its text would be mis-attributed to a
//     wrong/nonexistent collection.
//   • Every emitted event carries a non-empty groupId (both snake_case group_id
//     and camelCase groupId are accepted); an event with no id is dropped, so the
//     handler never gets groupId:'' (which would make it sendMessage('', …)).
//   • Never throws on missing/undefined fields.
// Participant-add events are listed before message events so a "member joined then
// spoke" body greets before it processes words.
function parseWebhook(body) {
  const events = [];
  if (!body || typeof body !== 'object') return { events };

  // Member-added events: `groups_participants` array with action:"add".
  const groupEvents = Array.isArray(body.groups_participants) ? body.groups_participants : [];
  for (const ev of groupEvents) {
    if (!ev || ev.action !== 'add') continue;
    const groupId = String(ev.group_id || ev.groupId || '').trim();
    if (!groupId) continue;
    const raw = Array.isArray(ev.participants) ? ev.participants : [];
    const added = raw.map(normalizeParticipant).filter(Boolean);
    if (!added.length) continue;
    // A stable event id for at-least-once de-dupe. Prefer Whapi's own id; else
    // synthesize one from the group + the added participant ids so a redelivery of
    // the SAME add batch is recognised and dropped by the handler.
    const id = String(ev.id || '') || 'padd:' + groupId + ':' + added.map((a) => a.id).join('|');
    events.push({ kind: 'participants_added', groupId, added, id });
  }

  // Message events: EVERY genuine inbound GROUP text message in the batch.
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.from_me) continue; // our own outgoing echo
    if (m.type && m.type !== 'text') continue; // only plain text carries words
    const groupId = String(m.chat_id || m.chatId || m.group_id || m.groupId || '').trim();
    if (!groupId || !groupId.endsWith('@g.us')) continue; // group messages only; DMs dropped
    const raw = m.text && typeof m.text === 'object' ? m.text.body : m.text;
    const text = raw == null ? '' : String(raw);
    if (!text.trim()) continue; // empty / system
    events.push({
      kind: 'message',
      groupId,
      from: String(m.from || '').trim(),
      fromName: String(m.from_name || ''),
      text,
      // Whapi message id, for at-least-once de-dupe by the handler. '' when the
      // payload omits it (older test fixtures) — such events are simply never
      // deduped rather than mis-deduped as a shared empty id.
      id: String(m.id || ''),
    });
  }

  return { events };
}

// Build the outgoing text for one trigger from the owner-editable catalog in
// settings.js. PURE + injectable: pass opts.settings (defaults to the real store)
// so tests need no DATA_DIR. Reads wa.trigger.<id> = { enabled, text, timing? },
// interpolates {tokens} from `values`, and returns
//   { triggerId, enabled, text, timing }
// with text=null when the trigger is disabled or unknown — so the caller sends
// nothing (a disabled trigger is silent). Never throws.
function buildTriggerMessage(triggerId, values, opts = {}) {
  const store = opts.settings || settings;
  let cfg = null;
  try {
    cfg = store.get('wa', 'trigger.' + triggerId);
  } catch {
    return { triggerId, enabled: false, text: null, timing: null };
  }
  const enabled = !!(cfg && cfg.enabled);
  const timing = (cfg && cfg.timing) || null;
  if (!enabled) return { triggerId, enabled: false, text: null, timing };
  const text = store.interpolate(cfg.text || '', values || {});
  return { triggerId, enabled: true, text, timing };
}

// Time-of-day parts of `date` in a given IANA timezone (default Asia/Jerusalem),
// as { date:'YYYY-MM-DD', hour: 0..23 }. Uses Intl so DST is handled correctly.
function tzParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some engines render midnight as '24'
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour };
}

// PURE building block for the (next-PR) nudge scheduler. Given a list of group
// STATE entries (the shape server/wa-state.js hands out: { groupId, closed,
// last_activity_at, created_at, nudge_slots, quiet:{count,last_at} }), a `now`,
// and the trigger catalog (opts.settings), returns the nudges due right now:
//   [{ groupId, triggerId, slotKey }]   (slotKey is null for quiet_reminder)
// It reads timing from the catalog and dedupes daily nudges against each group's
// own nudge_slots, but performs NO I/O and mutates nothing — the scheduler in
// index.js owns the loop, the send, and recording the slot / quiet.last_at.
// Idempotent across ticks so a fast scheduler interval never double-sends. Never
// throws.
//   • daily_morning / daily_evening: fire when the group is open, the trigger is
//     enabled, the current Jerusalem hour is >= timing.hour (so a tick that missed
//     the exact hour — a deploy/restart/GC spanning it, or a >1h interval — still
//     catches up the SAME day), and that day's slot ("<YYYY-MM-DD>:<triggerId>")
//     hasn't been recorded yet. The date-keyed slot prevents a double-send, and we
//     never fire BEFORE timing.hour.
//   • quiet_reminder: fires when enabled, the group has been idle (no activity) for
//     >= timing.idle_hours, fewer than timing.max quiet reminders have been sent,
//     the current hour is inside timing.window ([startHour,endHour)), AND it's been
//     >= timing.idle_hours since the LAST quiet reminder (quiet.last_at) — so at
//     most one quiet reminder per idle_hours window rather than one per tick. A
//     brand-new idle group (last_at null) is due immediately.
function groupsDueForNudge(groups, opts = {}) {
  const store = opts.settings || settings;
  const now = opts.now != null ? new Date(opts.now) : new Date();
  const nowMs = now.getTime();
  const { date: today, hour } = tzParts(now, opts.timezone);
  const trigger = (id) => {
    try {
      return store.get('wa', 'trigger.' + id);
    } catch {
      return null;
    }
  };
  const out = [];
  const list = Array.isArray(groups) ? groups : [];
  for (const g of list) {
    if (!g || g.closed) continue;
    const groupId = String(g.groupId || '');
    if (!groupId) continue;
    const slots = g.nudge_slots && typeof g.nudge_slots === 'object' ? g.nudge_slots : {};

    for (const id of ['daily_morning', 'daily_evening']) {
      const cfg = trigger(id);
      if (!cfg || !cfg.enabled) continue;
      const targetHour = cfg.timing && Number.isFinite(cfg.timing.hour) ? cfg.timing.hour : null;
      if (targetHour == null || hour < targetHour) continue; // not yet the hour (same-day catch-up once past it)
      const slotKey = today + ':' + id;
      if (Object.prototype.hasOwnProperty.call(slots, slotKey)) continue;
      out.push({ groupId, triggerId: id, slotKey });
    }

    const quiet = trigger('quiet_reminder');
    if (quiet && quiet.enabled) {
      const timing = quiet.timing || {};
      const idleHours = Number.isFinite(timing.idle_hours) ? timing.idle_hours : 24;
      const idleMsThreshold = idleHours * 3600 * 1000;
      const max = Number.isFinite(timing.max) ? timing.max : 3;
      const window =
        Array.isArray(timing.window) && timing.window.length === 2 ? timing.window : null;
      const count = (g.quiet && Number(g.quiet.count)) || 0;
      const lastActivity = Date.parse(g.last_activity_at || g.created_at || '');
      const idleMs = Number.isFinite(lastActivity) ? nowMs - lastActivity : 0;
      const inWindow = window ? hour >= window[0] && hour < window[1] : true;
      // Space reminders: due only if we've never sent one (last_at null) or the
      // last one was >= idle_hours ago — otherwise all `max` would fire back-to-back.
      const lastQuiet = g.quiet && g.quiet.last_at ? Date.parse(g.quiet.last_at) : null;
      const spaced =
        lastQuiet == null || !Number.isFinite(lastQuiet) || nowMs - lastQuiet >= idleMsThreshold;
      if (count < max && inWindow && idleMs >= idleMsThreshold && spaced) {
        out.push({ groupId, triggerId: 'quiet_reminder', slotKey: null });
      }
    }
  }
  return out;
}

module.exports = {
  isConfigured,
  verifyWebhookSecret,
  createGroup,
  sendMessage,
  getInviteLink,
  splitWords,
  parseWebhook,
  buildTriggerMessage,
  groupsDueForNudge,
  BASE_URL,
  MAX_WORDS,
};
