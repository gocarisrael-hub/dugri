#!/usr/bin/env node
// Product-thumbnail renderer for the templates gallery (site/products.html).
//
// The gallery shows a per-tile front→back→board carousel. Inlining the multi-MB
// tokenized SVGs there would white-screen the Instagram in-app browser, so each
// carousel frame is a lightweight raster webp instead — one per product.
//
// This is a SIBLING to scripts/tokenize-svg.mjs. That script renders the small
// picker thumb (thumb.webp) from the Canva STAGING sources (gitignored, local
// only). This script instead renders the bigger 2-up gallery thumbs
// (thumb-front/back/board.webp) FROM THE COMMITTED tokenized SVGs in
// site/assets/designs — so it runs in any checkout/worktree/CI without staging.
//
// Faithful colours: the committed SVGs paint their theme colours through
// var(--cN) tokens that only resolve once a <style> supplies them (that's what
// lets the live colour slider recolor them in the browser). We inject the SAME
// original-colour <style> the site's paintSvg() builds, so the raster matches
// the design's ORIGINAL look. 'fixed' designs (neon, empty anchors) already
// carry literal colours and need no style.
//
// It also (re)writes the per-design `thumbs:{front,back[,board]}` map into
// site/js/designs.generated.js, keeping `thumb` (= front picker thumb) intact so
// options.html's design picker keeps working unchanged.
//
// Usage:
//   node scripts/product-thumbs.mjs            # render only MISSING thumbs, refresh manifest
//   node scripts/product-thumbs.mjs --force    # re-render every product thumb
//
// Rendering (headless Chromium → PNG, ImageMagick → downscaled webp) mirrors
// scripts/tokenize-svg.mjs. Fails loudly if a renderer is missing or a result
// comes out near-blank, so a blank thumb can never ship.

import { readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SITE = resolve(ROOT, 'site');
const OUT_JS = resolve(SITE, 'js/designs.generated.js');

const FORCE = process.argv.includes('--force');
const THUMB_W = 480; // final webp width (px) — ~2x the 2-up CSS tile for retina
const THUMB_MIN_BYTES = 2500; // near-blank guard

// ---- original-colour style (mirror of site/options.html paintSvg) ----------
// Wrap the tokenized SVG so its var(--cN) paint resolves to the ORIGINAL hexes.
let uid = 0;
function paintOriginal(svgText, anchors) {
  if (!anchors || !anchors.length) return svgText; // fixed design: literal colours
  const id = 'thumb-svg-' + ++uid;
  const rules = anchors
    .map(
      (hex, i) =>
        `#${id} [fill="var(--c${i})"]{fill:${hex}}` +
        `#${id} [stroke="var(--c${i})"]{stroke:${hex}}`
    )
    .join('');
  return svgText.replace(/<svg\b([^>]*)>/i, `<svg id="${id}"$1><style>${rules}</style>`);
}

// ---- ImageMagick (PNG → webp) ----------------------------------------------
let magick = null;
try {
  execSync('magick --version', { stdio: 'ignore' });
  magick = 'magick';
} catch {
  magick = null;
}

function assertNotBlank(label, outPath) {
  if (!existsSync(outPath)) throw new Error(`thumb ${label}: not written`);
  const bytes = statSync(outPath).size;
  if (bytes < THUMB_MIN_BYTES) {
    throw new Error(
      `thumb ${label}: looks near-blank (${bytes} bytes < ${THUMB_MIN_BYTES}) — refusing to ship. ` +
        `The renderer likely dropped the artwork; check the source/render.`
    );
  }
}

// Render [{ label, svg, outPath }] via headless Chromium → PNG → webp.
async function render(jobs) {
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
          '`npx playwright install chromium`).'
      );
    }
  }
  if (!magick) {
    throw new Error('thumbnail rendering needs ImageMagick `magick` for PNG→webp conversion.');
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    for (const { label, svg, outPath } of jobs) {
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
      if (!el) throw new Error(`thumb ${label}: no <svg> element found in source`);
      const tmpPng = resolve(dirname(outPath), `.thumb-${label}.png`);
      await el.screenshot({ path: tmpPng, type: 'png' });
      execSync(
        `${magick} ${JSON.stringify(tmpPng)} -resize ${THUMB_W}x ` +
          `-background white -flatten -quality 82 ${JSON.stringify(outPath)}`,
        { stdio: 'ignore' }
      );
      rmSync(tmpPng, { force: true });
      assertNotBlank(label, outPath);
    }
  } finally {
    await browser.close();
  }
}

// ---- main ------------------------------------------------------------------
const { GENERATED } = await import('../site/js/designs.generated.js');

const jobs = [];
const thumbsById = {};
for (const [id, g] of Object.entries(GENERATED)) {
  const kinds = ['front', 'back', ...(g.products.board ? ['board'] : [])];
  thumbsById[id] = {};
  for (const kind of kinds) {
    const rel = `assets/designs/${id}/thumb-${kind}.webp`;
    thumbsById[id][kind] = rel;
    const outPath = resolve(SITE, rel);
    if (!FORCE && existsSync(outPath) && statSync(outPath).size >= THUMB_MIN_BYTES) continue;
    const svgPath = resolve(SITE, g.products[kind]);
    const svg = paintOriginal(readFileSync(svgPath, 'utf8'), g.anchors);
    jobs.push({ label: `${id}-${kind}`, svg, outPath });
  }
}

if (jobs.length) {
  console.log(`Rendering ${jobs.length} product thumbnail(s)…`);
  await render(jobs);
} else {
  console.log('All product thumbnails present — nothing to render (use --force to re-render).');
}

// ---- rewrite designs.generated.js with the per-design `thumbs` map ---------
// Re-emit GENERATED verbatim (same shape as tokenize-svg.mjs) plus `thumbs`.
let js =
  '// AUTO-GENERATED by scripts/tokenize-svg.mjs + scripts/product-thumbs.mjs — do not edit by hand.\n';
js += 'export const GENERATED = {\n';
for (const [id, g] of Object.entries(GENERATED)) {
  const anchorsStr = g.anchors.map((a) => `'${a}'`).join(',');
  const p = g.products;
  const prodParts = [`front:'${p.front}'`, `back:'${p.back}'`];
  if (p.board) prodParts.push(`board:'${p.board}'`);
  const t = thumbsById[id];
  const thumbParts = [`front:'${t.front}'`, `back:'${t.back}'`];
  if (t.board) thumbParts.push(`board:'${t.board}'`);
  const key = `${id}:`.padEnd(14);
  const accentPart = g.accent ? `accent:'${g.accent}', ` : '';
  js +=
    `  ${key}{ anchors:[${anchorsStr}], hasRaster:${g.hasRaster}, ` +
    `recolor:'${g.recolor}', ${accentPart}thumb:'${g.thumb}', ` +
    `thumbs:{ ${thumbParts.join(', ')} }, products:{ ${prodParts.join(', ')} } },\n`;
}
js += '};\n';
writeFileSync(OUT_JS, js);

const kb = (b) => (b / 1024).toFixed(1) + 'KB';
console.log(`\nProduct thumbnails:`);
for (const [id, t] of Object.entries(thumbsById)) {
  const parts = Object.entries(t).map(([kind, rel]) => {
    const bytes = statSync(resolve(SITE, rel)).size;
    return `${kind}:${kb(bytes)}`;
  });
  console.log(`  ${id.padEnd(14)} ${parts.join('  ')}`);
}
console.log(`\nWrote ${OUT_JS}`);
