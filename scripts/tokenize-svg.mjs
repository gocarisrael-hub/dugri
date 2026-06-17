#!/usr/bin/env node
// Dependency-free tokenizer for Canva SVG card designs.
// - Detects vivid theme colors (skips white/black/neutral greys)
// - Replaces them with CSS vars var(--c0)..var(--cN) (c0 = darkest), but ONLY
//   where the hex is real paint (fill / stop-color / style:fill) — never inside
//   url(#id) refs or id="…" attributes.
// - Fits each single-card SVG's viewBox to its rendered bounds via getBBox()
// - Writes tokenized SVGs to site/assets/designs/<id>/{front,back,board}.svg
// - Emits site/js/designs.generated.js
//
// Usage: node scripts/tokenize-svg.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CANVA = resolve(ROOT, 'resources/canva');
const OUT_ASSETS = resolve(ROOT, 'site/assets/designs');
const OUT_JS = resolve(ROOT, 'site/js/designs.generated.js');

// ---- design manifest -------------------------------------------------------
// Sources are single-card transparent SVG exports: a front, a back, and the
// board. Each card sits inside the full artboard, so we fit the viewBox to the
// card via getBBox() (below).
const DESIGNS = [
  {
    id: 'birthday',
    folder: 'dugri birthday no neon',
    files: {
      front: 'dugri birthday no neon.svg',
      back: 'back card.svg',
      board: 'לוח משחק.svg',
    },
  },
  {
    id: 'kids',
    folder: 'dugri birthday kids',
    files: {
      front: 'dugri birthday kids.svg',
      back: 'back card.svg',
      board: 'לוח משחק.svg',
    },
  },
  {
    id: 'marriage',
    folder: 'dugri marriage no affects',
    files: {
      front: 'dugri marriage no affects.svg',
      back: 'back card.svg',
      board: 'לוח משחק.svg',
    },
  },
  {
    id: 'bachelorette',
    folder: 'dugri bachelorette',
    files: { front: 'dugri bachelorette.svg', back: 'back card.svg', board: '3.svg' },
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

// ---- fit each card's viewBox to its real content --------------------------
// The single-card exports place the card inside the full artboard with empty
// space around it. We crop the viewBox to the card's true rendered bounds using
// the browser's getBBox() (transform-aware, reliable for any positioning).
// Geometry only — colours don't affect the bbox.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function fitViewBox(src, anchors, label) {
  const vars = anchors.map((c, i) => `--c${i}:${c}`).join(';');
  const tmp = `/tmp/fit_${label}.html`;
  writeFileSync(
    tmp,
    `<!doctype html><meta charset="utf8"><body><div style="${vars}">${src}</div>` +
      `<script>const s=document.querySelector('svg');const b=s.getBBox();` +
      `document.title='BB '+[b.x,b.y,b.width,b.height].map((n)=>n.toFixed(3)).join(' ');</script>`
  );
  let title = '';
  try {
    title = execSync(
      `"${CHROME}" --headless --disable-gpu --virtual-time-budget=4000 --dump-dom "file://${tmp}" 2>/dev/null | grep -oE '<title>BB[^<]*</title>'`,
      { encoding: 'utf8' }
    ).trim();
  } catch {
    title = '';
  }
  rmSync(tmp, { force: true });
  const m = title.match(/BB\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (!m) {
    console.warn(`  [fitViewBox] ${label}: Chrome/getBBox returned no bbox — viewBox left unfit.`);
    return src; // fallback: leave the viewBox untouched
  }
  const bw = parseFloat(m[3]);
  const bh = parseFloat(m[4]);
  if (bw <= 0 || bh <= 0) {
    console.warn(
      `  [fitViewBox] ${label}: empty bbox (BB ${m[1]} ${m[2]} ${m[3]} ${m[4]}) — viewBox left unfit.`
    );
    return src; // fallback: leave the viewBox untouched
  }
  const M = 3; // small breathing margin around the card
  const x = parseFloat(m[1]) - M;
  const y = parseFloat(m[2]) - M;
  const w = bw + 2 * M;
  const h = bh + 2 * M;
  const newVb = `${x.toFixed(3)} ${y.toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}`;
  let out;
  if (/viewBox\s*=\s*"[^"]+"/.test(src)) {
    out = src.replace(/viewBox\s*=\s*"[^"]+"/, `viewBox="${newVb}"`);
  } else {
    // source <svg> had no viewBox: insert the computed one so dropping
    // width/height below still leaves the SVG with a coordinate system.
    out = src.replace(/<svg\b/, `<svg viewBox="${newVb}"`);
  }
  // drop fixed width/height so the inline SVG scales to its container
  out = out.replace(/(<svg[^>]*?)\swidth="[^"]*"/, '$1');
  out = out.replace(/(<svg[^>]*?)\sheight="[^"]*"/, '$1');
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
    svg = fitViewBox(svg, anchors, `${d.id}-${kind}`);
    const outPath = resolve(outDir, `${kind}.svg`);
    writeFileSync(outPath, svg);
    products[kind] = `assets/designs/${d.id}/${kind}.svg`;
  }

  report.push({ id: d.id, anchors, products, rasterKinds, hasRaster: rasterKinds.length > 0 });
}

// ---- emit designs.generated.js --------------------------------------------
let js = '// AUTO-GENERATED by scripts/tokenize-svg.mjs — do not edit by hand.\n';
js += 'export const GENERATED = {\n';
for (const r of report) {
  const anchorsStr = r.anchors.map((a) => `'${a}'`).join(',');
  const p = r.products;
  const key = `${r.id}:`.padEnd(14);
  js += `  ${key}{ anchors:[${anchorsStr}], hasRaster:${r.hasRaster}, products:{ front:'${p.front}', back:'${p.back}', board:'${p.board}' } },\n`;
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
