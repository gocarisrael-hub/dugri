import { describe, it, expect } from 'vitest';
import {
  plainFrame,
  applyView,
  clampView,
  isDefaultView,
  subjectFrame,
  SUBJECT_Y,
  DISC_FILL,
  ZOOM_MIN,
  ZOOM_MAX,
} from '../../site/js/pawn-frame.js';

// THE BUYER MOVES HER PHOTO, AND THE PRINTER MOVES IT THE SAME WAY.
//
// Two implementations decide where a pawn photo sits: this one, which draws the
// circle on her phone, and build.apply_photo_view, which crops the file that goes
// to the press. A preview that framed differently from the printer would be worse
// than no preview, because she would believe it — so the tests that matter here
// are the ones that hold the two together.
//
// The pair are expressed in different units on purpose (percent-of-slot here, a
// crop rectangle in source pixels there), so this file re-derives one from the
// other rather than comparing them literally.

// build.apply_photo_view, transcribed. Kept deliberately close to the Python so a
// change there is visible as a diff against this.
function pyApplyView(crop, view) {
  const [x0, y0, x1, y1] = crop;
  const side = x1 - x0;
  const next = side / view.zoom;
  const cx = (x0 + x1) / 2 + view.dx * side;
  const cy = (y0 + y1) / 2 + view.dy * side;
  return [cx - next / 2, cy - next / 2, cx + next / 2, cy + next / 2];
}

// A frame answers "where does source pixel P land in the slot?"; a crop answers
// "which source rectangle fills the slot?". These two convert between them.
function cropFromFrame(frame, width, height) {
  const side = (100 * width) / frame.widthPct;
  const x0 = (-frame.leftPct * width) / frame.widthPct;
  const y0 = (-frame.topPct * height) / frame.heightPct;
  return [x0, y0, x0 + side, y0 + side];
}
function frameFromCrop(crop, width, height) {
  const side = crop[2] - crop[0];
  return {
    widthPct: (width / side) * 100,
    heightPct: (height / side) * 100,
    leftPct: (-crop[0] / side) * 100,
    topPct: (-crop[1] / side) * 100,
  };
}

const VIEWS = [
  { zoom: 1, dx: 0, dy: 0 },
  { zoom: 1.8, dx: 0, dy: 0 },
  { zoom: 0.6, dx: 0, dy: 0 },
  { zoom: 1, dx: 0.25, dy: -0.4 },
  { zoom: 2.2, dx: -0.35, dy: 0.15 },
];

describe('applyView agrees with the generator, view for view', () => {
  it.each(VIEWS)('zoom %#: the same square of the photo either way', (view) => {
    const width = 900;
    const height = 1200;
    const base = plainFrame(width, height);
    const mine = applyView(base, view);
    const theirs = frameFromCrop(
      pyApplyView(cropFromFrame(base, width, height), view),
      width,
      height
    );
    for (const k of ['widthPct', 'heightPct', 'leftPct', 'topPct']) {
      expect(mine[k]).toBeCloseTo(theirs[k], 6);
    }
  });

  it('agrees on a SUBJECT-framed photo too, not just the square fallback', () => {
    // A cutout: an off-centre blob, so the frame it produces is nothing like the
    // plain square and any sign error in the pan shows up immediately.
    const width = 80;
    const height = 120;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const on = x >= 40 && x < 70 && y >= 10 && y < 60;
        data[(y * width + x) * 4 + 3] = on ? 255 : 0;
      }
    }
    const base = subjectFrame({ data, width, height });
    expect(base).not.toBeNull();
    const view = { zoom: 1.5, dx: 0.2, dy: -0.1 };
    const mine = applyView(base, view);
    const theirs = frameFromCrop(
      pyApplyView(cropFromFrame(base, width, height), view),
      width,
      height
    );
    for (const k of ['widthPct', 'heightPct', 'leftPct', 'topPct']) {
      expect(mine[k]).toBeCloseTo(theirs[k], 6);
    }
  });
});

describe('applyView, on its own terms', () => {
  const base = { widthPct: 100, heightPct: 100, leftPct: 0, topPct: 0 };

  it('the default view changes nothing', () => {
    expect(applyView(base, { zoom: 1, dx: 0, dy: 0 })).toEqual(base);
  });

  it('zooming in grows the picture about the CENTRE of the slot', () => {
    const f = applyView(base, { zoom: 2, dx: 0, dy: 0 });
    expect(f.widthPct).toBeCloseTo(200, 6);
    // the point that was at the centre is still at the centre
    expect(f.leftPct + f.widthPct / 2).toBeCloseTo(50, 6);
    expect(f.topPct + f.heightPct / 2).toBeCloseTo(50, 6);
  });

  it('panning moves the WINDOW, so the picture goes the other way', () => {
    // dx > 0 slides the window right across the photo, which walks the picture
    // left under the slot. Get this backwards and the drag fights the finger.
    expect(applyView(base, { zoom: 1, dx: 0.25, dy: 0 }).leftPct).toBeCloseTo(-25, 6);
    expect(applyView(base, { zoom: 1, dx: 0, dy: -0.25 }).topPct).toBeCloseTo(25, 6);
  });

  it('a pan is measured in the WINDOW’s own units, so zoom scales it', () => {
    // The same dx moves half as far across the slot when the window is half the
    // size — which is what makes a drag feel the same at every zoom, because the
    // drag divides by the zoom on its way in.
    const near = applyView(base, { zoom: 2, dx: 0.25, dy: 0 });
    expect(near.leftPct - applyView(base, { zoom: 2, dx: 0, dy: 0 }).leftPct).toBeCloseTo(-50, 6);
  });
});

describe('plainFrame — the no-alpha fallback the printer takes', () => {
  it('anchors a tall photo on the head, not on the torso', () => {
    // build.square_photo: top = clamp(round(SUBJECT_Y*h - side/2), 0, h - side).
    const f = plainFrame(60, 200);
    const side = 60;
    const top = Math.round(SUBJECT_Y * 200 - side / 2);
    expect(f.widthPct).toBeCloseTo(100, 6);
    expect(f.heightPct).toBeCloseTo((200 / side) * 100, 6);
    expect(f.leftPct).toBeCloseTo(0, 6);
    expect(f.topPct).toBeCloseTo((-top / side) * 100, 6);
    // …and it is above the middle of the photo, which is the whole point.
    expect(top).toBeLessThan((200 - side) / 2);
  });

  it('centres a landscape photo left-to-right and takes it from the top', () => {
    const f = plainFrame(200, 80);
    expect(f.heightPct).toBeCloseTo(100, 6);
    expect(f.topPct).toBeCloseTo(0, 6);
    expect(f.leftPct + f.widthPct / 2).toBeCloseTo(50, 6);
  });

  it('a square photo needs no crop at all', () => {
    expect(plainFrame(300, 300)).toEqual({
      widthPct: 100,
      heightPct: 100,
      leftPct: -0,
      topPct: -0,
    });
  });

  it('fills the slot rather than the disc — the disc clips it afterwards', () => {
    // Unlike subjectFrame, which scales the SUBJECT onto the disc, this one hands
    // the whole square to the slot exactly as build.square_photo does, and
    // _disc_mask cuts the circle out of it. Getting this wrong would print every
    // uncut photo 10% too small.
    expect(plainFrame(100, 100).widthPct).toBeCloseTo(100, 6);
    expect(DISC_FILL).toBeLessThan(1);
  });

  it('has nothing to say about an undecodable photo', () => {
    expect(plainFrame(0, 100)).toBeNull();
    expect(plainFrame(undefined, undefined)).toBeNull();
  });
});

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
