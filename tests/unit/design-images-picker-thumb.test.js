import { describe, it, expect } from 'vitest';

// THE ONE PICTURE RESOLVER behind the order wizard's design step
// (site/js/design-images.js thumbSrc / previewPicture / previewPictures).
//
// The picker TILE and the big PREVIEW beside it show the same design's picture,
// so they resolve it through the same function. They used to not: the tile came
// from the owner's gallery while the preview inlined a static
// `assets/designs/<id>/front.svg` committed in the repo, and the two drifted —
// `kids` previewed a birthday deck long after its template had been replaced.
//
// Each picture comes back in two sizes because the two surfaces need different
// bytes: the uploads are 180 KB–1 MB each and the picker deliberately asks for
// small ones (a heavy first screen white-screens the Instagram in-app browser),
// while the enlarged view wants the full picture. They are two renditions of ONE
// picture, never two lookups.
import { previewPicture, previewPictures, thumbSrc } from '../../site/js/design-images.js';

const FRONTS = '/content-uploads/aaaaaaaaaaaaaaaa.png';
const BACKS = '/content-uploads/bbbbbbbbbbbbbbbb.webp';
const BOARD = '/content-uploads/cccccccccccccccc.jpg';
// A built-in design that ships every render, so the shipped side is real.
const DESIGN = {
  id: 'bachelorette',
  thumbs: {
    front: 'assets/designs/bachelorette/thumb-front.webp',
    back: 'assets/designs/bachelorette/thumb-back.webp',
    board: 'assets/designs/bachelorette/thumb-board.webp',
  },
};
// A built-in design with NO board render (kids) — the case the wizard hides a
// tab for.
const BOARDLESS = {
  id: 'kids',
  thumbs: {
    front: 'assets/designs/kids/thumb-front.webp',
    back: 'assets/designs/kids/thumb-back.webp',
  },
};
// An owner-uploaded template: no committed rasters at all, its pictures ARE the
// template's own SVGs (loadCustomDesigns puts them on `img`).
const CUSTOM = {
  id: 'grapefruit',
  custom: true,
  img: {
    front: '/api/template-image/grapefruit/front',
    back: '/api/template-image/grapefruit/back',
  },
};
const withDeck = (base, id = 'bachelorette') => ({ [id]: { base } });

describe('thumbSrc — the small-derivative URL', () => {
  it('routes one of OUR OWN uploads through /design-thumb, keeping the name', () => {
    expect(thumbSrc(FRONTS)).toBe('/design-thumb/aaaaaaaaaaaaaaaa.png');
    expect(thumbSrc(BACKS)).toBe('/design-thumb/bbbbbbbbbbbbbbbb.webp');
  });

  // The derivative URL is built from a value that came out of a config map, so
  // it gets the same validation every other consumer of that map applies: only
  // a path this server itself produced may be turned into a request.
  it('refuses anything that is not an our-own upload path', () => {
    for (const bad of [
      '',
      null,
      undefined,
      42,
      'https://evil.example/x.png',
      '/content-uploads/../../etc/passwd',
      '/content-uploads/short.png',
      '/content-uploads/aaaaaaaaaaaaaaaa.svg',
      'assets/designs/bachelorette/thumb.webp',
    ]) {
      expect(thumbSrc(bad)).toBe(null);
    }
  });
});

describe('previewPicture — one view of one design', () => {
  it('prefers the owner’s deck photograph of that face', () => {
    const map = withDeck({ deckFronts: { img: FRONTS } });
    expect(previewPicture(map, DESIGN, 'front')).toEqual({
      view: 'front',
      src: FRONTS,
      small: '/design-thumb/aaaaaaaaaaaaaaaa.png',
      // Her photo sits on top of the shipped render, so a broken upload has
      // somewhere to fall back to — at both sizes.
      fallback: 'assets/designs/bachelorette/gallery-front.webp',
      smallFallback: 'assets/designs/bachelorette/thumb-front.webp',
    });
  });

  // The majority case: nothing photographed → the design's own shipped render.
  it('falls back to the shipped render, big and small', () => {
    expect(previewPicture({}, DESIGN, 'back')).toEqual({
      view: 'back',
      src: 'assets/designs/bachelorette/gallery-back.webp',
      small: 'assets/designs/bachelorette/thumb-back.webp',
      fallback: '',
      smallFallback: '',
    });
  });

  // Each view reads its OWN deck slot. A design photographed board-first shows
  // that photograph on its BOARD tab — not under a tab labelled קלף.
  it('keeps every view on its own face', () => {
    const map = withDeck({ deckBoard: { img: BOARD } });
    expect(previewPicture(map, DESIGN, 'board').src).toBe(BOARD);
    expect(previewPicture(map, DESIGN, 'front').src).toBe(
      'assets/designs/bachelorette/gallery-front.webp'
    );
  });

  it('is null for a view the design has no picture for', () => {
    expect(previewPicture({}, BOARDLESS, 'board')).toBe(null);
    // …but an owner upload alone SURFACES that view (#159): she photographed a
    // board for a design that renders none, and it is hers to show.
    const map = withDeck({ deckBoard: { img: BOARD } }, 'kids');
    expect(previewPicture(map, BOARDLESS, 'board')).toEqual({
      view: 'board',
      src: BOARD,
      small: '/design-thumb/cccccccccccccccc.jpg',
      fallback: '', // nothing shipped behind it
      smallFallback: '',
    });
  });

  // An uploaded template has no committed rasters: its picture IS its SVG, at
  // both sizes (there is no small rendition to ask for).
  it('resolves an uploaded template to its own template image', () => {
    expect(previewPicture({}, CUSTOM, 'front')).toEqual({
      view: 'front',
      src: '/api/template-image/grapefruit/front',
      small: '/api/template-image/grapefruit/front',
      fallback: '',
      smallFallback: '',
    });
    expect(previewPicture({}, CUSTOM, 'board')).toBe(null);
  });

  it('never throws and never yields an off-origin src on a garbage map', () => {
    for (const map of [null, undefined, 'nope', 42, [], { bachelorette: null }]) {
      expect(previewPicture(map, DESIGN, 'front').src).toBe(
        'assets/designs/bachelorette/gallery-front.webp'
      );
    }
    expect(
      previewPicture(
        withDeck({ deckFronts: { img: 'https://evil.example/x.png' } }),
        DESIGN,
        'front'
      ).src
    ).toBe('assets/designs/bachelorette/gallery-front.webp');
    expect(previewPicture(withDeck({ deckFronts: 'not-an-object' }), DESIGN, 'front').src).toBe(
      'assets/designs/bachelorette/gallery-front.webp'
    );
    expect(previewPicture({}, null, 'front')).toBe(null);
    expect(previewPicture({}, DESIGN, 'nope')).toBe(null);
  });

  // Gallery pictures live in the same bag as the deck ones. The storefront's
  // renders must never leak into the wizard's preview.
  it('reads only the DECK slots, never the gallery ones', () => {
    const map = withDeck({ store: { img: FRONTS }, front: { img: BACKS } });
    expect(previewPicture(map, DESIGN, 'front').src).toBe(
      'assets/designs/bachelorette/gallery-front.webp'
    );
  });
});

describe('previewPictures — the views a design can show, in tab order', () => {
  it('is card → back → board', () => {
    expect(previewPictures({}, DESIGN).map((p) => p.view)).toEqual(['front', 'back', 'board']);
  });

  it('omits a view the design has no picture for', () => {
    expect(previewPictures({}, BOARDLESS).map((p) => p.view)).toEqual(['front', 'back']);
    expect(previewPictures({}, CUSTOM).map((p) => p.view)).toEqual(['front', 'back']);
  });

  // The tile shows the first of these and the preview opens on it, which is the
  // whole reason they cannot drift apart.
  it('leads with the same picture the picker tile shows', () => {
    const map = withDeck({ deckFronts: { img: FRONTS } });
    const first = previewPictures(map, DESIGN)[0];
    expect(first.src).toBe(previewPicture(map, DESIGN, 'front').src);
    expect(first.small).toBe('/design-thumb/aaaaaaaaaaaaaaaa.png');
  });

  it('is empty for a design with nothing to show', () => {
    expect(previewPictures({}, { id: 'nope', custom: true, img: {} })).toEqual([]);
    expect(previewPictures({}, null)).toEqual([]);
  });
});
