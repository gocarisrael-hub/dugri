import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './helpers/png-decode.js';
import {
  autoCrop,
  cropViewBox,
  DISC_FILL,
  haloFilterMarkup,
  pyRound,
  resizeBilinearL,
  slotRect,
  stickerMarkup,
  viewCrop,
} from '../../site/js/pawn-print.js';

// THE BROWSER'S PAWN IS THE PRINTER'S PAWN. site/js/pawn-print.js repeats
// build.square_photo's framing so the collection page and the wizard draw each
// photo exactly where the card prints it. The answers below are the GENERATOR's,
// computed from these very images (generator/pawn_print_fixtures.py) and held to
// build.py by generator/test_pawn_print_fixtures.py — so a pass here means the
// browser agrees with the printer, not with a copy of it.

const DIR = path.join(__dirname, 'fixtures', 'pawn-print');
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
    expect(stickerMarkup({ id: 'a', slot, photo: { href: 'u', width: 1, height: 1 }, crop: [0, 0, 5, 6], filterId: 'f' })).toContain(
      'preserveAspectRatio="none"'
    );
  });

  test("renames the theme's own filter rather than rewriting it", () => {
    const theme =
      '<filter id="sticker-halo" x="-25%"><feMorphology radius="1.5"/><feDropShadow flood-color="#711d20"/></filter>';
    expect(haloFilterMarkup(theme, 'halo-card2')).toBe(theme.replace('sticker-halo', 'halo-card2'));
  });

  test('turns the generator\'s fractional slot into card units', () => {
    const r = slotRect({ x: 0.2, y: 0.25, w: 0.3, h: 0.2 }, [0, 0, 200, 400]);
    expect(r).toEqual({ x: 40, y: 100, w: 60, h: 80 });
  });
});
