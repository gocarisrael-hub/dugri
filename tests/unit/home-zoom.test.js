// @vitest-environment node
// The homepage's tapped-design zoom math (site/js/home-zoom.js) and the hero deck's auto-deal rule (site/js/home-data.js).
//
// What these pin:
//   1. A zoomed view never opens a gap at any edge, never shrinks below its own size and never passes MAX_ZOOM.
//   2. A pinch keeps the point under the fingers under the fingers; a double-tap zoom keeps the tapped point where it was.
//   3. The deck deals by itself only when nobody is busy with the page: never under reduced motion, in the background,
//      with the hero off screen, with a dialog open, with a card in hand, or within AUTO_DEAL_MS of the last touch.
//   4. Every card picture's sharper twin exists at the width its srcset claims, and has a JPEG twin for old Safari.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { clampView, zoomAbout, pinch, MAX_ZOOM } from '../../site/js/home-zoom.js';
import { autoDealAllowed, AUTO_DEAL_MS, cardSrcset, DESIGN_ART } from '../../site/js/home-data.js';

const W = 300,
  H = 200;

describe('the zoom keeps the pictures in their box', () => {
  it('never zooms out below 1 or in past MAX_ZOOM', () => {
    expect(clampView({ s: 0.4, tx: 10, ty: 10 }, W, H)).toEqual({ s: 1, tx: 0, ty: 0 });
    expect(clampView({ s: 9, tx: 0, ty: 0 }, W, H).s).toBe(MAX_ZOOM);
  });
  it('never opens a gap at an edge', () => {
    const v = clampView({ s: 2, tx: 50, ty: -900 }, W, H);
    expect(v.tx).toBe(0); // the left edge stays covered
    expect(v.ty).toBe(H - H * 2); // the bottom edge stays covered
  });
});

describe('the zoom follows the fingers', () => {
  it('a double-tap zoom keeps the tapped point under the finger', () => {
    const v = zoomAbout({ s: 1, tx: 0, ty: 0 }, 2.5, 120, 80, W, H);
    expect(v.s).toBe(2.5);
    // the content point under (120, 80) before is under (120, 80) after
    expect(v.tx + 120 * v.s).toBeCloseTo(120, 6);
    expect(v.ty + 80 * v.s).toBeCloseTo(80, 6);
  });
  it('a pinch scales by the fingers’ spread and carries the point between them along', () => {
    const v0 = { s: 1, tx: 0, ty: 0 };
    const v = pinch(v0, [150, 100], 100, [160, 110], 200, W, H);
    expect(v.s).toBe(2);
    // the content point that was between the fingers (150, 100) is between them again at (160, 110)
    expect(v.tx + 150 * v.s).toBeCloseTo(160, 6);
    expect(v.ty + 100 * v.s).toBeCloseTo(110, 6);
  });
  it('pinching in past the original size settles back at 1 with no offset', () => {
    expect(pinch({ s: 2, tx: -100, ty: -50 }, [150, 100], 200, [150, 100], 20, W, H)).toEqual({
      s: 1,
      tx: 0,
      ty: 0,
    });
  });
});

describe('the deck deals by itself only when the page is left alone', () => {
  const idle = {
    reduce: false,
    pageHidden: false,
    heroOnScreen: true,
    dialogOpen: false,
    holding: false,
    sinceTouch: Infinity,
  };
  it('deals on an idle, visible hero', () => {
    expect(autoDealAllowed(idle)).toBe(true);
    expect(AUTO_DEAL_MS).toBe(8000);
  });
  it.each([
    ['reduced motion', { reduce: true }],
    ['the page in the background', { pageHidden: true }],
    ['the hero off screen', { heroOnScreen: false }],
    ['a dialog open', { dialogOpen: true }],
    ['a card in hand', { holding: true }],
    ['a touch moments ago', { sinceTouch: AUTO_DEAL_MS - 1 }],
  ])('waits with %s', (_, change) => {
    expect(autoDealAllowed({ ...idle, ...change })).toBe(false);
  });
  it('deals again once AUTO_DEAL_MS have passed since the last touch', () => {
    expect(autoDealAllowed({ ...idle, sinceTouch: AUTO_DEAL_MS })).toBe(true);
  });
});

// 4. The cards' sharper twins: every srcset names a file that exists, at the width it claims, with a JPEG twin for old Safari.
const CARDS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../site/assets/home/cards'
);
// a WebP's pixel width from its header (VP8X, lossy VP8 or lossless VP8L)
function webpWidth(file) {
  const b = fs.readFileSync(file);
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return 1 + b.readUIntLE(24, 3);
  if (kind === 'VP8 ') return b.readUInt16LE(26) & 0x3fff;
  if (kind === 'VP8L') return 1 + (b.readUInt16LE(21) & 0x3fff);
  throw new Error(`${file}: not a WebP`);
}

describe('the cards have sharp twins for 2x and 3x screens', () => {
  const all = Object.entries(DESIGN_ART).flatMap(([id, a]) => [
    ...Array.from({ length: a.fronts }, (_, i) => `assets/home/cards/${id}-f${i + 1}.webp`),
    ...(a.back ? [`assets/home/cards/${id}-b1.webp`] : []),
  ]);
  it.each(all)('%s', (src) => {
    const [one, ...twins] = cardSrcset(src)
      .split(', ')
      .map((c) => c.split(' '));
    expect(one).toEqual([src, '400w']);
    expect(webpWidth(path.join(CARDS, path.basename(src)))).toBe(400);
    expect(twins.length).toBeGreaterThanOrEqual(1);
    let last = 400;
    twins.forEach(([url, w], i) => {
      // @2x, then @3x: each a real file, as wide as it claims and wider than the rung below
      expect(url).toBe(src.replace('.webp', `@${i + 2}x.webp`));
      const width = Number(w.replace('w', ''));
      expect(webpWidth(path.join(CARDS, path.basename(url)))).toBe(width);
      expect(width).toBeGreaterThan(last);
      last = width;
    });
    // old Safari's JPEG twin: the @2x one serves every sharper rung
    expect(fs.existsSync(path.join(CARDS, path.basename(src).replace('.webp', '@2x.jpg')))).toBe(
      true
    );
  });
  it('gives the cards cut from a vector source a 1200 px rung for a zoomed view', () => {
    for (const id of ['bachelorette', 'birthday', 'marriage', 'tarifa'])
      for (const side of ['f1', 'b1'])
        expect(cardSrcset(`assets/home/cards/${id}-${side}.webp`)).toMatch(/@3x\.webp 1200w$/);
  });
  it('gives no srcset to a picture that is not one of the page’s own cards', () => {
    expect(cardSrcset('/api/template-image/brand-new/front')).toBe('');
    expect(cardSrcset('assets/home/cards/unknown-f1.webp')).toBe('');
  });
});
