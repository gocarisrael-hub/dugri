#!/usr/bin/env node
// Gallery-asset renderer for the product pages.
//
// WHY THIS EXISTS
// The product-detail gallery (site/product.html + js/product.js) shows crisp
// hi-res renders at assets/designs/<id>/gallery-{front,back,board}.webp. Those
// files were generated ONCE, by hand, and then frozen — nothing in the repo
// regenerated them. That bit us: on the `posttrip` design the "דוגרי" logo tile
// in the middle of the board came out as a BLACK SQUARE.
//
// ROOT CAUSE. In board.svg every logo tile is a base64 PNG turned into an
// alpha-luminance <mask> (a Canva export pattern) and then painted onto a circle
// via `mask="url(#<hash>)"`. An earlier minifier pass (svgo-style) reserialized
// element ids through a Number(): a hex-ish id such as `2175e85314` reads as
// scientific notation (2175 × 10^85314) → Infinity, so the MASK DEFINITION's id
// became the literal string "Infinity" while the `url(#2175e85314)` REFERENCE
// (inside a string, never reparsed) stayed intact. The reference now dangles, so
// the browser paints the group UNMASKED — the tile's opaque dark PNG background
// fills the whole circle → a black box. (bachelorette/marriage have the same
// id-overflow on clipPath/filter ids, which degrade harmlessly; only posttrip's
// collapsed id was on a <mask>, so only posttrip showed the black square.)
//
// The durable fix is in the source SVG (rename the mask id back). As belt-and-
// braces, healMaskIds() below repairs the unambiguous 1:1 case in memory before
// every render, so a re-export that reintroduces the corruption still renders
// correctly.
//
// This is the SIBLING of scripts/product-thumbs.mjs (which renders the small 2-up
// thumb-*.webp). Same toolchain — headless Chromium (Playwright) → PNG →
// ImageMagick → webp — and the same original-colour <style> injection so the
// tokenized var(--cN) paints resolve to each design's shipped hexes. It renders
// the LARGER gallery-*.webp (1100px) straight from the committed tokenized SVGs
// in site/assets/designs, so it runs in any checkout/CI without the Canva staging
// sources.
//
// NOTE. store.webp is a 3D "beauty shot" mockup (cards + board on a surface), NOT
// a flat board render, and is authored outside this repo — this script does not
// and cannot regenerate it. Every shipped store.webp already renders the logo
// correctly, so none needed fixing.
//
// Usage:
//   node scripts/render-design-assets.mjs                       # render MISSING gallery assets
//   node scripts/render-design-assets.mjs --force               # re-render every gallery asset
//   node scripts/render-design-assets.mjs --design=posttrip     # only this design
//   node scripts/render-design-assets.mjs --design=posttrip --kind=board --force
//
// Fails loudly if a renderer is missing or a result comes out near-blank, so a
// blank/broken gallery image can never ship.

import { readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SITE = resolve(ROOT, 'site');

const GALLERY_W = 1100; // final webp width (px) — matches the shipped gallery assets
const MIN_BYTES = 2500; // near-blank guard

// ---- original-colour style (mirror of site/options.html paintSvg) ----------
// Wrap the tokenized SVG so its var(--cN) paint resolves to the ORIGINAL hexes.
let uid = 0;
export function paintOriginal(svgText, anchors) {
  if (!anchors || !anchors.length) return svgText; // fixed design: literal colours
  const id = 'render-svg-' + ++uid;
  const rules = anchors
    .map(
      (hex, i) =>
        `#${id} [fill="var(--c${i})"]{fill:${hex}}` +
        `#${id} [stroke="var(--c${i})"]{stroke:${hex}}`
    )
    .join('');
  return svgText.replace(/<svg\b([^>]*)>/i, `<svg id="${id}"$1><style>${rules}</style>`);
}

// ---- self-heal the id-overflow corruption ----------------------------------
// A minifier that reserializes ids through Number() collapses a scientific-
// notation-looking hex id (e.g. "2175e85314") to the string "Infinity"/"NaN" on
// the DEFINITION while the url(#...) REFERENCE keeps the original text. If a mask
// def id collapsed this way, the reference dangles and the tile paints unmasked
// (a black box). Repair only the UNAMBIGUOUS case: exactly one dangling mask
// reference and exactly one unreferenced mask def with an overflow id — rename
// the def back to the dangling id. Anything ambiguous is left untouched.
const OVERFLOW_IDS = new Set(['Infinity', '-Infinity', 'NaN']);
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function healMaskIds(svgText) {
  const defs = [...svgText.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
  const refs = [...svgText.matchAll(/mask="url\(#([^)]+)\)"/g)].map((m) => m[1]);
  const defSet = new Set(defs);
  const refSet = new Set(refs);
  const dangling = [...new Set(refs.filter((r) => !defSet.has(r)))];
  const orphanOverflow = defs.filter((d) => OVERFLOW_IDS.has(d) && !refSet.has(d));
  if (dangling.length === 1 && orphanOverflow.length === 1) {
    const from = orphanOverflow[0];
    const to = dangling[0];
    // Replace ONLY the `<mask id="…"` prefix, keyed on the id via regex — never a
    // literal `<mask id="…">`. The detection regex tolerates trailing attributes
    // (`<mask id="Infinity" maskUnits="…">`); the heal must too, or it would detect
    // but silently no-op on such a def and re-ship the black board.
    const re = new RegExp('<mask id="' + escapeRe(from) + '"');
    return { svg: svgText.replace(re, '<mask id="' + to + '"'), healed: { from, to } };
  }
  return { svg: svgText, healed: null };
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
  if (!existsSync(outPath)) throw new Error(`gallery ${label}: not written`);
  const bytes = statSync(outPath).size;
  if (bytes < MIN_BYTES) {
    throw new Error(
      `gallery ${label}: looks near-blank (${bytes} bytes < ${MIN_BYTES}) — refusing to ship. ` +
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
        'gallery rendering needs Playwright (chromium). Run `npm install` (and ' +
          '`npx playwright install chromium`).'
      );
    }
  }
  if (!magick) {
    throw new Error('gallery rendering needs ImageMagick `magick` for PNG→webp conversion.');
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    for (const { label, svg, outPath } of jobs) {
      await page.setViewportSize({ width: GALLERY_W * 2, height: GALLERY_W * 2 });
      await page.setContent(
        `<!doctype html><body style="margin:0;background:#fff">` +
          `<div id="w" style="width:${GALLERY_W * 2}px">${svg}</div></body>`,
        { waitUntil: 'networkidle' }
      );
      await page.evaluate((w) => {
        const s = document.querySelector('#w svg');
        if (s) {
          s.style.width = w + 'px';
          s.style.height = 'auto';
          s.style.display = 'block';
        }
      }, GALLERY_W * 2);
      const el = await page.$('#w svg');
      if (!el) throw new Error(`gallery ${label}: no <svg> element found in source`);
      const tmpPng = resolve(dirname(outPath), `.gallery-${label}.png`);
      await el.screenshot({ path: tmpPng, type: 'png' });
      execSync(
        `${magick} ${JSON.stringify(tmpPng)} -resize ${GALLERY_W}x ` +
          `-background white -flatten -quality 86 ${JSON.stringify(outPath)}`,
        { stdio: 'ignore' }
      );
      rmSync(tmpPng, { force: true });
      assertNotBlank(label, outPath);
    }
  } finally {
    await browser.close();
  }
}

// ---- main (CLI only) -------------------------------------------------------
async function main() {
  const FORCE = process.argv.includes('--force');
  const ONLY_DESIGN =
    (process.argv.find((a) => a.startsWith('--design=')) || '').split('=')[1] || '';
  const ONLY_KIND = (process.argv.find((a) => a.startsWith('--kind=')) || '').split('=')[1] || '';

  const { GENERATED } = await import('../site/js/designs.generated.js');

  const jobs = [];
  for (const [id, g] of Object.entries(GENERATED)) {
    if (ONLY_DESIGN && id !== ONLY_DESIGN) continue;
    const kinds = ['front', 'back', ...(g.products.board ? ['board'] : [])];
    for (const kind of kinds) {
      if (ONLY_KIND && kind !== ONLY_KIND) continue;
      const rel = `assets/designs/${id}/gallery-${kind}.webp`;
      const outPath = resolve(SITE, rel);
      if (!FORCE && existsSync(outPath) && statSync(outPath).size >= MIN_BYTES) continue;
      const svgPath = resolve(SITE, g.products[kind]);
      const { svg: healedSvg, healed } = healMaskIds(readFileSync(svgPath, 'utf8'));
      if (healed) {
        console.log(`  [heal] ${id}-${kind}: mask id "${healed.from}" → "${healed.to}"`);
      }
      const svg = paintOriginal(healedSvg, g.anchors);
      jobs.push({ label: `${id}-${kind}`, svg, outPath, rel });
    }
  }

  if (jobs.length) {
    console.log(`Rendering ${jobs.length} gallery asset(s)…`);
    await render(jobs);
    const kb = (b) => (b / 1024).toFixed(1) + 'KB';
    for (const { label, outPath, rel } of jobs) {
      console.log(`  ${label.padEnd(22)} ${rel}  ${kb(statSync(outPath).size)}`);
    }
  } else {
    console.log('All gallery assets present — nothing to render (use --force to re-render).');
  }
}

// Run only when invoked directly (so unit tests can import the pure helpers).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
