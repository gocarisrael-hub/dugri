import { describe, it, expect } from 'vitest';
import {
  hexToHsl,
  hslToHex,
  clamp,
  mostSaturatedIndex,
  derivePalette,
  isValidHex,
  applyOriginal,
  mainAnchor,
} from '../../site/js/configurator.js';

const BIRTHDAY = ['#5100ad', '#ff00db', '#cb6ce6', '#f6d5ff'];

describe('applyOriginal / mainAnchor', () => {
  it('applyOriginal sets --c0..--cN to the literal anchors', () => {
    const set = {};
    const el = { style: { setProperty: (k, v) => (set[k] = v) } };
    const out = applyOriginal(el, BIRTHDAY);
    expect(out).toEqual(BIRTHDAY);
    expect(set['--c0']).toBe('#5100ad');
    expect(set['--c3']).toBe('#f6d5ff');
  });

  it('mainAnchor returns the most-saturated anchor', () => {
    expect(mainAnchor(BIRTHDAY)).toBe(BIRTHDAY[mostSaturatedIndex(BIRTHDAY)]);
  });

  it('applyOriginal throws on empty anchors', () => {
    expect(() => applyOriginal({ style: { setProperty() {} } }, [])).toThrow();
  });
});

describe('hexToHsl / hslToHex round-trip', () => {
  const samples = [
    '#000000',
    '#ffffff',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#7A3FF2',
    '#E5197D',
    '#2D7FF9',
    '#1FAE72',
    ...BIRTHDAY,
  ];

  it('round-trips hex -> hsl -> hex within 2 per channel', () => {
    for (const hex of samples) {
      const back = hslToHex(hexToHsl(hex));
      const a = hex.toLowerCase();
      for (let i = 1; i < 7; i += 2) {
        const orig = parseInt(a.slice(i, i + 2), 16);
        const rt = parseInt(back.slice(i, i + 2), 16);
        expect(Math.abs(orig - rt)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('hexToHsl returns h in 0..360, s/l in 0..100', () => {
    for (const hex of samples) {
      const { h, s, l } = hexToHsl(hex);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(360);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(100);
    }
  });

  it('grayscale has zero saturation', () => {
    expect(hexToHsl('#808080').s).toBe(0);
    expect(hexToHsl('#000000').s).toBe(0);
    expect(hexToHsl('#ffffff').s).toBe(0);
  });
});

describe('isValidHex', () => {
  it('accepts #rrggbb', () => {
    expect(isValidHex('#5100ad')).toBe(true);
    expect(isValidHex('#FFFFFF')).toBe(true);
  });
  it('rejects bad values', () => {
    expect(isValidHex('5100ad')).toBe(false);
    expect(isValidHex('#fff')).toBe(false);
    expect(isValidHex('#gggggg')).toBe(false);
    expect(isValidHex('#12345')).toBe(false);
    expect(isValidHex(123)).toBe(false);
    expect(isValidHex(null)).toBe(false);
  });
});

describe('clamp', () => {
  it('clamps to bounds', () => {
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(50, 0, 100)).toBe(50);
  });
});

describe('mostSaturatedIndex', () => {
  it('finds the most saturated anchor of birthday', () => {
    // '#5100ad' (idx 0) and '#ff00db' (idx 1) are both s=100; ties -> lowest index.
    expect(mostSaturatedIndex(BIRTHDAY)).toBe(0);
  });

  it('resolves ties to the lowest index', () => {
    // two equally (fully) saturated colors -> first wins
    expect(mostSaturatedIndex(['#ff0000', '#00ff00', '#777777'])).toBe(0);
  });
  it('throws on empty', () => {
    expect(() => mostSaturatedIndex([])).toThrow();
  });
});

describe('derivePalette', () => {
  const green = '#1FAE72';
  const mainIdx = mostSaturatedIndex(BIRTHDAY);

  it('main slot ~= chosen main color', () => {
    const derived = derivePalette(green, BIRTHDAY);
    const g = hexToHsl(green);
    const d = hexToHsl(derived[mainIdx]);
    expect(Math.abs(d.h - g.h)).toBeLessThanOrEqual(1);
    expect(Math.abs(d.s - g.s)).toBeLessThanOrEqual(1);
    expect(Math.abs(d.l - g.l)).toBeLessThanOrEqual(1);
  });

  it('returns one color per anchor', () => {
    expect(derivePalette(green, BIRTHDAY)).toHaveLength(BIRTHDAY.length);
  });

  it('preserves the lightness ordering of the original anchors', () => {
    const origL = BIRTHDAY.map((a) => hexToHsl(a).l);
    const derived = derivePalette(green, BIRTHDAY);
    const newL = derived.map((c) => hexToHsl(c).l);
    // Compare ordering of every pair where the original has a clear gap.
    for (let i = 0; i < origL.length; i++) {
      for (let j = 0; j < origL.length; j++) {
        if (origL[i] + 1 < origL[j]) {
          expect(newL[i]).toBeLessThan(newL[j]);
        }
      }
    }
  });

  it('preserves relative lightness deltas (no clamping for green main)', () => {
    const m = hexToHsl(BIRTHDAY[mainIdx]);
    const main = hexToHsl(green);
    const derived = derivePalette(green, BIRTHDAY);
    BIRTHDAY.forEach((a, i) => {
      const expectedL = main.l + (hexToHsl(a).l - m.l);
      if (expectedL >= 1 && expectedL <= 99) {
        expect(Math.abs(hexToHsl(derived[i]).l - expectedL)).toBeLessThanOrEqual(1.5);
      }
    });
  });

  it('preserves relative hue offsets between slots', () => {
    const m = hexToHsl(BIRTHDAY[mainIdx]);
    const main = hexToHsl(green);
    const derived = derivePalette(green, BIRTHDAY);
    BIRTHDAY.forEach((a, i) => {
      const ah = hexToHsl(a);
      const dh = hexToHsl(derived[i]);
      const expectedH = (((main.h + (ah.h - m.h)) % 360) + 360) % 360;
      // Only check saturated slots — hue is meaningless near s=0/l=0/l=100.
      if (dh.s > 5 && dh.l > 5 && dh.l < 95) {
        let diff = Math.abs(dh.h - expectedH) % 360;
        if (diff > 180) diff = 360 - diff;
        expect(diff).toBeLessThanOrEqual(2);
      }
    });
  });

  it('wraps hue across 360 (red main keeps offsets positive mod 360)', () => {
    const red = '#ff0000'; // h = 0
    const derived = derivePalette(red, BIRTHDAY);
    derived.forEach((c) => {
      const { h } = hexToHsl(c);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(360);
    });
  });

  it('clamps lightness at 0 and 100', () => {
    // A near-black main pushes the lighter anchors past 100 -> clamps.
    const whiteDerived = derivePalette('#ffffff', BIRTHDAY).map((c) => hexToHsl(c).l);
    whiteDerived.forEach((l) => expect(l).toBeLessThanOrEqual(100));
    const blackDerived = derivePalette('#000000', BIRTHDAY).map((c) => hexToHsl(c).l);
    blackDerived.forEach((l) => expect(l).toBeGreaterThanOrEqual(0));
    // With a pure-white main, every slot clamps to white (l=100) or near it.
    expect(Math.max(...whiteDerived)).toBeLessThanOrEqual(100);
  });
});
