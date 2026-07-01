import { describe, it, expect } from 'vitest';
import { lightestIndex, bleedColor, derivePalette } from '../../site/js/configurator.js';

// The card's printed background ("bleed") shown around the card in the preview
// is the design's lightest anchor, recoloured with the chosen main colour.
const BIRTHDAY = ['#5100ad', '#ff00db', '#ff00ff', '#cb6ce6', '#f6d5ff'];
const MARRIAGE = ['#004aad', '#4e8bdd', '#f4f1eb'];

describe('lightestIndex', () => {
  it('returns the index of the lightest anchor', () => {
    expect(lightestIndex(BIRTHDAY)).toBe(4); // #f6d5ff
    expect(lightestIndex(MARRIAGE)).toBe(2); // #f4f1eb
  });

  it('throws on an empty anchor list', () => {
    expect(() => lightestIndex([])).toThrow();
  });
});

describe('bleedColor', () => {
  it('with no main colour returns the design background anchor as-is', () => {
    expect(bleedColor(null, BIRTHDAY)).toBe('#f6d5ff');
    expect(bleedColor(null, MARRIAGE)).toBe('#f4f1eb');
  });

  it('with a chosen main colour returns the derived background slot', () => {
    const main = '#2d7ff9';
    const derived = derivePalette(main, BIRTHDAY);
    expect(bleedColor(main, BIRTHDAY)).toBe(derived[lightestIndex(BIRTHDAY)]);
  });

  it('always returns a valid #rrggbb colour', () => {
    expect(bleedColor('#0fbfa8', MARRIAGE)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
