#!/usr/bin/env node
// Dependency-free tokenizer for Canva SVG card designs.
// - Detects vivid theme colors (skips white/black/neutral greys)
// - Replaces them with CSS vars var(--c0)..var(--cN) (c0 = darkest)
// - Crops fronts & backs to one representative card (top-left cell of 8-up sheet)
// - Writes tokenized SVGs to site/assets/designs/<id>/{front,back,board}.svg
// - Emits site/js/designs.generated.js
//
// Usage: node scripts/tokenize-svg.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CANVA = resolve(ROOT, 'resources/canva');
const OUT_ASSETS = resolve(ROOT, 'site/assets/designs');
const OUT_JS = resolve(ROOT, 'site/js/designs.generated.js');

// ---- design manifest -------------------------------------------------------
const DESIGNS = [
  {
    id: 'birthday',
    folder: 'dugri birthday no neon',
    files: { front: 'פני כרטיסים.svg', back: 'גב כרטיסים.svg', board: 'לוח משחק.svg' },
  },
  {
    id: 'kids',
    folder: 'dugri birthday kids',
    files: { front: 'פני כרטיסים.svg', back: 'גב כרטיסים.svg', board: 'לוח משחק.svg' },
  },
  {
    id: 'marriage',
    folder: 'dugri marriage no affects',
    files: { front: 'פני כרטיסים.svg', back: 'גב כרטיסים.svg', board: 'לוח משחק.svg' },
  },
  // bachelorette: identified by rendering -> 1=front, 2=back, 3=board
  {
    id: 'bachelorette',
    folder: 'dugri bachelorette',
    files: { front: '1.svg', back: '2.svg', board: '3.svg' },
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
const HEX_RE = /#[0-9a-fA-F]{6}/g;
// Only colours declared in real paint attributes count toward the palette.
// (Bare hex strings also appear inside clip-path ids / antialias edges, which
// we must NOT treat as theme colours.)
const PAINT_RE =
  /(?:fill|stop-color)\s*=\s*"(#[0-9a-fA-F]{6})"|style\s*=\s*"[^"]*?fill\s*:\s*(#[0-9a-fA-F]{6})/g;

function collectThemeColors(svgFiles) {
  // Count occurrences across all 3 product svgs of a design so we pick
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
  const filtered = kept.filter((k) => k.count >= Math.max(3, maxCount * 0.01));
  // Sort darkest -> lightest by HSL lightness.
  filtered.sort((a, b) => {
    const la = rgbToHsl(...hexToRgb(a.hex))[2];
    const lb = rgbToHsl(...hexToRgb(b.hex))[2];
    return la - lb;
  });
  return filtered.map((k) => k.hex);
}

// ---- tokenization ----------------------------------------------------------
function tokenize(src, anchors) {
  // Build map hex -> var index. Also map near-duplicate hexes to nearest anchor.
  let out = src;
  // Replace every 6-digit hex literal occurrence that maps to a theme anchor.
  out = out.replace(HEX_RE, (hex) => {
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
  });
  return out;
}

// ---- crop fronts/backs to one card ----------------------------------------
// Each card is defined by a clipPath <path> rectangle (in absolute sheet
// coords). Detect the most-repeated card-sized clip (the 8 cards) and crop the
// viewBox to the TOP-LEFT one. Geometry only — no rendering. Falls back to a
// 4x2 grid cell if no clips are found.

function clipPathBBoxes(src) {
  const boxes = [];
  const re = /<clipPath\b[^>]*>\s*<path\b[^>]*\bd="([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const nums = (m[1].match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length < 4) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = nums[i];
      const y = nums[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
  }
  return boxes;
}

function cropToCard(src) {
  const vbMatch = src.match(/viewBox\s*=\s*"([^"]+)"/);
  if (!vbMatch) return src;
  const vb = vbMatch[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb.length !== 4) return src;

  // card-sized clips only (exclude tiny icon/text clips and full-sheet clips)
  const cards = clipPathBBoxes(src).filter(
    (b) => b.w > 80 && b.h > 120 && b.w < vb[2] * 0.9 && b.h < vb[3] * 0.95
  );

  let box;
  if (cards.length) {
    // the real cards are the most-repeated size; quantize and pick that group
    const groups = new Map();
    for (const b of cards) {
      const key = `${Math.round(b.w / 6)}x${Math.round(b.h / 6)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    const best = [...groups.values()].sort(
      (a, c) => c.length - a.length || c[0].w * c[0].h - a[0].w * a[0].h
    )[0];
    box = best.slice().sort((a, c) => a.y - c.y || a.x - c.x)[0]; // top-left
  } else {
    box = { x: vb[0], y: vb[1], w: vb[2] / 4, h: vb[3] / 2 };
  }

  const M = 1.5; // small margin so the card edge isn't clipped
  const x = box.x - M;
  const y = box.y - M;
  const w = box.w + 2 * M;
  const h = box.h + 2 * M;
  const newVb = `${x.toFixed(3)} ${y.toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}`;
  let out = src.replace(/viewBox\s*=\s*"[^"]+"/, `viewBox="${newVb}"`);
  out = out.replace(/(<svg[^>]*?)\swidth="[^"]*"/, `$1 width="${w.toFixed(2)}"`);
  out = out.replace(/(<svg[^>]*?)\sheight="[^"]*"/, `$1 height="${h.toFixed(2)}"`);
  return out;
}

// ---- main ------------------------------------------------------------------
const report = [];

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
  for (const kind of ['front', 'back', 'board']) {
    let svg = srcs[kind];
    if ((svg.match(/<image\b/g) || []).length > 0) rasterKinds.push(kind);
    svg = tokenize(svg, anchors);
    if (kind === 'front' || kind === 'back') svg = cropToCard(svg);
    const outPath = resolve(outDir, `${kind}.svg`);
    writeFileSync(outPath, svg);
    products[kind] = `assets/designs/${d.id}/${kind}.svg`;
  }

  report.push({ id: d.id, anchors, products, rasterKinds });
}

// ---- emit designs.generated.js --------------------------------------------
let js = '// AUTO-GENERATED by scripts/tokenize-svg.mjs — do not edit by hand.\n';
js += 'export const GENERATED = {\n';
for (const r of report) {
  const anchorsStr = r.anchors.map((a) => `'${a}'`).join(',');
  const p = r.products;
  const key = `${r.id}:`.padEnd(14);
  js += `  ${key}{ anchors:[${anchorsStr}], products:{ front:'${p.front}', back:'${p.back}', board:'${p.board}' } },\n`;
}
js += '};\n';
mkdirSync(dirname(OUT_JS), { recursive: true });
writeFileSync(OUT_JS, js);

// ---- console report --------------------------------------------------------
console.log('Tokenized designs:\n');
for (const r of report) {
  console.log(`  ${r.id}`);
  console.log(`    anchors (c0..): ${r.anchors.join(', ')}`);
  console.log(`    front: ${r.products.front}`);
  console.log(`    back:  ${r.products.back}`);
  console.log(`    board: ${r.products.board}`);
  console.log(
    `    raster <image> in: ${r.rasterKinds.length ? r.rasterKinds.join(', ') : '(none)'}`
  );
}
console.log(`\nWrote ${OUT_JS}`);
