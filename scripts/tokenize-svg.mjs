#!/usr/bin/env node
// Dependency-light tokenizer for the Canva full-deck SVG designs.
//
// Each source page is a FULL A4-landscape artboard exported from Canva:
//   front = a sheet of 8 word-cards, back = 8 card-backs, board = the game board.
// (The old single-card exports are gone — every product is now a full page.)
//
// What this does, per design:
//   1. Detect the design's vivid theme colours (skips white/black/neutral greys).
//   2. Rewrite those hexes to CSS vars var(--c0)..var(--cN) (c0 = darkest) — but
//      ONLY where the hex is real paint (fill / stroke / stop-color / style:fill),
//      never inside url(#id) refs or id="…" attributes. This is what lets the live
//      colour slider recolor the design in the browser.
//   3. Strip the fixed width/height from the <svg> (keep the native viewBox) so the
//      inline SVG scales to its container. Full-page landscape art needs no
//      per-card viewBox cropping, so there is NO headless-Chrome/getBBox step
//      anymore (that fragile dependency is gone).
//   4. Optimise each tokenized page through svgo (outlined-text pages shrink
//      ~60%). svgo is optional: if it can't be loaded the raw tokenized SVG is
//      written and a follow-up is flagged.
//   5. Write site/assets/designs/<id>/{front,back[,board]}.svg and emit
//      site/js/designs.generated.js.
//
// The `board` product is OPTIONAL — a design may ship without one (kids, whose
// board template is still pending). Such a design simply omits board everywhere.
//
// Usage: node scripts/tokenize-svg.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// ASCII staging copies of the Canva "full deck" exports (originals: the Hebrew,
// typo-prone `resources/canva/full deck/…` tree — gitignored, local-only). Staging
// gives the build stable, robust paths. Each staging/<id>/ holds front.svg /
// back.svg / board.svg, copied from:
//   bachelorette <- full deck/with backgrounf/דוגרי רווקות חדש/{1,2,3}.svg
//   marriage     <- full deck/with backgrounf/דוגרי יום נישואין חדש/{1,2,3}.svg
//   birthday     <- full deck/with backgrounf/דוגרי יום הולדת בנות חדש/{1,2,3}.svg
//   japanese     <- full deck/with backgrounf/דוגרי יפני חדש/{1,2,3}.svg
//   posttrip     <- full deck/with backgrounf/דוגרי מסיבת חזרה מטיול/{1,2,3}.svg
//   neon         <- full deck/with backgrounf/דוגרי יום הולדת בנות ניאון חדש/{1,2,3}.svg
//   kids         <- full deck/dugri birthday kids/{פני כרטיסים,גב כרטיסים}.svg (no board)
const CANVA = resolve(ROOT, 'resources/canva/staging');
const OUT_ASSETS = resolve(ROOT, 'site/assets/designs');
const OUT_JS = resolve(ROOT, 'site/js/designs.generated.js');

// ---- design manifest -------------------------------------------------------
// Every source is a full-page landscape export (fullPage:true → no viewBox crop).
// recolor: 'slider' → the live colour slider recolors it; 'fixed' → locked to its
// original colours (neon's baked-in raster glow can't be recoloured). board is
// optional (kids has none yet).
const DESIGNS = [
  {
    id: 'bachelorette',
    folder: 'bachelorette',
    files: { front: 'front.svg', back: 'back.svg', board: 'board.svg' },
    fullPage: true,
    recolor: 'slider',
  },
  {
    id: 'marriage',
    folder: 'marriage',
    files: { front: 'front.svg', back: 'back.svg', board: 'board.svg' },
    fullPage: true,
    recolor: 'slider',
  },
  {
    id: 'birthday',
    folder: 'birthday',
    files: { front: 'front.svg', back: 'back.svg', board: 'board.svg' },
    fullPage: true,
    recolor: 'slider',
  },
  {
    id: 'japanese',
    folder: 'japanese',
    files: { front: 'front.svg', back: 'back.svg', board: 'board.svg' },
    fullPage: true,
    recolor: 'slider',
  },
  {
    id: 'posttrip',
    folder: 'posttrip',
    files: { front: 'front.svg', back: 'back.svg', board: 'board.svg' },
    fullPage: true,
    recolor: 'slider',
  },
  {
    id: 'neon',
    folder: 'neon',
    files: { front: 'front.svg', back: 'back.svg', board: 'board.svg' },
    fullPage: true,
    recolor: 'fixed',
  },
  {
    // kids: no board template yet — front + back only.
    id: 'kids',
    folder: 'kids',
    files: { front: 'front.svg', back: 'back.svg' },
    fullPage: true,
    recolor: 'slider',
  },
];

// ---- colour helpers --------------------------------------------------------
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0,
    h = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h * 360, s, l];
}

// Decide whether a colour is a "theme" colour worth tokenizing.
// Drop pure white, pure black, and near-neutral greys.
function isThemeColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  const [, s, l] = rgbToHsl(r, g, b);
  if (r === 255 && g === 255 && b === 255) return false; // pure white
  if (r === 0 && g === 0 && b === 0) return false; // pure black
  // near-neutral grey: very low saturation
  if (s < 0.12) return false;
  // extremely light or extremely dark near-neutral tints
  if (l > 0.97 || l < 0.03) return false;
  return true;
}

// ---- collect & detect ------------------------------------------------------
// Only colours declared in real paint attributes count toward the palette.
// (Bare hex strings also appear inside clip-path ids / antialias edges, which
// we must NOT treat as theme colours.)
const PAINT_RE =
  /(?:fill|stroke|stop-color)\s*=\s*"(#[0-9a-fA-F]{6})"|style\s*=\s*"[^"]*?(?:fill|stroke)\s*:\s*(#[0-9a-fA-F]{6})/g;

function collectThemeColors(svgFiles) {
  // Count occurrences across all product svgs of a design so we pick
  // a single consistent palette for the whole design.
  const counts = new Map();
  for (const src of svgFiles) {
    let m;
    PAINT_RE.lastIndex = 0;
    while ((m = PAINT_RE.exec(src)) !== null) {
      let hex = (m[1] || m[2]).toLowerCase();
      if (!isThemeColor(hex)) continue;
      counts.set(hex, (counts.get(hex) || 0) + 1);
    }
  }
  // Merge near-duplicate colours (e.g. #ff00db vs #ff04dc) into the dominant one.
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const kept = [];
  for (const [hex, cnt] of entries) {
    const [r, g, b] = hexToRgb(hex);
    let merged = false;
    for (const k of kept) {
      const [kr, kg, kb] = hexToRgb(k.hex);
      const dist = Math.abs(r - kr) + Math.abs(g - kg) + Math.abs(b - kb);
      if (dist <= 24) {
        k.count += cnt;
        merged = true;
        break;
      } // collapse near-identical
    }
    if (!merged) kept.push({ hex, count: cnt });
  }
  // Keep only colours that appear enough to be a real theme colour, not a
  // one-off antialias artifact. Threshold relative to the dominant colour.
  const maxCount = kept.length ? Math.max(...kept.map((k) => k.count)) : 0;
  // Floor of 2 (was 3): a genuine accent painted only 1-2x would otherwise be
  // dropped. isThemeColor already screened out white/black/neutral noise above,
  // so low-count survivors here are real vivid theme colors.
  const filtered = kept.filter((k) => k.count >= Math.max(2, maxCount * 0.01));
  // Sort darkest -> lightest by HSL lightness.
  filtered.sort((a, b) => {
    const la = rgbToHsl(...hexToRgb(a.hex))[2];
    const lb = rgbToHsl(...hexToRgb(b.hex))[2];
    return la - lb;
  });
  return filtered.map((k) => k.hex);
}

// Pick a design's representative "accent" colour — the most saturated, breaking
// ties toward mid-lightness (mirrors configurator.js mostSaturatedIndex). Used to
// theme the page accent/background for EVERY design, including 'fixed' ones (neon)
// which have no anchors but still need their own page tint.
function representativeColor(hexes) {
  if (!hexes.length) return null;
  let bestS = -Infinity;
  for (const h of hexes) bestS = Math.max(bestS, rgbToHsl(...hexToRgb(h))[1]);
  const EPS = 0.005; // s is 0..1 here (matches the 0.5-on-0..100 tolerance)
  let best = hexes[0];
  let bestLDist = Infinity;
  for (const h of hexes) {
    const [, s, l] = rgbToHsl(...hexToRgb(h));
    if (s < bestS - EPS) continue;
    const lDist = Math.abs(l - 0.5);
    if (lDist < bestLDist) {
      bestLDist = lDist;
      best = h;
    }
  }
  return best;
}

// ---- tokenization ----------------------------------------------------------
// Map a single hex literal to its CSS var, or return the original hex unchanged.
// Maps near-duplicate vivid colours to the nearest anchor.
function hexToVar(hex, anchors) {
  const low = hex.toLowerCase();
  let idx = anchors.indexOf(low);
  if (idx === -1) {
    // map near-duplicate vivid colours to nearest anchor
    if (!isThemeColor(low)) return hex; // leave white/neutral literal
    const [r, g, b] = hexToRgb(low);
    let best = -1,
      bestDist = Infinity;
    anchors.forEach((a, i) => {
      const [ar, ag, ab] = hexToRgb(a);
      const d = Math.abs(r - ar) + Math.abs(g - ag) + Math.abs(b - ab);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    if (best !== -1 && bestDist <= 40) idx = best;
  }
  if (idx === -1) return hex; // not a theme colour (vivid but unmatched) -> leave
  return `var(--c${idx})`;
}

function tokenize(src, anchors) {
  // Only rewrite hex literals that are REAL PAINT — i.e. inside fill="#…",
  // stroke="#…", stop-color="#…", or style="…fill/stroke:#…". This mirrors
  // PAINT_RE so we never touch hex inside url(#id) refs or id="…" attributes
  // (a value like stroke="url(#id)" doesn't start with #rrggbb, so it's safe).
  if (!anchors.length) return src;
  let out = src;
  // fill="#…" / stroke="#…" / stop-color="#…"
  out = out.replace(
    /(\b(?:fill|stroke|stop-color)\s*=\s*")(#[0-9a-fA-F]{6})(")/g,
    (_, pre, hex, post) => pre + hexToVar(hex, anchors) + post
  );
  // style="… fill:#… / stroke:#… …" (every paint hex within the style value)
  out = out.replace(/\bstyle\s*=\s*"([^"]*)"/g, (whole, body) => {
    const newBody = body.replace(
      /((?:fill|stroke)\s*:\s*)(#[0-9a-fA-F]{6})/g,
      (_, pre, hex) => pre + hexToVar(hex, anchors)
    );
    return newBody === body ? whole : `style="${newBody}"`;
  });
  return out;
}

// ---- full-page prep --------------------------------------------------------
// Drop the fixed width/height on the root <svg> so the inline SVG scales to its
// container; the native viewBox is kept, giving a stable coordinate system and
// the true page aspect ratio (~1.414, A4 landscape). No cropping needed.
// If a source ever lacks a viewBox, synthesise one from its width/height FIRST —
// otherwise stripping width/height would leave the SVG with no coordinate system
// and it would render blank.
function stripSize(src) {
  return src.replace(/<svg\b[^>]*>/i, (tag) => {
    let out = tag;
    if (!/\bviewBox\s*=/i.test(out)) {
      const w = (out.match(/\bwidth\s*=\s*"([\d.]+)/i) || [])[1];
      const h = (out.match(/\bheight\s*=\s*"([\d.]+)/i) || [])[1];
      if (w && h) out = out.replace(/<svg\b/i, `<svg viewBox="0 0 ${w} ${h}"`);
    }
    return out.replace(/\s(?:width|height)\s*=\s*"[^"]*"/gi, '');
  });
}

// ---- svgo (optional) -------------------------------------------------------
// Optimise outlined-text pages. Loaded lazily so the build still runs (raw) if
// svgo isn't installed. removeHiddenElems/cleanupIds are off to avoid dropping
// anything the design relies on or churning clip-path ids referenced via url(#id).
let svgo = null;
try {
  svgo = await import('svgo');
} catch {
  svgo = null;
}
const SVGO_CONFIG = {
  multipass: true,
  plugins: [
    {
      name: 'preset-default',
      params: { overrides: { removeHiddenElems: false, cleanupIds: false } },
    },
  ],
};
function optimize(src, label) {
  if (!svgo) return { data: src, optimized: false };
  try {
    const { data } = svgo.optimize(src, { ...SVGO_CONFIG, path: label });
    // Never let optimisation strip the tokens the live recolor depends on — check
    // BOTH fill and stroke var() tokens (a stroke-painted design would silently
    // stop recolouring if svgo dropped its stroke="var(--cN)" tokens).
    for (const paint of ['fill', 'stroke']) {
      const re = new RegExp(`${paint}="var\\(--c`);
      if (re.test(src) && !re.test(data)) {
        console.warn(`  [svgo] ${label}: dropped ${paint} var() tokens — keeping raw.`);
        return { data: src, optimized: false };
      }
    }
    return { data, optimized: true };
  } catch (e) {
    console.warn(`  [svgo] ${label}: optimise failed (${e.message}) — keeping raw.`);
    return { data: src, optimized: false };
  }
}

// ---- thumbnails (separate, explicit step) ---------------------------------
// Picker tiles show a small webp raster instead of inlining the multi-MB full-page
// SVG (seven of which white-screen the Instagram in-app browser). Rendering is
// FAITHFUL via headless Chromium — ImageMagick's internal SVG renderer degrades
// some Canva pages (e.g. birthday's card backgrounds vanish); ImageMagick is used
// only to convert the PNG to a downscaled webp.
//
// This is a LOCAL, one-time build step. The committed thumb.webp files (alongside
// designs.generated.js + the SVGs) are the source of truth for CI, which does NOT
// run this script. So:
//   - `node scripts/tokenize-svg.mjs --thumbs`  (re)renders every thumbnail.
//   - a normal run PRESERVES the committed thumbs and never nulls/deletes them; it
//     only renders a thumb that is genuinely MISSING, and then FAILS LOUDLY if the
//     renderer (Chromium/ImageMagick) isn't available — rather than shipping a
//     text-only picker. A green, reproducible state never depends on these binaries.
const REGEN_THUMBS = process.argv.includes('--thumbs');
const THUMB_W = 240; // final webp width (px)
const THUMB_MIN_BYTES = 3000; // near-blank guard: real full-page thumbs are 4–12KB

let magick = null;
try {
  execSync('magick --version', { stdio: 'ignore' });
  magick = 'magick';
} catch {
  magick = null;
}

// Reject a thumbnail that came out near-blank (a bad renderer can silently produce
// an almost-empty tile — e.g. ImageMagick dropped birthday's cards). Throw so a
// blank thumbnail can NEVER be committed/shipped.
function assertThumbNotBlank(id, outPath) {
  if (!existsSync(outPath)) throw new Error(`thumb ${id}: not written`);
  const bytes = statSync(outPath).size;
  if (bytes < THUMB_MIN_BYTES) {
    throw new Error(
      `thumb ${id}: looks near-blank (${bytes} bytes < ${THUMB_MIN_BYTES}) — refusing to ship. ` +
        `The renderer likely dropped the artwork; check the source/render.`
    );
  }
}

// Render the given jobs [{id, srcPath, outPath}] with headless Chromium -> PNG,
// then ImageMagick -> downscaled webp. Throws (fails loudly) if a renderer is
// missing or a result is near-blank.
async function renderThumbnails(jobs) {
  if (!jobs.length) return;
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    try {
      ({ chromium } = await import('@playwright/test'));
    } catch {
      throw new Error(
        'thumbnail rendering needs Playwright (chromium). Run `npm install` (and ' +
          '`npx playwright install chromium`), or run WITHOUT --thumbs to keep the committed thumbs.'
      );
    }
  }
  if (!magick) {
    throw new Error('thumbnail rendering needs ImageMagick `magick` for PNG→webp conversion.');
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    for (const { id, srcPath, outPath } of jobs) {
      const svg = readFileSync(srcPath, 'utf8');
      await page.setViewportSize({ width: THUMB_W * 2, height: THUMB_W * 2 });
      await page.setContent(
        `<!doctype html><body style="margin:0;background:#fff">` +
          `<div id="w" style="width:${THUMB_W * 2}px">${svg}</div></body>`,
        { waitUntil: 'networkidle' }
      );
      await page.evaluate((w) => {
        const s = document.querySelector('#w svg');
        if (s) {
          s.style.width = w + 'px';
          s.style.height = 'auto';
          s.style.display = 'block';
        }
      }, THUMB_W * 2);
      const el = await page.$('#w svg');
      if (!el) throw new Error(`thumb ${id}: no <svg> element found in source`);
      const tmpPng = resolve(dirname(outPath), `.thumb-${id}.png`);
      await el.screenshot({ path: tmpPng, type: 'png' });
      execSync(
        `${magick} ${JSON.stringify(tmpPng)} -resize ${THUMB_W}x ` +
          `-background white -flatten -quality 82 ${JSON.stringify(outPath)}`,
        { stdio: 'ignore' }
      );
      rmSync(tmpPng, { force: true });
      assertThumbNotBlank(id, outPath);
    }
  } finally {
    await browser.close();
  }
}

// ---- main ------------------------------------------------------------------
// Preserve committed thumbnails across the rmSync unless we're regenerating them,
// so a normal run never destroys them (the picker depends on them and CI can't
// rebuild them). Snapshot the bytes now, restore them after rewriting the SVGs.
const preservedThumbs = {};
if (!REGEN_THUMBS) {
  for (const d of DESIGNS) {
    const tp = resolve(OUT_ASSETS, d.id, 'thumb.webp');
    if (existsSync(tp)) preservedThumbs[d.id] = readFileSync(tp);
  }
}

rmSync(OUT_ASSETS, { recursive: true, force: true });
const report = [];
const thumbJobs = [];
let rawTotal = 0;
let outTotal = 0;

for (const d of DESIGNS) {
  const folder = resolve(CANVA, d.folder);
  const srcs = {};
  for (const [kind, fname] of Object.entries(d.files)) {
    srcs[kind] = readFileSync(resolve(folder, fname), 'utf8');
  }

  // Theme colours drive both the SVG token recolor AND the design's page accent.
  // 'fixed' designs (neon) are never recoloured, so they get NO var(--cN) tokens
  // and an EMPTY anchor list — but they still keep their own page accent.
  const isFixed = d.recolor === 'fixed';
  const themeColors = collectThemeColors(Object.values(srcs));
  const anchors = isFixed ? [] : themeColors;
  const accent = representativeColor(themeColors);

  const outDir = resolve(OUT_ASSETS, d.id);
  mkdirSync(outDir, { recursive: true });

  const products = {};
  const rasterKinds = [];
  const sizes = {};
  for (const kind of Object.keys(d.files)) {
    let svg = srcs[kind];
    if ((svg.match(/<image\b/g) || []).length > 0) rasterKinds.push(kind);
    const rawBytes = Buffer.byteLength(svg);
    svg = tokenize(svg, anchors); // no-op for fixed (empty anchors)
    if (d.fullPage) svg = stripSize(svg);
    const { data } = optimize(svg, `${d.id}-${kind}`);
    const outBytes = Buffer.byteLength(data);
    rawTotal += rawBytes;
    outTotal += outBytes;
    sizes[kind] = { raw: rawBytes, out: outBytes };
    const outPath = resolve(outDir, `${kind}.svg`);
    writeFileSync(outPath, data);
    products[kind] = `assets/designs/${d.id}/${kind}.svg`;
  }

  // Thumbnail: stable committed path. Restore the preserved copy, or queue a
  // (re)render. `thumb` is ALWAYS the path — never null — so the picker never
  // silently falls back to text; a missing thumb + no renderer fails loudly below.
  const thumbPath = resolve(outDir, 'thumb.webp');
  if (!REGEN_THUMBS && preservedThumbs[d.id]) {
    writeFileSync(thumbPath, preservedThumbs[d.id]);
  } else {
    thumbJobs.push({ id: d.id, srcPath: resolve(folder, d.files.front), outPath: thumbPath });
  }

  report.push({
    id: d.id,
    anchors,
    accent,
    products,
    thumb: `assets/designs/${d.id}/thumb.webp`,
    thumbPath,
    rasterKinds,
    hasRaster: rasterKinds.length > 0,
    recolor: d.recolor,
    sizes,
  });
}

// Render any thumbnails that were regenerated or missing (fails loudly if a
// renderer is unavailable or a result comes out near-blank).
await renderThumbnails(thumbJobs);
for (const r of report) {
  const tb = statSync(r.thumbPath).size;
  outTotal += tb;
  r.sizes.thumb = { raw: 0, out: tb };
}

// ---- emit designs.generated.js --------------------------------------------
let js =
  '// AUTO-GENERATED by scripts/tokenize-svg.mjs + scripts/product-thumbs.mjs — do not edit by hand.\n';
js += 'export const GENERATED = {\n';
for (const r of report) {
  const anchorsStr = r.anchors.map((a) => `'${a}'`).join(',');
  const p = r.products;
  const prodParts = [`front:'${p.front}'`, `back:'${p.back}'`];
  if (p.board) prodParts.push(`board:'${p.board}'`); // board optional
  // Per-product gallery thumbs (rendered by scripts/product-thumbs.mjs). `thumb`
  // above stays the small picker thumb (= front) so options.html is unaffected.
  // Emit a kind ONLY if its webp actually exists on disk, so the manifest can never
  // list a missing file (e.g. a design tokenized here before product-thumbs ran).
  // products.html falls back to the front `thumb` for any kind not listed here.
  // NOTE: scripts/product-thumbs.mjs re-emits this same GENERATED shape — keep the
  // two serializers in sync if the manifest fields change.
  const thumbKinds = p.board ? ['front', 'back', 'board'] : ['front', 'back'];
  const thumbParts = thumbKinds
    .filter((k) => existsSync(resolve(OUT_ASSETS, r.id, `thumb-${k}.webp`)))
    .map((k) => `${k}:'assets/designs/${r.id}/thumb-${k}.webp'`);
  const key = `${r.id}:`.padEnd(14);
  const accentPart = r.accent ? `accent:'${r.accent}', ` : '';
  js +=
    `  ${key}{ anchors:[${anchorsStr}], hasRaster:${r.hasRaster}, ` +
    `recolor:'${r.recolor}', ${accentPart}thumb:'${r.thumb}', ` +
    `thumbs:{ ${thumbParts.join(', ')} }, products:{ ${prodParts.join(', ')} } },\n`;
}
js += '};\n';
mkdirSync(dirname(OUT_JS), { recursive: true });
writeFileSync(OUT_JS, js);

// ---- console report --------------------------------------------------------
const kb = (b) => (b / 1024).toFixed(0) + 'KB';
console.log(
  `Tokenized designs (svgo: ${svgo ? 'on' : 'OFF — raw output, optimise as follow-up'}):\n`
);
for (const r of report) {
  console.log(`  ${r.id}  [recolor:${r.recolor}]  accent:${r.accent}`);
  console.log(`    anchors (c0..): ${r.anchors.join(', ')}`);
  for (const kind of Object.keys(r.sizes)) {
    const s = r.sizes[kind];
    const where = r.products[kind] || r.thumb;
    console.log(`    ${kind.padEnd(6)} ${kb(s.raw)} -> ${kb(s.out)}  (${where})`);
  }
  if (!r.products.board) console.log('    board  (none — deferred)');
  console.log(
    `    raster <image> in: ${r.rasterKinds.length ? r.rasterKinds.join(', ') : '(none)'}`
  );
}
console.log(
  `\nTotal: ${(rawTotal / 1024 / 1024).toFixed(1)}MB raw -> ${(outTotal / 1024 / 1024).toFixed(1)}MB written` +
    (svgo ? ` (${Math.round(100 - (outTotal / rawTotal) * 100)}% smaller)` : '')
);
console.log(`Wrote ${OUT_JS}`);
