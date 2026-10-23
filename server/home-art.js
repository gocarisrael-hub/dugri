// home-art.js — the homepage's (new.html) pictures of an UPLOADED design, rendered by the real generator.
//
// THE PROBLEM. A design the owner uploads shows on new.html as its plain template picture: the filled SVG, one card, no
// board in the view, nothing sharper for a 3x phone or a zoomed view. The built-in designs have hand-cut art in
// site/assets/home/; an uploaded one has nobody to cut it.
//
// THIS MODULE renders, per public custom design, its sample front, back and board through generator/preview.py — the
// same render the buyer's name preview and the printed deck use — at high resolution (--scale 5 for the cards, a board
// scale that lands ~3400 px wide), then derives a WebP width ladder with generator/thumb_image.py (the gallery's own
// resizer, server/image-thumbs.js). /api/custom-designs hands the ladder to the page as srcsets once it exists.
//
// ── INVARIANT 1: the URL carries the artwork's revision ─────────────────────────────────────────────────────────────
// `rev` hashes the template's fingerprint (index.js templateFingerprint: themes.json layers, every file of the template,
// its fonts), the sample inputs and this module's REV. Any change the owner makes to the design is a new rev, so a new
// URL; the files are served `immutable`. Nothing is invalidated by hand: the next /api/custom-designs after a change
// sees a rev with no art, shows the template picture meanwhile, and queues the render. A finished rev sweeps the
// design's older revs from the volume.
//
// ── INVARIANT 2: a render is ONE at a time, and never on a buyer's path ─────────────────────────────────────────────
// A render is a Chrome run of ~15 s and ~2 GB at this scale. Jobs wait in a queue of one; a request never waits for a
// render — it gets the template picture until the art is there. A render YIELDS to the buyers' previews, which share the
// generator's Chrome slots (generator/chrome.py: a flock over DUGRI_CHROME_MAX_CONCURRENT files, scanned from slot 0):
// it is spawned allowed ONE slot, so it never holds more than one and a buyer skips past it to the next; it gives up
// waiting for that slot before its own timeout (a busy box costs it a retry, not a buyer a slot); and it runs at a low
// CPU priority, which the Chrome it starts inherits.
//
// /api/custom-designs is public, so what a visitor can make it do is bounded: it only ever asks about the PUBLIC custom
// designs themes.json lists, for the rev the server computes from their files (nothing in a request picks a design or a
// rev); each (design, rev) is queued at most once at a time; and /home-art/ serves files, it never renders.
//
// ── INVARIANT 3: failure is PER DESIGN AND REV, bounded, and never worse than today ─────────────────────────────────
// A failed render (an uncalibrated template, a timeout, a busy box) is remembered for that (design, rev): it is tried
// again only after RETRY_MS, and at most MAX_TRIES times in the life of the process; the next change to the design is
// a new rev and starts over. Until then the page shows the template picture, exactly as before this module existed.
//
// OFF unless HOME_ART=on, or NODE_ENV=production with HOME_ART unset (the deployed image): a local server and the E2E
// suite never spawn these renders.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { spawnGenerator, killGenerator } = require('./generator-proc');

const REPO_ROOT = path.resolve(__dirname, '..');
const PREVIEW_SCRIPT = path.join(REPO_ROOT, 'generator', 'preview.py');
const THUMB_SCRIPT = path.join(REPO_ROOT, 'generator', 'thumb_image.py');
const PYTHON_BIN = process.env.PYTHON || 'python3';

// Everything about the OUTPUT that is not the template: bump it when the scales, the ladder or the sample inputs change.
//   r1 = cards at scale 5, board ~3400 px, ladder below, webp via thumb_image.py
const REV = 'r1';
const CARD_SCALE = 5;
const BOARD_TARGET_W = 3400;
// The widths the page can pick from. A card is drawn at most ~250 CSS px (the design view on a big screen) and zooms to
// 4x in the view; the board at most 800 CSS px.
const LADDER = { front: [400, 800, 1200], back: [400, 800, 1200], board: [1200, 2000, 3000] };
const ROLES = Object.keys(LADDER);
const RENDER_TIMEOUT_MS = Math.max(10000, Number(process.env.HOME_ART_TIMEOUT_MS) || 120000);
const RESIZE_TIMEOUT_MS = 30000;
// How long a design's fingerprint is trusted before it is stat'ed again. /api/custom-designs is a public, hot route
// and a fingerprint stats every file of the template.
const FINGERPRINT_TTL_MS = 10000;
// A failed (design, rev): tried again after this long, at most this many times in all.
const RETRY_MS = 30 * 60 * 1000;
const MAX_TRIES = 3;
// Yielding to the buyers' previews (see INVARIANT 2): one Chrome slot, a slot wait shorter than RENDER_TIMEOUT_MS, and
// a low CPU priority (19 is the lowest).
const RENDER_ENV = { DUGRI_CHROME_MAX_CONCURRENT: '1', DUGRI_CHROME_SLOT_WAIT_S: '90' };
const RENDER_NICE = 15;

// One fixed sample per name language — the name the print renders on the homepage already carry (האלאנד's "Ben's
// B-day"). A constant so it can become an admin field per design later without changing anything else.
const SAMPLE = {
  english: { name: 'Ben', gender: 'male' },
  hebrew: { name: 'נועה', gender: 'female' },
};
// Sample values for a title's extra fields, so a title like "{NAME} {AGE}" renders whole.
const SAMPLE_FIELDS = { AGE: '30', YEARS: '10', NAME1: 'נועה', NAME2: 'בן' };
// The title for a design with no title template (one uploaded since the buyer types the title, e.g. חנוכה): without
// it the render prints no title at all. In the design's language, the sample name's; two lines, like the templates'.
const SAMPLE_TITLE = { english: "Ben's\nParty", hebrew: 'החגיגה\nשל נועה' };

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REV_RE = /^[a-f0-9]{16}$/;
const FILE_RE = /^(front|back|board)-(\d{3,4})\.webp$/;

function enabled(env = process.env) {
  if (env.HOME_ART === 'on') return true;
  if (env.HOME_ART === 'off') return false;
  return env.NODE_ENV === 'production';
}

/** What the render is given for a theme: the sample name, gender and extra fields. */
function sampleFor(theme) {
  const t = theme || {};
  const lang = t.language === 'english' ? 'english' : 'hebrew';
  const s = SAMPLE[lang];
  const fields = {};
  for (const k of Array.isArray(t.extra_fields) ? t.extra_fields : []) {
    if (Object.prototype.hasOwnProperty.call(SAMPLE_FIELDS, k)) fields[k] = SAMPLE_FIELDS[k];
  }
  const out = { name: s.name, gender: s.gender, fields };
  // [""] is no template too: config.title_lines would substitute it to one blank line
  const lines = Array.isArray(t.title_lines) ? t.title_lines : [];
  if (!lines.some((l) => String(l == null ? '' : l).trim())) out.title = SAMPLE_TITLE[lang];
  return out;
}

/** The board's scale for ~BOARD_TARGET_W px, from the board SVG's own CSS width; 3 when it cannot be read. */
function boardScaleFor(boardSvgPath, readFile = fs.readFileSync) {
  try {
    const head = String(readFile(boardSvgPath, 'utf8')).slice(0, 4000);
    const svg = /<svg\b[^>]*>/.exec(head);
    const w = svg && /\swidth="([\d.]+)(px)?"/.exec(svg[0]);
    const vb = svg && /\sviewBox="[\d.\s-]+?\s([\d.]+)\s[\d.]+"/.exec(svg[0]);
    const css = w ? Number(w[1]) : vb ? Number(vb[1]) * (4 / 3) : 0;
    if (css > 100) return Math.min(8, Math.max(1, Math.round((BOARD_TARGET_W / css) * 100) / 100));
  } catch {
    /* no board, or unreadable: the default */
  }
  return 3;
}

/**
 * The module, built over its environment so the tests can drive it without Chrome.
 * @param {object} o
 * @param {string} o.dataDir           where the art lives (DATA_DIR)
 * @param {(theme:string)=>string} o.fingerprint   index.js templateFingerprint
 * @param {(theme:string)=>string|null} [o.boardSvg]  the theme's board SVG path, for the board's scale
 * @param {boolean} [o.on]             override enabled()
 * @param {Function} [o.render]        (job) => Promise<{front,back,board?}> PNG paths; default spawns preview.py
 * @param {Function} [o.resize]        (src, dest, width) => Promise<boolean>; default spawns thumb_image.py
 * @param {Function} [o.now]
 * @param {Function} [o.log]
 */
function createHomeArt(o) {
  const root = path.join(o.dataDir, 'home-art');
  const on = typeof o.on === 'boolean' ? o.on : enabled();
  const now = o.now || Date.now;
  const log = o.log || ((m) => console.log('[home-art] ' + m));
  const render = o.render || ((job) => defaultRender(job, o.spawnRender || spawnGenerator));
  const resize = o.resize || defaultResize;
  const fpCache = new Map(); // slug -> { at, fp }
  const failed = new Map(); // `${slug}@${rev}` -> { tries, at }
  const queued = new Set(); // `${slug}@${rev}` waiting or running
  const queue = [];
  let running = false;

  function revFor(slug, theme) {
    let c = fpCache.get(slug);
    if (!c || now() - c.at > FINGERPRINT_TTL_MS) {
      c = { at: now(), fp: String(o.fingerprint(slug)) };
      fpCache.set(slug, c);
    }
    const sample = sampleFor(theme);
    return crypto
      .createHash('sha256')
      .update([REV, slug, c.fp, JSON.stringify(sample)].join('\n'))
      .digest('hex')
      .slice(0, 16);
  }

  const dirOf = (slug, rev) => path.join(root, slug, rev);

  function readManifest(slug, rev) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dirOf(slug, rev), 'manifest.json'), 'utf8'));
      return m && typeof m === 'object' ? m : null;
    } catch {
      return null;
    }
  }

  /** The srcsets of a design's art when it is ready: { front:{src,srcset}, back?, board? }, else null. */
  function srcsetsFrom(slug, rev, manifest) {
    const out = {};
    for (const role of ROLES) {
      const widths = manifest[role];
      if (!Array.isArray(widths) || !widths.length) continue;
      const url = (w) => `/home-art/${encodeURIComponent(slug)}/${rev}/${role}-${w}.webp`;
      out[role] = { src: url(widths[0]), srcset: widths.map((w) => `${url(w)} ${w}w`).join(', ') };
    }
    return out.front ? out : null;
  }

  /**
   * The design's homepage art if it is ready for the artwork as it is NOW; otherwise null, and (when on) its render is
   * queued in the background. Never throws, never waits for a render.
   */
  function artFor(slug, theme) {
    if (!on || !SLUG_RE.test(String(slug))) return null;
    let rev;
    try {
      rev = revFor(slug, theme);
    } catch {
      return null;
    }
    const m = readManifest(slug, rev);
    if (m) return srcsetsFrom(slug, rev, m);
    enqueue(slug, rev, theme);
    return null;
  }

  function enqueue(slug, rev, theme) {
    const key = `${slug}@${rev}`;
    if (queued.has(key)) return;
    const f = failed.get(key);
    if (f && (f.tries >= MAX_TRIES || now() - f.at < RETRY_MS)) return;
    queued.add(key);
    queue.push({ slug, rev, theme, key });
    pump();
  }

  function pump() {
    if (running || !queue.length) return;
    running = true;
    const job = queue.shift();
    build(job)
      .catch((e) => {
        const f = failed.get(job.key);
        failed.set(job.key, { tries: (f ? f.tries : 0) + 1, at: now() });
        log(
          `${job.slug}: no art for rev ${job.rev}: ${String((e && e.message) || e).slice(0, 300)}`
        );
      })
      .finally(() => {
        queued.delete(job.key);
        running = false;
        pump();
      });
  }

  async function build({ slug, rev, theme }) {
    const started = now();
    fs.mkdirSync(path.join(root, slug), { recursive: true });
    const tmp = path.join(root, slug, `.${rev}.${process.pid}.tmp`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const sample = sampleFor(theme);
      const boardSvg = o.boardSvg ? o.boardSvg(slug) : null;
      const pngs = await render({
        slug,
        outDir: path.join(tmp, 'src'),
        sample,
        scale: CARD_SCALE,
        boardScale: boardSvg ? boardScaleFor(boardSvg) : 3,
      });
      if (!pngs || !pngs.card) throw new Error('the render produced no card');
      const manifest = {};
      for (const [role, file] of [
        ['front', pngs.card],
        ['back', pngs.back],
        ['board', pngs.board],
      ]) {
        if (!file || !fs.existsSync(file)) continue;
        const native = pngWidth(file);
        // never upscaled: the rungs above the render's own width collapse onto it
        const widths = [...new Set(LADDER[role].map((w) => Math.min(w, native || w)))];
        for (const w of widths) {
          const ok = await resize(file, path.join(tmp, `${role}-${w}.webp`), w);
          if (!ok) throw new Error(`resizing the ${role} to ${w} failed`);
        }
        manifest[role] = widths;
      }
      if (!manifest.front) throw new Error('no front');
      fs.rmSync(path.join(tmp, 'src'), { recursive: true, force: true });
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest));
      const dest = dirOf(slug, rev);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
      sweep(slug, rev);
      log(`${slug}: art ready for rev ${rev} in ${Math.round((now() - started) / 1000)} s`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Delete a design's other revs (and stray temp dirs) once a newer rev is ready. */
  function sweep(slug, keep) {
    try {
      for (const f of fs.readdirSync(path.join(root, slug))) {
        if (f !== keep) fs.rmSync(path.join(root, slug, f), { recursive: true, force: true });
      }
    } catch {
      /* nothing to sweep */
    }
  }

  /** The file behind a /home-art URL, or null. Confined to the art dir by the shapes of its three parts. */
  function fileFor(slug, rev, file) {
    if (!SLUG_RE.test(String(slug)) || !REV_RE.test(String(rev)) || !FILE_RE.test(String(file)))
      return null;
    const p = path.join(dirOf(slug, rev), file);
    return fs.existsSync(p) ? p : null;
  }

  return {
    artFor,
    fileFor,
    revFor,
    // for tests and the admin: what is known about a design right now
    state: (slug, rev) => ({
      failed: failed.has(`${slug}@${rev}`),
      tries: (failed.get(`${slug}@${rev}`) || { tries: 0 }).tries,
      queued: queued.has(`${slug}@${rev}`),
    }),
    idle: () => !running && !queue.length,
    on,
  };
}

/** A PNG's width from its IHDR, or 0. */
function pngWidth(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    fs.closeSync(fd);
    return b.toString('ascii', 12, 16) === 'IHDR' ? b.readUInt32BE(16) : 0;
  } catch {
    return 0;
  }
}

/** preview.py at high resolution; resolves its { card, back, board } PNG paths. */
function defaultRender({ slug, outDir, sample, scale, boardScale }, spawnRender) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    const args = [PREVIEW_SCRIPT, slug, sample.name, outDir];
    for (const [k, v] of Object.entries(sample.fields)) args.push('--field', `${k}=${v}`);
    // `=`-joined, one token, as server/index.js passes a buyer's title
    if (sample.title) args.push('--title=' + sample.title);
    args.push(
      '--gender',
      sample.gender,
      '--scale',
      String(scale),
      '--board-scale',
      String(boardScale)
    );
    let child;
    try {
      child = spawnRender(PYTHON_BIN, args, {
        cwd: REPO_ROOT,
        env: { ...process.env, ...RENDER_ENV },
      });
      try {
        // before Python has started Chrome (it imports first), so every process of the render inherits it
        if (child && child.pid) os.setPriority(child.pid, RENDER_NICE);
      } catch {
        /* not permitted here: it still holds only one slot */
      }
    } catch (e) {
      return reject(e);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGenerator(child);
    }, RENDER_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('render timed out'));
      if (code !== 0) return reject(new Error((stderr || 'exit ' + code).trim()));
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop() || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** thumb_image.py: one WebP at an exact width (never upscaled). */
function defaultResize(src, dest, width) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PYTHON_BIN, [THUMB_SCRIPT, src, dest, String(width)], {
        timeout: RESIZE_TIMEOUT_MS,
        stdio: 'ignore',
      });
    } catch {
      return resolve(false);
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(dest)));
  });
}

module.exports = {
  createHomeArt,
  enabled,
  sampleFor,
  boardScaleFor,
  REV,
  LADDER,
  SAMPLE,
  SAMPLE_TITLE,
  RETRY_MS,
  MAX_TRIES,
  RENDER_ENV,
};
