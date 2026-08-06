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

// --- how far a fallback pawn reaches from the centre of its slot -------------
//
// The fallbacks are 200 × 200 SVGs dropped into a 66-unit slot whose cut-line is
// the inscribed circle, so "radius 100" IS the dashed line and everything here
// is in that 200-unit space.

const PAWN_ARGC = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Every point a path's commands name, control points INCLUDED.
 *  A bézier stays inside the convex hull of its control points, so a bound built
 *  from these is an over-estimate — the safe direction for "must not cross". */
function pathPoints(d) {
  const out = [];
  let cur = [0, 0];
  let start = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^A-Za-z]*)/g)) {
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const n = PAWN_ARGC[up];
    if (n === 0) {
      cur = start;
      out.push(cur);
      continue;
    }
    const v = (args.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
    for (let i = 0; i + n <= v.length; i += n) {
      const a = v.slice(i, i + n);
      let pts;
      if (up === 'H') pts = [[rel ? cur[0] + a[0] : a[0], cur[1]]];
      else if (up === 'V') pts = [[cur[0], rel ? cur[1] + a[0] : a[0]]];
      else if (up === 'A') pts = [rel ? [cur[0] + a[5], cur[1] + a[6]] : [a[5], a[6]]];
      else {
        pts = [];
        for (let j = 0; j + 1 < n; j += 2) {
          pts.push(rel ? [cur[0] + a[j], cur[1] + a[j + 1]] : [a[j], a[j + 1]]);
        }
      }
      out.push(...pts);
      cur = pts[pts.length - 1];
      if (up === 'M') start = cur;
    }
  }
  return out;
}

/** The group transform as [scale, tx, ty] — translate/scale only, which is all
 *  these hand-drawn files ever use. */
function pawnTransform(svg) {
  const spec = svg.match(/<g\s+transform="([^"]*)"/)?.[1] ?? '';
  let s = 1;
  let tx = 0;
  let ty = 0;
  for (const [, kind, args] of spec.matchAll(/(translate|scale)\(([^)]*)\)/g)) {
    const v = (args.match(/-?\d*\.?\d+/g) || []).map(Number);
    if (kind === 'scale') {
      s *= v[0];
    } else {
      tx += s * v[0];
      ty += s * (v[1] ?? 0);
    }
  }
  return [s, tx, ty];
}

/** How far the pawn's ink reaches from the centre of the slot (100, 100). */
function pawnReach(svg) {
  const [s, tx, ty] = pawnTransform(svg);
  // A stroked pawn paints half its width outside its own outline.
  const strokes = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
  const pad = (s * Math.max(0, ...strokes, 0)) / 2;
  let worst = 0;
  for (const [, d] of svg.matchAll(/\bd="([^"]+)"/g)) {
    for (const [x, y] of pathPoints(d)) {
      worst = Math.max(worst, Math.hypot(s * x + tx - 100, s * y + ty - 100));
    }
  }
  return worst === 0 ? 0 : worst + pad;
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

      // The image ARRIVES round: the generator frames each photo on its subject
      // and clips it to a disc (docs/photo-card.md). A clip-path here would be
      // applied to the halo `<use>` as well and shave the white outline off the
      // sticker, so the artwork must NOT add one.
      it('does not clip the slot — the generator hands it a round image', () => {
        for (const id of SLOT_IDS) {
          expect(slotTag(svg, id)).not.toMatch(/\bclip-path=/);
        }
        expect(svg).not.toMatch(/<clipPath id="photo-slot-/);
      });

      // The halo bleeds past the slot box; the gutter between slots has to
      // absorb it or neighbouring stickers bump into each other.
      it('leaves a gutter wide enough for the halo to bleed into', () => {
        const boxes = SLOT_IDS.map((id) => slotBox(svg, id));
        const xs = [...new Set(boxes.map((b) => b.x))].sort((a, b) => a - b);
        const ys = [...new Set(boxes.map((b) => b.y))].sort((a, b) => a - b);
        expect(xs[1] - (xs[0] + boxes[0].width)).toBeGreaterThanOrEqual(10);
        expect(ys[1] - (ys[0] + boxes[0].height)).toBeGreaterThanOrEqual(10);
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

      // THE STICKER. Each slot is a die-cut sticker: a DASHED cut-line circle
      // under the artwork, and a white halo that follows the SUBJECT'S OWN
      // SILHOUETTE — generated from the cutout's alpha, not drawn as a disc.
      // Asserted on all four slots; a regression on one is as broken a card as
      // a regression on all of them.
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

          it('marks the cut with a DOTTED, unfilled circle', () => {
            const cut = circles(group)[0];
            expect(cut, 'no circle in the sticker group').toBeTruthy();
            expect(cut.fill, 'the cut-line must not be filled — no disc').toBe('none');
            expect(attr(cut.tag, 'stroke-dasharray'), 'cut-line is not dashed').toBeTruthy();
            expect(cut.stroke).toBeTruthy();
            expect(cut.cx).toBe(centre.cx);
            expect(cut.cy).toBe(centre.cy);
            expect(cut.r).toBe(box.width / 2); // inscribed in the slot box
          });

          it('paints exactly ONE circle — no white disc behind the photo', () => {
            expect(circles(group)).toHaveLength(1);
            for (const c of circles(group)) {
              expect(WHITE.has(c.fill), `a ${c.fill} disc crept back in`).toBe(false);
            }
          });

          it('draws the cut-line UNDER the artwork, so the halo covers it', () => {
            const cut = circles(group)[0];
            expect(group.indexOf(cut.tag)).toBeLessThan(group.indexOf(`id="${id}"`));
          });

          it('haloes the slot through a <use> of the slot itself', () => {
            // A <use> rather than a second <image>: the generator still fills
            // ONE element and the halo picks the same cutout up for free.
            const use = group.match(/<use\b[^>]*\/>/)?.[0];
            expect(use, `slot ${n} has no halo <use>`).toBeTruthy();
            expect(attr(use, 'href')).toBe(`#${id}`);
            expect(attr(use, 'xlink:href')).toBe(`#${id}`);
            // …and it is BEHIND the real image, which stays unfiltered so the
            // photo is never rasterised through the filter pipeline.
            expect(group.indexOf(use)).toBeLessThan(group.indexOf(`id="${id}"`));
            expect(slotTag(svg, id)).not.toMatch(/\bfilter=/);
          });

          it('builds the halo from the cutout ALPHA, with a soft shadow', () => {
            const use = group.match(/<use\b[^>]*\/>/)[0];
            const ref = attr(use, 'filter')?.match(/^url\(#([^)]+)\)$/)?.[1];
            expect(ref, 'halo <use> carries no filter').toBeTruthy();
            const filter = svg.match(new RegExp(`<filter id="${ref}"[\\s\\S]*?</filter>`))?.[0];
            expect(filter, `no <filter id="${ref}"> in the file`).toBeTruthy();
            // Silhouette-following, not a circle: dilate the alpha, flood it
            // white, and shadow the result.
            expect(filter).toMatch(/<feMorphology[^>]*in="SourceAlpha"[^>]*operator="dilate"/);
            expect(Number(filter.match(/<feMorphology[^>]*radius="([\d.]+)"/)[1])).toBeGreaterThan(
              0
            );
            expect(filter).toMatch(/<feFlood[^>]*flood-color="#ffffff"/);
            expect(filter).toContain('feDropShadow');
          });
        }
      );

      it('carries no numbered badges — the photo is the identity', () => {
        expect(svg).not.toContain('photo-sticker-badges');
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

      // NEVER OUTSIDE OR ON THE DOTTED LINE — the owner's words.
      //
      // This used to assert the opposite: the pawns were drawn at 1.2× "so it
      // fills the cut-line and spills a little past it". They did spill, and the
      // owner rejected it on a real render. `docs/photo-card.md` had already
      // logged the same thing as the one debt the contract still owed: a
      // customer's photo is clipped to 0.90 of the slot (`PHOTO_DISC_FILL`) and
      // its halo lands INSIDE the dashes, so a fallback crossing them made a
      // half-filled card look like two different products.
      //
      // Measured as a CONVEX-HULL bound: every point a path command names,
      // control points included. A bézier never leaves the hull of its control
      // points, so this over-estimates and can only be too strict — which is the
      // safe direction for a "must not cross" rule.
      it('stays inside the cut-line, like a customer photo does', () => {
        const reach = pawnReach(svg);
        expect(reach, 'no drawable path in the pawn').toBeGreaterThan(0);
        // 0.90 × the 200-unit box's radius: the disc a customer photo is
        // clipped to. The cut-line itself is at 100 and the halo spreads ~7
        // further, so this leaves the white ring just inside the dashes.
        expect(reach).toBeLessThanOrEqual(90);
        // …and a floor, because a pawn floating small in its box reads as a
        // missing image.
        expect(reach).toBeGreaterThan(60);
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

  // Transparency is now LOAD-BEARING, not a nicety: the host card builds the
  // white sticker outline out of this image's alpha, so an opaque ground would
  // print as a white-edged square instead of a pawn-shaped sticker.
  it('leaves the ground transparent — the halo is cut from its alpha', () => {
    for (const f of files) {
      const svg = fs.readFileSync(path.join(FALLBACK_DIR, f), 'utf8');
      expect(svg, `${f} has a full-bleed rect`).not.toMatch(
        /<rect[^>]*\bwidth="200"[^>]*\bheight="200"/
      );
      // …and no full-bleed disc either, which would be just as opaque.
      expect(svg, `${f} has a full-bleed circle`).not.toMatch(
        /<circle[^>]*\bcx="100"[^>]*\bcy="100"[^>]*\br="1[0-9][0-9]"/
      );
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

  // The doc used to say the opposite — an uncut photo was meant to print as an
  // obvious white-edged rectangle. The owner rejected that, so the generator
  // clips EVERY photo to the disc. Stating the reversal is the whole point:
  // someone reading the old rule would happily "restore" it as a bug fix.
  it('states that a photo never prints as a rectangle', () => {
    expect(doc).toMatch(/never prints as a rectangle/i);
    expect(doc).toMatch(/unconditionally/i);
    expect(doc).toMatch(/do not restore it/i);
    expect(doc).toMatch(/alpha/i);
  });

  // The card no longer advertises a failed cut, so the RECORD is what catches
  // it. If that stops being documented, the miss becomes invisible.
  it('says a failed cut is still recorded on the collection', () => {
    expect(doc).toMatch(/pawn_cutouts/);
    expect(doc).toMatch(/null/);
  });
});
