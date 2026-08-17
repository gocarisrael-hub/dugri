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

// ---------------------------------------------------------------------------
// AND THE FRAME UNDERNEATH IT.
//
// applyView is the buyer's ADJUSTMENT; everything above holds the two ends of
// that together. The frame it adjusts — where the automatic framing put the
// photo before she touched it — had no such pin, and that is where the two
// implementations drifted apart: build.subject_box picks ONE blob out of a cut
// that kept two people and erases the rest, and this side measured both. On a
// real order that showed the honoree and a bystander shrunk to fit the circle
// between them in the preview, and the honoree alone at full size on the card.
//
// So the same trick again, one level down: build.subject_box + subject_reach +
// subject_window transcribed, and the two answers derived from each other.
//
// The transcription drops two things ON PURPOSE, and neither can bite here:
// the 200 px working mask (both sides measure the array they are given, and
// every image below is smaller than that), and subject_window's rounding of the
// crop to whole source pixels (a sub-pixel quantisation of the answer, not part
// of the rule). Keep the fixtures small and the comparison stays exact.
function pySubjectWindow(image) {
  const { data, width, height } = image;
  const at = (x, y) => data[(y * width + x) * 4 + 3];
  // subject_box: the mask, its cover, and the box.
  const mask = new Uint8Array(width * height);
  let opaque = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (at(x, y) >= 24) {
        mask[y * width + x] = 1;
        opaque++;
      }
    }
  }
  if (!opaque) return null;
  const cover = opaque / (width * height);
  if (cover < 0.005 || cover > 0.995) return null;
  // …the blobs, 8-connected, biggest first.
  const seen = new Uint8Array(width * height);
  const found = [];
  for (let y0 = 0; y0 < height; y0++) {
    for (let x0 = 0; x0 < width; x0++) {
      if (!mask[y0 * width + x0] || seen[y0 * width + x0]) continue;
      const px = [[x0, y0]];
      seen[y0 * width + x0] = 1;
      const b = { n: 0, sx: 0, sy: 0, px: [] };
      while (px.length) {
        const [x, y] = px.pop();
        b.n++;
        b.sx += x;
        b.sy += y;
        b.px.push([x, y]);
        for (let ny = Math.max(0, y - 1); ny < Math.min(height, y + 2); ny++) {
          for (let nx = Math.max(0, x - 1); nx < Math.min(width, x + 2); nx++) {
            if (mask[ny * width + nx] && !seen[ny * width + nx]) {
              seen[ny * width + nx] = 1;
              px.push([nx, ny]);
            }
          }
        }
      }
      found.push(b);
    }
  }
  found.sort((a, b) => b.n - a.n);
  // …and the pick: nearest centre of mass to the middle of the frame, specks
  // dropped first. Only when there is more than one — a single soft-edged
  // subject is never "chosen", so nothing of it is erased.
  let keep = found[0];
  if (found.length > 1) {
    const real = found.filter((b) => b.n >= 0.08 * found[0].n);
    const pool = real.length ? real : [found[0]];
    keep = pool.reduce((best, b) => {
      const d = (x) => (x.sx / x.n - width / 2) ** 2 + (x.sy / x.n - height / 2) ** 2;
      return d(b) < d(best) ? b : best;
    }, pool[0]);
    mask.fill(0);
    for (const [x, y] of keep.px) mask[y * width + x] = 1;
  }
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (const [x, y] of keep.px) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const box = [x0, y0, x1 + 1, y1 + 1];
  // subject_reach: off the silhouette, one pixel of slack, never past the corner.
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const corner = Math.hypot(box[2] - box[0], box[3] - box[1]) / 2;
  let best = 0;
  for (let y = 0; y < height; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    for (const x of [first, last]) best = Math.max(best, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
  }
  const reach = best > 0 ? Math.min(best + 1, corner) : corner;
  // subject_window: a square of the disc's diameter over DISC_FILL, on the box.
  const side = (2 * reach) / DISC_FILL;
  return frameFromCrop([cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2], width, height);
}

// Build an RGBA {data,width,height} from a paint function, as pawn-frame.test.js does.
function img(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = paint(x, y);
  }
  return { data, width, height };
}

// The photos that actually reach a pawn slot, as alpha. Named for what they ARE,
// because a regression in any one of them is a different bug on the card.
const CUTOUTS = {
  'one face, head and shoulders, running off the bottom of the frame': img(90, 120, (x, y) =>
    Math.hypot(x - 45, y - 30) <= 18 || (x >= 25 && x < 65 && y >= 45) ? 255 : 0
  ),
  'a subject hard against one corner': img(100, 100, (x, y) => (x < 20 && y < 20 ? 255 : 0)),
  'two people, the honoree in the middle and a bigger bystander at the edge': img(
    160,
    100,
    (x, y) =>
      (x >= 4 && x < 54 && y >= 4 && y < 96) || (x >= 78 && x < 112 && y >= 25 && y < 75) ? 255 : 0
  ),
  'a person plus the speck the segmenter left behind': img(120, 120, (x, y) =>
    (x >= 70 && x < 115 && y >= 20 && y < 100) || (x === 60 && y === 60) ? 255 : 0
  ),
  'a soft matte, all one blob at the alpha floor': img(80, 80, (x, y) =>
    x >= 30 && x < 50 && y >= 30 && y < 50 ? 255 : x >= 20 && x < 60 && y >= 20 && y < 60 ? 30 : 0
  ),
  'a wide subject, wider than the disc': img(150, 60, (x, y) =>
    x >= 10 && x < 140 && y >= 20 && y < 40 ? 255 : 0
  ),
};

describe('the automatic frame agrees with the generator, photo for photo', () => {
  it.each(Object.keys(CUTOUTS))('%s', (name) => {
    const im = CUTOUTS[name];
    const mine = subjectFrame(im);
    const theirs = pySubjectWindow(im);
    expect(mine).not.toBeNull();
    for (const k of ['widthPct', 'heightPct', 'leftPct', 'topPct']) {
      expect(mine[k]).toBeCloseTo(theirs[k], 6);
    }
  });

  it('and they refuse the same photos, which is how the plain crop is reached', () => {
    // subject_box answers None on an alpha that says nothing, and square_photo
    // then takes the head-anchored square. subjectFrame answers null and
    // collect.html then takes plainFrame. The FORK has to be in the same place or
    // one side crops the head while the other shrinks the whole rectangle.
    const opaque = img(60, 60, () => 255);
    expect(subjectFrame(opaque)).toBeNull();
    expect(pySubjectWindow(opaque)).toBeNull();
    const speck = img(120, 120, (x, y) => (x < 6 && y < 6 ? 255 : 0));
    expect(subjectFrame(speck)).toBeNull();
    expect(pySubjectWindow(speck)).toBeNull();
    // …and the square the generator takes instead is the one plainFrame draws.
    const w = 900;
    const h = 1200;
    const side = Math.min(w, h);
    const top = Math.max(0, Math.min(Math.round(SUBJECT_Y * h - side / 2), h - side));
    expect(plainFrame(w, h)).toEqual(frameFromCrop([0, top, side, top + side], w, h));
  });
});
