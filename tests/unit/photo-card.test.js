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

      it('crops photos to fill the slot rather than letterboxing them', () => {
        for (const id of SLOT_IDS) {
          expect(slotTag(svg, id)).toContain('preserveAspectRatio="xMidYMid slice"');
        }
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
        expect(withoutNamespaces(svg)).not.toMatch(/https?:\/\//);
        expect(fs.statSync(abs).size).toBeLessThan(4 * 1024);
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
