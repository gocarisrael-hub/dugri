// image-thumbs.js — DOWNSCALED DERIVATIVES of the owner's gallery uploads.
//
// THE PROBLEM. The uploads (server/design-images.js → content-uploads) are real
// camera files: up to 4032x4032 and 3.4 MB. Every surface that shows them paints
// them into a box between roughly 100 and 400 CSS px — a shop tile is 163 px
// wide on a phone and was receiving a 3021x2417 photograph, about 97x the pixels
// the screen can display. Measured on a 390x844 viewport against the owner's real
// gallery, /products.html transferred 26 MB of images before a single tap.
//
// THIS MODULE serves, per upload, a LADDER of widths so an <img srcset> can pick
// the one that fits its box. It shells out to generator/thumb_image.py (Python +
// Pillow, already in the image — the same pattern as templates.js
// shrinkSvgImages) and caches the result on the volume under
// DATA_DIR/content-derivatives.
//
// ── INVARIANT 1: ONE authority on output geometry ────────────────────────────
// generator/thumb_image.py `fit()` decides the output pixels, by ONE rule:
//     out_width = min(source_width, rung)
// and this module's `candidatesForDims` advertises exactly `min(source_width,
// rung)` as the srcset `w` descriptor. The descriptor is not an independent
// assertion about the file — it is the same expression the resizer evaluates, so
// the two cannot drift. tests/unit/design-derivative-geometry.test.js pins this
// by running real portraits, landscapes and squares through the REAL resizer and
// reading the produced width back out of the bytes.
//
// ── INVARIANT 2: the cache key AND the public URL carry the output revision ──
// The route serves `immutable` for a year, so changing what the bytes look like
// while keeping the URL would leave every browser holding a stale copy until
// 2027. REV covers everything that changes the output — encoder, quality, colour
// handling, the geometry rule — and appears in BOTH the on-disk filename and the
// public URL, so a bump is a clean cutover. `sweepStale()` deletes the previous
// generation's files at boot, so a bump does not orphan the volume either.
//
// ── INVARIANT 3: failure is PER PICTURE, never global ────────────────────────
// One undecodable upload must not cost any other picture its derivative. The
// failure memo is keyed by (name, width) — never a module-wide streak or breaker,
// which in an earlier attempt let three unrelated failures 404 the whole catalog.
// Host pressure is handled by BOUNDING CONCURRENCY (a queue, `MAX_PARALLEL`)
// rather than by shedding work: a queued job waits, it is never cancelled. A
// child killed by a signal (OOM, timeout) records a failure for that (name,width)
// so it cannot re-spawn Python forever.
//
// LAZY, not at upload time: the pictures already uploaded need no backfill, and a
// design nobody opens costs nothing. The source name is a CONTENT HASH, so a
// derivative can never go stale — the same name is always the same bytes — which
// is what makes "generate once, cache forever, serve immutable" correct.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const content = require('./content');

const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const CACHE_DIR = path.join(DATA_DIR, 'content-derivatives');
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'generator', 'thumb_image.py');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

// EVERYTHING that changes the produced bytes, in one token. Bump it when the
// resizer's encoder, quality, colour/alpha handling or geometry rule changes.
// It is in the public URL as well as the filename — see the header note.
//   r1 = webp q80 / jpeg q82 fallback, width-capped, alpha preserved
const REV = 'r1';

// The width ladder. Chosen against the boxes these pictures actually paint into
// at a 2x device pixel ratio, so `sizes` lands on a rung rather than just above
// one: a 163 px shop tile needs 326 → 400; a full-width product slide is ~358 px
// → 716 → 800; the wizard picker's ~150 px tile → 300 → 400. 1200/1600 exist for
// desktop and for the fullscreen zoom.
const RUNGS = [200, 400, 800, 1200, 1600];
const RUNG_SET = new Set(RUNGS);

// A resize is a fraction of a second; anything near this is a broken environment.
const TIMEOUT_MS = Math.max(1000, Number(process.env.DESIGN_THUMB_TIMEOUT_MS) || 20000);
// How many resizes may run at once. This is the load valve — see INVARIANT 3. A
// grid paints eight cards at once and several shoppers can arrive together; the
// answer is to make them QUEUE, not to start failing pictures.
const MAX_PARALLEL = Math.max(1, Number(process.env.DESIGN_THUMB_PARALLEL) || 2);

// EXACTLY the shape content.saveImageBytes produces (16-hex content hash + an
// allowlisted raster ext) — no traversal, no arbitrary read.
const NAME_RE = /^[a-f0-9]{16}\.(webp|jpe?g|png)$/;
const MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png' };

// ---- source dimensions -----------------------------------------------------
//
// Read from the file's own header, in pure JS — no Pillow, so a host without it
// still gets correct srcset descriptors (the derivative 404s and the client falls
// back, but nothing is ever advertised wrongly). EXIF orientation is applied,
// because thumb_image.py runs exif_transpose BEFORE fit(): a sideways-shot photo
// is resized from its UPRIGHT dimensions, so the descriptor must come from those
// too. tests/unit/design-derivative-dims.test.js cross-checks this parser against
// Pillow's own post-transpose size for all eight orientations.

/** EXIF Orientation (tag 274) from a TIFF header buffer, or 1 when absent. */
function exifOrientation(buf) {
  try {
    if (buf.length < 8) return 1;
    const le = buf[0] === 0x49 && buf[1] === 0x49;
    const be = buf[0] === 0x4d && buf[1] === 0x4d;
    if (!le && !be) return 1;
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd = u32(4);
    if (ifd + 2 > buf.length) return 1;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > buf.length) break;
      if (u16(e) === 274) return u16(e + 8) || 1;
    }
  } catch {
    /* malformed EXIF — treat as upright */
  }
  return 1;
}

/** Orientations 5..8 swap the axes (Pillow's exif_transpose does the same). */
function swapsAxes(orientation) {
  return orientation >= 5 && orientation <= 8;
}

function pngDims(buf) {
  // IHDR is always the first chunk: width at 16, height at 20 (big-endian u32).
  if (buf.length < 24) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!w || !h) return null;
  let o = 1;
  // An eXIf chunk may carry orientation. Walk the chunk list (bounded).
  let p = 8;
  for (let guard = 0; guard < 64 && p + 8 <= buf.length; guard++) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'eXIf' && p + 8 + len <= buf.length) {
      o = exifOrientation(buf.subarray(p + 8, p + 8 + len));
      break;
    }
    p += 12 + len;
    if (len < 0 || !Number.isFinite(len)) break;
  }
  return swapsAxes(o) ? { w: h, h: w } : { w, h };
}

function jpegDims(buf) {
  let p = 2; // past SOI
  let o = 1;
  let dims = null;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = buf[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    const len = buf.readUInt16BE(p + 2);
    if (len < 2) break;
    // APP1/Exif → orientation.
    if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      o = exifOrientation(buf.subarray(p + 10, p + 2 + len));
    }
    // SOF0..SOF15 (skipping the non-frame DHT/JPG/DAC markers) carry the size.
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF && p + 9 <= buf.length) {
      dims = { w: buf.readUInt16BE(p + 7), h: buf.readUInt16BE(p + 5) };
      // Keep walking only if orientation hasn't been seen yet; APP1 always
      // precedes SOF in practice, so we can stop here.
      break;
    }
    p += 2 + len;
  }
  if (!dims || !dims.w || !dims.h) return null;
  return swapsAxes(o) ? { w: dims.h, h: dims.w } : dims;
}

function webpDims(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  let p = 12;
  let dims = null;
  let o = 1;
  while (p + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (fourcc === 'VP8X' && body + 10 <= buf.length) {
      dims = {
        w: 1 + (buf[body + 4] | (buf[body + 5] << 8) | (buf[body + 6] << 16)),
        h: 1 + (buf[body + 7] | (buf[body + 8] << 8) | (buf[body + 9] << 16)),
      };
    } else if (fourcc === 'VP8 ' && body + 10 <= buf.length) {
      dims = { w: buf.readUInt16LE(body + 6) & 0x3fff, h: buf.readUInt16LE(body + 8) & 0x3fff };
    } else if (fourcc === 'VP8L' && body + 5 <= buf.length) {
      const b = buf.readUInt32LE(body + 1);
      dims = { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    } else if (fourcc === 'EXIF' && body + size <= buf.length) {
      o = exifOrientation(buf.subarray(body, body + size));
    }
    p = body + size + (size % 2);
    if (!Number.isFinite(size) || size <= 0) break;
  }
  if (!dims || !dims.w || !dims.h) return null;
  return swapsAxes(o) ? { w: dims.h, h: dims.w } : dims;
}

/** Pixel dimensions of a raster file, or null when it isn't one we can read.
 *  Exported for the cross-check test. */
function dimsOfFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    // 64 KB is comfortably past IHDR / the JPEG APP1+SOF headers / the WebP
    // chunk list, without reading a 3 MB photo to learn two numbers.
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, 65536, 0);
    const head = buf.subarray(0, read);
    if (head.length < 16) return null;
    if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return pngDims(head);
    if (head[0] === 0xff && head[1] === 0xd8) return jpegDims(head);
    if (head.toString('latin1', 0, 4) === 'RIFF') return webpDims(head);
    return null;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

// Memoized per upload NAME. Sources are content-addressed, so a name's pixel
// dimensions are immutable — this can never serve a stale answer.
//
// A FAILED read is memoized only when the file is actually there and unreadable.
// A name whose file is simply ABSENT is never remembered: uploads are
// content-addressed, so the same bytes always land on the same name and a
// picture can legitimately appear later (a staging mirror fetching images after
// the config, say). Caching that absence would blacklist the upload for the life
// of the process.
const dimsCache = new Map();
function dims(name, opts = {}) {
  const n = String(name || '');
  if (!NAME_RE.test(n)) return null;
  if (dimsCache.has(n)) return dimsCache.get(n);
  const file = path.join(opts.uploadDir || content._uploadDir, n);
  const d = dimsOfFile(file);
  if (d || fs.existsSync(file)) dimsCache.set(n, d);
  return d;
}

// ---- the candidate ladder ---------------------------------------------------

/** Public URL for one rung of one upload. The REVISION is in the path — see
 *  INVARIANT 2. */
function urlFor(name, rung) {
  return `/design-img/${REV}/${rung}/${name}`;
}

/**
 * The srcset candidates for a source of these dimensions: `[{ w, rung }]`
 * ascending, where `w` is the descriptor and `rung` is the number that goes in
 * the URL.
 *
 * `w` is `min(source_width, rung)` — LITERALLY the expression thumb_image.py's
 * fit() evaluates — so the advertised width is the produced width. A rung above
 * the source width still resolves to the source width (never upscaled), so it is
 * de-duplicated away rather than advertised twice.
 */
function candidatesForDims(d) {
  if (!d || !(d.w > 0) || !(d.h > 0)) return [];
  const out = [];
  const seen = new Set();
  for (const rung of RUNGS) {
    const w = Math.min(d.w, rung);
    if (seen.has(w)) continue;
    seen.add(w);
    out.push({ w, rung });
  }
  return out;
}

/** The srcset string for an upload NAME, or '' when its dimensions are unknown
 *  (the caller then keeps a plain `src` — never a wrong descriptor). */
function srcsetFor(name, opts) {
  const d = dims(name, opts);
  return candidatesForDims(d)
    .map((c) => `${urlFor(name, c.rung)} ${c.w}w`)
    .join(', ');
}

// ---- generation -------------------------------------------------------------

/** Cache path for (name, effective width). REV is in the filename so a bump
 *  yields a new file rather than a stale one, and sweepStale can find the
 *  previous generation by its absence of the current token. */
function cachePath(name, width) {
  return path.join(CACHE_DIR, `${name.replace(/\.[a-z]+$/i, '')}-${REV}-${width}.der`);
}

/** The content type of a generated derivative, sniffed from its own bytes (the
 *  same magic-byte typing content.saveImageBytes uses on the way in). */
function typeOf(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, 16, 0);
    return MIME[content.extFromMagic(head.subarray(0, read))] || null;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

// One generation per (name,width) at a time: a grid paints many tiles at once and
// two shoppers can arrive together, so without this the same picture would spawn
// a Python process per request.
const inflight = new Map();
// (name,width) pairs whose generation FAILED — an undecodable upload, a missing
// Pillow, a child killed by a signal. PER PICTURE (see INVARIANT 3): there is no
// module-wide breaker, so one broken upload can never take the catalog with it.
// Process-lifetime only — a deploy or restart retries.
const failed = new Set();

// The concurrency valve. `running` is the number of live Python children; jobs
// past MAX_PARALLEL wait in `queue` and run later. Waiting is the ONLY back-off:
// a queued job is never dropped, so pressure delays a picture, it never loses one.
let running = 0;
const queue = [];
function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}
function schedule(job) {
  return new Promise((resolve) => {
    queue.push(() => job().then(resolve, () => resolve(false)));
    pump();
  });
}

/** Run the resizer. Resolves true only on a clean exit — never throws. `runner`
 *  is injectable so tests can exercise the failure paths without Python. */
function runResize(src, dest, width, runner) {
  return new Promise((resolve) => {
    let child;
    try {
      child = (runner || spawn)(PYTHON_BIN, [SCRIPT, src, dest, String(width)], {
        timeout: TIMEOUT_MS,
        stdio: 'ignore',
      });
    } catch {
      return resolve(false);
    }
    if (!child || typeof child.on !== 'function') return resolve(false);
    // A missing interpreter surfaces as 'error'; a crash, a timeout kill or an
    // OOM as a non-zero code or a signal. All of them mean "no derivative for
    // THIS picture at THIS width", never "serve the original".
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * The derivative of `name` at `rung` — `{ file, type, width }` or null.
 *
 * `rung` must be one of RUNGS (the public URL only ever carries one). The
 * EFFECTIVE width is `min(sourceWidth, rung)`, which is both what the resizer
 * produces and what the srcset advertises, so two rungs above a small source
 * share ONE cache file instead of duplicating identical bytes.
 */
function get(name, rung, opts = {}) {
  const n = String(name || '');
  const r = Number(rung);
  if (!NAME_RE.test(n) || !RUNG_SET.has(r)) return Promise.resolve(null);
  const d = dims(n, opts);
  // Unknown dimensions (unreadable / missing) — no width to produce.
  if (!d) return Promise.resolve(null);
  const width = Math.min(d.w, r);

  const key = `${n}@${width}`;
  const dest = cachePath(n, width);
  const hit = typeOf(dest);
  if (hit) return Promise.resolve({ file: dest, type: hit, width });
  if (failed.has(key)) return Promise.resolve(null);
  if (inflight.has(key)) return inflight.get(key);

  const src = path.join(opts.uploadDir || content._uploadDir, n);
  // Deferred to a microtask so `inflight.set` below has ALWAYS run before the
  // body's `finally` clears it. A path that finishes without ever awaiting (a
  // source that isn't there) would otherwise delete nothing and then be recorded
  // — leaving a resolved promise in the map for good. That is a memory leak any
  // client could drive by requesting well-formed names that don't exist.
  const job = Promise.resolve().then(async () => {
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      // No `failed` entry for a missing source: unlike a broken resizer this can
      // legitimately become true later (uploads are content-addressed, so the
      // same bytes always land on this same name).
      if (!fs.existsSync(src)) return null;
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const ok = await schedule(() => runResize(src, tmp, width, opts.runner));
      const type = ok ? typeOf(tmp) : null;
      if (!type) {
        // PER (name,width) — never a global streak.
        failed.add(key);
        return null;
      }
      fs.renameSync(tmp, dest);
      return { file: dest, type, width };
    } catch {
      failed.add(key);
      return null;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already renamed away, or never written */
      }
      inflight.delete(key);
    }
  });
  inflight.set(key, job);
  return job;
}

// ---- reclaiming the previous generation ------------------------------------

/**
 * Delete cached derivatives that are NOT of the current REV, plus any leftover
 * temp files and the pre-ladder `*.thumb` files. Called once at boot.
 *
 * This is the other half of INVARIANT 2: bumping REV changes the URL and the
 * filename, which would otherwise leave the old generation on the volume forever.
 * Safe to run at any time — a swept file is regenerated on demand.
 */
function sweepStale() {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const keep = f.endsWith('.der') && f.includes(`-${REV}-`) && !f.endsWith('.tmp');
      if (keep) continue;
      try {
        fs.unlinkSync(path.join(CACHE_DIR, f));
        removed++;
      } catch {
        /* raced with another worker — fine */
      }
    }
  } catch {
    /* no cache dir yet */
  }
  return removed;
}

module.exports = {
  get,
  dims,
  dimsOfFile,
  candidatesForDims,
  srcsetFor,
  urlFor,
  sweepStale,
  REV,
  RUNGS,
  // Test seams.
  _cacheDir: CACHE_DIR,
  _script: SCRIPT,
  _inflight: inflight,
};
