// photo-fallback.js — OWNER OVERRIDES for the photo card's four fallback pawns.
//
// The deck's 104th card is the PHOTO CARD: the customer's four pawn photos. An
// order that supplies none is filled with generic Dugri pawns shipped at
// resources/canva/templates/_shared/photo-fallback/{1..4}.svg. Those are baked
// into the repo, so changing one used to mean a PR and a deploy.
//
// This store lets the owner REPLACE any of the four from the admin, per slot,
// with no deploy. ONLY overridden slots are stored: a slot the owner never
// touched is simply absent, and the shipped artwork keeps being used. That is
// what makes "reset to default" a deletion rather than a second copy of the
// shipped file.
//
// Storage is REUSED from content.js — content.saveImageBytes writes the bytes
// (magic-byte typed, size-capped, content-addressed under DATA_DIR/content-uploads)
// and this store only ever holds the resulting "/content-uploads/<hash>.<ext>"
// path, re-validated on write. So a pawn can only ever be an image THIS server
// produced, never an arbitrary or off-origin URL.
//
// ONE ASYMMETRY, AND IT IS DELIBERATE: the shipped defaults are SVG, but an
// override is always a RASTER. content.js refuses SVG uploads on purpose — an
// uploaded .svg is served from our own origin at a public /content-uploads URL
// and can carry <script>, which would make it a stored-XSS vector. Both forms
// render into the photo card the same way, so the restriction costs nothing here.
//
// Persisted shape (DATA_DIR/photo-fallback.json) — deviations only:
//   { "slots": { "1": "/content-uploads/<hash>.<ext>", "3": "..." } }
//
// THE GENERATOR READS THIS FILE. generator/config.py:photo_fallback_paths()
// consults it before falling back to the shipped set, mapping a stored
// "/content-uploads/<name>" to "<DATA_DIR>/content-uploads/<name>" on disk. See
// docs/photo-fallback-overrides.md for that contract — changing the shape here
// changes what production prints.
const fs = require('fs');
const path = require('path');
const { backupFile } = require('./store-backup');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'photo-fallback.json');

// The photo card has exactly four pawn slots, and slot N takes pawn N. Fixed,
// not owner-extensible: the card art has four holes in it.
const SLOTS = ['1', '2', '3', '4'];
const SLOT_SET = new Set(SLOTS);

// A stored path must be EXACTLY one content.saveImageBytes produced (16-hex
// content hash + a raster ext) — the same guard design-images.js applies, for
// the same reason.
const UPLOAD_PATH_RE = /^\/content-uploads\/[a-f0-9]{16}\.(webp|jpe?g|png)$/;

/** '1'..'4' for a valid slot, else null. Accepts a number or a string. */
function slotOk(slot) {
  const s = String(slot === 0 ? '' : slot || '');
  return SLOT_SET.has(s) ? s : null;
}

/** True when `p` is a path this server produced. */
function imgOk(p) {
  return UPLOAD_PATH_RE.test(String(p || ''));
}

let _store = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return sanitize(raw);
  } catch {
    /* missing / unreadable — start empty, exactly as the sibling stores do */
  }
  return { slots: {} };
}

// Drop anything that is not a known slot pointing at one of our own uploads.
// Applied on LOAD as well as on write, so a hand-edited or restored file can
// never introduce an off-origin path.
function sanitize(raw) {
  const out = { slots: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const slots = raw.slots;
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return out;
  for (const slot of SLOTS) {
    const v = slots[slot];
    if (imgOk(v)) out.slots[slot] = String(v);
  }
  return out;
}

function save() {
  // Ensure the data dir exists before the atomic tmp-write+rename (same guard as
  // content.js/design-images.js) — otherwise the first write throws ENOENT.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

/** Every override, as { slot: imgPath }. Absent slot = use the shipped pawn. */
function getAll() {
  return { ..._store.slots };
}

/** The override for one slot, or null when it uses the shipped pawn. */
function getSlot(slot) {
  const s = slotOk(slot);
  return s ? _store.slots[s] || null : null;
}

/**
 * Point a slot at an uploaded image. Returns `{ prev }` — the path this
 * displaced, so the caller can reclaim it when nothing else references it.
 * Throws on a bad slot or a path we did not produce.
 */
function setSlot(slot, imgPath) {
  const s = slotOk(slot);
  if (!s) throw new Error('bad slot');
  if (!imgOk(imgPath)) throw new Error('bad image path');
  const prev = _store.slots[s] || null;
  // Re-pointing a slot at the image it already holds is a no-op, NOT a
  // displacement — returning it as `prev` would have the caller reclaim the file
  // the slot still uses.
  if (prev === imgPath) return { prev: null };
  _store.slots[s] = String(imgPath);
  save();
  return { prev };
}

/**
 * Revert a slot to its shipped pawn by REMOVING the override. Returns
 * `{ prev }` for reclaiming.
 */
function resetSlot(slot) {
  const s = slotOk(slot);
  if (!s) throw new Error('bad slot');
  const prev = _store.slots[s] || null;
  if (!prev) return { prev: null };
  delete _store.slots[s];
  save();
  return { prev };
}

/**
 * Does any slot still point at this upload? Uploads are content-addressed and
 * SHARED with the content and design-image stores, so this has to be consulted
 * before a displaced file is deleted — otherwise replacing pawn 1 would delete
 * the bytes pawn 3 is also using.
 */
function isImageReferenced(imgPath) {
  const target = String(imgPath || '');
  if (!target) return false;
  return SLOTS.some((s) => _store.slots[s] === target);
}

/** Timestamped copy of the store file, for the admin backup flow. */
function backup() {
  return backupFile(FILE);
}

module.exports = {
  getAll,
  getSlot,
  setSlot,
  resetSlot,
  isImageReferenced,
  slotOk,
  imgOk,
  backup,
  sanitize,
  SLOTS,
  _file: FILE,
  // Test seam: reload from disk after a test rewrites the file underneath us.
  _reload() {
    _store = load();
  },
};
