// @vitest-environment node
//
// Site-path latency/health probe. Boots the REAL Express app (server/index.js)
// exactly the way tests/unit/pelecard-routes.test.js does, then fetches EVERY
// static path the site serves and asserts each one loads: HTTP 200, a non-empty
// body, and within a generous per-request time budget so a HANGING or broken
// route can't ship green.
//
// NOTE: this exercises the LOCAL app's own serving path (route wiring +
// express.static + the SPA fallback). It catches app-level regressions and
// hangs — a route that 500s, returns empty, or blocks — NOT Railway/proxy/CDN
// infrastructure issues, which this harness can't see. Don't over-trust a green
// run here as "prod is fast".
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const SITE_DIR = path.join(__dirname, '..', '..', 'site');

// Generous per-request budget: the goal is to catch a hang/timeout, not to
// micro-benchmark. Serving a static file locally is sub-millisecond; 2000ms
// leaves ample headroom so a busy CI machine never makes this flaky, while a
// truly stuck route (which would otherwise 502 in prod) still trips it.
const BUDGET_MS = 2000;

let server;
let base;

// Recursively collect files under `dir` whose extension is in `exts`.
// Resilient: skips directories, symlink loops, and anything unreadable.
function collectFiles(dir, exts, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(full, exts, acc);
    else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

// Turn an absolute file path under site/ into the URL path the server serves.
function toUrlPath(absFile) {
  return '/' + path.relative(SITE_DIR, absFile).split(path.sep).join('/');
}

// Enumerate the paths to probe by GLOBBING the site directory, so new pages and
// scripts are covered automatically (no stale hardcoded list):
//  - every *.html page (index, collect, options, admin, dashboard, coupons,
//    timer, pay-done, plus any others, including nested ones under assets/)
//  - every site/js/*.js module
// Plus a representative sample of the HEAVIEST assets so large-file serving is
// exercised: one design-board .svg, one hero .mp4 video, one gallery .jpg.
function enumeratePaths() {
  const htmlPaths = collectFiles(SITE_DIR, ['.html']).map(toUrlPath);
  const jsPaths = collectFiles(path.join(SITE_DIR, 'js'), ['.js']).map(toUrlPath);

  const heavy = [];
  const firstExisting = (candidates) =>
    candidates.find((rel) => fs.existsSync(path.join(SITE_DIR, rel)));
  const board = firstExisting([
    'assets/designs/bachelorette/board.svg',
    'assets/designs/birthday/board.svg',
  ]);
  const video = firstExisting(['assets/video/dugri-hero-loop.mp4', 'assets/video/party.mp4']);
  const jpg = firstExisting(['assets/gallery-1.jpg', 'assets/testimonials/review-1.jpg']);
  for (const rel of [board, video, jpg]) if (rel) heavy.push('/' + rel);

  // De-dupe while preserving order.
  return [...new Set([...htmlPaths, ...jsPaths, ...heavy])];
}

// Fetch a path and report status, body byte length, elapsed ms, and headers.
async function probe(urlPath) {
  const started = Date.now();
  const res = await fetch(base + urlPath);
  // arrayBuffer().byteLength works for binary assets too (no Buffer global).
  const buf = await res.arrayBuffer();
  return {
    status: res.status,
    bytes: buf.byteLength,
    ms: Date.now() - started,
    cacheControl: res.headers.get('cache-control'),
  };
}

beforeAll(async () => {
  // Isolate any DB writes the app may perform on boot to a throwaway dir.
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-site-'));
  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
});

describe('site paths — every route serves fast and non-empty', () => {
  const paths = enumeratePaths();

  it('discovers the expected core pages (guards the enumeration itself)', () => {
    // If globbing silently found nothing, the per-path assertions below would
    // vacuously pass — so assert the known-critical pages are in the set.
    for (const p of ['/index.html', '/collect.html', '/options.html', '/pay-done.html']) {
      expect(paths, `enumeration should include ${p}`).toContain(p);
    }
    // And that we actually collected a meaningful number of paths + some JS.
    expect(paths.length).toBeGreaterThan(8);
    expect(paths.some((p) => p.startsWith('/js/'))).toBe(true);
  });

  it.each(paths)('%s -> 200, non-empty, under budget', async (urlPath) => {
    const r = await probe(urlPath);
    expect(r.status, `${urlPath} status`).toBe(200);
    expect(r.bytes, `${urlPath} body bytes`).toBeGreaterThan(0);
    expect(r.ms, `${urlPath} took ${r.ms}ms (> ${BUDGET_MS}ms budget — hang?)`).toBeLessThan(
      BUDGET_MS
    );
    // The server sets Cache-Control: no-cache on HTML so in-app browsers don't
    // show a stale page. Assert it for .html paths (nice-to-have policy check).
    if (urlPath.endsWith('.html')) {
      expect(r.cacheControl, `${urlPath} cache-control`).toBe('no-cache');
    }
  });

  it('an extension-less route falls back to index.html (SPA nav)', async () => {
    // e.g. /collect (no .html) must resolve — this is the express `extensions`
    // + `*` fallback behavior real visitors hit from shared links.
    const r = await probe('/collect');
    expect(r.status).toBe(200);
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.ms).toBeLessThan(BUDGET_MS);
  });

  it('a KNOWN-MISSING asset (has an extension) 404s quickly, never hangs', async () => {
    // The server returns a real 404 for a missing file with an extension
    // (instead of the SPA homepage). Assert it 404s AND returns promptly, so a
    // broken asset can't turn into a hanging request.
    const r = await probe('/assets/does-not-exist-' + Date.now() + '.png');
    expect(r.status).toBe(404);
    expect(r.ms, `404 took ${r.ms}ms (should be prompt, not a hang)`).toBeLessThan(BUDGET_MS);
  });
});
