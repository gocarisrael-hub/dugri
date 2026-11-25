import { describe, it, expect } from 'vitest';
import {
  clampPan,
  clampView,
  isDefaultView,
  PAN_REACH,
  ZOOM_MIN,
  ZOOM_MAX,
} from '../../site/js/pawn-frame.js';
import { viewCrop } from '../../site/js/pawn-print.js';

// THE BUYER'S ADJUSTMENT, ON ITS WAY TO THE PRINTER. The zoom and pan she sets on
// the collection page are stored on the order (db.clampPawnView holds the same
// bounds) and handed to the generator as --photo-frame. Where they MOVE the photo
// is build.apply_photo_view, repeated in the browser by pawn-print.js viewCrop and
// held to it by tests/unit/pawn-print.test.js; what this file holds is the range
// and the defaults both ends read.
describe('clampView — the page and the store agree on the bounds', () => {
  it('holds zoom and pan inside the range the slider can produce', () => {
    const v = clampView({ zoom: 99, dx: 5, dy: -5 });
    expect(v.zoom).toBe(ZOOM_MAX);
    expect(Math.hypot(v.dx, v.dy)).toBeCloseTo(PAN_REACH / ZOOM_MAX, 12);
    expect(v.dx).toBeCloseTo(-v.dy, 12);
    expect(clampView({ zoom: 0.01 }).zoom).toBe(ZOOM_MIN);
  });

  it('treats junk as "she has not moved it"', () => {
    expect(clampView({ zoom: 'x', dx: null, dy: NaN })).toEqual({
      zoom: 1,
      dx: 0,
      dy: 0,
      bg: false,
    });
    expect(clampView(undefined)).toEqual({ zoom: 1, dx: 0, dy: 0, bg: false });
  });

  it('keeps the background choice, which is not a number', () => {
    expect(clampView({ bg: 1 }).bg).toBe(true);
    expect(clampView({ bg: false }).bg).toBe(false);
  });

  it('knows when a view asks for nothing — that is when it is not sent at all', () => {
    expect(isDefaultView({ zoom: 1, dx: 0, dy: 0 })).toBe(true);
    // The background is not part of it: keeping the background changes WHICH file
    // prints, not how it is framed, so it travels separately.
    expect(isDefaultView({ zoom: 1, dx: 0, dy: 0, bg: true })).toBe(true);
    expect(isDefaultView({ zoom: 1.2, dx: 0, dy: 0 })).toBe(false);
    expect(isDefaultView({ zoom: 1, dx: 0.01, dy: 0 })).toBe(false);
  });
});

// THE PAN KEEPS THE SUBJECT IN THE CIRCLE. A real order printed five of eight
// pawns as empty discs: page-scroll swipes that began on a photo were saved as
// pans of ±1, and at ±1 the window no longer overlaps the subject. The automatic
// window centres the subject with its farthest pixel on a disc of radius 0.45 of
// the window's side; her view puts the printed disc's centre (dx, dy) away with a
// radius of 0.45 / zoom — so the subject's centre stays inside while the pan's
// LENGTH is at most 0.45 / zoom.
describe('clampPan — a radius of PAN_REACH / zoom', () => {
  it('is the printed disc radius, from the default disc fill', () => {
    expect(PAN_REACH).toBe(0.45);
  });

  it('pulls a runaway pan back onto the circle, keeping its direction', () => {
    for (const zoom of [ZOOM_MIN, 1, 1.7, ZOOM_MAX]) {
      for (const [dx, dy] of [
        [-1, 1],
        [0, -1],
        [0.99, -1],
        [1, 0],
      ]) {
        const [x, y] = clampPan(dx, dy, zoom);
        expect(Math.hypot(x, y)).toBeCloseTo(PAN_REACH / zoom, 12);
        expect(Math.atan2(y, x)).toBeCloseTo(Math.atan2(dy, dx), 12);
      }
    }
  });

  it('leaves a pan inside the circle alone, and is idempotent on the rim', () => {
    expect(clampPan(0.2, -0.1, 1)).toEqual([0.2, -0.1]);
    expect(clampPan(0.8, 0, 0.5)).toEqual([0.8, 0]);
    const once = clampPan(0.99, -1, 1);
    expect(clampPan(once[0], once[1], 1)).toEqual(once);
    expect(clampView(clampView({ zoom: 1.3, dx: -1, dy: 1 }))).toEqual(
      clampView({ zoom: 1.3, dx: -1, dy: 1 })
    );
  });

  it('a drag can never take the subject out of the circle at any zoom', () => {
    for (let zoom = ZOOM_MIN; zoom <= ZOOM_MAX; zoom += 0.1) {
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 7) {
        const v = clampView({ zoom, dx: 3 * Math.cos(a), dy: 3 * Math.sin(a) });
        // In the window's own units, the subject's centre is at -(dx, dy) * zoom
        // from the printed disc's centre, and that disc's radius is 0.45.
        expect(Math.hypot(v.dx, v.dy) * v.zoom).toBeLessThanOrEqual(0.45 * (1 + 1e-9));
      }
    }
  });

  it('viewCrop clamps too, so a view stored before the bound draws as it prints', () => {
    // build.apply_photo_view gives (0, -45, 100, 55) for this — test_photo_view.py.
    expect(viewCrop([0, 0, 100, 100], { zoom: 1, dx: 0, dy: -1 })).toEqual([0, -45, 100, 55]);
  });
});
