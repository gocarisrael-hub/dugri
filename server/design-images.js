// design-images.js — per-design product-image OVERRIDES.
//
// Each design ships static "beauty" pictures under site/assets/designs/<id>/:
//   store.webp  — the tile shown on the products listing + homepage
//   gallery-{front,back,board}.webp — the product-detail gallery slides
// Those are baked into the repo. This store lets the owner REPLACE any one of
// them with their own uploaded photo, per design + slot, WITHOUT a deploy — the
// same self-serve pattern as the inline content editor (server/content.js).
//
// It deliberately REUSES content.js for image storage: an upload is saved by
// content.saveImageBytes (magic-byte typed, size-capped, content-addressed under
// DATA_DIR/content-uploads) and this store only ever holds the resulting
// "/content-uploads/<hash>.<ext>" PATH. So an override can only ever point at an
// image THIS server produced — never an arbitrary/off-origin URL.
//
// Store shape: { [designId]: { [slot]: "/content-uploads/<name>",
//                              carousel?: ["/content-uploads/<name>", …] } }
//   designId = a catalog design id (kebab, e.g. "posttrip").
//   slot     = one of store | board | front | back.
//   carousel = an ORDERED array of the owner's extra store-tile pictures. The
//              products-grid tile cycles [store image, …carousel] as a fast,
//              seamless, auto-advancing carousel; an absent/empty array leaves the
//              tile showing just the store image (no cycling).
//
// Persistence mirrors content.js/playbook.js: an in-memory object loaded at boot,
// mutated through helpers, written to disk atomically (temp file + rename) on
// every change, under DATA_DIR so it survives redeploys.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'design-images.json');

// A design id: starts alphanumeric, then kebab, ≤41 chars (matches the catalog).
const DESIGN_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
// The four overridable image slots.
const SLOTS = ['store', 'board', 'front', 'back'];
const SLOT_SET = new Set(SLOTS);
// A stored path must be EXACTLY one content.saveImageBytes produced (16-hex
// content hash + a raster ext) — same shape content.js enforces. Validating on
// write means an override can never become an off-origin / stored-XSS vector.
const UPLOAD_PATH_RE = /^\/content-uploads\/[a-f0-9]{16}\.(webp|jpe?g|png)$/;
// Max pictures in a design's store-tile CAROUSEL (mirrors content.js PHOTO_CAP).
// Generous but bounded so a runaway client can't grow the store without limit.
const CAROUSEL_CAP = 12;

function designOk(id) {
  return DESIGN_RE.test(String(id || '')) ? String(id) : null;
}
function slotOk(slot) {
  return SLOT_SET.has(String(slot || '')) ? String(slot) : null;
}

let _store = load();
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch {
    /* missing / unreadable — start empty */
  }
  return {};
}
function save() {
  // Ensure the data dir exists before the atomic tmp-write+rename (same guard as
  // content.js/db.js) — otherwise the first write throws ENOENT.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

// The WHOLE override map (every design), returned BY REFERENCE for cheap
// serialization by the public GET /api/design-images (res.json copies it). The
// map is small (a handful of designs × 4 slots). Callers treat it as read-only.
function getAll() {
  return _store;
}

// The overrides for one design (a fresh, independent copy — callers can mutate it
// without touching the store). Unknown/absent → {}. Array fields (the carousel)
// are sliced too: a shallow spread would share the SAME array reference, so a
// caller mutating the returned `.carousel` would silently mutate + persist the
// store on the next save.
function getForDesign(id) {
  const d = designOk(id);
  if (!d || !_store[d]) return {};
  const out = {};
  for (const key of Object.keys(_store[d])) {
    const v = _store[d][key];
    out[key] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

// The override path for design/slot, or null when none is set.
function get(id, slot) {
  const d = designOk(id);
  const s = slotOk(slot);
  if (!d || !s || !_store[d]) return null;
  const p = _store[d][s];
  return UPLOAD_PATH_RE.test(String(p || '')) ? p : null;
}

// Set the override for design/slot to an our-own "/content-uploads/<name>" path.
// Returns the design's updated slot map, or null on a bad design/slot/path.
function set(id, slot, imgPath) {
  const d = designOk(id);
  const s = slotOk(slot);
  if (!d || !s || !UPLOAD_PATH_RE.test(String(imgPath || ''))) return null;
  const bag = _store[d] || (_store[d] = {});
  bag[s] = String(imgPath);
  save();
  return { ...bag };
}

// Remove the override for design/slot (revert to the shipped static asset). Prunes
// an empty design bag so the store stays tidy. Returns true if something changed.
function reset(id, slot) {
  const d = designOk(id);
  const s = slotOk(slot);
  if (!d || !s) return false;
  if (!_store[d] || !(s in _store[d])) return false;
  delete _store[d][s];
  if (Object.keys(_store[d]).length === 0) delete _store[d];
  save();
  return true;
}

// ---- per-design store-tile CAROUSEL (an ORDERED photo array) ---------------
// Beyond the single per-slot overrides above, a design can carry a `carousel`
// array of extra store-tile pictures. The products-grid tile cycles
// [store image, …carousel] as a fast seamless carousel; an empty/absent array
// leaves the tile as a single static picture. The array lives in the SAME design
// bag as the slot overrides (so the public GET exposes it in one map) and holds
// only our-own upload paths, validated on every write — never an off-origin URL.

// Keep only valid, distinct, our-own upload paths, capped at CAROUSEL_CAP, order
// preserved. Never trusts a client string beyond the exact saveImageBytes shape.
function sanitizeCarousel(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const p = String(raw || '');
    if (!UPLOAD_PATH_RE.test(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= CAROUSEL_CAP) break;
  }
  return out;
}

// The carousel array for a design (a fresh copy so callers can't mutate the
// store). Unknown/absent design or no array → [].
function getCarousel(id) {
  const d = designOk(id);
  if (!d || !_store[d]) return [];
  const arr = _store[d].carousel;
  return Array.isArray(arr) ? arr.slice() : [];
}

// Append one uploaded picture to a design's carousel (deduped, capped, order
// preserved). Returns the new array, or null on a bad design/path. A no-op append
// (duplicate or already at cap) still returns the current array so the client
// stays in sync — the route compares lengths to detect a dropped upload.
function addCarouselImage(id, imgPath) {
  const d = designOk(id);
  if (!d || !UPLOAD_PATH_RE.test(String(imgPath || ''))) return null;
  const cur = getCarousel(d);
  const next = sanitizeCarousel(cur.concat(String(imgPath)));
  // No-op append (a content-hash duplicate, or dropped because already at cap):
  // the sanitized array is identical, so skip the JSON serialize + tmp-write +
  // rename entirely and just return it — the route then reports a 409.
  if (next.length === cur.length && next.every((p, i) => p === cur[i])) return next;
  const bag = _store[d] || (_store[d] = {});
  bag.carousel = next;
  save();
  return next;
}

// Remove one picture from a design's carousel by its path. Prunes an emptied
// carousel key (and an emptied design bag) so the store stays tidy. Returns the
// new array (possibly []), or null on a bad design id. A no-op when the path is
// absent (returns the unchanged array).
function removeCarouselImage(id, imgPath) {
  const d = designOk(id);
  if (!d) return null;
  if (!_store[d] || !Array.isArray(_store[d].carousel)) return [];
  const target = String(imgPath || '');
  const next = _store[d].carousel.filter((p) => p !== target);
  if (next.length) {
    _store[d].carousel = next;
  } else {
    delete _store[d].carousel;
    if (Object.keys(_store[d]).length === 0) delete _store[d];
  }
  save();
  return next;
}

// Is `imgPath` referenced by ANY design/slot in THIS store (a single slot path OR
// an entry in a carousel array)? Uploads are content-addressed and shared (a file
// can back a content-editor override AND a design-image override, several slots,
// or a carousel), so a caller reclaiming an orphan must confirm nothing here still
// points at it — combined with content.isImageReferenced on the other store.
// Own-property scan only.
function isImageReferenced(imgPath) {
  const target = String(imgPath || '');
  if (!target) return false;
  for (const id of Object.keys(_store)) {
    const bag = _store[id] || {};
    for (const key of Object.keys(bag)) {
      const v = bag[key];
      if (v === target) return true;
      if (Array.isArray(v) && v.indexOf(target) !== -1) return true;
    }
  }
  return false;
}

module.exports = {
  getAll,
  getForDesign,
  get,
  set,
  reset,
  getCarousel,
  addCarouselImage,
  removeCarouselImage,
  sanitizeCarousel,
  isImageReferenced,
  designOk,
  slotOk,
  SLOTS,
  CAROUSEL_CAP,
  UPLOAD_PATH_RE,
  _file: FILE,
};
