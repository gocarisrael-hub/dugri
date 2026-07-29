// @vitest-environment node
//
// Guards the PHOTO CARD contract — the 104th front of the deck, which carries
// the buyer's four pawn photos (server/db.js `pawn_images`).
//
// The generator does exactly one thing to these files: set `href` on the four
// `photo-slot-N` elements. Everything that makes that safe is asserted here —
// the ids exist, they are `<image>` elements with explicit numeric geometry,
// they ship WITHOUT an href (so a missing photo renders as the designed empty
// disc, never a broken link), and the geometry is byte-identical across every
// photo card so the generator never branches on which template it loaded.
//
// It also guards SIZE. Canva SVG exports in this repo routinely embed multi-MB
// rasters (see #162/#163); a photo card is authored by hand precisely so it
// stays small, and a regression here would multiply by every order.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const TEMPLATES = path.join(ROOT, 'resources', 'canva', 'templates');

const GENERIC_CARD = path.join(TEMPLATES, '_shared', 'photo-card', 'photo.svg');
const GRAPEFRUIT_CARD = path.join(TEMPLATES, 'grapefruit', 'clean', 'photo.svg');
const FALLBACK_DIR = path.join(TEMPLATES, '_shared', 'photo-fallback');
const DOC = path.join(ROOT, 'docs', 'photo-card.md');

// Portrait single card, same viewBox as every other card in the new deck.
const VIEWBOX = '0 0 223.92 312';
const CARD_W = 223.92;
const CARD_H = 312;
const SLOT_IDS = [1, 2, 3, 4].map((n) => `photo-slot-${n}`);

const cards = [
  ['generic', GENERIC_CARD],
  ['grapefruit', GRAPEFRUIT_CARD],
];

/** The `<image id="photo-slot-N" .../>` tag as raw markup, or undefined. */
function slotTag(svg, id) {
  return svg.match(new RegExp(`<image[^>]*\\bid="${id}"[^>]*>`))?.[0];
}

function attr(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

/** The markup minus its namespace declarations — those are the only legitimate
 *  http:// strings in an SVG, and they are not fetched. */
function withoutNamespaces(svg) {
  return svg.replace(/\sxmlns(:\w+)?="[^"]*"/g, '');
}

/** {x, y, width, height} of a slot, as numbers. */
function slotBox(svg, id) {
  const tag = slotTag(svg, id);
  return {
    x: Number(attr(tag, 'x')),
    y: Number(attr(tag, 'y')),
    width: Number(attr(tag, 'width')),
    height: Number(attr(tag, 'height')),
  };
}

/** The markup of one slot's `<g class="photo-sticker" data-slot="N">` group. */
function stickerGroup(svg, n) {
  return svg.match(new RegExp(`<g class="photo-sticker" data-slot="${n}">([\\s\\S]*?)</g>`))?.[1];
}

/** Every `<circle .../>` in a fragment, as attribute maps. */
function circles(fragment) {
  return [...(fragment.match(/<circle\b[^>]*\/>/g) || [])].map((tag) => ({
    tag,
    cx: Number(attr(tag, 'cx')),
    cy: Number(attr(tag, 'cy')),
    r: Number(attr(tag, 'r')),
    fill: attr(tag, 'fill'),
    stroke: attr(tag, 'stroke'),
    filter: attr(tag, 'filter'),
  }));
}

const WHITE = new Set(['#ffffff', '#fff', 'white', '#FFFFFF']);

describe('photo card templates', () => {
  for (const [name, file] of cards) {
    describe(name, () => {
      const svg = fs.readFileSync(file, 'utf8');

      it('is a portrait single card on the deck viewBox', () => {
        expect(svg).toContain(`viewBox="${VIEWBOX}"`);
      });

      it('exposes exactly four photo slots, each an <image> with a unique id', () => {
        for (const id of SLOT_IDS) {
          const tag = slotTag(svg, id);
          expect(tag, `${name} is missing <image id="${id}">`).toBeTruthy();
          // Unique: an id that appears twice would make the generator's
          // "set href on #photo-slot-N" silently fill only the first.
          expect(svg.match(new RegExp(`\\bid="${id}"`, 'g'))).toHaveLength(1);
        }
        // …and no fifth slot crept in.
        expect(svg.match(/\bid="photo-slot-\d+"/g)).toHaveLength(4);
      });

      it('gives every slot explicit numeric geometry inside the card', () => {
        for (const id of SLOT_IDS) {
          const box = slotBox(svg, id);
          for (const [k, v] of Object.entries(box)) {
            expect(Number.isFinite(v), `${id}.${k} is not a number`).toBe(true);
          }
          expect(box.width).toBeGreaterThan(0);
          expect(box.height).toBeGreaterThan(0);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(CARD_W);
          expect(box.y + box.height).toBeLessThanOrEqual(CARD_H);
        }
      });

      it('never overlaps two slots', () => {
        const boxes = SLOT_IDS.map((id) => slotBox(svg, id));
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            const apart =
              a.x + a.width <= b.x ||
              b.x + b.width <= a.x ||
              a.y + a.height <= b.y ||
              b.y + b.height <= a.y;
            expect(apart, `slots ${i + 1} and ${j + 1} overlap`).toBe(true);
          }
        }
      });

      it('ships the slots EMPTY — the generator supplies href', () => {
        for (const id of SLOT_IDS) {
          const tag = slotTag(svg, id);
          expect(tag).not.toMatch(/\bhref=/);
          expect(tag).not.toMatch(/\bxlink:href=/);
        }
      });

      it('gives every slot a circular clip whose id follows the slot id', () => {
        for (const id of SLOT_IDS) {
          expect(slotTag(svg, id)).toContain(`clip-path="url(#${id}-clip)"`);
          expect(svg).toContain(`<clipPath id="${id}-clip">`);
        }
      });

      // The generator hands us a cutout with the background already removed, so
      // the slot must CONTAIN it: `slice` would scale a 2:3 cutout to cover the
      // square slot and cut the subject's head off. See docs/photo-card.md.
      it('contains the cutout rather than cropping it', () => {
        for (const id of SLOT_IDS) {
          expect(slotTag(svg, id)).toContain('preserveAspectRatio="xMidYMid meet"');
          expect(slotTag(svg, id)).not.toContain('slice');
        }
      });

      // THE STICKER. Each slot is a round die-cut sticker: a white disc BEHIND
      // the image (so a transparent cutout sits on white, never on the card's
      // background pattern), a white ring wider than the image disc, and a soft
      // drop shadow. Asserted on all four slots — a regression on one is as
      // broken a card as a regression on all of them.
      describe.each(SLOT_IDS.map((id, i) => [i + 1, id]))(
        'slot %i is a die-cut sticker',
        (n, id) => {
          const group = stickerGroup(svg, n);
          const box = slotBox(svg, id);
          const centre = { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };

          it('wraps the slot in its own sticker group', () => {
            expect(group, `${name}: no sticker group for slot ${n}`).toBeTruthy();
            expect(group).toContain(`id="${id}"`);
          });

          it('paints a WHITE circle BEHIND the image', () => {
            const face = circles(group)[0];
            expect(WHITE.has(face.fill), `face fill is ${face.fill}, not white`).toBe(true);
            expect(face.cx).toBe(centre.cx);
            expect(face.cy).toBe(centre.cy);
            // …and it really is behind: the disc is painted before the image.
            expect(group.indexOf(face.tag)).toBeLessThan(group.indexOf(`id="${id}"`));
          });

          it('extends that circle past the image disc — the white die-cut ring', () => {
            const face = circles(group)[0];
            const clip = svg.match(new RegExp(`<clipPath id="${id}-clip">\\s*<circle[^>]*/>`))[0];
            const disc = circles(clip)[0];
            expect(disc.r).toBe(box.width / 2); // image disc inscribed in the slot
            expect(disc.cx).toBe(centre.cx);
            expect(disc.cy).toBe(centre.cy);
            // A hairline would not read as die-cut; insist on a real border.
            expect(face.r - disc.r).toBeGreaterThanOrEqual(2);
          });

          it('lifts the sticker with a drop-shadow filter that the file defines', () => {
            const face = circles(group)[0];
            const ref = face.filter?.match(/^url\(#([^)]+)\)$/)?.[1];
            expect(ref, 'sticker face carries no filter').toBeTruthy();
            const filter = svg.match(new RegExp(`<filter id="${ref}"[\\s\\S]*?</filter>`))?.[0];
            expect(filter, `no <filter id="${ref}"> in the file`).toBeTruthy();
            expect(filter).toContain('feDropShadow');
            // The shadow is on the disc ALONE — never on the customer's photo.
            expect(slotTag(svg, id)).not.toMatch(/\bfilter=/);
          });

          it('closes the die-cut edge with a stroked ring ON TOP of the image', () => {
            const face = circles(group)[0];
            const ring = circles(group).at(-1);
            expect(ring.fill).toBe('none');
            expect(ring.stroke).toBeTruthy();
            expect(ring.r).toBe(face.r);
            expect(ring.cx).toBe(centre.cx);
            expect(ring.cy).toBe(centre.cy);
            expect(group.indexOf(ring.tag)).toBeGreaterThan(group.indexOf(`id="${id}"`));
          });
        }
      );

      it('draws the number badges after every sticker, so none is buried', () => {
        const badges = svg.indexOf('<g class="photo-sticker-badges">');
        expect(badges).toBeGreaterThan(-1);
        expect(svg.lastIndexOf('<g class="photo-sticker" data-slot=')).toBeLessThan(badges);
      });

      it('carries no embedded raster and stays small', () => {
        expect(svg).not.toContain('base64');
        expect(svg).not.toMatch(/\bdata:/);
        expect(fs.statSync(file).size).toBeLessThan(64 * 1024);
      });

      it('depends on no font at render time (static copy is baked to paths)', () => {
        expect(svg).not.toMatch(/<text\b/);
        expect(svg).not.toMatch(/font-family/);
      });

      it('references nothing off the card (no remote fetch during render)', () => {
        expect(withoutNamespaces(svg)).not.toMatch(/https?:\/\//);
      });
    });
  }

  it('uses identical slot geometry on every photo card', () => {
    const [first, ...rest] = cards.map(([, file]) => fs.readFileSync(file, 'utf8'));
    const geom = (svg) => SLOT_IDS.map((id) => slotBox(svg, id));
    for (const svg of rest) expect(geom(svg)).toEqual(geom(first));
  });

  it('numbers the slots left-to-right, top-to-bottom', () => {
    const svg = fs.readFileSync(GENERIC_CARD, 'utf8');
    const [a, b, c, d] = SLOT_IDS.map((id) => slotBox(svg, id));
    expect(a.y).toBe(b.y);
    expect(c.y).toBe(d.y);
    expect(a.y).toBeLessThan(c.y);
    expect(a.x).toBeLessThan(b.x);
    expect(c.x).toBeLessThan(d.x);
  });
});

describe('generic pawn fallback set', () => {
  const files = fs
    .readdirSync(FALLBACK_DIR)
    .filter((f) => !f.startsWith('.') && f !== 'README.md')
    .sort();

  it('is exactly four images, named 1..4 to match the slot numbers', () => {
    expect(files).toEqual(['1.svg', '2.svg', '3.svg', '4.svg']);
  });

  for (const f of files) {
    describe(f, () => {
      const abs = path.join(FALLBACK_DIR, f);
      const svg = fs.readFileSync(abs, 'utf8');

      it('is a square, self-describing SVG usable as an <image> href', () => {
        expect(svg).toContain('viewBox="0 0 200 200"');
        expect(svg).toContain('width="200"');
        expect(svg).toContain('height="200"');
        expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      });

      it('stays tiny and self-contained', () => {
        expect(svg).not.toContain('base64');
        expect(svg).not.toMatch(/\bdata:/);
        expect(svg).not.toMatch(/<text\b/);
        expect(withoutNamespaces(svg)).not.toMatch(/https?:\/\//);
        expect(fs.statSync(abs).size).toBeLessThan(4 * 1024);
      });

      // A pawn floating small in the middle of a big white sticker reads as a
      // missing image. It is drawn at ≥ 1× and bottom-anchored so it fills the
      // sticker the way a cutout portrait does, clear of the number badge.
      it('fills the sticker instead of sitting in it like a placeholder', () => {
        const scale = Number(svg.match(/\bscale\(([\d.]+)\)/)?.[1]);
        expect(Number.isFinite(scale), 'no scale() on the pawn group').toBe(true);
        expect(scale).toBeGreaterThanOrEqual(1);
      });
    });
  }

  it('keeps every fallback visually distinct (no two identical drawings)', () => {
    const bodies = files.map((f) =>
      fs
        .readFileSync(path.join(FALLBACK_DIR, f), 'utf8')
        // ignore the <title>, which is the only intentionally per-file text
        .replace(/<title>[\s\S]*?<\/title>/, '')
    );
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it('leaves the ground transparent so it drops onto any theme', () => {
    for (const f of files) {
      const svg = fs.readFileSync(path.join(FALLBACK_DIR, f), 'utf8');
      // A full-bleed background rect/circle would fight the card's own disc.
      expect(svg).not.toMatch(/<rect[^>]*width="200"[^>]*height="200"/);
    }
  });
});

describe('photo card documentation', () => {
  const doc = fs.readFileSync(DOC, 'utf8');

  it('names every path the generator has to resolve', () => {
    expect(doc).toContain('resources/canva/templates/<slug>/clean/photo.svg');
    expect(doc).toContain('resources/canva/templates/_shared/photo-card/photo.svg');
    expect(doc).toContain('resources/canva/templates/_shared/photo-fallback/');
  });

  it('names the slot ids', () => {
    for (const id of SLOT_IDS) expect(doc).toContain(id);
  });
});
