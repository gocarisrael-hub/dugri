import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Unit tests for the pure per-design override helpers in site/js/product.js.
// Importing the module in jsdom does NOT boot the page (boot only auto-runs when a
// #galleryTrack element exists, which a bare test import has no reason to create),
// so these exercise the exported helpers directly.
import {
  fieldKey,
  legacyFieldKey,
  overrideKeys,
  overrideText,
  photosFromOverride,
  galleryShots,
  shouldShowBoard,
  galleryAspect,
  LANDSCAPE_ASPECT,
  PORTRAIT_ASPECT,
} from '../../site/js/product.js';
import { designShipsBoard, DESIGNS } from '../../site/js/designs.js';

const P1 = '/content-uploads/aaaaaaaaaaaaaaaa.png';
const P2 = '/content-uploads/bbbbbbbbbbbbbbbb.webp';

// The fixed-section fields tagged data-edit-pd in product.html, namespaced per
// design so each product page persists its OWN copy (not one shared value).
// The "what's inside" list ends at inside-4 — see the list-shape test below.
const PD_FIELDS = [
  'about-heading',
  'inside-1',
  'inside-2',
  'inside-3',
  'inside-4',
  'buy-cta',
  'buy-note',
  'related-heading',
  'related-sub',
];

describe('fieldKey — per-design content-override key derivation', () => {
  it('encodes both the design id and the field into the key', () => {
    expect(fieldKey('japanese', 'about-heading')).toBe('product-japanese-about-heading');
    expect(fieldKey('marriage', 'buy-cta')).toBe('product-marriage-buy-cta');
  });

  it('gives a DISTINCT key per design for the same field (no cross-product leak)', () => {
    const keys = ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'kids'].map(
      (id) => fieldKey(id, 'buy-cta')
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every design × field key stays within the server key shape (alnum start, kebab, ≤61)', () => {
    const KEY_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
    for (const id of ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'kids']) {
      for (const field of PD_FIELDS) expect(KEY_RE.test(fieldKey(id, field))).toBe(true);
    }
  });
});

describe('legacyFieldKey — the pre-namespacing design-agnostic shared key', () => {
  it('is the design-independent "product-<field>" every design falls back to', () => {
    expect(legacyFieldKey('about-heading')).toBe('product-about-heading');
    expect(legacyFieldKey('buy-cta')).toBe('product-buy-cta');
    // it is NOT any design's per-design key (so the fallback is unambiguous)
    for (const id of ['bachelorette', 'japanese', 'marriage']) {
      for (const field of PD_FIELDS) expect(legacyFieldKey(field)).not.toBe(fieldKey(id, field));
    }
    // and stays a valid server key
    const KEY_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
    for (const field of PD_FIELDS) expect(KEY_RE.test(legacyFieldKey(field))).toBe(true);
  });
});

describe('overrideKeys — per-design content-override keys', () => {
  it('encodes the design id into name/about/photos keys (kebab, page-shared)', () => {
    expect(overrideKeys('bachelorette')).toEqual({
      name: 'product-bachelorette-name',
      about: 'product-bachelorette-about',
      photos: 'product-bachelorette-photos',
    });
    // derived from fieldKey, so name/about/photos match the field derivation
    expect(overrideKeys('japanese').about).toBe(fieldKey('japanese', 'about'));
    // every key stays within the server's key shape (alnum start, kebab, ≤61)
    const KEY_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
    for (const id of ['bachelorette', 'marriage', 'kids', 'posttrip']) {
      for (const k of Object.values(overrideKeys(id))) expect(KEY_RE.test(k)).toBe(true);
    }
  });
});

describe('overrideText — a saved text override wins, else null', () => {
  it('returns the override text when present, null otherwise', () => {
    expect(
      overrideText({ 'product-japanese-about': { text: 'חדש' } }, 'product-japanese-about')
    ).toBe('חדש');
    // an empty string is a valid (blanked) override, not "absent"
    expect(overrideText({ k: { text: '' } }, 'k')).toBe('');
    expect(overrideText({}, 'k')).toBe(null);
    expect(overrideText(null, 'k')).toBe(null);
    // an img-only entry has no text override
    expect(overrideText({ k: { img: '/x' } }, 'k')).toBe(null);
  });
});

describe('photosFromOverride — the owner’s custom photos (validated)', () => {
  it('returns only our-own upload paths for the design’s photos key', () => {
    const ov = { 'product-japanese-photos': { imgs: [P1, 'https://evil/x.png', P2] } };
    expect(photosFromOverride(ov, 'japanese')).toEqual([P1, P2]); // off-origin dropped
  });
  it('is [] when there is no override or an empty array', () => {
    expect(photosFromOverride({}, 'japanese')).toEqual([]);
    expect(photosFromOverride({ 'product-japanese-photos': { imgs: [] } }, 'japanese')).toEqual([]);
    expect(photosFromOverride(null, 'japanese')).toEqual([]);
    // a photos key for a DIFFERENT design must not leak in
    expect(photosFromOverride({ 'product-kids-photos': { imgs: [P1] } }, 'japanese')).toEqual([]);
  });
});

describe('galleryShots — custom photos replace the defaults, else fall back', () => {
  const design = {
    id: 'japanese',
    name: 'יפני',
    thumb: 'assets/designs/japanese/thumb.webp',
    thumbs: {
      front: 'assets/designs/japanese/thumb-front.webp',
      back: 'assets/designs/japanese/thumb-back.webp',
      board: 'assets/designs/japanese/thumb-board.webp',
    },
  };

  it('uses the owner’s custom photos when present', () => {
    const shots = galleryShots(design, { 'product-japanese-photos': { imgs: [P1, P2] } });
    expect(shots.map((s) => s.src)).toEqual([P1, P2]);
    // each shot carries an accessible per-design label
    expect(shots[0].label).toContain(design.name);
  });

  it('falls back to the design’s default hi-res renders when there are no custom photos', () => {
    const shots = galleryShots(design, {});
    // front/back/board hi-res renders (never the tiny thumb-*.webp)
    expect(shots.map((s) => s.src)).toEqual([
      'assets/designs/japanese/gallery-front.webp',
      'assets/designs/japanese/gallery-back.webp',
      'assets/designs/japanese/gallery-board.webp',
    ]);
    for (const s of shots) expect(s.src).not.toMatch(/thumb-(front|back|board)\.webp$/);
  });

  it('skips the board render for a boardless design (no board override)', () => {
    const kids = { id: 'kids', name: 'ילדים', thumbs: { front: 'f', back: 'b' } };
    const shots = galleryShots(kids, {});
    expect(shots.map((s) => s.src)).toEqual([
      'assets/designs/kids/gallery-front.webp',
      'assets/designs/kids/gallery-back.webp',
    ]);
  });

  it('surfaces a board slide for a boardless design when the owner uploaded a board', () => {
    // kids ships NO board (thumbs has only front/back) but the owner uploaded one.
    const kids = { id: 'kids', name: 'ילדים', thumbs: { front: 'f', back: 'b' } };
    const map = { kids: { base: { board: { img: P1 } } } };
    const shots = galleryShots(kids, {}, map);
    expect(shots.map((s) => s.src)).toEqual([
      'assets/designs/kids/gallery-front.webp',
      'assets/designs/kids/gallery-back.webp',
      P1, // owner's uploaded board picture — appears from the override alone
    ]);
    // No shipped gallery-board.webp exists, so the board slide carries NO fallback
    // (a fallback would 404). front/back keep their static renders / no fallback.
    expect(shots[2].fallback).toBeUndefined();
  });

  it('tags a boardless design’s override-only board slide `droppable` (no 404 fallback)', () => {
    // kids ships NO board → its board slide (from the override alone) has no shipped
    // gallery-board.webp to degrade to, so it must NOT carry a fallback (that would
    // 404). Instead it is tagged `droppable` so fillTrack removes the whole slide +
    // its dot on a load error rather than showing a broken image.
    const kids = { id: 'kids', name: 'ילדים', thumbs: { front: 'f', back: 'b' } };
    const shots = galleryShots(kids, {}, { kids: { base: { board: { img: P1 } } } });
    expect(shots[2]).toMatchObject({ src: P1, droppable: true });
    expect(shots[2].fallback).toBeUndefined();
    // A design that SHIPS a board keeps its static fallback and is NOT droppable
    // (it degrades to the shipped render, never dropped).
    const japanese = {
      id: 'japanese',
      name: 'יפני',
      thumbs: { front: 'f', back: 'b', board: 'brd' },
    };
    const shipShots = galleryShots(japanese, {}, { japanese: { base: { board: { img: P1 } } } });
    expect(shipShots[2]).toMatchObject({
      src: P1,
      fallback: 'assets/designs/japanese/gallery-board.webp',
    });
    expect(shipShots[2].droppable).toBeUndefined();
  });

  it('prefers a per-design SLOT override over the static render, else falls back per-slot', () => {
    // Only the board slot is overridden → front/back keep their static renders.
    const map = { japanese: { base: { board: { img: P1 } } } };
    const shots = galleryShots(design, {}, map);
    expect(shots.map((s) => s.src)).toEqual([
      'assets/designs/japanese/gallery-front.webp',
      'assets/designs/japanese/gallery-back.webp',
      P1, // owner's uploaded board picture
    ]);
  });

  it('an override shot carries the static render as `fallback` (broken-file degrade)', () => {
    const map = { japanese: { base: { board: { img: P1 } } } };
    const shots = galleryShots(design, {}, map);
    // The override slide points its onerror at the shipped static asset…
    expect(shots[2]).toMatchObject({
      src: P1,
      fallback: 'assets/designs/japanese/gallery-board.webp',
    });
    // …while a non-overridden slide has no fallback (it IS the static asset).
    expect(shots[0].fallback).toBeUndefined();
    expect(shots[1].fallback).toBeUndefined();
  });

  it('ignores a malformed/off-origin override path and keeps the static asset', () => {
    const map = {
      japanese: {
        base: {
          front: { img: 'https://evil.example/x.png' },
          back: { img: '/content-uploads/nope.gif' },
        },
      },
    };
    const shots = galleryShots(design, {}, map);
    expect(shots.map((s) => s.src)).toEqual([
      'assets/designs/japanese/gallery-front.webp',
      'assets/designs/japanese/gallery-back.webp',
      'assets/designs/japanese/gallery-board.webp',
    ]);
  });

  it('curated custom photos still win over per-slot overrides', () => {
    const map = {
      japanese: { base: { front: { img: P1 }, back: { img: P2 }, board: { img: P1 } } },
    };
    const shots = galleryShots(design, { 'product-japanese-photos': { imgs: [P2] } }, map);
    expect(shots.map((s) => s.src)).toEqual([P2]); // the curated carousel wins
  });

  // An UPLOADED TEMPLATE is a design like any other on the detail page: its shipped
  // pictures are the template's own SVGs, and the owner's curation applies on top.
  // It used to bypass the curated gallery entirely, so anything the owner set for it
  // in the admin was silently ignored here.
  describe('a CUSTOM design (uploaded template)', () => {
    const tpl = {
      id: 'grapefruit',
      name: 'אשכוליות',
      custom: true,
      img: {
        front: '/api/template-image/grapefruit/front',
        back: '/api/template-image/grapefruit/back',
        board: '/api/template-image/grapefruit/board',
      },
    };

    it('shows the template SVGs when nothing is curated', () => {
      const shots = galleryShots(tpl, {}, {});
      expect(shots.map((s) => s.src)).toEqual([tpl.img.front, tpl.img.back, tpl.img.board]);
      expect(shots[0].label).toContain(tpl.name);
    });

    it('applies the owner’s replaced picture, extra photo and order', () => {
      const map = {
        grapefruit: {
          base: { front: { img: P1 } },
          photos: [{ id: 'p1', img: P2, name: 'מהמסיבה', onProduct: true }],
          order: ['p1', 'front', 'back', 'board'],
        },
      };
      const shots = galleryShots(tpl, {}, map);
      expect(shots.map((s) => s.src)).toEqual([P2, P1, tpl.img.back, tpl.img.board]);
      // The replaced front falls back to the template SVG if the upload breaks.
      expect(shots[1].fallback).toBe(tpl.img.front);
    });
  });
});

describe('shouldShowBoard — board slide visibility', () => {
  const shipsBoard = { id: 'japanese', thumbs: { front: 'f', back: 'b', board: 'brd' } };
  const boardless = { id: 'kids', thumbs: { front: 'f', back: 'b' } };

  it('is true for a design that ships a board (regardless of overrides)', () => {
    expect(shouldShowBoard(shipsBoard, {})).toBe(true);
    expect(shouldShowBoard(shipsBoard, { japanese: { base: { board: { img: P1 } } } })).toBe(true);
  });

  it('is true for a boardless design once a valid board override exists', () => {
    expect(shouldShowBoard(boardless, { kids: { base: { board: { img: P1 } } } })).toBe(true);
  });

  it('is false for a boardless design with no board override', () => {
    expect(shouldShowBoard(boardless, {})).toBe(false);
    expect(shouldShowBoard(boardless, { kids: { base: { front: { img: P1 } } } })).toBe(false);
  });

  it('ignores a malformed/off-origin board override for a boardless design', () => {
    expect(
      shouldShowBoard(boardless, {
        kids: { base: { board: { img: 'https://evil.example/x.png' } } },
      })
    ).toBe(false);
    expect(
      shouldShowBoard(boardless, {
        kids: { base: { board: { img: '/content-uploads/nope.gif' } } },
      })
    ).toBe(false);
  });
});

// The admin image manager (admin-images.html shipsSlot) and the product gallery
// (product.js shouldShowBoard / defaultShots) once read TWO different fields to
// decide "this design ships a board" — admin `products.board`, product
// `thumbs.board`. They agree in the generated catalog today but nothing enforced
// it. Both now key off the SHARED designShipsBoard(d) (thumbs.board), so they can
// never disagree. These guard that single source of truth.
describe('board "ships a board" is ONE shared field (admin ↔ product agree)', () => {
  // admin shipsSlot(d,'board') === designShipsBoard(d); product shouldShowBoard uses it.
  const shipsBoard = {
    id: 'japanese',
    thumbs: { front: 'f', back: 'b', board: 'brd' },
    products: { front: 'f', back: 'b', board: 'b' },
  };
  const boardless = {
    id: 'kids',
    thumbs: { front: 'f', back: 'b' },
    products: { front: 'f', back: 'b' },
  };

  it('boardless design (no override): admin "ships board" and product "shows board" are BOTH false', () => {
    expect(designShipsBoard(boardless)).toBe(false);
    expect(shouldShowBoard(boardless, {})).toBe(false);
  });

  it('board-shipping design: admin "ships board" and product "shows board" are BOTH true', () => {
    expect(designShipsBoard(shipsBoard)).toBe(true);
    expect(shouldShowBoard(shipsBoard, {})).toBe(true);
  });

  it('the exact old divergence (products.board present, thumbs.board absent) now agrees — both false', () => {
    // Under the old code admin (products.board) said "ships" while product
    // (thumbs.board) said "boardless". Nothing keys off products.board anymore, so
    // both treat it as boardless — the two pages can no longer disagree.
    const divergent = {
      id: 'x',
      thumbs: { front: 'f', back: 'b' },
      products: { board: 'only-svg' },
    };
    expect(designShipsBoard(divergent)).toBe(false);
    expect(shouldShowBoard(divergent, {})).toBe(false);
  });

  it('designShipsBoard guards nullish inputs (never throws)', () => {
    expect(designShipsBoard(null)).toBe(false);
    expect(designShipsBoard({})).toBe(false);
    expect(designShipsBoard({ thumbs: null })).toBe(false);
  });
});

// The gallery box's shape follows the design's CARD ERA. A legacy design's
// front/back renders are landscape A4 sheets of 8 cards (1.41); a portrait
// card-structure design's are single 223.92×312 cards (0.72), which contained in
// the landscape box would show at ~51% of the frame width. See galleryAspect for
// why a portrait design gets a SQUARE box rather than a portrait one.
describe('galleryAspect — picture-box shape per card era', () => {
  it('keeps the landscape sheet box for a design still on the legacy artwork', () => {
    expect(galleryAspect({ id: 'birthday' })).toBe(LANDSCAPE_ASPECT);
    expect(galleryAspect({ id: 'birthday', portrait: false })).toBe(LANDSCAPE_ASPECT);
  });

  it('gives a portrait card-structure design a square box', () => {
    expect(galleryAspect({ id: 'grapefruit', portrait: true })).toBe(PORTRAIT_ASPECT);
  });

  it('falls back to the landscape box for a missing/garbage design (never throws)', () => {
    expect(galleryAspect(null)).toBe(LANDSCAPE_ASPECT);
    expect(galleryAspect(undefined)).toBe(LANDSCAPE_ASPECT);
    expect(galleryAspect({})).toBe(LANDSCAPE_ASPECT);
  });

  it('EVERY shipped design is still on the landscape artwork — none re-exported yet', () => {
    // Guards the migration: the day a design's artwork is re-exported into the
    // portrait structure, this flips and its store tile + gallery box change shape.
    // If this test fails, that is the change — confirm the renders were regenerated
    // (scripts/render-design-assets.mjs) before updating it.
    expect(DESIGNS.filter((d) => d.portrait).map((d) => d.id)).toEqual([]);
    expect(DESIGNS.every((d) => galleryAspect(d) === LANDSCAPE_ASPECT)).toBe(true);
  });
});

describe('"what\'s inside" list — shape of the shipped HTML', () => {
  // Read the real page: this list is plain markup, and the point of the change
  // was the MARKUP, so asserting against a fixture would pin nothing.
  const html = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'site', 'product.html'),
    'utf8'
  );
  const list = html.slice(html.indexOf('<ul class="pdp-list">'), html.indexOf('</ul>'));

  it('ships FOUR rows, each a tick beside its own editable text', () => {
    expect(list.match(/<li>/g) || []).toHaveLength(4);
    expect(list.match(/class="tick"/g) || []).toHaveLength(4);
    expect(list.match(/data-edit-pd="inside-\d"/g)).toEqual([
      'data-edit-pd="inside-1"',
      'data-edit-pd="inside-2"',
      'data-edit-pd="inside-3"',
      'data-edit-pd="inside-4"',
    ]);
  });

  it('carries NO fifth row — the row is retired for every design, present and future', () => {
    // Retiring it in the markup is what makes it stick: applyPerDesignFields only
    // stamps overrides onto elements present in the DOM, so a design that had saved
    // its own inside-5 text has nothing left to apply it to. Re-adding the element
    // would silently resurrect those stored values on exactly those designs.
    // The ATTRIBUTE is what resurrects the row — prose mentioning the retired
    // field (the explanatory comment in the markup) is documentation, not markup.
    expect(list).not.toContain('data-edit-pd="inside-5"');
    expect(html).not.toContain('data-edit-pd="inside-5"');
  });
});
