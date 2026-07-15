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
// path calls these on the hot path and a thrown error would drop a message.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'whatsapp-state.json');

// Keep the per-group nudge-slot map bounded — a group runs for weeks and would
// otherwise accumulate one key per slot forever. We only ever need "did we
// already fire THIS slot?", so retaining the most recent few is plenty.
const NUDGE_SLOTS_CAP = 6;

function nowIso() {
  return new Date().toISOString();
}

// Normalize the caller-supplied timestamp. Accepts an ISO string, a Date, or an
// epoch-ms number; falls back to "now" for anything unusable. Never throws.
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
      return Number.isNaN(t) ? at : new Date(t).toISOString();
    }
  } catch {
    /* fall through to now */
  }
  return nowIso();
}

function emptyStore() {
  return { version: 1, groups: {}, by_collection: {} };
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
  // failing write (read-only fs in tests) never propagates out of a helper.
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
// id literally named "__proto__" must not resolve to Object.prototype).
function getGroup(groupId) {
  const id = String(groupId || '');
  if (!id) return null;
  if (!Object.prototype.hasOwnProperty.call(_store.groups, id)) return null;
  return _store.groups[id];
}

// Create the group entry + reverse index. `at` is the caller-provided time
// (ISO/Date/epoch-ms) used for created_at and last_activity_at so tests are
// deterministic; omitted -> now. Idempotent-ish: re-linking the same group
// overwrites the entry. Returns the stored entry, or null on a bad groupId.
function linkGroup(groupId, collectionId, ownerWa, initialMembers = [], at) {
  const id = String(groupId || '');
  if (!id) return null;
  const cid = String(collectionId || '');
  const ts = toIso(at);
  const members = Array.isArray(initialMembers)
    ? initialMembers.map((m) => String(m || '')).filter((m) => m)
    : [];
  const entry = {
    collection_id: cid,
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
  if (cid) _store.by_collection[cid] = id;
  save();
  return entry;
}

// Reverse lookup: which group backs this collection? Returns the groupId string
// or null.
function groupForCollection(collectionId) {
  const cid = String(collectionId || '');
  if (!cid) return null;
  if (!Object.prototype.hasOwnProperty.call(_store.by_collection, cid)) return null;
  return _store.by_collection[cid] || null;
}

// Forward lookup: the full entry for a group, with its groupId folded in, or
// null when the group is unknown.
function collectionForGroup(groupId) {
  const entry = getGroup(groupId);
  if (!entry) return null;
  return Object.assign({ groupId: String(groupId) }, entry);
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
  // Prune to the most recent keys (insertion order is preserved for string
  // keys) so a long-lived group can't grow the file without bound.
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

// All groups the bot should still service (not closed), each with its groupId
// folded in.
function activeGroups() {
  const out = [];
  for (const id of Object.keys(_store.groups)) {
    const entry = _store.groups[id];
    if (entry && !entry.closed) out.push(Object.assign({ groupId: id }, entry));
  }
  return out;
}

module.exports = {
  linkGroup,
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
};
