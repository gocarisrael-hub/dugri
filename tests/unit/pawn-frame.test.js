import { describe, it, expect } from 'vitest';
import { containRect } from '../../site/js/pawn-frame.js';

// Where `object-fit: contain` really puts the card picture inside its frame. The
// photo layer is measured onto that rectangle, because the frame around the card
// is not always the card's shape: Chrome derives the frame's width from
// `aspect-ratio` + `max-height`, Safari leaves the frame at full width and centres
// the picture inside it. Assuming the two rectangles were the same is what put the
// buyer's photos 22px off their printed cut-lines on an iPhone, and stretched each
// circle 27% wider than tall.
//
// (How a photo is framed and drawn is site/js/pawn-print.js, held to the generator
// by tests/unit/pawn-print.test.js.)
describe('containRect', () => {
  it('is the whole element when the shapes agree', () => {
    const r = containRect(200, 300, 400, 600);
    expect(r).toEqual({ left: 0, top: 0, width: 200, height: 300 });
  });

  it('bands the sides when the element is wider than the picture', () => {
    // Exactly the Safari case measured on a phone: a 327px frame around a card
    // that wants to be 257 wide.
    const r = containRect(327, 357.8, 448, 624);
    expect(r.width).toBeCloseTo(256.9, 1);
    expect(r.height).toBeCloseTo(357.8, 1);
    expect(r.left).toBeCloseTo((327 - r.width) / 2, 6); // centred, not flush
    expect(r.top).toBeCloseTo(0, 6);
  });

  it('bands the top and bottom when the element is taller', () => {
    const r = containRect(300, 400, 400, 200);
    expect(r).toEqual({ left: 0, top: 125, width: 300, height: 150 });
  });

  it('answers null rather than a guess when a size is missing', () => {
    // An <img> that has not decoded yet reports 0 for its natural size, and the
    // caller leaves the layer where the stylesheet put it instead of collapsing
    // it — which would blank the photos on any redraw that lands early.
    expect(containRect(200, 300, 0, 0)).toBe(null);
    expect(containRect(0, 300, 400, 600)).toBe(null);
    expect(containRect(200, 300, 400, undefined)).toBe(null);
  });
});
