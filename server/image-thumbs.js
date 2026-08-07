// image-thumbs.js — SMALL on-demand derivatives of the owner's gallery uploads.
//
// The gallery uploads (server/design-images.js → content-uploads) are real
// photographs: 180 KB–1 MB each, sized for the product page where they are shown
// big. Some surfaces show the SAME picture at postage-stamp size — notably the
// wizard's design picker, a dozen tiles about 150 px wide. Serving the originals
// there would put multiple MB on the first screen of the funnel, on the page
// whose thumbnails are deliberately 5–10 KB because heavier ones white-screen the
// Instagram in-app browser (our main audience). This module is what stands
// between those two facts: it hands a surface a ~15 KB version of the picture.
//
// HOW: shells out to generator/thumb_image.py (Python + Pillow, already in the
// image — same pattern as templates.js shrinkSvgImages) and caches the result on
// the volume under DATA_DIR/content-thumbs.
//
// LAZY, not at upload time, for two reasons: the pictures the owner has ALREADY
// uploaded need no backfill migration, and a design nobody opens costs nothing.
// The source name is a CONTENT HASH, so a derivative can never go stale — the
// same name is always the same bytes — which is what makes "generate once, cache
// forever, serve immutable" correct rather than merely convenient.
//
// FAIL-SAFE: every failure path (no Python, no Pillow, an undecodable upload, a
// timeout) resolves to null so the caller 404s and the client falls back to the
// shipped render. It NEVER falls back to serving the original — that would
// reintroduce the multi-MB page this module exists to prevent.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const content = require('./content');

const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const CACHE_DIR = path.join(DATA_DIR, 'content-thumbs');
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'generator', 'thumb_image.py');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
// Longest side, in px. ~2× the widest surface that uses these (a ~150 px picker
// tile) so it stays sharp on a retina phone, and small enough to land in tens of
// KB. Part of the cache filename, so changing it invalidates cleanly.
const MAXPX = Math.max(1, Number(process.env.DESIGN_THUMB_MAXPX) || 400);
// A resize is a fraction of a second; anything near this is a broken environment.
const TIMEOUT_MS = Math.max(1000, Number(process.env.DESIGN_THUMB_TIMEOUT_MS) || 20000);
// EXACTLY the shape content.saveImageBytes produces (16-hex content hash + an
// allowlisted raster ext) — no traversal, no arbitrary read.
const NAME_RE = /^[a-f0-9]{16}\.(webp|jpe?g|png)$/;
const MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png' };

// One generation per name at a time: a picker paints a dozen tiles at once and
// two shoppers can arrive together, so without this the same picture would spawn
// a Python process per request.
const inflight = new Map();
// Names whose generation FAILED. Without Pillow every request would otherwise pay
// a process spawn to fail again; the client has already fallen back by then, so
// remembering the failure costs nothing and protects the box. Process-lifetime
// only — a deploy (or a restart) retries.
const failed = new Set();

/** The cached derivative's path for an upload name. The px cap is in the name so
 *  a changed cap yields a new file instead of a stale one. Extension-less: the
 *  encoder picks WebP or JPEG (Pillow is not guaranteed to have WebP), and the
 *  bytes themselves say which — see typeOf. */
function cachePath(name) {
  return path.join(CACHE_DIR, name.replace(/\.[a-z]+$/i, '') + '-' + MAXPX + '.thumb');
}

/** The content type of a generated derivative, sniffed from its own bytes (the
 *  same magic-byte typing content.saveImageBytes uses on the way in). null when
 *  the file is missing or is not a raster we recognize. */
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

/** Run the resizer. Resolves true only on a clean exit — never throws. `runner`
 *  is injectable so tests can exercise the failure paths without Python. */
function runResize(src, dest, runner) {
  return new Promise((resolve) => {
    let child;
    try {
      child = (runner || spawn)(PYTHON_BIN, [SCRIPT, src, dest, String(MAXPX)], {
        timeout: TIMEOUT_MS,
        stdio: 'ignore',
      });
    } catch {
      return resolve(false);
    }
    if (!child || typeof child.on !== 'function') return resolve(false);
    // A missing interpreter surfaces as 'error', a crash/timeout as a non-zero
    // code; both mean "no thumbnail", never "serve the original".
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * The small derivative for an upload `name` — `{ file, type }` (an absolute path
 * + its content type) or null when one cannot be produced.
 *
 * Cache hit → returned immediately. Miss → generated once (concurrent callers
 * share the one run) into a temp file and renamed into place, so a killed process
 * can never leave a truncated file to be served forever.
 */
function get(name, opts = {}) {
  const n = String(name || '');
  if (!NAME_RE.test(n)) return Promise.resolve(null);
  const dest = cachePath(n);
  const hit = typeOf(dest);
  if (hit) return Promise.resolve({ file: dest, type: hit });
  if (failed.has(n)) return Promise.resolve(null);
  if (inflight.has(n)) return inflight.get(n);

  const src = path.join(opts.uploadDir || content._uploadDir, n);
  const job = (async () => {
    if (!fs.existsSync(src)) return null;
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const ok = await runResize(src, tmp, opts.runner);
      const type = ok ? typeOf(tmp) : null;
      if (!type) {
        failed.add(n);
        return null;
      }
      fs.renameSync(tmp, dest);
      return { file: dest, type };
    } catch {
      failed.add(n);
      return null;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already renamed away, or never written */
      }
      inflight.delete(n);
    }
  })();
  inflight.set(n, job);
  return job;
}

// NOT garbage-collected alongside the source upload, deliberately: a derivative
// is ~15 KB and content-addressed, so an orphan is negligible clutter and a
// re-upload of the same bytes re-uses it. Keeping it out of the reclaim paths
// keeps those (shared by three stores) untouched.

module.exports = { get, _cacheDir: CACHE_DIR, _script: SCRIPT, MAXPX, NAME_RE };
