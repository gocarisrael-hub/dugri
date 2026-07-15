// wa-state.js — runtime state store for the WhatsApp bot. Maps WhatsApp groups
// to word collections and tracks per-group activity + message dedupe. Same
// pattern as server/content.js and server/playbook.js: an in-memory object
// loaded at boot, mutated through helpers, written to disk atomically (temp file
// + rename) on every change. The file lives under DATA_DIR (a persistent Railway
// volume in production) so the bot's runtime state survives redeploys.
//
// Store shape:
//   { version: 1,
//     groups: { "<groupId>": {
//         collection_id, owner_wa, created_at, initial_members: ["<wa>", ...],
//         welcome_sent, invite_dm_sent, last_activity_at, closed,
//         nudge_slots: { "<slotKey>": true },
//         quiet: { count, last_at } } },
//     by_collection: { "<collection_id>": "<groupId>" } }
//
// Every helper is SYNCHRONOUS and must NEVER throw — the bot's inbound-message
// path calls these on the hot path and a thrown error would drop a message. The
// in-memory store is authoritative: a failed disk write is swallowed (best
// effort) and the mutation still takes effect in memory.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'whatsapp-state.json');

// Keep the per-group nudge-slot map bounded — a group runs for weeks and would
// otherwise accumulate one key per slot forever. We only ever need "did we
// already fire THIS slot?", so retaining the most recent few is plenty.
const NUDGE_SLOTS_CAP = 6;

// Keep the per-group processed-event id list bounded. Whapi is at-least-once and
// can redeliver a batch, so we remember recently-processed message/participant
// event ids to drop the duplicate — but only the most recent few matter (a
// redelivery arrives right after the original), so cap it so a long-lived group
// can't grow the file without bound.
const PROCESSED_EVENTS_CAP = 50;

// Keys that would poison Object.prototype (or clobber the map's own machinery)
// if written as an own property. Rejected on BOTH the read and write paths so a
// hostile/garbage groupId or collectionId can never touch the prototype —
// `_store.groups['__proto__'] = entry` would invoke the __proto__ SETTER and
// silently drop the link rather than store it. A rejected key is a safe no-op.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function safeKey(k) {
  const s = String(k == null ? '' : k);
  if (!s || UNSAFE_KEYS.has(s)) return null;
  return s;
}

// Deep copy so public getters never hand back a live reference into the store.
// Consumers must go through the mutator helpers (which persist) to change state;
// a copy means an in-place tweak (entry.quiet.count++, initial_members.push(...))
// can't silently diverge from disk. structuredClone is built in on Node 20.
function clone(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj));
  }
}

function nowIso() {
  return new Date().toISOString();
}

// Normalize the caller-supplied timestamp to a VALID ISO string. Accepts an ISO
// string, a Date, or an epoch-ms number; falls back to "now" for anything
// unusable — INCLUDING an unparseable string. The return value is ALWAYS a valid
// ISO string, never raw junk, so downstream Date.parse-based nudge/quiet
// scheduling can trust created_at / last_activity_at. Never throws.
function toIso(at) {
  try {
    if (at == null) return nowIso();
    if (at instanceof Date) {
      const t = at.getTime();
      return Number.isNaN(t) ? nowIso() : at.toISOString();
    }
    if (typeof at === 'number' && Number.isFinite(at)) return new Date(at).toISOString();
    if (typeof at === 'string' && at) {
      const t = Date.parse(at);
      // Unparseable -> now (NOT the raw string): storing junk here would break
      // every downstream Date.parse of created_at / last_activity_at.
      return Number.isNaN(t) ? nowIso() : new Date(t).toISOString();
    }
  } catch {
    /* fall through to now */
  }
  return nowIso();
}

function emptyStore() {
  return { version: 1, groups: {}, by_collection: {}, pending: {} };
}

let _store = load();
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Defensive: ensure the two sub-maps always exist so helpers never touch
      // undefined even if an older/partial file is loaded.
      if (!raw.groups || typeof raw.groups !== 'object') raw.groups = {};
      if (!raw.by_collection || typeof raw.by_collection !== 'object') raw.by_collection = {};
      if (!raw.pending || typeof raw.pending !== 'object') raw.pending = {};
      if (raw.version == null) raw.version = 1;
      return raw;
    }
  } catch {
    /* missing / unreadable — start empty */
  }
  return emptyStore();
}

function save() {
  // Ensure the data dir exists before the atomic tmp-write+rename — otherwise
  // writeFileSync throws ENOENT on the first save when DATA_DIR hasn't been
  // created yet (content.js + playbook.js do the same guard). Wrapped so a
  // failing write (read-only fs, full disk, tests) never propagates out of a
  // helper: the in-memory store stays authoritative.
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {
    /* best-effort persistence — the in-memory store stays authoritative */
  }
}

// Own-property lookup for a group entry, guarding prototype pollution (a group
// id of "__proto__"/"constructor"/"prototype" must not resolve to a prototype
// object). Returns the LIVE entry — internal callers only; public getters clone.
function getGroup(groupId) {
  const id = safeKey(groupId);
  if (!id) return null;
  if (!Object.prototype.hasOwnProperty.call(_store.groups, id)) return null;
  return _store.groups[id];
}

// Create (or re-link) a group entry + reverse index. `at` is the caller-provided
// time (ISO/Date/epoch-ms) used for created_at + last_activity_at so tests are
// deterministic; omitted -> now. Returns a CLONE of the stored entry, or null on
// a bad groupId.
//
// IDEMPOTENT: re-linking an EXISTING group PRESERVES its progress fields
// (created_at, welcome_sent, invite_dm_sent, last_activity_at, closed,
// nudge_slots, quiet) so the bot never re-sends the welcome or re-fires a
// delivered nudge. Only the linkage fields (collection_id, owner_wa,
// initial_members) are refreshed from the arguments. If the group is re-linked
// to a DIFFERENT collection, the stale reverse-index entry is deleted first so
// the forward map (groups[g].collection_id) and reverse map (by_collection)
// never desync.
function linkGroup(groupId, collectionId, ownerWa, initialMembers = [], at) {
  const id = safeKey(groupId);
  if (!id) return null;
  const cid = safeKey(collectionId); // null if empty/unsafe -> stored as ''
  const members = Array.isArray(initialMembers)
    ? initialMembers.map((m) => String(m || '')).filter((m) => m)
    : [];
  const existing = getGroup(id);
  let entry;
  if (existing) {
    // Re-link: drop a stale reverse-index pointer when the collection changes,
    // so by_collection never keeps a dangling id for the old collection.
    const oldCid = existing.collection_id;
    if (
      oldCid &&
      oldCid !== (cid || '') &&
      Object.prototype.hasOwnProperty.call(_store.by_collection, oldCid)
    ) {
      delete _store.by_collection[oldCid];
    }
    existing.collection_id = cid || '';
    existing.owner_wa = String(ownerWa || '');
    existing.initial_members = members;
    // created_at + every progress field intentionally left untouched.
    entry = existing;
  } else {
    const ts = toIso(at);
    entry = {
      collection_id: cid || '',
      owner_wa: String(ownerWa || ''),
      created_at: ts,
      initial_members: members,
      welcome_sent: false,
      invite_dm_sent: false,
      last_activity_at: ts,
      closed: false,
      nudge_slots: {},
      quiet: { count: 0, last_at: null },
    };
    _store.groups[id] = entry;
  }
  if (cid) _store.by_collection[cid] = id;
  save();
  return clone(entry);
}

// Synchronous "intent to create a group for this collection" latch. Closes the
// check-then-await-then-link TOCTOU in openWhatsappGroup: two concurrent paid
// events for one collection would both pass the groupForCollection() check and
// both createGroup before either linkGroup ran. reserveCollection records the
// intent atomically (no await inside) BEFORE the caller's first await, so the
// second call sees it and backs off — only one group is ever created. Returns
// true for the FIRST caller (intent granted), false if a group already exists for
// the collection OR another call already reserved it. Never throws; a bad id is a
// safe false. releaseCollection clears the marker (call it once the create has
// finished, success or fail, so a later paid event can retry after a failure).
function reserveCollection(collectionId) {
  const cid = safeKey(collectionId);
  if (!cid) return false;
  // A real group already exists -> nothing to reserve (caller no-ops anyway).
  if (Object.prototype.hasOwnProperty.call(_store.by_collection, cid)) return false;
  if (!_store.pending || typeof _store.pending !== 'object') _store.pending = {};
  if (Object.prototype.hasOwnProperty.call(_store.pending, cid)) return false; // already reserved
  _store.pending[cid] = true;
  save();
  return true;
}

function releaseCollection(collectionId) {
  const cid = safeKey(collectionId);
  if (!cid) return;
  if (_store.pending && Object.prototype.hasOwnProperty.call(_store.pending, cid)) {
    delete _store.pending[cid];
    save();
  }
}

// Per-group event de-dupe (Whapi at-least-once redelivery). wasEventProcessed
// reports whether we've already handled this message/participant event id for the
// group; markEventProcessed records it (and prunes to the most recent
// PROCESSED_EVENTS_CAP ids so the file stays bounded). A missing group or empty id
// is a safe no-op / false — only mapped groups (linked via linkGroup) carry the
// list, which is exactly where re-greeting / re-acking must be prevented.
function wasEventProcessed(groupId, eventId) {
  const entry = getGroup(groupId);
  if (!entry) return false;
  const key = String(eventId || '');
  if (!key) return false;
  return Array.isArray(entry.processed_events) && entry.processed_events.indexOf(key) !== -1;
}

function markEventProcessed(groupId, eventId) {
  const entry = getGroup(groupId);
  if (!entry) return;
  const key = String(eventId || '');
  if (!key) return;
  if (!Array.isArray(entry.processed_events)) entry.processed_events = [];
  if (entry.processed_events.indexOf(key) !== -1) return; // already recorded
  entry.processed_events.push(key);
  if (entry.processed_events.length > PROCESSED_EVENTS_CAP) {
    entry.processed_events = entry.processed_events.slice(
      entry.processed_events.length - PROCESSED_EVENTS_CAP
    );
  }
  save();
}

// Reverse lookup: which group backs this collection? Returns the groupId string
// or null.
function groupForCollection(collectionId) {
  const cid = safeKey(collectionId);
  if (!cid) return null;
  if (!Object.prototype.hasOwnProperty.call(_store.by_collection, cid)) return null;
  return _store.by_collection[cid] || null;
}

// Forward lookup: a DEEP COPY of the entry for a group, with its groupId folded
// in, or null when the group is unknown. A copy (not the live object) so a caller
// that mutates a nested field can't bypass save() and diverge from disk.
function collectionForGroup(groupId) {
  const entry = getGroup(groupId);
  if (!entry) return null;
  return Object.assign({ groupId: safeKey(groupId) }, clone(entry));
}

// Was this WhatsApp id recorded as an initial member at group creation (the
// buyer + the bot)? Used to skip member_joined greetings for them.
function isInitialMember(groupId, wa) {
  const entry = getGroup(groupId);
  if (!entry) return false;
  const target = String(wa || '');
  if (!target) return false;
  return Array.isArray(entry.initial_members) && entry.initial_members.indexOf(target) !== -1;
}

// Stamp last_activity_at (any inbound group traffic). `at` optional -> now.
// NOTE: this performs a full synchronous whole-store write on every inbound
// message. Acceptable at the expected volume (a handful of small live groups);
// revisit with a debounce / dirty-flag if group traffic ever grows large.
function touchActivity(groupId, at) {
  const entry = getGroup(groupId);
  if (!entry) return;
  entry.last_activity_at = toIso(at);
  save();
}

function markWelcomeSent(groupId) {
  const entry = getGroup(groupId);
  if (!entry) return;
  entry.welcome_sent = true;
  save();
}

function setInviteDmSent(groupId) {
  const entry = getGroup(groupId);
  if (!entry) return;
  entry.invite_dm_sent = true;
  save();
}

// Per-slot nudge dedupe. A slotKey is a stable string like
// "2026-07-15:daily_morning". markNudged records it (and prunes the map to the
// most recent NUDGE_SLOTS_CAP keys so the file stays bounded); wasNudged reports
// whether that exact slot already fired.
function wasNudged(groupId, slotKey) {
  const entry = getGroup(groupId);
  if (!entry || !entry.nudge_slots) return false;
  const key = String(slotKey || '');
  if (!key) return false;
  return Object.prototype.hasOwnProperty.call(entry.nudge_slots, key);
}

function markNudged(groupId, slotKey) {
  const entry = getGroup(groupId);
  if (!entry) return;
  const key = String(slotKey || '');
  if (!key) return;
  if (!entry.nudge_slots || typeof entry.nudge_slots !== 'object') entry.nudge_slots = {};
  entry.nudge_slots[key] = true;
  // Prune to the most recent keys so a long-lived group can't grow the file
  // without bound. This relies on Object.keys returning keys in INSERTION order,
  // which holds because slot keys always contain a ':' (a date:label separator)
  // and are therefore non-integer strings — integer-like keys would instead be
  // enumerated in ascending numeric order and break the "oldest first" drop.
  const keys = Object.keys(entry.nudge_slots);
  if (keys.length > NUDGE_SLOTS_CAP) {
    const drop = keys.slice(0, keys.length - NUDGE_SLOTS_CAP);
    for (const k of drop) delete entry.nudge_slots[k];
  }
  save();
}

// Record that a "the group's gone quiet" reminder went out: bump the count and
// stamp when. `at` optional -> now.
function recordQuietReminder(groupId, at) {
  const entry = getGroup(groupId);
  if (!entry) return;
  if (!entry.quiet || typeof entry.quiet !== 'object') entry.quiet = { count: 0, last_at: null };
  entry.quiet.count = (Number(entry.quiet.count) || 0) + 1;
  entry.quiet.last_at = toIso(at);
  save();
}

// Mark a group closed (collection delivered / order done). Closed groups drop
// out of activeGroups but keep their entry + reverse index for lookups.
function markClosed(groupId) {
  const entry = getGroup(groupId);
  if (!entry) return;
  entry.closed = true;
  save();
}

// All groups the bot should still service (not closed), each a DEEP COPY with
// its groupId folded in (a copy so a caller can't mutate the store in place).
function activeGroups() {
  const out = [];
  for (const id of Object.keys(_store.groups)) {
    const entry = _store.groups[id];
    if (entry && !entry.closed) out.push(Object.assign({ groupId: id }, clone(entry)));
  }
  return out;
}

module.exports = {
  linkGroup,
  reserveCollection,
  releaseCollection,
  wasEventProcessed,
  markEventProcessed,
  groupForCollection,
  collectionForGroup,
  isInitialMember,
  touchActivity,
  markWelcomeSent,
  setInviteDmSent,
  markNudged,
  wasNudged,
  recordQuietReminder,
  markClosed,
  activeGroups,
  _file: FILE,
  NUDGE_SLOTS_CAP,
  PROCESSED_EVENTS_CAP,
};
