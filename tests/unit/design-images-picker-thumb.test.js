import { describe, it, expect } from 'vitest';

// The PICKER TILE picture (site/js/design-images.js thumbSrc / deckPickerSrc).
//
// The wizard's design picker used to show only the shipped build-time thumbnail.
// The owner photographs her real decks and uploads those pictures in the admin
// gallery ("תמונות החפיסה"), and asked for the tile to show the first of them.
//
// The catch the whole design turns on: those uploads are 180 KB–1 MB each and
// the picker deliberately ships 5–10 KB thumbnails, because a heavy first screen
// white-screens the Instagram in-app browser. So the tile never asks for the
// upload itself — it asks /design-thumb/<name> for a small derivative of it.
import { deckPickerSrc, thumbSrc } from '../../site/js/design-images.js';

const FRONTS = '/content-uploads/aaaaaaaaaaaaaaaa.png';
const BACKS = '/content-uploads/bbbbbbbbbbbbbbbb.webp';
const BOARD = '/content-uploads/cccccccccccccccc.jpg';
const DESIGN = { id: 'bachelorette', thumbs: { front: 'f', back: 'b', board: 'brd' } };
const withDeck = (base) => ({ bachelorette: { base } });

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

describe('deckPickerSrc — the tile picture', () => {
  it('uses the FIRST deck picture the owner uploaded', () => {
    expect(deckPickerSrc(withDeck({ deckFronts: { img: FRONTS } }), DESIGN)).toBe(
      '/design-thumb/aaaaaaaaaaaaaaaa.png'
    );
    // …and it is the first PRESENT one, in wizard order — not specifically the
    // fronts. A design photographed backs-first shows its backs.
    expect(
      deckPickerSrc(withDeck({ deckBacks: { img: BACKS }, deckBoard: { img: BOARD } }), DESIGN)
    ).toBe('/design-thumb/bbbbbbbbbbbbbbbb.webp');
    // A design with ONLY a board photographed shows the board (the owner's call:
    // her picture beats no picture).
    expect(deckPickerSrc(withDeck({ deckBoard: { img: BOARD } }), DESIGN)).toBe(
      '/design-thumb/cccccccccccccccc.jpg'
    );
  });

  it('picks the fronts when several are uploaded, ignoring the gallery slots', () => {
    const map = withDeck({
      store: { img: BOARD },
      front: { img: BOARD },
      deckFronts: { img: FRONTS },
      deckBacks: { img: BACKS },
      deckBoard: { img: BOARD },
    });
    expect(deckPickerSrc(map, DESIGN)).toBe('/design-thumb/aaaaaaaaaaaaaaaa.png');
  });

  // The majority case, and the one that must not regress: nothing uploaded →
  // null → the caller keeps the shipped build-time thumbnail.
  it('is null when the design has no deck picture, so the tile keeps its shipped thumb', () => {
    expect(deckPickerSrc({}, DESIGN)).toBe(null);
    expect(deckPickerSrc(withDeck({}), DESIGN)).toBe(null);
    // Gallery pictures are NOT deck pictures — the storefront renders live in the
    // same bag and must not leak into the picker.
    expect(deckPickerSrc(withDeck({ store: { img: FRONTS }, front: { img: BACKS } }), DESIGN)).toBe(
      null
    );
  });

  it('never throws and never yields an off-origin src on a garbage map', () => {
    for (const map of [null, undefined, 'nope', 42, [], { bachelorette: null }]) {
      expect(deckPickerSrc(map, DESIGN)).toBe(null);
    }
    expect(
      deckPickerSrc(withDeck({ deckFronts: { img: 'https://evil.example/x.png' } }), DESIGN)
    ).toBe(null);
    expect(deckPickerSrc(withDeck({ deckFronts: 'not-an-object' }), DESIGN)).toBe(null);
    expect(deckPickerSrc({}, null)).toBe(null);
  });
});
