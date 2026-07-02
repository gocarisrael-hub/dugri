import { describe, it, expect } from 'vitest';
import { validateManifest, assertManifest, isValidHex } from '../../site/js/configurator.js';
import { DESIGNS, MAIN_COLORS } from '../../site/js/designs.js';

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

  it('board is OPTIONAL: a design without a board is still valid', () => {
    const noBoard = JSON.parse(JSON.stringify(goodDesigns));
    delete noBoard[0].products.board;
    expect(validateManifest(noBoard, goodColors)).toEqual([]);
  });

  it('fails when a required product (front) is missing', () => {
    const bad = JSON.parse(JSON.stringify(goodDesigns));
    delete bad[0].products.front;
    const errors = validateManifest(bad, goodColors);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain('front');
  });

  it('fails when a required product (back) is missing', () => {
    const bad = JSON.parse(JSON.stringify(goodDesigns));
    delete bad[1].products.back;
    expect(validateManifest(bad, goodColors).join('\n')).toContain('back');
  });

  it('fails when products object is missing entirely', () => {
    const bad = JSON.parse(JSON.stringify(goodDesigns));
    delete bad[1].products;
    const errors = validateManifest(bad, goodColors);
    expect(errors.join('\n')).toContain('products');
  });

  it('fails when a SLIDER design has empty anchors', () => {
    const bad = JSON.parse(JSON.stringify(goodDesigns));
    bad[0].anchors = [];
    expect(validateManifest(bad, goodColors).join('\n')).toContain('anchors');
  });

  it('allows an empty anchor list for a FIXED design (never recoloured)', () => {
    const fixed = JSON.parse(JSON.stringify(goodDesigns));
    fixed[0].anchors = [];
    fixed[0].recolor = 'fixed';
    expect(validateManifest(fixed, goodColors)).toEqual([]);
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

describe('generated manifest (real DESIGNS)', () => {
  const byId = Object.fromEntries(DESIGNS.map((d) => [d.id, d]));

  it('the committed manifest is valid', () => {
    expect(validateManifest(DESIGNS, MAIN_COLORS)).toEqual([]);
    expect(assertManifest(DESIGNS, MAIN_COLORS)).toBe(true);
  });

  it('ships every owner-confirmed theme id (incl. the new japanese/posttrip/neon)', () => {
    for (const id of [
      'bachelorette',
      'marriage',
      'birthday',
      'japanese',
      'posttrip',
      'neon',
      'kids',
    ]) {
      expect(byId[id], `missing design ${id}`).toBeTruthy();
    }
  });

  it('every design has a front + back; only board is optional', () => {
    for (const d of DESIGNS) {
      expect(d.products.front, `${d.id} front`).toBeTruthy();
      expect(d.products.back, `${d.id} back`).toBeTruthy();
    }
  });

  it('kids has NO board (deferred) and that is allowed', () => {
    expect(byId.kids.products.board).toBeUndefined();
    // a manifest with a board-less design still validates cleanly.
    expect(validateManifest(DESIGNS, MAIN_COLORS)).toEqual([]);
  });

  it('every other design DOES have a board', () => {
    for (const id of ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'neon']) {
      expect(byId[id].products.board, `${id} board`).toBeTruthy();
    }
  });

  it('every anchor is a valid #rrggbb; sliders have anchors, the fixed theme has none', () => {
    for (const d of DESIGNS) {
      for (const a of d.anchors) expect(isValidHex(a), `${d.id}: ${a}`).toBe(true);
      if (d.recolor === 'fixed') {
        // a fixed theme is never recoloured -> no var(--cN) tokens, no anchors.
        expect(d.anchors, `${d.id} (fixed) should have no anchors`).toEqual([]);
      } else {
        expect(d.anchors.length, `${d.id} (slider) needs anchors`).toBeGreaterThan(0);
      }
    }
  });

  it("recolor is 'slider' for all themes except neon, which is 'fixed'", () => {
    for (const d of DESIGNS) {
      expect(['slider', 'fixed']).toContain(d.recolor);
    }
    expect(byId.neon.recolor).toBe('fixed');
    for (const id of ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'kids']) {
      expect(byId[id].recolor, id).toBe('slider');
    }
  });

  it('every design has a raster thumbnail for the picker tile (not the full SVG)', () => {
    for (const d of DESIGNS) {
      expect(d.thumb, `${d.id} thumb`).toMatch(/assets\/designs\/.+\/thumb\.webp$/);
    }
  });

  it('full-page designs carry embedded photos, so hasRaster is true across the board', () => {
    // the with-background full-deck pages all embed at least one <image> (a photo
    // background on a card or the board), so every shipped design reports raster.
    for (const d of DESIGNS) {
      expect(d.hasRaster, `${d.id} hasRaster`).toBe(true);
    }
  });
});
