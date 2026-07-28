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
// PORTRAIT CARD STRUCTURE (docs/card-structure-schema.md). The deck is moving
// from landscape A4 sheets of 8 cards to PORTRAIT SINGLE CARDS
// (viewBox "0 0 223.92 312", ~0.72 aspect). A migrated template keeps its
// artwork as <slug>/clean/{1..9}.svg — 1 = the card BACK, 2–9 = the eight front
// styles — so a migrated design's gallery renders ONE representative card per
// slide instead of a whole sheet:
//   clean/1.svg -> gallery-back.webp   the portrait card back
//   clean/2.svg -> gallery-front.webp  the HERO card (one representative front)
//   photo card  -> gallery-photo.webp  the 104th front, which carries the buyer's
//                                      four pawn photos — ALWAYS rendered here
//                                      with the GENERIC Dugri fallback art, never
//                                      with a real customer's photos.
// Only designs listed in PORTRAIT below take that path; every other design still
// renders from the committed landscape sheets in site/assets/designs, unchanged.
// The board is NOT part of the 1–9 set and keeps rendering from its site SVG.
//
// NOTE. store.webp is a 3D "beauty shot" mockup (cards + board on a surface), NOT
// a flat board render, and is authored outside this repo — this script does not
// and cannot regenerate it. Every shipped store.webp already renders the logo
// correctly, so none needed fixing.
// ⚠ store.webp is now STALE for portrait designs: the hand-authored beauty shots
// still show the old LANDSCAPE cards. Nothing here can fix that — the owner has
// to re-shoot them. Accepted deliberately; see the portrait-gallery PR.
//
// Usage:
//   node scripts/render-design-assets.mjs                       # render MISSING gallery assets
//   node scripts/render-design-assets.mjs --force               # re-render every gallery asset
//   node scripts/render-design-assets.mjs --design=posttrip     # only this design
//   node scripts/render-design-assets.mjs --design=posttrip --kind=board --force
//
// Fails loudly if a renderer is missing or a result comes out near-blank, so a
// blank/broken gallery image can never ship.

import { readFileSync, existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SITE = resolve(ROOT, 'site');
const TEMPLATES = resolve(ROOT, 'resources/canva/templates');

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

// ---- portrait card structure -----------------------------------------------
// Storefront design id -> its template directory under resources/canva/templates.
// A design is listed here ONLY once its artwork has been re-exported into the
// numbered portrait structure (clean/1..9.svg). Everything not listed keeps the
// legacy landscape-sheet renders — which is why the seven live designs are
// untouched by this file until the owner re-exports them one at a time.
//
// `grapefruit` is the first (and today the only) migrated template. It is NOT yet
// a storefront product — it has no generator theme in generator/themes.json, so it
// is deliberately absent from the design catalog. Its renders are STAGED here so
// the portrait pipeline is proven end-to-end and so the pictures are ready the day
// the owner promotes it. tests/e2e/product-portrait.spec.js drives the real
// storefront against exactly these files.
export const PORTRAIT = {
  grapefruit: 'grapefruit',
};

// Which numbered card stands in for each gallery slide. 1 = back, 2–9 = the eight
// fronts; front 2 is the representative HERO card. (An "all eight styles" contact
// sheet was considered and dropped: on grapefruit, fronts 2–8 render pixel
// identical — they differ only by Canva's randomised element ids — so the slide
// would have shown eight copies of one card. Revisit when a template ships fronts
// that genuinely differ.)
const PORTRAIT_CARD = { back: 1, front: 2 };

// The PHOTO CARD's artwork, in preference order, relative to the template dir and
// then to the shared fallback dir. It must ALWAYS be the generic Dugri art — this
// picture is a storefront advert, so a real customer's four photos must never be
// rendered into it.
const PHOTO_CARD_SOURCES = [
  (dir) => resolve(dir, 'clean/photo.svg'), // per-theme photo-card template
  () => resolve(TEMPLATES, '_shared/photo-fallback/photo-card.svg'), // shared generic
];

const DATA_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Read a portrait card SVG with its DE-DUPLICATED images inlined.
 *
 * Migrated artwork stores each shared background raster ONCE at
 * <slug>/assets/<sha16>.png and references it as href="../assets/<sha16>.png"
 * (docs/card-structure-schema.md §4) — grapefruit's eight fronts share one 5 MB
 * PNG, so this is what keeps the template at 9 MB instead of 124 MB.
 *
 * That relative reference resolves fine over HTTP, but this renderer hands the
 * SVG to page.setContent(), whose document has NO base URL: a relative href has
 * nothing to resolve against, and rewriting it to file:// only gets it blocked as
 * a local-file subresource. Rewriting to file:// was tried and the card came out
 * with visible garbage where the grapefruit pattern should be — and the near-blank
 * byte guard did NOT catch it, because the card frame alone is far bigger than
 * MIN_BYTES. So a bad reference here ships a broken picture silently; always LOOK
 * at a new render. Inlining as a data: URI is the only form that survives
 * setContent, and it is byte-for-byte the raster the SVG shipped with.
 *
 * A no-op on artwork that was never de-duplicated, so it is always the correct
 * way to read a card SVG (mirrors generator/card_assets.read_svg on the Python
 * side).
 */
export function inlineCardAssets(svgText, svgPath, readFile = readFileSync) {
  const base = dirname(svgPath);
  return svgText.replace(/href="(\.\.\/assets\/[^"]+)"/g, (whole, rel) => {
    const abs = resolve(base, rel);
    let bytes;
    try {
      bytes = readFile(abs);
    } catch {
      // Missing asset: leave the reference alone so the near-blank guard / a
      // visual check surfaces it, rather than silently swallowing the error.
      console.warn(`  [warn] card asset not found: ${rel} (from ${basename(svgPath)})`);
      return whole;
    }
    const mime = DATA_MIME[extname(abs).toLowerCase()] || 'image/png';
    return `href="data:${mime};base64,${bytes.toString('base64')}"`;
  });
}

/** Read a card SVG from disk, assets inlined. */
function readCardSvg(svgPath) {
  return inlineCardAssets(readFileSync(svgPath, 'utf8'), svgPath);
}

/** The photo card's source SVG for a template dir, or '' when none exists yet. */
export function photoCardSource(templateDir, exists = existsSync) {
  for (const pick of PHOTO_CARD_SOURCES) {
    const p = pick(templateDir);
    if (exists(p)) return p;
  }
  return '';
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
      // A design rendering for the first time (a newly migrated portrait template)
      // has no assets/designs/<id>/ dir yet.
      mkdirSync(dirname(outPath), { recursive: true });
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
  const wanted = (id, kind) => {
    if (ONLY_DESIGN && id !== ONLY_DESIGN) return null;
    if (ONLY_KIND && kind !== ONLY_KIND) return null;
    const rel = `assets/designs/${id}/gallery-${kind}.webp`;
    const outPath = resolve(SITE, rel);
    // Already rendered (and not near-blank)? Leave it — --force re-renders.
    if (!FORCE && existsSync(outPath) && statSync(outPath).size >= MIN_BYTES) return null;
    return { rel, outPath };
  };

  // PORTRAIT designs first: their card slides come from the template's numbered
  // artwork, NOT from the landscape sheets in site/assets/designs. A portrait
  // design may not be in the catalog at all yet (grapefruit), so this loop is
  // driven by PORTRAIT rather than by GENERATED.
  for (const [id, slug] of Object.entries(PORTRAIT)) {
    const dir = resolve(TEMPLATES, slug);
    if (!existsSync(dir)) {
      // The artwork lands via the asset-migration PR; until then there is simply
      // nothing to render. Never fatal — the rest of the gallery must still build.
      console.log(`  [skip] ${id}: portrait artwork missing (${dir})`);
      continue;
    }
    for (const [kind, n] of Object.entries(PORTRAIT_CARD)) {
      const want = wanted(id, kind);
      if (!want) continue;
      const svgPath = resolve(dir, `clean/${n}.svg`);
      if (!existsSync(svgPath)) {
        console.log(`  [skip] ${id}-${kind}: no clean/${n}.svg`);
        continue;
      }
      jobs.push({ label: `${id}-${kind}`, svg: readCardSvg(svgPath), ...want });
    }
    // The photo card is optional: it needs the generic Dugri fallback art, which
    // ships separately. Without it we render NOTHING — no gallery-photo.webp means
    // no thumbs.photo, which means the reader simply omits the slide (it never
    // 404s a missing slide into the carousel).
    const photoWant = wanted(id, 'photo');
    if (photoWant) {
      const src = photoCardSource(dir);
      if (src) jobs.push({ label: `${id}-photo`, svg: readCardSvg(src), ...photoWant });
      else console.log(`  [skip] ${id}-photo: no photo-card art yet (see docs/photo-card.md)`);
    }
  }

  for (const [id, g] of Object.entries(GENERATED)) {
    if (ONLY_DESIGN && id !== ONLY_DESIGN) continue;
    // A portrait design's front/back come from the loop above; only its BOARD
    // (which is not part of the 1–9 card set) still renders from the site SVG.
    const cards = PORTRAIT[id] ? [] : ['front', 'back'];
    const kinds = [...cards, ...(g.products.board ? ['board'] : [])];
    for (const kind of kinds) {
      const want = wanted(id, kind);
      if (!want) continue;
      const svgPath = resolve(SITE, g.products[kind]);
      const { svg: healedSvg, healed } = healMaskIds(readFileSync(svgPath, 'utf8'));
      if (healed) {
        console.log(`  [heal] ${id}-${kind}: mask id "${healed.from}" → "${healed.to}"`);
      }
      const svg = paintOriginal(healedSvg, g.anchors);
      jobs.push({ label: `${id}-${kind}`, svg, ...want });
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
