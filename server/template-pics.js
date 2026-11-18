// template-pics.js — the shop's PICTURES of an uploaded design, as a WebP width ladder instead of the raw template SVG.
//
// THE PROBLEM. An uploaded design's shop picture is its template's filled SVG (GET /api/template-image/<slug>/<slot>):
// a Canva export with its photos embedded at full resolution. Measured on production 2026-11-18: tarifa's front is
// 3.08 MB (545 KB gzipped), its board 3.3 MB; grapefruit's front 0.64 MB. The shop grid paints them into ~160 px tiles,
// the response is not edge-cacheable (an /api/ URL with a 5-minute max-age), so every phone pulled them from Railway.
//
// THIS MODULE rasterizes exactly those SVGs (generator/svg_picture.py: one Chrome screenshot each, drawn as an <img>
// draws it) and cuts a WebP ladder from them. It is a second KIND of art on server/home-art.js's machinery, so it
// inherits its invariants rather than restating them: the URL carries a revision of the template's files (a replaced
// card is a new URL, the files are served `immutable` and Cloudflare keeps them); a request never waits for a render;
// renders share ONE lane with the home art and yield to the buyers' previews; a failure is per (design, rev) and
// bounded, and until a ladder exists the page keeps the SVG it shows today.
//
// SCOPE. Pictures for the shop only. The deck, the proof, the press export and the wizard's name preview never read
// these files: they render the template's own SVGs, untouched.
//
// OFF unless TEMPLATE_PICS=on, or NODE_ENV=production with TEMPLATE_PICS unset.
const path = require('path');
const { createHomeArt, runRender, enabled } = require('./home-art');

const SCRIPT = path.join(__dirname, '..', 'generator', 'svg_picture.py');

// Bump when the output changes (the ladder, the render). p1 = svg_picture.py screenshot, the ladder below.
const REV = 'p1';
// A card paints at most ~430 CSS px wide (the product page on a phone, 96vw) and the grid ~170; the board up to the
// product page's 860 px column. The top rungs serve a 3x phone; the fullscreen zoom takes the top rung.
const LADDER = { front: [400, 800, 1200], back: [400, 800, 1200], board: [800, 1400, 2000] };
const SLOTS = ['front', 'back', 'board'];

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {(slug:string)=>string} o.fingerprint      the template's files (index.js templateFingerprint)
 * @param {(slug:string, slot:string)=>string|null} o.imagePath  the SVG behind /api/template-image/<slug>/<slot>
 * @param {(p:string)=>boolean} [o.exists]
 * @param {{run:Function}} [o.lane]                 shared with the home art
 * @param {boolean} [o.on]
 * @param {Function} [o.render] / [o.resize] / [o.spawnRender] / [o.now] / [o.log]   test seams, as in home-art.js
 */
function createTemplatePics(o) {
  const exists = o.exists || require('fs').existsSync;
  const svgFor = (slug, slot) => {
    const p = o.imagePath(slug, slot);
    return p && exists(p) ? p : null;
  };
  const render =
    o.render ||
    (({ slug, outDir }) => {
      const args = [SCRIPT, outDir];
      for (const slot of SLOTS) {
        const svg = svgFor(slug, slot);
        if (svg) args.push(`${slot}=${svg}:${Math.max(...LADDER[slot])}`);
      }
      if (args.length === 2) return Promise.reject(new Error('the template has no picture SVG'));
      return runRender(args, o.spawnRender);
    });
  return createHomeArt({
    dataDir: o.dataDir,
    fingerprint: o.fingerprint,
    name: 'template-pics',
    rev: REV,
    ladder: LADDER,
    // nothing but the template's files: the pictures carry no sample name
    revInput: () => '',
    lane: o.lane,
    on: typeof o.on === 'boolean' ? o.on : enabled(process.env, 'TEMPLATE_PICS'),
    render,
    resize: o.resize,
    now: o.now,
    log: o.log,
  });
}

module.exports = { createTemplatePics, REV, LADDER };
