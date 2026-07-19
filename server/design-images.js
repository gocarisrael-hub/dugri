// design-images.js — per-design GALLERY configuration (owner self-serve).
//
// Each design ships three required "base" renders under site/assets/designs/<id>/:
//   gallery-front.webp  — the card front
//   gallery-back.webp   — the card back
//   gallery-board.webp   — the game board (only designs that ship a board)
// plus a store cover (store.webp). Those are baked into the repo and are the
// DEFAULT gallery. This store lets the owner CURATE each design's gallery WITHOUT
// a deploy:
//   • REPLACE any base render with an uploaded picture (per slot).
//   • ADD extra photos (any number), each with an optional name.
//   • CHOOSE, per picture, whether it shows on the products page (the grid card
//     carousel) and/or the product page (the detail gallery).
//   • ORDER the pictures.
//
// It REUSES content.js for image storage: an upload is saved by
// content.saveImageBytes (magic-byte typed, size-capped, content-addressed under
// DATA_DIR/content-uploads) and this store only ever holds the resulting
// "/content-uploads/<hash>.<ext>" PATH. So a picture can only ever be one THIS
// server produced — never an arbitrary / off-origin URL.
//
// Persisted store shape — only DEVIATIONS from the defaults are kept, so a design
// the owner never touched is simply absent (the client applies full defaults):
//   { [designId]: {
//       base:   { [slot]: { img?, onProducts?, onProduct? } },  // slot: store|front|back|board
//       photos: [ { id, img, name, onProducts, onProduct } ],   // owner extras
//       order:  [ key, ... ]   // display order; keys = base slots + photo ids
//   } }
//
// Persistence mirrors content.js/playbook.js: an in-memory object loaded at boot,
// mutated through helpers, written atomically (temp file + rename) on every change,
// under DATA_DIR so it survives redeploys.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'design-images.json');

// A design id: starts alphanumeric, then kebab, ≤41 chars (matches the catalog).
const DESIGN_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
// The four base (shipped-render) slots, in their default display order.
const BASE_SLOTS = ['store', 'front', 'back', 'board'];
const BASE_SLOT_SET = new Set(BASE_SLOTS);
// A stored path must be EXACTLY one content.saveImageBytes produced (16-hex
// content hash + a raster ext). Validating on write means a picture can never
// become an off-origin / stored-XSS vector.
const UPLOAD_PATH_RE = /^\/content-uploads\/[a-f0-9]{16}\.(webp|jpe?g|png)$/;
// Cap an owner-supplied photo name so the store can't be bloated with a huge string.
const NAME_MAX = 60;

function designOk(id) {
  return DESIGN_RE.test(String(id || '')) ? String(id) : null;
}
function slotOk(slot) {
  return BASE_SLOT_SET.has(String(slot || '')) ? String(slot) : null;
}
function pathOk(p) {
  return UPLOAD_PATH_RE.test(String(p || '')) ? String(p) : null;
}
function cleanName(name) {
  return String(name == null ? '' : name)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}
function boolOr(v, dflt) {
  return typeof v === 'boolean' ? v : dflt;
}

// Default per-surface visibility of a BASE slot when the owner has set no explicit
// flag. Everything shows by default EXCEPT the store cover on the product-detail
// page (that page's gallery leads with the card renders, not the shop cover). The
// CLIENT reader (site/js/design-images.js) applies the SAME rule — keep them in
// sync. The store keeps only DEVIATIONS from this default, so it stays lean.
function baseDefault(slot, flag) {
  return !(slot === 'store' && flag === 'onProduct');
}

let _store = load();
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return sanitize(raw);
  } catch {
    /* missing / unreadable — start empty */
  }
  return {};
}

// Coerce an arbitrary parsed object into the store shape, dropping anything
// malformed or off-origin. A corrupt / hand-edited file can never poison the store.
function sanitize(raw) {
  const out = {};
  for (const id of Object.keys(raw)) {
    if (!designOk(id)) continue;
    const g = normalizeDesign(raw[id]);
    if (g) out[id] = g;
  }
  return out;
}
function normalizeDesign(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  const base = {};
  if (g.base && typeof g.base === 'object') {
    for (const slot of Object.keys(g.base)) {
      if (!slotOk(slot)) continue;
      const s = g.base[slot];
      if (!s || typeof s !== 'object') continue;
      const cfg = {};
      const img = pathOk(s.img);
      if (img) cfg.img = img;
      // Keep a flag only when it deviates from the slot's default (lean store).
      for (const flag of ['onProducts', 'onProduct']) {
        if (typeof s[flag] === 'boolean' && s[flag] !== baseDefault(slot, flag))
          cfg[flag] = s[flag];
      }
      if (Object.keys(cfg).length) base[slot] = cfg;
    }
  }
  const photos = [];
  const seenIds = new Set();
  if (Array.isArray(g.photos)) {
    for (const p of g.photos) {
      if (!p || typeof p !== 'object') continue;
      const img = pathOk(p.img);
      const id = typeof p.id === 'string' && /^p[0-9]+$/.test(p.id) ? p.id : null;
      if (!img || !id || seenIds.has(id)) continue;
      seenIds.add(id);
      photos.push({
        id,
        img,
        name: cleanName(p.name),
        onProducts: boolOr(p.onProducts, true),
        onProduct: boolOr(p.onProduct, true),
      });
    }
  }
  const known = new Set([...BASE_SLOTS, ...photos.map((p) => p.id)]);
  let order = [];
  if (Array.isArray(g.order)) {
    for (const k of g.order) {
      if (known.has(k) && order.indexOf(k) === -1) order.push(k);
    }
  }
  const g2 = {};
  if (Object.keys(base).length) g2.base = base;
  if (photos.length) g2.photos = photos;
  if (order.length) g2.order = order;
  return Object.keys(g2).length ? g2 : null;
}

function save() {
  // Ensure the data dir exists before the atomic tmp-write+rename (same guard as
  // content.js/db.js) — otherwise the first write throws ENOENT.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

// Drop a design bag that no longer holds any deviation, so the store stays tidy
// (an untouched design = absent → client applies full defaults).
function prune(id) {
  const g = _store[id];
  if (!g) return;
  if (
    !(g.base && Object.keys(g.base).length) &&
    !(g.photos && g.photos.length) &&
    !(g.order && g.order.length)
  ) {
    delete _store[id];
  }
}
function ensure(id) {
  return _store[id] || (_store[id] = {});
}

// ---- reads ----------------------------------------------------------------

// The WHOLE config map (every configured design), returned BY REFERENCE for cheap
// serialization by the public GET /api/design-images (res.json copies it). Small
// (a few designs). Callers treat it as read-only.
function getAll() {
  return _store;
}

// One design's stored config (a deep copy). Absent/untouched design → {}.
function getForDesign(id) {
  const d = designOk(id);
  if (!d || !_store[d]) return {};
  return JSON.parse(JSON.stringify(_store[d]));
}

// The base-slot OVERRIDE path for a design/slot, or null when none is set (or the
// stored value is malformed). Compatibility accessor for server-side consumers
// that only need "did the owner replace this base render?" — notably the paid-order
// email product-photo lookup (get(id,'store') || get(id,'front')).
function get(id, slot) {
  const d = designOk(id);
  const s = slotOk(slot);
  if (!d || !s || !_store[d] || !_store[d].base || !_store[d].base[s]) return null;
  const p = _store[d].base[s].img;
  return UPLOAD_PATH_RE.test(String(p || '')) ? p : null;
}

// ---- base-slot overrides ---------------------------------------------------

// Replace a base slot's shipped render with an our-own upload. Returns the
// DISPLACED previous override path (or null) so the caller can reclaim its file.
function setBaseImg(id, slot, imgPath) {
  const d = designOk(id);
  const s = slotOk(slot);
  const p = pathOk(imgPath);
  if (!d || !s || !p) return { ok: false, prev: null };
  const g = ensure(d);
  const base = g.base || (g.base = {});
  const cfg = base[s] || (base[s] = {});
  const prev = cfg.img || null;
  if (prev === p) return { ok: true, prev: null };
  cfg.img = p;
  save();
  return { ok: true, prev };
}

// Revert a base slot to its shipped render (clears only the img override, keeps
// any visibility deviation). Returns the cleared path (or null).
function resetBaseImg(id, slot) {
  const d = designOk(id);
  const s = slotOk(slot);
  if (!d || !s || !_store[d] || !_store[d].base || !_store[d].base[s]) {
    return { ok: false, prev: null };
  }
  const cfg = _store[d].base[s];
  const prev = cfg.img || null;
  delete cfg.img;
  if (Object.keys(cfg).length === 0) delete _store[d].base[s];
  if (Object.keys(_store[d].base).length === 0) delete _store[d].base;
  prune(d);
  save();
  return { ok: true, prev };
}

// Set a base slot's per-surface visibility. `flags` may carry onProducts and/or
// onProduct; a value of true (the default) is stored as the ABSENCE of a
// deviation, so only real hides persist.
function setBaseFlags(id, slot, flags) {
  const d = designOk(id);
  const s = slotOk(slot);
  if (!d || !s || !flags || typeof flags !== 'object') return false;
  const g = ensure(d);
  const base = g.base || (g.base = {});
  const cfg = base[s] || (base[s] = {});
  for (const f of ['onProducts', 'onProduct']) {
    if (f in flags) {
      // Store only a DEVIATION from the slot default; a value equal to the default
      // is the absence of a deviation (keeps the store lean + reversible).
      if (!!flags[f] !== baseDefault(s, f)) cfg[f] = !!flags[f];
      else delete cfg[f];
    }
  }
  if (Object.keys(cfg).length === 0) delete base[s];
  if (Object.keys(base).length === 0) delete g.base;
  prune(d);
  save();
  return true;
}

// ---- extra photos ----------------------------------------------------------

function nextPhotoId(g) {
  let max = 0;
  for (const p of g.photos || []) {
    const m = /^p([0-9]+)$/.exec(p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'p' + (max + 1);
}

// Append an extra photo (an our-own upload path + optional name). Returns the
// created photo, or null on a bad design/path.
function addPhoto(id, imgPath, name) {
  const d = designOk(id);
  const p = pathOk(imgPath);
  if (!d || !p) return null;
  const g = ensure(d);
  const photos = g.photos || (g.photos = []);
  const photo = {
    id: nextPhotoId(g),
    img: p,
    name: cleanName(name),
    onProducts: true,
    onProduct: true,
  };
  photos.push(photo);
  if (g.order && g.order.indexOf(photo.id) === -1) g.order.push(photo.id);
  save();
  return { ...photo };
}

// Patch an extra photo's name / visibility. Returns the updated photo or null.
function updatePhoto(id, photoId, patch) {
  const d = designOk(id);
  if (!d || !_store[d] || !Array.isArray(_store[d].photos) || !patch || typeof patch !== 'object') {
    return null;
  }
  const photo = _store[d].photos.find((p) => p.id === photoId);
  if (!photo) return null;
  if ('name' in patch) photo.name = cleanName(patch.name);
  if ('onProducts' in patch) photo.onProducts = !!patch.onProducts;
  if ('onProduct' in patch) photo.onProduct = !!patch.onProduct;
  save();
  return { ...photo };
}

// Remove an extra photo (and its order entry). Returns the removed img path (so
// the caller can reclaim the file) or null when nothing was removed.
function removePhoto(id, photoId) {
  const d = designOk(id);
  if (!d || !_store[d] || !Array.isArray(_store[d].photos)) return null;
  const idx = _store[d].photos.findIndex((p) => p.id === photoId);
  if (idx === -1) return null;
  const [removed] = _store[d].photos.splice(idx, 1);
  if (_store[d].photos.length === 0) delete _store[d].photos;
  if (_store[d].order) {
    _store[d].order = _store[d].order.filter((k) => k !== photoId);
    if (_store[d].order.length === 0) delete _store[d].order;
  }
  prune(d);
  save();
  return removed.img;
}

// ---- ordering --------------------------------------------------------------

// Set the display order. `keys` may name base slots and existing photo ids in any
// arrangement; unknown / duplicate keys are dropped. Returns the stored order or
// null on a bad design.
function setOrder(id, keys) {
  const d = designOk(id);
  if (!d || !Array.isArray(keys)) return null;
  const g = ensure(d);
  const knownPhotos = new Set((g.photos || []).map((p) => p.id));
  const out = [];
  for (const k of keys) {
    if ((BASE_SLOT_SET.has(k) || knownPhotos.has(k)) && out.indexOf(k) === -1) out.push(k);
  }
  if (out.length) g.order = out;
  else delete g.order;
  prune(d);
  save();
  return out;
}

// ---- reclaim guard ---------------------------------------------------------

// Is `imgPath` referenced by ANY design (as a base override OR an extra photo)?
// Uploads are content-addressed and shared, so a caller reclaiming an orphan must
// confirm nothing here still points at it (combined with content.isImageReferenced
// on the other store). Own-property scan only.
function isImageReferenced(imgPath) {
  const target = String(imgPath || '');
  if (!target) return false;
  for (const id of Object.keys(_store)) {
    const g = _store[id] || {};
    if (g.base) {
      for (const slot of Object.keys(g.base)) {
        if (g.base[slot] && g.base[slot].img === target) return true;
      }
    }
    if (Array.isArray(g.photos)) {
      for (const p of g.photos) if (p.img === target) return true;
    }
  }
  return false;
}

module.exports = {
  getAll,
  getForDesign,
  get,
  setBaseImg,
  resetBaseImg,
  setBaseFlags,
  addPhoto,
  updatePhoto,
  removePhoto,
  setOrder,
  isImageReferenced,
  designOk,
  slotOk,
  BASE_SLOTS,
  UPLOAD_PATH_RE,
  NAME_MAX,
  _file: FILE,
};
