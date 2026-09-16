import { describe, it, expect } from 'vitest';
import { clampView, isDefaultView, ZOOM_MIN, ZOOM_MAX } from '../../site/js/pawn-frame.js';

// THE BUYER'S ADJUSTMENT, ON ITS WAY TO THE PRINTER. The zoom and pan she sets on
// the collection page are stored on the order (db.clampPawnView holds the same
// bounds) and handed to the generator as --photo-frame. Where they MOVE the photo
// is build.apply_photo_view, repeated in the browser by pawn-print.js viewCrop and
// held to it by tests/unit/pawn-print.test.js; what this file holds is the range
// and the defaults both ends read.
describe('clampView — the page and the store agree on the bounds', () => {
  it('holds zoom and pan inside the range the slider can produce', () => {
    expect(clampView({ zoom: 99, dx: 5, dy: -5 })).toEqual({
      zoom: ZOOM_MAX,
      dx: 1,
      dy: -1,
      bg: false,
    });
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
