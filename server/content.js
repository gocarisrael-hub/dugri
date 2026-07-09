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
  remove,
  saveImageBytes,
  extFromMagic,
  pageOk,
  keyOk,
  _file: FILE,
  _uploadDir: UPLOAD_DIR,
  IMAGE_CAP,
  TEXT_CAP,
};
