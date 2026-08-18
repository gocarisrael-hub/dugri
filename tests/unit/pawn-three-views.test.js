// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {
  DISC_FILL,
  RING_FILL,
  HALO_FILL,
  insetPct,
  pawnCssVars,
  haloFilter,
  liveSlotStyle,
  discPhotoStyle,
} from '../../site/js/pawn-frame.js';

// THE PAWN'S GEOMETRY, IN ONE PLACE — the arithmetic side.
//
// The same photo is drawn three times on the collection page's photos tab: on
// the PRINTED card (the generator), on the PREVIEW CARD at the top of the tab,
// and in the EDITOR CIRCLE in the row below it. They each used to carry their own
// copy of the proportions, and they drifted: the editor drew its dashed cut-line
// at the DISC's size (90% of the slot) instead of the slot's, so the same photo
// filled its ring in the row and sat well inside its ring on the card above.
//
// generator/test_pawn_three_views.py is the test that RENDERS all three and
// measures them against each other; it needs Chrome and the generator. This file
// is the cheap half: the functions those three now share, and the proof that the
// page really does call them rather than keeping its own copy again.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(__dirname, '..', '..', 'site');
const read = (...p) => fs.readFileSync(path.join(site, ...p), 'utf8');

const pct = (s) => parseFloat(s);

describe('the three circles', () => {
  it('puts the disc inside the ring, never on it', () => {
    // The cut-line is the SLOT's inscribed circle and the photo's disc is 90% of
    // the slot, which is what leaves room for the white sticker edge between the
    // two. Equal would be the bug as it shipped.
    expect(RING_FILL).toBe(1);
    expect(DISC_FILL).toBeLessThan(RING_FILL);
    expect(insetPct(RING_FILL)).toBe(0);
    expect(insetPct(DISC_FILL)).toBeCloseTo(5, 6);
  });

  it('hands the stylesheet the same two numbers', () => {
    const vars = pawnCssVars();
    expect(pct(vars['--pawn-disc-inset'])).toBeCloseTo(insetPct(DISC_FILL), 6);
    expect(pct(vars['--pawn-ring-inset'])).toBeCloseTo(insetPct(RING_FILL), 6);
  });

  it('leaves the halo room between the disc and the cut-line', () => {
    // The white rim is dilated OUT of the disc and has to land INSIDE the dashes:
    // on the dashes it hides the line she is meant to cut along, and outside them
    // it is trimmed off the finished sticker. That is the whole reason DISC_FILL
    // is not 1.
    const gap = (RING_FILL - DISC_FILL) / 2;
    expect(HALO_FILL).toBeLessThan(gap);
  });
});

describe('liveSlotStyle — the disc on a picture of the card', () => {
  const geo = { x: 0.2, y: 0.3, w: 0.25, h: 0.2 };
  const s = liveSlotStyle(geo);

  it('is the disc, centred in the generator´s slot rect', () => {
    expect(pct(s.width)).toBeCloseTo(geo.w * DISC_FILL * 100, 3);
    expect(pct(s.height)).toBeCloseTo(geo.h * DISC_FILL * 100, 3);
    // Centre for centre with the slot the generator reported, which is the square
    // the cut-line is inscribed in.
    expect(pct(s.left) + pct(s.width) / 2).toBeCloseTo((geo.x + geo.w / 2) * 100, 3);
    expect(pct(s.top) + pct(s.height) / 2).toBeCloseTo((geo.y + geo.h / 2) * 100, 3);
  });
});

describe('discPhotoStyle — the photo inside the disc', () => {
  it('rebases percent-of-slot onto the disc', () => {
    // A frame that exactly fills the SLOT has to come out 1/DISC_FILL of the disc
    // and hang over it evenly, because the disc is the smaller box.
    const s = discPhotoStyle({ widthPct: 100, heightPct: 100, leftPct: 0, topPct: 0 }, null);
    expect(pct(s.width)).toBeCloseTo(100 / DISC_FILL, 3);
    expect(pct(s.left)).toBeCloseTo(-insetPct(DISC_FILL) / DISC_FILL, 3);
    expect(pct(s.left) + pct(s.width) / 2).toBeCloseTo(50, 3);
    expect(s.objectFit).toBe('contain');
  });

  it('fills and crops when there was nothing to measure', () => {
    // The "we could not frame this photo" outcome, which is also what the printer
    // does with it: a photo never comes out of that circle as a rectangle.
    const s = discPhotoStyle(null, null);
    expect(s).toEqual({
      width: '100%',
      height: '100%',
      left: '0',
      top: '0',
      objectFit: 'cover',
    });
  });

  it('carries the buyer´s own zoom and pan through', () => {
    const frame = { widthPct: 100, heightPct: 100, leftPct: 0, topPct: 0 };
    const flat = discPhotoStyle(frame, null);
    const zoomed = discPhotoStyle(frame, { zoom: 1.5, dx: 0, dy: 0 });
    expect(pct(zoomed.width)).toBeCloseTo(pct(flat.width) * 1.5, 3);
    // Zoom is about the centre of the circle, so the middle does not wander.
    // 2 places, not 3: the style values are rounded to a thousandth of a percent
    // on the way out, which at a 1.5x zoom lands half a thousandth off centre.
    expect(pct(zoomed.left) + pct(zoomed.width) / 2).toBeCloseTo(50, 2);
  });
});

describe('haloFilter — the white sticker edge', () => {
  it('is the same fraction of the circle at every size', () => {
    // The bug this replaces: a fixed 2px+2px+1.5px, which is twice as wide a rim
    // on the row's 116px circle as on the ~58px one on the card beside it. Both
    // are the same photo in the same tab.
    const offsets = (px) =>
      [...haloFilter(px).matchAll(/drop-shadow\((-?[\d.]+)px (-?[\d.]+)px/g)].map((m) =>
        Math.hypot(parseFloat(m[1]), parseFloat(m[2]))
      );
    const small = offsets(58);
    const big = offsets(116);
    expect(small.length).toBeGreaterThan(4);
    expect(big.length).toBe(small.length);
    expect(Math.max(...big) / Math.max(...small)).toBeCloseTo(2, 1);
  });

  it('dilates instead of smearing', () => {
    // Every shadow is HARD (a zero blur radius). The printed halo is an
    // feMorphology dilate with an alpha ramp — a rim that stops dead — and a
    // stack of blurred shadows measured 60% too wide with only 9% of it ever
    // reaching white.
    const f = haloFilter(116);
    expect(f).toMatch(/drop-shadow\(-?[\d.]+px -?[\d.]+px 0 #fff\)/);
    expect(f).not.toMatch(/drop-shadow\(0 0 /);
    // Spread around a circle, not stacked in one direction: the offsets have to
    // cancel out, or the rim is a shadow on one side.
    const xs = [...f.matchAll(/drop-shadow\((-?[\d.]+)px (-?[\d.]+)px/g)];
    const sum = xs.reduce((a, m) => [a[0] + parseFloat(m[1]), a[1] + parseFloat(m[2])], [0, 0]);
    expect(Math.abs(sum[0])).toBeLessThan(0.2);
    expect(Math.abs(sum[1])).toBeLessThan(0.2);
  });

  it('draws nothing on a circle too small to hold a rim', () => {
    expect(haloFilter(4)).toBe('none');
    expect(haloFilter(0)).toBe('none');
    expect(haloFilter(undefined)).toBe('none');
  });
});

describe('the page and the stylesheet read that one source', () => {
  const page = read('collect.html');
  const css = read('css', 'pawn.css');

  it('places every photo through the shared geometry', () => {
    for (const fn of ['liveSlotStyle(', 'discPhotoStyle(', 'haloFilter(', 'pawnCssVars(']) {
      expect(page).toContain(fn);
    }
  });

  it('draws the cut-line at the ring´s inset and the photo at the disc´s', () => {
    // Both were the literal 5% and sitting next to each other, which is exactly
    // how they came to be the same circle.
    expect(css).toContain('inset: var(--pawn-disc-inset, 5%)');
    expect(css).toContain('inset: var(--pawn-ring-inset, 0%)');
  });

  it('puts the halo on the circle, not on the photo inside it', () => {
    // The circle clips with overflow:hidden, so a filter on the clipped <img> was
    // cut off at the same rim — no white edge where the print has one. A filter on
    // the clipping element paints outside its own overflow.
    expect(css).toMatch(/\.pawn-disc\.is-cut,\s*\n\.pawn-live-slot\.is-cut \{/);
    expect(css).not.toMatch(/\.pawn-disc\.is-cut img/);
  });

  it('measures where the card was drawn instead of assuming it filled the frame', () => {
    // The discs are fractions of THE CARD and the layer they live in used to fill
    // the FRAME; those are one rectangle only when the frame is the card's shape.
    // Handing the frame the card's `aspect-ratio` was the first attempt at that
    // and it holds in Chrome only — Safari leaves a `width: auto` box at full
    // width and centres the picture inside it, which stretched every pawn into an
    // ellipse and slid it off its ring on every iPhone. So the layer is now
    // MEASURED onto the picture (containRect), and the frame is sized BY the
    // picture rather than by a shape it was told to assume.
    expect(page).toContain('containRect(');
    expect(page).toContain('function fitLiveSlots(');
    expect(page).toContain("classList.add('has-card')");
    // …and the frame rule reaches the CARD only. Written as a bare
    // `.prev-box.has-card img` it also matched the four photos laid over the
    // card, and its `max-width: 100%` clamped each one to its own circle —
    // re-cropping every pawn tighter than the printer cuts it.
    expect(page).toContain('.prev-box.has-card > img');
    expect(page).not.toMatch(/\.prev-box(\.has-card)? img \{/);
  });

  it('re-sizes the halo when the circle does, instead of measuring it once', () => {
    // The photos tab is `display: none` until she opens it, so every box in it
    // measures zero at the moment the rows are built — and a halo read once at
    // that moment is never read again. On the real page that left the
    // stylesheet's fallback edge on every pawn, at the wrong width, which is the
    // bug this whole file is about wearing a different hat.
    expect(page).toContain('new ResizeObserver(apply).observe(el)');
  });

  it('keeps the drag badge out of the filtered circle', () => {
    // A filter applies to everything the element contains, and the badge came out
    // with a white glow around its pill.
    expect(page).toContain('pad.appendChild(grab)');
    expect(page).not.toContain('disc.appendChild(grab)');
  });
});
