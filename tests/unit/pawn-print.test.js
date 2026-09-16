import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './helpers/png-decode.js';
import {
  autoCrop,
  cropViewBox,
  DISC_FILL,
  fallbackDeal,
  haloFilterMarkup,
  plainCrop,
  pyRound,
  resizeBilinearL,
  slotRect,
  stickerMarkup,
  SUBJECT_Y,
  subjectWindow,
  viewCrop,
} from '../../site/js/pawn-print.js';

// THE BROWSER'S PAWN IS THE PRINTER'S PAWN. site/js/pawn-print.js repeats
// build.square_photo's framing so the collection page and the wizard draw each
// photo exactly where the card prints it. The answers below are the GENERATOR's,
// computed from these very images (generator/pawn_print_fixtures.py) and held to
// build.py by generator/test_pawn_print_fixtures.py — so a pass here means the
// browser agrees with the printer, not with a copy of it.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pawn-print');
const expected = JSON.parse(readFileSync(path.join(DIR, 'expected.json'), 'utf8'));
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex');

describe('the crop, image by image', () => {
  for (const [name, want] of Object.entries(expected.images)) {
    test(name, () => {
      const img = decodePng(readFileSync(path.join(DIR, name + '.png')));
      expect([img.width, img.height]).toEqual([want.width, want.height]);
      const got = autoCrop(img.data, img.width, img.height, want.cutout);
      expect(got.crop).toEqual(want.crop);
      expect(got.erased).toBe(want.erased);
      // The erased alpha is what the sticker's halo is dilated from, so a
      // bystander left in it — or a pixel of the subject shaved off — is visible.
      if (want.alpha_sha1) expect(sha1(got.alpha)).toBe(want.alpha_sha1);
      else expect(got.alpha).toBe(null);
      for (const [view, crop] of want.views) {
        const v = view && { zoom: view[0], dx: view[1], dy: view[2] };
        expect(viewCrop(want.crop, v)).toEqual(crop);
      }
    });
  }
});

describe("Pillow's BILINEAR resize, which the generator thresholds its masks after", () => {
  const pattern = (w, h) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[y * w + x] = (x * 7 + y * 13 + ((x * y) % 11)) % 256;
    }
    return out;
  };
  for (const r of expected.resample) {
    test(`${r.from.join('x')} -> ${r.to.join('x')}`, () => {
      const [w, h] = r.from;
      const [W, H] = r.to;
      expect(sha1(resizeBilinearL(pattern(w, h), w, h, W, H))).toBe(r.sha1);
    });
  }
});

// THE SHIPPED PAWNS, DEALT AS THE DECK DEALS THEM. The page draws them into the
// slots her photos leave empty, so one bare card per design serves every deck
// size. The answers are build.card_photo_plan's, for pools of one to four pawns.
test('the shipped pawns are dealt across the deck exactly as the generator deals them', () => {
  for (const [key, flat] of Object.entries(expected.deals)) {
    const [pool, cards, filled] = key.split(':').map(Number);
    const got = [];
    for (let card = 0; card < cards; card++) got.push(...fallbackDeal(pool, filled, cards, card));
    expect(got, key).toEqual(flat);
  }
});

test("Python's round sends halves to the even neighbour", () => {
  // Compared as numbers: Python's round(-0.5) is -0.0, and the crop only ever
  // uses the integer.
  const got = [0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.5001].map((v) => pyRound(v) + 0);
  expect(got).toEqual([0, 2, 2, 0, -2, 2, 3]);
});

describe('the sticker markup', () => {
  const slot = { x: 39.93, y: 87, w: 66, h: 66 };

  test('clips to the disc the generator multiplies into the alpha', () => {
    const svg = stickerMarkup({
      id: 'p1',
      slot,
      photo: { href: 'blob:x', width: 900, height: 1200 },
      crop: [-54, 131, 1055, 1240],
      filterId: 'halo-a',
    });
    const r = /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/.exec(svg);
    expect(Number(r[1])).toBeCloseTo(72.93, 4);
    expect(Number(r[2])).toBeCloseTo(120, 4);
    expect(Number(r[3])).toBeCloseTo((66 * DISC_FILL) / 2, 4);
  });

  test('draws the halo BEHIND the photo, through the named filter', () => {
    const svg = stickerMarkup({
      id: 'p1',
      slot,
      photo: { href: 'blob:x', width: 10, height: 10 },
      crop: [0, 0, 10, 10],
      filterId: 'halo-a',
    });
    expect(svg.indexOf('<use href="#p1" filter="url(#halo-a)"/>')).toBeLessThan(
      svg.indexOf('<g id="p1"')
    );
  });

  test('maps the crop window onto the slot, stretch and all', () => {
    // An odd rounding can leave the window one pixel taller than wide; the
    // generator's resize to a square stretches it, and so does this.
    expect(cropViewBox([-54, 131, 1055, 1241])).toBe('-54 131 1109 1110');
    expect(
      stickerMarkup({
        id: 'a',
        slot,
        photo: { href: 'u', width: 1, height: 1 },
        crop: [0, 0, 5, 6],
        filterId: 'f',
      })
    ).toContain('preserveAspectRatio="none"');
  });

  test("renames the theme's own filter rather than rewriting it", () => {
    const theme =
      '<filter id="sticker-halo" x="-25%"><feMorphology radius="1.5"/><feDropShadow flood-color="#711d20"/></filter>';
    expect(haloFilterMarkup(theme, 'halo-card2')).toBe(theme.replace('sticker-halo', 'halo-card2'));
  });

  test("turns the generator's fractional slot into card units", () => {
    const r = slotRect({ x: 0.2, y: 0.25, w: 0.3, h: 0.2 }, [0, 0, 200, 400]);
    expect(r).toEqual({ x: 40, y: 100, w: 60, h: 80 });
  });
});

// THE GENERATOR'S CONSTANTS, NOT THIS MODULE'S. PHOTO_DISC_FILL and
// PHOTO_SUBJECT_Y are env-overridable on the generator (DUGRI_PHOTO_DISC_FILL,
// DUGRI_PHOTO_SUBJECT_Y), so a deck tuned there and a site that kept the defaults
// would print one framing and show another — and now that both sides look
// plausible, nobody would see it. The card's render sends both
// (preview.sticker_spec) and every one of these takes them.
describe('a tuned generator moves the page with it', () => {
  test('the disc fill decides how big the window is', () => {
    const box = [100, 100, 300, 300];
    const tight = subjectWindow(box, null, 400, 400, 0.9);
    const loose = subjectWindow(box, null, 400, 400, 0.6);
    // The window is the subject's reach over the fill, so a smaller fill is a
    // bigger window — the subject drawn smaller inside the same circle.
    expect(loose[2] - loose[0]).toBeGreaterThan(tight[2] - tight[0]);
    // Each edge is rounded to a whole source pixel (Python's own rounding), so
    // the ratio lands within a pixel of 0.9/0.6 rather than exactly on it.
    expect((loose[2] - loose[0]) / (tight[2] - tight[0])).toBeCloseTo(0.9 / 0.6, 2);
    // …and it is the default when nobody says otherwise.
    expect(subjectWindow(box, null, 400, 400)).toEqual(tight);
  });

  test('the disc fill decides the circle the sticker is clipped to', () => {
    const slot = { x: 0, y: 0, w: 66, h: 66 };
    const photo = { href: 'u', width: 10, height: 10 };
    const crop = [0, 0, 10, 10];
    const r = (svg) => Number(/<circle [^>]*r="([\d.]+)"/.exec(svg)[1]);
    expect(
      r(stickerMarkup({ id: 'a', slot, photo, crop, filterId: 'f', discFill: 0.8 }))
    ).toBeCloseTo((66 * 0.8) / 2, 4);
    expect(r(stickerMarkup({ id: 'a', slot, photo, crop, filterId: 'f' }))).toBeCloseTo(
      (66 * DISC_FILL) / 2,
      4
    );
  });

  test('the head anchor decides where an unframed square is cut', () => {
    // A portrait with no silhouette: the square is centred on subjectY of the
    // height, so raising it takes the crop further down the photo.
    expect(plainCrop(400, 800, 0.3)).toEqual([0, 40, 400, 440]);
    expect(plainCrop(400, 800, 0.5)).toEqual([0, 200, 400, 600]);
    expect(plainCrop(400, 800)).toEqual(plainCrop(400, 800, SUBJECT_Y));
  });

  test('autoCrop carries both through to the crop it answers with', () => {
    const img = decodePng(readFileSync(path.join(DIR, 'portrait-offcentre.png')));
    const tuned = autoCrop(img.data, img.width, img.height, true, { discFill: 0.6 });
    const standard = autoCrop(img.data, img.width, img.height, true);
    expect(tuned.crop).not.toEqual(standard.crop);
    // …and for a photo with no silhouette, the head anchor does the same.
    const opaque = decodePng(readFileSync(path.join(DIR, 'opaque-cutout.png')));
    const low = autoCrop(opaque.data, opaque.width, opaque.height, true, { subjectY: 0.6 });
    expect(low.crop).not.toEqual(
      autoCrop(opaque.data, opaque.width, opaque.height, true, { subjectY: 0.3 }).crop
    );
  });
});

// A CONSTANT THAT HAS NOT ARRIVED IS NOT A CONSTANT OF ZERO. The spec reaches the
// page asynchronously, so a slot filled in the first moments of the step was
// framed with `spec && spec.disc_fill` — which is NULL, not undefined, so the
// default parameter stood aside and the division ran against it. The wizard drew
// viewBox="-Infinity -Infinity NaN NaN"; a null head anchor was worse still,
// framing a portrait from its top with nothing visibly wrong. Each is the exact
// failure this module exists to prevent, on the card captioned "this is how it
// prints", and no amount of the suite above saw either.
describe('a constant that never arrived falls back to the generator’s', () => {
  const box = [100, 100, 300, 300];
  const want = subjectWindow(box, null, 400, 400, DISC_FILL);

  for (const missing of [null, undefined, NaN, 0, -1, '0.9']) {
    test(`disc fill: ${String(missing)}`, () => {
      const got = subjectWindow(box, null, 400, 400, missing);
      expect(got).toEqual(want);
      expect(cropViewBox(got)).not.toMatch(/NaN|Infinity/);
    });
  }

  for (const missing of [null, undefined, NaN, '0.3']) {
    test(`head anchor: ${String(missing)}`, () => {
      expect(plainCrop(400, 800, missing)).toEqual(plainCrop(400, 800, SUBJECT_Y));
    });
  }

  // 0 is a real anchor — the top of the photo — and must NOT be read as missing.
  test('but 0 is a head anchor, not a missing one', () => {
    expect(plainCrop(400, 800, 0)).toEqual([0, 0, 400, 400]);
  });

  // …and through the call both pages actually make.
  test('autoCrop with a spec that has not arrived yet', () => {
    const img = decodePng(readFileSync(path.join(DIR, 'portrait-offcentre.png')));
    const blank = autoCrop(img.data, img.width, img.height, true, {
      discFill: null,
      subjectY: null,
    });
    expect(blank.crop).toEqual(autoCrop(img.data, img.width, img.height, true).crop);
  });
});
