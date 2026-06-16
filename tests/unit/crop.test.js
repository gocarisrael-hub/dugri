import { describe, it, expect } from 'vitest';
import { pathToBox, clipPathBBoxes, pickCardBox } from '../../scripts/crop-util.mjs';

// A pure card-frame rectangle: 5 points (closed), only 2 distinct x and 2
// distinct y values. This is what a real card's clipPath looks like.
const RECT_D = 'M 0.3 0.3 L 191.1 0.3 L 191.1 276.8 L 0.3 276.8 Z';

// A rounded / decoration path: many distinct x and y values. This is the kind
// of clip that previously bled neighbour decorations into the preview.
const ROUNDED_D =
  'M 88.5 -181.5 L 120.2 -150.9 L 150.7 -90.4 L 180.1 -40.2 L 220.9 12.3 L 200.4 60.8 L 150.0 103.9 Z';

describe('pathToBox', () => {
  it('detects a pure-rectangle card frame as a rect', () => {
    const box = pathToBox(RECT_D);
    expect(box).not.toBeNull();
    expect(box.isRect).toBe(true);
    expect(box.x).toBeCloseTo(0.3, 3);
    expect(box.y).toBeCloseTo(0.3, 3);
    expect(box.w).toBeCloseTo(190.8, 1);
    expect(box.h).toBeCloseTo(276.5, 1);
  });

  it('does NOT mark a many-point rounded/decoration path as a rect', () => {
    const box = pathToBox(ROUNDED_D);
    expect(box).not.toBeNull();
    expect(box.isRect).toBe(false);
  });

  it('returns null when there are too few coordinates', () => {
    expect(pathToBox('M 1 1')).toBeNull();
    expect(pathToBox('')).toBeNull();
  });
});

describe('clipPathBBoxes', () => {
  it('extracts a box per clipPath <path> with isRect flags', () => {
    const svg = `
      <clipPath id="a"><path d="${RECT_D}"/></clipPath>
      <clipPath id="b"><path d="${ROUNDED_D}"/></clipPath>
    `;
    const boxes = clipPathBBoxes(svg);
    expect(boxes).toHaveLength(2);
    expect(boxes[0].isRect).toBe(true);
    expect(boxes[1].isRect).toBe(false);
  });
});

describe('pickCardBox', () => {
  const VB_W = 841.92;
  const VB_H = 595.5;

  // Build a card-frame rectangle box at (x, y) with the real card size.
  const card = (x, y) => ({ x, y, w: 190.8, h: 276.5, isRect: true });

  it('ignores card-sized boxes that are NOT pure rectangles (decoration bleed)', () => {
    const boxes = [
      // a single rounded decoration clip that is card-sized but not a rect
      { x: 88.5, y: -181.5, w: 237.9, h: 285.4, isRect: false },
    ];
    expect(pickCardBox(boxes, VB_W, VB_H)).toBeNull();
  });

  it('picks the most-repeated pure-rect group and its TOP-LEFT box', () => {
    const boxes = [
      // the 8-card group (repeated) — top-left should be (0.3, 0.3)
      card(420.6, 0.3),
      card(0.3, 297.5),
      card(0.3, 0.3), // <- top-left (min y, then min x)
      card(210.4, 0.3),
      card(420.6, 297.5),
      // a smaller, less-repeated pure-rect group that must not win
      { x: 700, y: 0, w: 150, h: 145, isRect: true },
      { x: 700, y: 200, w: 150, h: 145, isRect: true },
    ];
    const picked = pickCardBox(boxes, VB_W, VB_H);
    expect(picked).not.toBeNull();
    expect(picked.x).toBeCloseTo(0.3, 3);
    expect(picked.y).toBeCloseTo(0.3, 3);
    expect(picked.w).toBeCloseTo(190.8, 1);
  });

  it('top-left selection prefers min-y, then min-x', () => {
    const boxes = [card(50, 50), card(10, 50), card(30, 10)];
    const picked = pickCardBox(boxes, VB_W, VB_H);
    // (30,10) has the smallest y, so it wins even though (10,50) has smaller x.
    expect(picked.x).toBe(30);
    expect(picked.y).toBe(10);
  });

  it('returns null when there are no card-sized pure-rect boxes', () => {
    const tiny = [{ x: 0, y: 0, w: 20, h: 20, isRect: true }];
    expect(pickCardBox(tiny, VB_W, VB_H)).toBeNull();
  });
});
