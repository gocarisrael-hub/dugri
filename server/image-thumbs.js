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
// Longest side, in px, for a request that names no width — the wizard's design
// picker, whose tiles are ~150 px wide. Part of the cache filename, so changing
// it invalidates cleanly.
const MAXPX = Math.max(1, Number(process.env.DESIGN_THUMB_MAXPX) || 400);
// The LADDER the storefront picks from via srcset. One size can't serve both a
// 163 px grid tile and a full-width product photo: the tile only ever needs 400
// (163 CSS px × DPR 3 ≈ 490, and `object-fit: contain` in a landscape box makes
// the real need smaller still), while the detail page wants the top rung. 1200
// is the ceiling on purpose — a 390 px phone at DPR 3 resolves 1170 device px,
// so anything beyond it is pixels no phone screen can display.
//
// A CLOSED set, not an arbitrary ?w=: every distinct value is a Python spawn and
// a cached file on the volume, so an open parameter would let any client fill
// the disk and pin the CPU.
const WIDTHS = [400, 800, 1200];
// MAXPX is included so an env override still resolves (it is the no-width default).
const ALLOWED_PX = new Set([...WIDTHS, MAXPX]);

/** The px cap for a requested width: the number itself when it is one we serve,
 *  MAXPX when none was asked for, else null (refused — see WIDTHS). */
function pxOk(px) {
  if (px == null || px === '') return MAXPX;
  const n = Number(px);
  return Number.isInteger(n) && ALLOWED_PX.has(n) ? n : null;
}
// A resize is a fraction of a second; anything near this is a broken environment.
const TIMEOUT_MS = Math.max(1000, Number(process.env.DESIGN_THUMB_TIMEOUT_MS) || 20000);
// EXACTLY the shape content.saveImageBytes produces (16-hex content hash + an
// allowlisted raster ext) — no traversal, no arbitrary read.
const NAME_RE = /^[a-f0-9]{16}\.(webp|jpe?g|png)$/;
const MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png' };

// One generation per name+size at a time: a grid paints ten cards at once and two
// shoppers can arrive together, so without this the same picture would spawn a
// Python process per request. Keyed by SIZE too — 400 and 800 are different
// files, and sharing one entry would hand a caller the wrong one.
const inflight = new Map();
// name+size pairs whose generation FAILED. Without Pillow every request would
// otherwise pay a process spawn to fail again; the client has already fallen back
// by then, so remembering the failure costs nothing and protects the box.
// Process-lifetime only — a deploy (or a restart) retries.
const failed = new Set();

/** The cache key for one derivative: the source name AND the px cap, since the
 *  same picture legitimately has one file per rung of the ladder. */
function keyOf(name, px) {
  return name + '@' + px;
}

/** The cached derivative's path for an upload name at a px cap. The cap is in the
 *  name so a changed cap yields a new file instead of a stale one. Extension-less:
 *  the encoder picks WebP or JPEG (Pillow is not guaranteed to have WebP), and the
 *  bytes themselves say which — see typeOf. */
function cachePath(name, px) {
  return path.join(CACHE_DIR, name.replace(/\.[a-z]+$/i, '') + '-' + px + '.thumb');
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

// At most this many resizes at once. A cold cache on a busy page is the whole
// catalog arriving together — ten cards times three rungs — and spawning that
// many Pythons at once on a small Railway box is how you hit EAGAIN. Which used
// to be self-inflicted AND permanent: a failed spawn was memoised per name, so a
// momentary fork exhaustion would have put the multi-MB originals back for the
// life of the process. Queueing keeps the fan-out bounded instead.
const MAX_CONCURRENT = Math.max(1, Number(process.env.DESIGN_THUMB_CONCURRENCY) || 2);
let active = 0;
const waiting = [];
function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) return next(); // hand the slot straight over; `active` unchanged
  active--;
}

// A spawn that never started (no interpreter, or a box out of processes) is not
// this picture's fault, so it must not be remembered against it. But retrying it
// per request would hammer a box that is already struggling — so back off
// globally for a short while and then let it heal by itself.
const SPAWN_BACKOFF_MS = Math.max(0, Number(process.env.DESIGN_THUMB_BACKOFF_MS) || 30000);
let backoffUntil = 0;

/** Run the resizer. Resolves `{ ok, spawnFailed }` — never throws. `runner` is
 *  injectable so tests can exercise the failure paths without Python.
 *
 *  `spawnFailed` separates "this environment cannot run resizes right now" from
 *  "this picture cannot be resized": only the latter is a permanent fact. */
function runResize(src, dest, px, runner) {
  return new Promise((resolve) => {
    let child;
    try {
      child = (runner || spawn)(PYTHON_BIN, [SCRIPT, src, dest, String(px)], {
        timeout: TIMEOUT_MS,
        stdio: 'ignore',
      });
    } catch {
      return resolve({ ok: false, spawnFailed: true });
    }
    if (!child || typeof child.on !== 'function') {
      return resolve({ ok: false, spawnFailed: true });
    }
    // 'error' = never started (missing interpreter, EAGAIN). A non-zero exit
    // code = it ran and could not do the job. Both mean "no thumbnail", never
    // "serve the original" — but only the second is about this file.
    child.on('error', () => resolve({ ok: false, spawnFailed: true }));
    child.on('close', (code) => resolve({ ok: code === 0, spawnFailed: false }));
  });
}

/**
 * The small derivative for an upload `name` — `{ file, type }` (an absolute path
 * + its content type) or null when one cannot be produced.
 *
 * `opts.px` picks the rung of the ladder (see WIDTHS); omitted means MAXPX, the
 * picker default. A px we do not serve yields null rather than a fresh cache
 * entry, so the set of files on the volume stays bounded by the catalog.
 *
 * Cache hit → returned immediately. Miss → generated once (concurrent callers
 * share the one run) into a temp file and renamed into place, so a killed process
 * can never leave a truncated file to be served forever.
 */
function get(name, opts = {}) {
  const n = String(name || '');
  if (!NAME_RE.test(n)) return Promise.resolve(null);
  const px = pxOk(opts.px);
  if (px == null) return Promise.resolve(null);
  const key = keyOf(n, px);
  const dest = cachePath(n, px);
  const hit = typeOf(dest);
  if (hit) return Promise.resolve({ file: dest, type: hit });
  if (failed.has(key)) return Promise.resolve(null);
  // Still backing off from a failed spawn: answer null (the caller 404s and the
  // client keeps the original) without adding to the pressure.
  if (Date.now() < backoffUntil) return Promise.resolve(null);
  if (inflight.has(key)) return inflight.get(key);

  const src = path.join(opts.uploadDir || content._uploadDir, n);
  // Deferred to a microtask so `inflight.set` below has ALWAYS run before the
  // body's `finally` clears it. A path that finishes without ever awaiting (a
  // source that isn't there) would otherwise delete nothing and then be recorded
  // — leaving a resolved promise in the map for good. That is a memory leak any
  // client could drive by requesting well-formed names that don't exist.
  const job = Promise.resolve().then(async () => {
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      // No `failed` entry for a missing source: unlike a broken resizer this can
      // legitimately become true later (uploads are content-addressed, so the
      // same bytes always land on this same name).
      if (!fs.existsSync(src)) return null;
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      let res;
      await acquire();
      try {
        res = await runResize(src, tmp, px, opts.runner);
      } finally {
        release();
      }
      if (res.spawnFailed) {
        // Environmental, not this picture's fault: back off globally and let a
        // later request try again, rather than condemning this name for good.
        backoffUntil = Date.now() + SPAWN_BACKOFF_MS;
        return null;
      }
      const type = res.ok ? typeOf(tmp) : null;
      if (!type) {
        failed.add(key);
        return null;
      }
      fs.renameSync(tmp, dest);
      return { file: dest, type };
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

// NOT garbage-collected alongside the source upload, deliberately: a derivative
// is ~15 KB and content-addressed, so an orphan is negligible clutter and a
// re-upload of the same bytes re-uses it. Keeping it out of the reclaim paths
// keeps those (shared by three stores) untouched.

module.exports = {
  get,
  pxOk,
  // Test hook: clear the global spawn backoff, so one test exercising a failed
  // spawn does not silently mute every test that runs after it.
  _resetBackoff: () => {
    backoffUntil = 0;
  },
  _cacheDir: CACHE_DIR,
  _script: SCRIPT,
  _inflight: inflight,
  MAXPX,
  WIDTHS,
  NAME_RE,
};
