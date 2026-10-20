// photo-fallback.js — OWNER OVERRIDES for the photo card's four fallback pawns.
//
// The deck's FIRST card is the PHOTO CARD: the customer's four pawn photos. An
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
//   { "slots": { "1": "/content-uploads/<hash>.<ext>", "3": "..." },
//     "variants": { "3": { "original": "/content-uploads/…", "centred": "/content-uploads/…" } } }
//
// `slots` is the ONLY key the generator reads, and it always holds the file in
// use. `variants` exists only for a slot whose upload was auto-centred
// (generator/pawn_normalise.py, run by the upload route): it remembers both
// files so the owner can switch to her original and back. A slot without an
// entry there was stored as uploaded.
//
// THE GENERATOR READS THIS FILE. generator/config.py:photo_fallback_paths()
// consults it before falling back to the shipped set, mapping a stored
// "/content-uploads/<name>" to "<DATA_DIR>/content-uploads/<name>" on disk. See
// docs/photo-fallback-overrides.md for that contract — changing the shape here
// changes what production prints.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
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
  return { slots: {}, variants: {} };
}

// Drop anything that is not a known slot pointing at one of our own uploads.
// Applied on LOAD as well as on write, so a hand-edited or restored file can
// never introduce an off-origin path.
function sanitize(raw) {
  const out = { slots: {}, variants: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const slots = raw.slots;
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return out;
  for (const slot of SLOTS) {
    const v = slots[slot];
    if (imgOk(v)) out.slots[slot] = String(v);
  }
  // A variant pair survives only whole, only for a slot that is set, and only
  // while the slot holds one of its two files — anything else is a pair that no
  // longer describes what prints.
  const variants = raw.variants && typeof raw.variants === 'object' ? raw.variants : {};
  for (const slot of Object.keys(out.slots)) {
    const v = variants[slot];
    if (!v || !imgOk(v.original) || !imgOk(v.centred) || v.original === v.centred) continue;
    if (out.slots[slot] !== v.original && out.slots[slot] !== v.centred) continue;
    out.variants[slot] = { original: String(v.original), centred: String(v.centred) };
  }
  return out;
}

function save() {
  // Ensure the data dir exists before the atomic tmp-write+rename (same guard as
  // content.js/design-images.js) — otherwise the first write throws ENOENT.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  // `variants` is written only when there is one, so a store with no
  // auto-centred upload stays byte-for-byte the shape it always was.
  const out = { slots: _store.slots };
  if (Object.keys(_store.variants).length) out.variants = _store.variants;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
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

/** Every file a slot holds on to: the one in use and both variants. */
function slotFiles(s) {
  const v = _store.variants[s];
  return [_store.slots[s], v && v.original, v && v.centred].filter(Boolean);
}

/**
 * Point a slot at an uploaded image. Returns `{ prev, displaced }`: `prev` is
 * the file it used before, and `displaced` every file the slot no longer holds
 * (the old variant pair included), so the caller can reclaim each one when
 * nothing else references it. Throws on a bad slot or a path we did not produce.
 *
 * `variants` ({ original, centred }) records an auto-centred upload: `imgPath`
 * must be one of the two. Omitted, the slot holds the upload as it came.
 */
function setSlot(slot, imgPath, variants = null) {
  const s = slotOk(slot);
  if (!s) throw new Error('bad slot');
  if (!imgOk(imgPath)) throw new Error('bad image path');
  if (variants) {
    if (!imgOk(variants.original) || !imgOk(variants.centred)) throw new Error('bad image path');
    if (imgPath !== variants.original && imgPath !== variants.centred) {
      throw new Error('the slot must hold one of its variants');
    }
  }
  const before = slotFiles(s);
  const prev = _store.slots[s] || null;
  _store.slots[s] = String(imgPath);
  if (variants && variants.original !== variants.centred) {
    _store.variants[s] = { original: String(variants.original), centred: String(variants.centred) };
  } else {
    delete _store.variants[s];
  }
  const after = new Set(slotFiles(s));
  // Re-pointing a slot at the image it already holds is a no-op, NOT a
  // displacement — returning it as `prev` would have the caller reclaim the file
  // the slot still uses.
  if (prev === imgPath && before.every((f) => after.has(f))) {
    save();
    return { prev: null, displaced: [] };
  }
  save();
  return {
    prev: prev === imgPath ? null : prev,
    displaced: [...new Set(before)].filter((f) => !after.has(f)),
  };
}

/**
 * Switch an auto-centred slot between the owner's ORIGINAL upload and the
 * CENTRED copy. Nothing is deleted either way — both files stay referenced, so
 * switching back is always possible. Returns `{ img }`, or `{ error }` when the
 * slot has no pair to switch between.
 */
function useVariant(slot, which) {
  const s = slotOk(slot);
  if (!s) return { error: 'bad slot' };
  const v = _store.variants[s];
  if (!v) return { error: 'this pawn has no centred copy to switch with' };
  if (which !== 'original' && which !== 'centred')
    return { error: 'use must be original or centred' };
  _store.slots[s] = v[which];
  save();
  return { img: v[which] };
}

/** The `{ original, centred }` pair of an auto-centred slot, or null. */
function getVariants(slot) {
  const s = slotOk(slot);
  const v = s && _store.variants[s];
  return v ? { ...v } : null;
}

/**
 * Revert a slot to its shipped pawn by REMOVING the override. Returns
 * `{ prev }` for reclaiming.
 */
function resetSlot(slot) {
  const s = slotOk(slot);
  if (!s) throw new Error('bad slot');
  const prev = _store.slots[s] || null;
  if (!prev) return { prev: null, displaced: [] };
  const displaced = [...new Set(slotFiles(s))];
  delete _store.slots[s];
  delete _store.variants[s];
  save();
  return { prev, displaced };
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
  return SLOTS.some((s) => slotFiles(s).includes(target));
}

// ---- auto-centring an upload ------------------------------------------------
// A pawn is drawn into its slot by its CANVAS, on the site and in print alike, so
// an upload cropped tight on two sides prints off-centre and too big (the
// owner's green and gold pawns, 2026-10-20). generator/pawn_normalise.py trims it
// to its ink and pads it centred onto a square; see that file for the rule.
// Run ONCE at upload, on the stored file, so the site and the print keep reading
// the same bytes — never at render, where two implementations could drift.
const NORMALISE_SCRIPT = path.join(__dirname, '..', 'generator', 'pawn_normalise.py');
const NORMALISE_TIMEOUT_MS = 60000;

/**
 * Centre the uploaded image at `file`. Resolves `{ buf, reason }`: `buf` is the
 * centred PNG, or null when the image was left as it is (a photo with no
 * transparency, something Pillow cannot read, or a Python that failed). Never
 * rejects — a broken normaliser must not cost the owner her upload, so every
 * failure comes back as "keep the original" with the reason.
 *
 * Asynchronous on purpose: a synchronous spawn stalls every request the server
 * is handling for as long as Pillow takes (see the redetect job's history).
 * `runner` is injectable for tests: (bin, args, opts, cb) like execFile.
 */
function normaliseUpload(file, { pythonBin = 'python3', runner = execFile } = {}) {
  return new Promise((resolve) => {
    let dir;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pawn-'));
    } catch (e) {
      resolve({ buf: null, reason: 'no temp dir: ' + e.message });
      return;
    }
    const out = path.join(dir, 'centred.png');
    const done = (r) => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(r);
    };
    runner(
      pythonBin,
      [NORMALISE_SCRIPT, file, out],
      { timeout: NORMALISE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return done({ buf: null, reason: 'normaliser failed: ' + err.message });
        let info = {};
        try {
          info = JSON.parse(
            String(stdout || '')
              .trim()
              .split('\n')
              .pop() || '{}'
          );
        } catch {
          return done({ buf: null, reason: 'normaliser said nothing readable' });
        }
        if (!info.normalised)
          return done({ buf: null, reason: String(info.reason || 'left as is') });
        let buf = null;
        try {
          buf = fs.readFileSync(out);
        } catch (e) {
          return done({ buf: null, reason: 'no output: ' + e.message });
        }
        done({ buf, reason: String(info.reason || 'centred') });
      }
    );
  });
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
  useVariant,
  getVariants,
  normaliseUpload,
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
