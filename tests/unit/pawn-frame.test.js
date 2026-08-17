import { describe, it, expect } from 'vitest';
import { subjectFrame, DISC_FILL } from '../../site/js/pawn-frame.js';

// Build an RGBA {data,width,height} with `paint(x,y)` deciding opacity, so these
// tests need no canvas and no browser.
function img(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const on = paint(x, y);
      data[i] = 200;
      data[i + 1] = 150;
      data[i + 2] = 150;
      data[i + 3] = on ? 255 : 0;
    }
  }
  return { data, width, height };
}

// A square subject with a one-pixel transparent border. The border is not
// decoration: an image with NOTHING transparent in it carries no silhouette, so
// subjectFrame refuses it (MAX_COVER) exactly as build.subject_box does, and a
// fixture painted edge to edge would be testing the refusal rather than the
// scaling rule it is written for.
const disc = (f) =>
  img(f.size, f.size, (x, y) => x > 0 && y > 0 && x < f.size - 1 && y < f.size - 1);

// The circle the slot will clip to, in the same percent units subjectFrame answers in.
const R = (DISC_FILL / 2) * 100;

// Where a source pixel lands, as a percent of the slot.
function place(frame, x, y, width, height) {
  return {
    x: frame.leftPct + ((x + 0.5) / width) * frame.widthPct,
    y: frame.topPct + ((y + 0.5) / height) * frame.heightPct,
  };
}

describe('subjectFrame', () => {
  it('puts the whole subject inside the disc — the rule the printer follows', () => {
    // A tall subject: the case that used to be cut off at the bottom.
    const width = 60;
    const height = 100;
    const im = img(width, height, (x, y) => x >= 10 && x < 50 && y >= 5 && y < 95);
    const f = subjectFrame(im);
    expect(f).not.toBeNull();
    let worst = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!(x >= 10 && x < 50 && y >= 5 && y < 95)) continue;
        const p = place(f, x, y, width, height);
        worst = Math.max(worst, Math.hypot(p.x - 50, p.y - 50));
      }
    }
    // every subject pixel lands within the clip radius (half a pixel of slack)
    expect(worst).toBeLessThanOrEqual(R + 0.5);
    // ...and it fills the disc rather than floating small inside it
    expect(worst).toBeGreaterThan(R - 2);
  });

  it('centres the subject on the disc, not the image', () => {
    // Subject hard against one corner: the frame has to move it to the middle.
    const im = img(100, 100, (x, y) => x < 20 && y < 20);
    const f = subjectFrame(im);
    const c = place(f, 9.5, 9.5, 100, 100); // the subject's own centre
    expect(c.x).toBeCloseTo(50, 1);
    expect(c.y).toBeCloseTo(50, 1);
  });

  it('measures the silhouette, not the bounding box — a round subject gets a bigger face', () => {
    const size = 101;
    const r = 50;
    const round = img(size, size, (x, y) => Math.hypot(x - 50, y - 50) <= r);
    // …against a square that stops one pixel short of the edge, so it still has
    // an alpha to be a silhouette IN (see `disc` above).
    const square = img(size, size, (x, y) => x > 0 && y > 0 && x < size - 1 && y < size - 1);
    const fRound = subjectFrame(round);
    const fSquare = subjectFrame(square);
    // The square's corners reach sqrt(2) further than the circle's edge, so the
    // square has to be drawn smaller to fit the same disc. Reading the round
    // subject off its BOX would have scaled it down to the square's size.
    expect(fRound.widthPct).toBeGreaterThan(fSquare.widthPct * 1.3);
  });

  it('scales a subject that is too big DOWN rather than cropping it', () => {
    const small = subjectFrame(img(100, 100, (x, y) => Math.hypot(x - 50, y - 50) <= 10));
    const big = subjectFrame(img(100, 100, (x, y) => Math.hypot(x - 50, y - 50) <= 45));
    expect(big.widthPct).toBeLessThan(small.widthPct);
  });

  it('returns null when there is nothing to frame', () => {
    expect(subjectFrame(img(10, 10, () => false))).toBeNull();
    expect(subjectFrame(null)).toBeNull();
    expect(subjectFrame({ data: null, width: 0, height: 0 })).toBeNull();
  });

  it('refuses an image with no silhouette in it, rather than framing its rectangle', () => {
    // An opaque photo — or a cut that kept everything — has no subject, only a
    // rectangle, and its "reach" is half its own diagonal. Framed on that it
    // would be drawn ~1.4x smaller than the printer draws it, floating in the
    // middle of the circle. build.subject_box refuses it (PHOTO_SUBJECT_MAX_COVER)
    // and takes the plain square crop; null is how that fork is spelled here.
    expect(subjectFrame(img(40, 40, () => true))).toBeNull();
    // …and the mirror image: a cut that collapsed to a speck is not a subject
    // either (PHOTO_SUBJECT_MIN_COVER — 0.5% of the frame).
    expect(subjectFrame(img(100, 100, (x, y) => x < 5 && y < 4))).toBeNull();
    // The line is a share of the frame, not a pixel count: the same speck in a
    // small frame IS the subject.
    expect(subjectFrame(img(20, 20, (x, y) => x < 5 && y < 4))).not.toBeNull();
  });

  it('frames the honoree, not the bystander who was cut out with her', () => {
    // Two blobs: a BIGGER one off to the left and a smaller one in the middle.
    // build.subject_box keeps the one whose centre of mass is nearest the middle
    // of the frame — the biggest is often the person standing behind — and erases
    // the rest before measuring. Measuring both would scale the pair down to fit
    // the circle between them, which is what the card preview used to show for a
    // photo the printer produced with one large face.
    const width = 200;
    const height = 120;
    const bystander = (x, y) => x >= 5 && x < 65 && y >= 5 && y < 115;
    const honoree = (x, y) => x >= 95 && x < 135 && y >= 30 && y < 90;
    const both = subjectFrame(img(width, height, (x, y) => bystander(x, y) || honoree(x, y)));
    const alone = subjectFrame(img(width, height, honoree));
    expect(both).not.toBeNull();
    for (const k of ['widthPct', 'heightPct', 'leftPct', 'topPct']) {
      expect(both[k]).toBeCloseTo(alone[k], 6);
    }
    // The honoree's own centre lands in the middle of the disc — i.e. the pair's
    // centre, well to her left, is NOT what the frame was built on.
    const c = place(both, 114.5, 59.5, width, height);
    expect(c.x).toBeCloseTo(50, 1);
    expect(c.y).toBeCloseTo(50, 1);
  });

  it('drops specks before choosing, so a scrap at dead centre cannot win', () => {
    // A 2x2 crumb the segmenter left in the middle is under BLOB_MIN_SHARE of the
    // person, so it is not a candidate at all — without that rule it would be the
    // nearest blob to the centre and the whole card would be framed on it.
    const width = 120;
    const height = 120;
    const person = (x, y) => x >= 70 && x < 115 && y >= 20 && y < 100;
    const f = subjectFrame(img(width, height, (x, y) => person(x, y) || (x === 60 && y === 60)));
    const clean = subjectFrame(img(width, height, person));
    for (const k of ['widthPct', 'heightPct', 'leftPct', 'topPct']) {
      expect(f[k]).toBeCloseTo(clean[k], 6);
    }
  });

  it('ignores the soft edge of a matte only below the alpha floor', () => {
    // alpha 24 IS subject (a hair matte fades to zero over a few pixels and all
    // of it belongs to the person) — a frame measured at 255-only would clip it.
    const width = 40;
    const height = 40;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const core = x >= 15 && x < 25 && y >= 15 && y < 25;
        const fringe = x >= 5 && x < 35 && y >= 5 && y < 35;
        data[i + 3] = core ? 255 : fringe ? 30 : 10;
      }
    }
    const f = subjectFrame({ data, width, height });
    const edge = place(f, 5, 5, width, height); // a fringe pixel at alpha 30
    expect(Math.hypot(edge.x - 50, edge.y - 50)).toBeLessThanOrEqual(R + 0.5);
    // …and it is the FRINGE that touches the circle, not the core. The core and
    // the fringe are ONE blob at the alpha floor, so the blob pick leaves them
    // together — it only ever erases when it found more than one, exactly as
    // build.subject_box does.
    expect(Math.hypot(edge.x - 50, edge.y - 50)).toBeGreaterThan(R - 3);
  });

  it('honours a different disc fill', () => {
    const im = disc({ size: 50 });
    const tight = subjectFrame(im, { discFill: 0.5 });
    const loose = subjectFrame(im, { discFill: 1 });
    expect(loose.widthPct / tight.widthPct).toBeCloseTo(2, 5);
  });
});
