// content.js — the inline content-editor store. The owner edits any tagged text
// or photo on the live site (in an admin-key-gated edit mode); the overrides are
// kept here and overlaid on the shipped HTML for every visitor. Same pattern as
// server/playbook.js and server/db.js: an in-memory object loaded at boot,
// mutated through helpers, written to disk atomically (temp file + rename) on
// every change. The file (and the uploaded images) live under DATA_DIR — a
// persistent Railway volume in production — so the owner's edits survive
// redeploys and overlay the defaults that ship in site/.
//
// Store shape: { [page]: { [key]: { text?, img? } } }
//   page = an html filename ("index.html"); never a path.
//   key  = an element's data-edit id.
//   text = plain override string; img = a "/content-uploads/<name>" path this
//          server produced (the uploaded file lives in DATA_DIR/content-uploads).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'content-overrides.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'content-uploads');

// A page is always the bare html filename. Sanitize any input to a basename and
// accept only lowercase-kebab ".html" names — never a path, never traversal.
const PAGE_RE = /^[a-z0-9-]+\.html$/;
// A key is the element's data-edit id: starts alphanumeric, then kebab, ≤61 chars.
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
// Plain-text override cap (matches the client's editable cap).
const TEXT_CAP = 5000;
// Hard cap on a single uploaded image (bytes).
const IMAGE_CAP = 4 * 1024 * 1024;
// Max photos in a per-key photo array (a product carousel). Generous but bounded
// so a runaway client can't grow the store without limit.
const PHOTO_CAP = 12;
// A stored photo path must be EXACTLY one this server produced (saveImageBytes:
// a 16-hex content hash + a raster ext). Validating the array on write means the
// owner can only ever reference our own uploaded images — never an arbitrary URL
// — so the photo array can't become an off-origin / stored-XSS vector.
const UPLOAD_PATH_RE = /^\/content-uploads\/[a-f0-9]{16}\.(webp|jpe?g|png)$/;

function pageOk(page) {
  const base = path.basename(String(page || ''));
  return PAGE_RE.test(base) ? base : null;
}
function keyOk(key) {
  return KEY_RE.test(String(key || '')) ? String(key) : null;
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
  // Ensure the data dir exists before the atomic tmp-write+rename — otherwise
  // writeFileSync throws ENOENT on the first save when DATA_DIR hasn't been
  // created yet (server/db.js + playbook.js do the same guard).
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

// Sniff the image type from the leading magic bytes — NEVER trust a client-sent
// filename or Content-Type. Returns a safe extension from a tight allowlist, or
// null when the bytes are not one of the accepted formats.
//
// RASTER ONLY, on purpose. SVG is deliberately NOT accepted: an uploaded .svg is
// served from our own origin at a public /content-uploads URL, and an SVG can
// carry <script>, so allowing it would be a stored-XSS vector able to read the
// admin key from localStorage. Photos are raster anyway, so we lose nothing.
function extFromMagic(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  // WEBP: "RIFF"...."WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return '.webp';
  }
  return null;
}

// Read the override sub-tree for one page (validated). Unknown page -> {}.
// Returns the live sub-tree by reference: the sole caller (GET /api/content) only
// serializes it, and res.json already makes a fresh copy — so this is the site's
// hottest endpoint and must not deep-clone on every request. Callers must treat
// the result as read-only.
function getPage(page) {
  const p = pageOk(page);
  if (!p || !_store[p]) return {};
  return _store[p];
}

// Merge one field into a page/key entry. Returns null on a bad page/key.
function setField(page, key, field, value) {
  const p = pageOk(page);
  const k = keyOk(key);
  if (!p || !k) return null;
  const bag = _store[p] || (_store[p] = {});
  const entry = bag[k] || {};
  entry[field] = value;
  bag[k] = entry;
  save();
  return entry;
}

// Set the text override for page/key. An empty string is valid (blanks the node).
function setText(page, key, text) {
  const t = String(text == null ? '' : text).slice(0, TEXT_CAP);
  return setField(page, key, 'text', t);
}

// Set the image override for page/key to a "/content-uploads/<name>" path.
function setImg(page, key, imgPath) {
  return setField(page, key, 'img', String(imgPath || ''));
}

// ---- per-key photo ARRAY (a product carousel) ------------------------------
// Some editable surfaces are a LIST of photos (the per-product gallery on
// product.html), not a single image. These live under the same page/key store
// as everything else, in an `imgs` array of "/content-uploads/<name>" paths. A
// key with a non-empty `imgs` array is the source of truth for that carousel;
// an empty/absent array falls back to the shipped default photos on the client.

// Keep only valid, distinct, our-own upload paths, capped at PHOTO_CAP, order
// preserved. Never trusts a client-supplied string beyond the exact shape
// saveImageBytes produces.
function sanitizePhotos(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const p = String(raw || '');
    if (!UPLOAD_PATH_RE.test(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= PHOTO_CAP) break;
  }
  return out;
}

// The photo array for page/key (a fresh copy so callers can't mutate the store).
function getPhotos(page, key) {
  const p = pageOk(page);
  const k = keyOk(key);
  if (!p || !k || !_store[p] || !_store[p][k]) return [];
  const imgs = _store[p][k].imgs;
  return Array.isArray(imgs) ? imgs.slice() : [];
}

// Append one uploaded photo path to page/key's array (deduped, capped). Returns
// the new array, or null on a bad page/key/path. A no-op-append (dup or at cap)
// still returns the current array so the client stays in sync.
function addPhoto(page, key, imgPath) {
  const p = pageOk(page);
  const k = keyOk(key);
  if (!p || !k || !UPLOAD_PATH_RE.test(String(imgPath || ''))) return null;
  const next = sanitizePhotos(getPhotos(p, k).concat(String(imgPath)));
  setField(p, k, 'imgs', next);
  return next;
}

// Replace page/key's whole photo array (used for remove + reorder — the client
// sends the desired full order). Returns the sanitized array, or null on a bad
// page/key. An empty result stores `imgs: []` (the client then falls back to the
// shipped defaults); a full reset uses remove() instead.
function setPhotos(page, key, arr) {
  const p = pageOk(page);
  const k = keyOk(key);
  if (!p || !k) return null;
  const next = sanitizePhotos(arr);
  setField(p, k, 'imgs', next);
  return next;
}

// Remove a page/key override entirely (revert to the shipped default). Prunes an
// empty page bag so the store stays tidy.
function remove(page, key) {
  const p = pageOk(page);
  const k = keyOk(key);
  if (!p || !k) return false;
  if (!_store[p] || !(k in _store[p])) return false;
  delete _store[p][k];
  if (Object.keys(_store[p]).length === 0) delete _store[p];
  save();
  return true;
}

// Is `imgPath` referenced by ANY page/key in the store (as a single `img` or in an
// `imgs` array)? Uploads are content-addressed and shared across the whole store,
// so a file must NOT be deleted while any override still points at it — this guard
// makes orphan cleanup (a dropped photo upload) safe. Own-property only, so a key
// literally named "__proto__" can't smuggle in a prototype hit.
function isImageReferenced(imgPath) {
  const target = String(imgPath || '');
  if (!target) return false;
  for (const page of Object.keys(_store)) {
    const bag = _store[page];
    if (!bag) continue;
    for (const k of Object.keys(bag)) {
      const entry = bag[k] || {};
      if (entry.img === target) return true;
      if (Array.isArray(entry.imgs) && entry.imgs.indexOf(target) !== -1) return true;
    }
  }
  return false;
}

// Delete an uploaded file by its "/content-uploads/<name>" path. Used to reclaim an
// ORPHAN — a just-written upload that was then dropped (photo array at cap, or a
// content-hash duplicate that isn't the one being referenced). The name is
// re-validated to the exact hash+ext shape so this can never touch anything else.
// Returns true if a file was removed. Callers MUST first confirm the path is not
// referenced anywhere (isImageReferenced) — content-addressed files are shared.
function deleteUpload(imgPath) {
  const name = String(imgPath || '')
    .split('/')
    .pop();
  if (!/^[a-f0-9]{16}\.(webp|jpe?g|png)$/.test(name)) return false;
  const file = path.join(UPLOAD_DIR, name);
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
  } catch {
    /* best-effort cleanup — a failure just leaves the file, never throws */
  }
  return false;
}

// ---- full-store read / mirror (cross-service import) -----------------------
// Used by the one-click "import content from staging" flow (server/content-import.js
// + POST /api/admin/content/import-from-staging): read the WHOLE store to copy it,
// and replace this store with a staging one — after backing the current one up.

// The whole override store (every page), returned BY REFERENCE for cheap
// serialization by the sole admin-gated caller (GET /api/admin/content/all). res.json
// makes its own copy, so this never deep-clones. Callers must treat it as read-only.
function getAll() {
  return _store;
}

// Produce a CLEAN copy of an arbitrary store-shaped object, keeping only valid
// pages/keys and, per entry, a capped `text`, an our-own `img` upload path, and a
// sanitized `imgs` array. Anything malformed or off-origin is dropped. This is the
// "validate/stage before commit" guard: a corrupt/hostile staging payload can never
// poison this store, and an `img`/`imgs` can only ever be an our-own upload path.
function sanitizeStore(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const page of Object.keys(raw)) {
    const p = pageOk(page);
    if (!p) continue;
    const bag = raw[page];
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
    const cleanBag = {};
    for (const key of Object.keys(bag)) {
      const k = keyOk(key);
      if (!k) continue;
      const entry = bag[key];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const cleanEntry = {};
      if (typeof entry.text === 'string') cleanEntry.text = entry.text.slice(0, TEXT_CAP);
      if (typeof entry.img === 'string' && UPLOAD_PATH_RE.test(entry.img))
        cleanEntry.img = entry.img;
      if (Array.isArray(entry.imgs)) {
        const imgs = sanitizePhotos(entry.imgs);
        if (imgs.length) cleanEntry.imgs = imgs;
      }
      if (Object.keys(cleanEntry).length) cleanBag[k] = cleanEntry;
    }
    if (Object.keys(cleanBag).length) out[p] = cleanBag;
  }
  return out;
}

// Every distinct our-own upload path referenced by a store (single `img` or an
// `imgs` array), so the importer knows which image files to fetch + re-save.
function collectImagePaths(store) {
  const set = new Set();
  if (!store || typeof store !== 'object') return [];
  for (const page of Object.keys(store)) {
    const bag = store[page];
    if (!bag || typeof bag !== 'object') continue;
    for (const key of Object.keys(bag)) {
      const entry = bag[key] || {};
      if (typeof entry.img === 'string' && UPLOAD_PATH_RE.test(entry.img)) set.add(entry.img);
      if (Array.isArray(entry.imgs)) {
        for (const im of entry.imgs) {
          const s = String(im || '');
          if (UPLOAD_PATH_RE.test(s)) set.add(s);
        }
      }
    }
  }
  return Array.from(set);
}

// Copy the current content-overrides.json to a timestamped backup on the volume,
// BEFORE a destructive mirror overwrites it — a recovery point. Returns the backup
// path, or null when there is nothing to back up / the copy failed (best-effort).
function backup() {
  try {
    if (!fs.existsSync(FILE)) return null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const dest = path.join(DATA_DIR, `content-overrides.backup-${Date.now()}.json`);
    fs.copyFileSync(FILE, dest);
    return dest;
  } catch {
    return null; // best-effort — never throw
  }
}

// Replace the ENTIRE store with a mirror of `raw` (sanitized) and persist it. Used
// only by the cross-service import, AFTER backup(). Returns the sanitized store.
function replaceAll(raw) {
  _store = sanitizeStore(raw);
  save();
  return _store;
}

// Persist raw image bytes under DATA_DIR/content-uploads and return the public
// "/content-uploads/<name>" path. The name is a content hash + the sniffed
// extension, so identical bytes de-dupe and the extension can't be spoofed.
// Throws on an oversized upload or an unrecognized image type.
function saveImageBytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('empty upload');
  if (buf.length > IMAGE_CAP) throw new Error('image too large');
  const ext = extFromMagic(buf);
  if (!ext) throw new Error('unsupported image type');
  const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) + ext;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const dest = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(dest)) {
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  }
  return '/content-uploads/' + name;
}

module.exports = {
  getPage,
  setText,
  setImg,
  getPhotos,
  addPhoto,
  setPhotos,
  sanitizePhotos,
  isImageReferenced,
  deleteUpload,
  remove,
  getAll,
  sanitizeStore,
  collectImagePaths,
  backup,
  replaceAll,
  saveImageBytes,
  extFromMagic,
  pageOk,
  keyOk,
  _file: FILE,
  _uploadDir: UPLOAD_DIR,
  IMAGE_CAP,
  TEXT_CAP,
  PHOTO_CAP,
};
