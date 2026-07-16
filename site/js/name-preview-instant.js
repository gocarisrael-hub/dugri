// name-preview-instant.js — pure helpers for the step-3 name-preview's INSTANT,
// in-browser card approximation.
//
// The name preview used to wait on POST /api/preview, which spawns a fresh
// Python + headless-Chrome render PER request (slow, and sometimes 429/times
// out). Instead we now draw a plausible card in the browser IMMEDIATELY from
// artwork the client already has (the per-design product SVGs), overlay the typed
// name, and let the exact server PNG swap in when it eventually arrives.
//
// Everything here is PURE and best-effort: a malformed SVG returns null so the
// caller can fall back to the neutral CSS placeholder — the instant draw must
// never throw or block.

// The representative sample card the server crops out of the 8-up front/back
// sheet is card 0. Its cell — in the shared 841.92×595.5 viewBox every shipped
// design uses — is effectively constant across all recipes, so we mirror that
// exact window here. Framing the SAME single card (not the whole sheet) keeps the
// instant approximation close to the PNG the server will return.
export const CARD_CELL = Object.freeze({
  x0: 9.746, //  left
  y0: 10.496, // top
  x1: 200.172, // right
  y1: 286.388, // bottom
});

/** The card cell as an {x,y,w,h,ratio} box (ratio = width/height, ~0.69 portrait). */
export function cellBox(cell = CARD_CELL) {
  const w = cell.x1 - cell.x0;
  const h = cell.y1 - cell.y0;
  return { x: cell.x0, y: cell.y0, w, h, ratio: w / h };
}

/**
 * Re-window an SVG document to a single card `cell` so an inline copy renders
 * ONLY that card (not the full 8-up sheet). We rewrite the root <svg>'s viewBox
 * to the cell and drop any width/height so it scales to its container;
 * preserveAspectRatio "xMidYMid meet" shows the whole card centred without
 * distortion. Returns null when there is no parseable root <svg>.
 */
export function cropSvgToCell(svgText, cell = CARD_CELL) {
  if (typeof svgText !== 'string') return null;
  const open = svgText.match(/<svg\b[^>]*>/i);
  if (!open) return null;
  const b = cellBox(cell);
  const vb = `${round(b.x)} ${round(b.y)} ${round(b.w)} ${round(b.h)}`;
  const tag = open[0]
    .replace(/\s(?:width|height|viewBox|preserveAspectRatio)="[^"]*"/gi, '')
    .replace(/<svg\b/i, `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet"`);
  return svgText.replace(open[0], tag);
}

/**
 * Strip the width/height off a full-artboard SVG (the board) so it scales to its
 * container, keeping its own viewBox. Returns the sized text, or null when there
 * is no root <svg>.
 */
export function fluidSvg(svgText) {
  if (typeof svgText !== 'string') return null;
  const open = svgText.match(/<svg\b[^>]*>/i);
  if (!open) return null;
  const tag = open[0].replace(/\s(?:width|height)="[^"]*"/gi, '');
  return svgText.replace(open[0], tag);
}

/**
 * Auto-shrink the overlaid name to fit the title band width. Text width is
 * estimated as glyphs × size × an average glyph-width factor (display faces run
 * ~0.58em), so we pick the largest size that fits `boxW` while staying within
 * [minPx, maxPx]. A single very long word can only shrink to minPx (it may then
 * marginally overflow — acceptable for an approximation the server render fixes).
 * @returns {number} font-size in px
 */
export function fitNameFontPx(name, boxW, { maxPx = 40, minPx = 11, glyph = 0.58 } = {}) {
  const len = Math.max(1, [...String(name || '').trim()].length);
  if (!(boxW > 0)) return minPx;
  const ideal = boxW / (len * glyph);
  return clamp(ideal, minPx, maxPx);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function round(n) {
  return Math.round(n * 1000) / 1000;
}
