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

const disc = (f) => img(f.size, f.size, () => true);

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
    const square = img(size, size, () => true);
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
  });

  it('honours a different disc fill', () => {
    const im = disc({ size: 50 });
    const tight = subjectFrame(im, { discFill: 0.5 });
    const loose = subjectFrame(im, { discFill: 1 });
    expect(loose.widthPct / tight.widthPct).toBeCloseTo(2, 5);
  });
});
