import { describe, it, expect } from 'vitest';
import {
  CARD_CELL,
  cellBox,
  cropSvgToCell,
  fluidSvg,
  fitNameFontPx,
} from '../../site/js/name-preview-instant.js';

// Pure helpers behind the step-3 INSTANT client card draw. They must be robust to
// malformed input (return null, never throw) so the instant draw can always fall
// back to the neutral CSS placeholder.

describe('cellBox', () => {
  it('derives a portrait card box (~0.69 ratio) from the card cell', () => {
    const b = cellBox(CARD_CELL);
    expect(b.w).toBeCloseTo(190.426, 2);
    expect(b.h).toBeCloseTo(275.892, 2);
    expect(b.ratio).toBeLessThan(1); // portrait
    expect(b.ratio).toBeGreaterThan(0.6);
  });
});

describe('cropSvgToCell', () => {
  const SHEET = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 841.92 595.5"><rect/></svg>';

  it('re-windows the viewBox to the single card cell and drops width/height', () => {
    const out = cropSvgToCell('<svg width="800" height="600" viewBox="0 0 841.92 595.5"></svg>');
    expect(out).toMatch(/viewBox="9\.746 10\.496 190\.426 275\.892"/);
    expect(out).not.toMatch(/width="800"/);
    expect(out).not.toMatch(/height="600"/);
    expect(out).toMatch(/preserveAspectRatio="xMidYMid meet"/);
  });

  it('keeps the rest of the document intact', () => {
    const out = cropSvgToCell(SHEET);
    expect(out).toContain('<rect/>');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('returns null for input without a root <svg>', () => {
    expect(cropSvgToCell('<div>no svg</div>')).toBeNull();
    expect(cropSvgToCell(null)).toBeNull();
    expect(cropSvgToCell(undefined)).toBeNull();
  });
});

describe('fluidSvg', () => {
  it('strips width/height but keeps the artboard viewBox', () => {
    const out = fluidSvg('<svg width="842" height="595" viewBox="0 0 842.25 595.5"></svg>');
    expect(out).toMatch(/viewBox="0 0 842\.25 595\.5"/);
    expect(out).not.toMatch(/width="842"/);
    expect(out).not.toMatch(/height="595"/);
  });

  it('returns null without a root <svg>', () => {
    expect(fluidSvg('nope')).toBeNull();
  });
});

describe('fitNameFontPx', () => {
  it('shrinks longer names so they fit the same box', () => {
    const short = fitNameFontPx('Sara', 120);
    const long = fitNameFontPx('Alexandrina', 120);
    expect(long).toBeLessThan(short);
  });

  it('clamps within [minPx, maxPx]', () => {
    expect(fitNameFontPx('I', 300, { maxPx: 40 })).toBe(40); // a single glyph would blow past the cap
    expect(fitNameFontPx('AbsurdlyLongUnbreakableName', 40, { minPx: 11 })).toBe(11);
  });

  it('never returns NaN/0 for a zero-width box', () => {
    expect(fitNameFontPx('Sara', 0)).toBe(11);
  });
});
