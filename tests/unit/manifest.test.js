import { describe, it, expect } from 'vitest';
import { validateManifest, assertManifest } from '../../site/js/configurator.js';

const goodDesigns = [
  {
    id: 'birthday',
    name: 'יום הולדת',
    anchors: ['#5100ad', '#ff00db', '#cb6ce6', '#f6d5ff'],
    products: { front: 'front.svg', back: 'back.svg', board: 'board.svg' },
  },
  {
    id: 'marriage',
    name: 'חתונה',
    anchors: ['#102030', '#405060'],
    products: { front: 'f.svg', back: 'b.svg', board: 'g.svg' },
  },
];

const goodColors = [
  { id: 'violet', name: 'סגול', hex: '#7A3FF2' },
  { id: 'pink', name: 'ורוד', hex: '#E5197D' },
];

describe('validateManifest', () => {
  it('passes on a good manifest', () => {
    expect(validateManifest(goodDesigns, goodColors)).toEqual([]);
  });

  it('assertManifest returns true on a good manifest', () => {
    expect(assertManifest(goodDesigns, goodColors)).toBe(true);
  });

  it('fails when a product is missing', () => {
    const bad = JSON.parse(JSON.stringify(goodDesigns));
    delete bad[0].products.board;
    const errors = validateManifest(bad, goodColors);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain('board');
  });

  it('fails when products object is missing entirely', () => {
    const bad = JSON.parse(JSON.stringify(goodDesigns));
    delete bad[1].products;
    const errors = validateManifest(bad, goodColors);
    expect(errors.join('\n')).toContain('products');
  });

  it('fails when anchors are missing or empty', () => {
    const bad = JSON.parse(JSON.stringify(goodDesigns));
    bad[0].anchors = [];
    expect(validateManifest(bad, goodColors).join('\n')).toContain('anchors');
  });

  it('fails on an anchor that is not a valid hex', () => {
    const bad = JSON.parse(JSON.stringify(goodDesigns));
    bad[0].anchors[1] = 'not-a-color';
    expect(validateManifest(bad, goodColors).join('\n')).toContain('anchor');
  });

  it('fails on a main color with a bad hex', () => {
    const bad = JSON.parse(JSON.stringify(goodColors));
    bad[1].hex = '#zzz';
    const errors = validateManifest(goodDesigns, bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain('pink');
  });

  it('fails on empty inputs', () => {
    expect(validateManifest([], goodColors).length).toBeGreaterThan(0);
    expect(validateManifest(goodDesigns, []).length).toBeGreaterThan(0);
  });

  it('assertManifest throws on a bad manifest', () => {
    const bad = JSON.parse(JSON.stringify(goodDesigns));
    delete bad[0].products.front;
    expect(() => assertManifest(bad, goodColors)).toThrow(/Invalid manifest/);
  });
});
