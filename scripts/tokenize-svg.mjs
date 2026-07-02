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

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
function stripSize(src) {
  return src.replace(/<svg\b[^>]*>/i, (tag) =>
    tag.replace(/\s(?:width|height)\s*=\s*"[^"]*"/gi, '')
  );
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
    // Never let optimisation strip the tokens the live recolor depends on.
    if (/fill="var\(--c/.test(src) && !/fill="var\(--c/.test(data)) {
      console.warn(`  [svgo] ${label}: dropped var() tokens — keeping raw.`);
      return { data: src, optimized: false };
    }
    return { data, optimized: true };
  } catch (e) {
    console.warn(`  [svgo] ${label}: optimise failed (${e.message}) — keeping raw.`);
    return { data: src, optimized: false };
  }
}

// ---- main ------------------------------------------------------------------
rmSync(OUT_ASSETS, { recursive: true, force: true });
const report = [];
let rawTotal = 0;
let outTotal = 0;

for (const d of DESIGNS) {
  const folder = resolve(CANVA, d.folder);
  const srcs = {};
  for (const [kind, fname] of Object.entries(d.files)) {
    srcs[kind] = readFileSync(resolve(folder, fname), 'utf8');
  }

  const anchors = collectThemeColors(Object.values(srcs));

  const outDir = resolve(OUT_ASSETS, d.id);
  mkdirSync(outDir, { recursive: true });

  const products = {};
  const rasterKinds = [];
  const sizes = {};
  for (const kind of Object.keys(d.files)) {
    let svg = srcs[kind];
    if ((svg.match(/<image\b/g) || []).length > 0) rasterKinds.push(kind);
    const rawBytes = Buffer.byteLength(svg);
    svg = tokenize(svg, anchors);
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

  report.push({
    id: d.id,
    anchors,
    products,
    rasterKinds,
    hasRaster: rasterKinds.length > 0,
    recolor: d.recolor,
    sizes,
  });
}

// ---- emit designs.generated.js --------------------------------------------
let js = '// AUTO-GENERATED by scripts/tokenize-svg.mjs — do not edit by hand.\n';
js += 'export const GENERATED = {\n';
for (const r of report) {
  const anchorsStr = r.anchors.map((a) => `'${a}'`).join(',');
  const p = r.products;
  const prodParts = [`front:'${p.front}'`, `back:'${p.back}'`];
  if (p.board) prodParts.push(`board:'${p.board}'`); // board optional
  const key = `${r.id}:`.padEnd(14);
  js +=
    `  ${key}{ anchors:[${anchorsStr}], hasRaster:${r.hasRaster}, ` +
    `recolor:'${r.recolor}', products:{ ${prodParts.join(', ')} } },\n`;
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
  console.log(`  ${r.id}  [recolor:${r.recolor}]`);
  console.log(`    anchors (c0..): ${r.anchors.join(', ')}`);
  for (const kind of Object.keys(r.sizes)) {
    const s = r.sizes[kind];
    console.log(`    ${kind.padEnd(6)} ${kb(s.raw)} -> ${kb(s.out)}  (${r.products[kind]})`);
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
