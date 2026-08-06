import { describe, it, expect, vi, afterEach } from 'vitest';

// Unit tests for the buyer-facing gallery reader (site/js/design-images.js):
// galleryFor resolution (order, per-surface visibility, overrides, extras,
// fail-safe fallback) and loadDesignImages fail-safe behaviour.
import { galleryFor, baseSrc, loadDesignImages } from '../../site/js/design-images.js';

const P1 = '/content-uploads/aaaaaaaaaaaaaaaa.png';
const P2 = '/content-uploads/bbbbbbbbbbbbbbbb.webp';
// A design that ships a board, and one that does not. `thumbs.board` is the
// canonical board-render indicator (matches designs.js designShipsBoard).
const BOARDED = { id: 'posttrip', thumbs: { front: 'f', back: 'b', board: 'brd' } };
const BOARDLESS = { id: 'neon', thumbs: { front: 'f', back: 'b' } };
const keys = (items) => items.map((i) => i.key);
const srcs = (items) => items.map((i) => i.src);

describe('galleryFor — resolved per-surface gallery', () => {
  it('with no config, the grid shows store + card renders; the detail page omits the store cover', () => {
    const products = galleryFor({}, BOARDED, 'products');
    expect(keys(products)).toEqual(['store', 'front', 'back', 'board']);
    expect(srcs(products)).toEqual([
      baseSrc('posttrip', 'store'),
      baseSrc('posttrip', 'front'),
      baseSrc('posttrip', 'back'),
      baseSrc('posttrip', 'board'),
    ]);
    // Every base item carries a shipped fallback (for onerror) and no caption.
    expect(products.every((i) => i.fallback === baseSrc('posttrip', i.key) && i.name === '')).toBe(
      true
    );
    // The product-detail surface leads with the card renders (no store cover by default).
    expect(keys(galleryFor({}, BOARDED, 'product'))).toEqual(['front', 'back', 'board']);
  });

  it('the owner can opt the store cover INTO the product page', () => {
    const map = { posttrip: { base: { store: { onProduct: true } } } };
    expect(keys(galleryFor(map, BOARDED, 'product'))).toEqual(['store', 'front', 'back', 'board']);
  });

  it('omits the board slot for a boardless design (no override)', () => {
    expect(keys(galleryFor({}, BOARDLESS, 'product'))).toEqual(['front', 'back']);
    expect(keys(galleryFor({}, BOARDLESS, 'products'))).toEqual(['store', 'front', 'back']);
  });

  it('surfaces a boardless design’s board from an override alone, tagged droppable (#159)', () => {
    // A boardless design gains a board slide from the OVERRIDE — with NO shipped
    // gallery-board.webp there is no fallback, so it is droppable (drop on error).
    const map = { neon: { base: { board: { img: P1 } } } };
    const board = galleryFor(map, BOARDLESS, 'product').find((i) => i.key === 'board');
    expect(board).toMatchObject({ src: P1, fallback: '', droppable: true });
    // A design that SHIPS a board keeps its static fallback and is NOT droppable.
    const shipped = galleryFor(
      { posttrip: { base: { board: { img: P1 } } } },
      BOARDED,
      'product'
    ).find((i) => i.key === 'board');
    expect(shipped).toMatchObject({
      src: P1,
      fallback: baseSrc('posttrip', 'board'),
      droppable: false,
    });
  });

  it('prefers a base override for its slot, keeps the shipped fallback', () => {
    const map = { posttrip: { base: { board: { img: P1 } } } };
    const items = galleryFor(map, BOARDED, 'products');
    const board = items.find((i) => i.key === 'board');
    expect(board.src).toBe(P1);
    expect(board.fallback).toBe(baseSrc('posttrip', 'board'));
  });

  it('honors per-surface visibility flags independently', () => {
    // store hidden on the product page, front hidden on the products grid.
    const map = {
      posttrip: { base: { store: { onProduct: false }, front: { onProducts: false } } },
    };
    expect(keys(galleryFor(map, BOARDED, 'products'))).toEqual(['store', 'back', 'board']);
    expect(keys(galleryFor(map, BOARDED, 'product'))).toEqual(['front', 'back', 'board']);
  });

  it('inserts extra photos and respects the owner order', () => {
    const map = {
      posttrip: {
        photos: [
          { id: 'p1', img: P1, name: 'וריאציה', onProducts: true, onProduct: true },
          { id: 'p2', img: P2, name: 'סטודיו', onProducts: true, onProduct: false },
        ],
        order: ['p1', 'store', 'front'],
      },
    };
    const products = galleryFor(map, BOARDED, 'products');
    // Stored order first, then remaining known keys appended in default order.
    expect(keys(products)).toEqual(['p1', 'store', 'front', 'back', 'board', 'p2']);
    expect(products[0]).toMatchObject({ src: P1, name: 'וריאציה' });
    // p2 is hidden on the product page.
    expect(keys(galleryFor(map, BOARDED, 'product'))).not.toContain('p2');
  });

  it('drops an off-origin / malformed override and photo path', () => {
    const map = {
      posttrip: {
        base: { front: { img: 'https://evil/x.png' } },
        photos: [
          { id: 'p1', img: '/content-uploads/not-a-hash.png', onProducts: true, onProduct: true },
        ],
      },
    };
    const items = galleryFor(map, BOARDED, 'products');
    // front falls back to its shipped render; the bad photo is skipped entirely.
    expect(items.find((i) => i.key === 'front').src).toBe(baseSrc('posttrip', 'front'));
    expect(keys(items)).not.toContain('p1');
  });

  // REVERSED on purpose. This used to assert the opposite — hiding everything fell
  // back to the shipped renders, so the shopper always saw something. That rescue
  // was itself a mandatory-picture rule: it made "remove them all" impossible. The
  // owner asked for no picture to be mandatory and confirmed the consequence, so
  // her explicit choice now outranks the default.
  it('respects the owner hiding everything — no shipped render is resurrected', () => {
    const map = {
      posttrip: {
        base: {
          store: { onProducts: false },
          front: { onProducts: false },
          back: { onProducts: false },
          board: { onProducts: false },
        },
      },
    };
    expect(galleryFor(map, BOARDED, 'products')).toEqual([]);
  });

  it('tolerates a garbage map and a design without an id', () => {
    expect(galleryFor(null, BOARDED, 'products').length).toBe(4);
    expect(galleryFor({ posttrip: 'nope' }, BOARDED, 'products').length).toBe(4);
    expect(galleryFor({}, {}, 'products')).toEqual([]); // no id → nothing
  });

  // NO PICTURE IS MANDATORY: the owner can take every picture off a surface,
  // store cover included, and she confirmed the consequence — that design's shop
  // tile carries no picture. An EMPTY gallery is therefore a legitimate answer,
  // not a bug, and the reader must return it plainly rather than resurrecting a
  // shipped render to fill the gap. products.html renders the tile's name, price
  // and link regardless and wires no carousel below two slides, so the tile
  // degrades to a caption instead of breaking.
  it('returns an empty gallery when the owner hid every picture on that surface', () => {
    const allOff = {
      posttrip: {
        base: {
          store: { onProducts: false, onProduct: false },
          front: { onProducts: false, onProduct: false },
          back: { onProducts: false, onProduct: false },
          board: { onProducts: false, onProduct: false },
        },
      },
    };
    expect(galleryFor(allOff, BOARDED, 'products')).toEqual([]);
    expect(galleryFor(allOff, BOARDED, 'product')).toEqual([]);
  });

  it('hiding a picture on ONE surface leaves the other surface untouched', () => {
    // The two flags are independent — removing the store cover from the shop grid
    // must not also strip the card renders from the detail page.
    const storeOff = { posttrip: { base: { store: { onProducts: false } } } };
    expect(keys(galleryFor(storeOff, BOARDED, 'products'))).toEqual(['front', 'back', 'board']);
    expect(keys(galleryFor(storeOff, BOARDED, 'product'))).toEqual(['front', 'back', 'board']);
  });
});

// The PHOTO CARD slide — the deck's 104th front, shown on the storefront with the
// generic Dugri fallback art. Only a PORTRAIT card-structure design renders one,
// and only once that art ships, so the slot behaves exactly like the board: present
// when the design ships the render (thumbs.photo) or the owner uploaded one, absent
// otherwise. No live design ships one yet, so today's gallery is unchanged.
describe('galleryFor — the photo-card slot', () => {
  const PORTRAIT = { id: 'grapefruit', thumbs: { front: 'f', back: 'b', photo: 'ph' } };

  it('sits between the card renders and the board', () => {
    const boarded = {
      id: 'grapefruit',
      thumbs: { front: 'f', back: 'b', photo: 'ph', board: 'g' },
    };
    expect(keys(galleryFor({}, boarded, 'products'))).toEqual([
      'store',
      'front',
      'back',
      'photo',
      'board',
    ]);
    expect(keys(galleryFor({}, PORTRAIT, 'product'))).toEqual(['front', 'back', 'photo']);
    expect(galleryFor({}, PORTRAIT, 'product').find((i) => i.key === 'photo')).toMatchObject({
      src: baseSrc('grapefruit', 'photo'),
      fallback: baseSrc('grapefruit', 'photo'),
      droppable: false,
    });
  });

  it('is absent for a design that ships no photo card (every design today)', () => {
    expect(keys(galleryFor({}, BOARDED, 'product'))).not.toContain('photo');
    expect(keys(galleryFor({}, BOARDLESS, 'products'))).not.toContain('photo');
  });

  it('is surfaced by an owner override alone, tagged droppable (no shipped render)', () => {
    const map = { posttrip: { base: { photo: { img: P1 } } } };
    const photo = galleryFor(map, BOARDED, 'product').find((i) => i.key === 'photo');
    expect(photo).toMatchObject({ src: P1, fallback: '', droppable: true });
  });

  it('ignores an off-origin photo override rather than surfacing a bogus slide', () => {
    const map = { posttrip: { base: { photo: { img: 'https://evil.example/x.png' } } } };
    expect(keys(galleryFor(map, BOARDED, 'product'))).not.toContain('photo');
  });

  it('honours the owner hiding it per surface', () => {
    const map = { grapefruit: { base: { photo: { onProduct: false } } } };
    expect(keys(galleryFor(map, PORTRAIT, 'product'))).toEqual(['front', 'back']);
    expect(keys(galleryFor(map, PORTRAIT, 'products'))).toContain('photo');
  });
});

// A CUSTOM design is an uploaded template turned product: no committed rasters at
// all, its shipped renders ARE the template's own SVGs (loadCustomDesigns puts them
// on `img`). It goes through the SAME resolver as a built-in design, so the owner
// can curate its gallery in the admin exactly like any other design — which used to
// be impossible: the storefront read a custom design's pictures straight off `img`
// and ignored the curated config entirely.
describe('galleryFor — a CUSTOM design (uploaded template)', () => {
  const TPL = {
    id: 'grapefruit',
    custom: true,
    img: {
      front: '/api/template-image/grapefruit/front',
      back: '/api/template-image/grapefruit/back',
      board: '/api/template-image/grapefruit/board',
    },
  };

  it('shows the template SVGs as its shipped gallery, in the normal slot order', () => {
    const items = galleryFor({}, TPL, 'products');
    expect(keys(items)).toEqual(['front', 'back', 'board']);
    expect(srcs(items)).toEqual([TPL.img.front, TPL.img.back, TPL.img.board]);
    // Each falls back to itself (the template SVG is the shipped render).
    expect(items.every((i) => i.fallback === i.src && !i.droppable)).toBe(true);
    expect(keys(galleryFor({}, TPL, 'product'))).toEqual(['front', 'back', 'board']);
  });

  it('never invents committed rasters for it (no assets/designs/<id>/ paths)', () => {
    const all = [...galleryFor({}, TPL, 'products'), ...galleryFor({}, TPL, 'product')];
    expect(all.some((i) => i.src.includes('assets/designs/'))).toBe(false);
  });

  it('omits a slot the template has no art for', () => {
    const frontOnly = {
      id: 'x-tpl',
      custom: true,
      img: { front: '/api/template-image/x-tpl/front' },
    };
    expect(keys(galleryFor({}, frontOnly, 'products'))).toEqual(['front']);
  });

  it('honours an owner override, falling back to the template SVG', () => {
    const map = { grapefruit: { base: { front: { img: P1 } } } };
    const front = galleryFor(map, TPL, 'products').find((i) => i.key === 'front');
    expect(front).toMatchObject({ src: P1, fallback: TPL.img.front });
  });

  it('surfaces an uploaded store cover / extra photo it never shipped', () => {
    const map = {
      grapefruit: {
        base: { store: { img: P1 } },
        photos: [{ id: 'p1', img: P2, name: 'מהמסיבה', onProducts: true, onProduct: true }],
      },
    };
    const items = galleryFor(map, TPL, 'products');
    expect(keys(items)).toEqual(['store', 'front', 'back', 'board', 'p1']);
    // No shipped store render behind it → droppable rather than a 404 slide.
    expect(items[0]).toMatchObject({ src: P1, fallback: '', droppable: true });
    // The store cover still stays off the detail page by default.
    expect(keys(galleryFor(map, TPL, 'product'))).toEqual(['front', 'back', 'board', 'p1']);
  });

  it('honours per-surface hiding and the owner order', () => {
    const map = {
      grapefruit: { base: { board: { onProducts: false } }, order: ['back', 'front'] },
    };
    expect(keys(galleryFor(map, TPL, 'products'))).toEqual(['back', 'front']);
    expect(keys(galleryFor(map, TPL, 'product'))).toEqual(['back', 'front', 'board']);
  });

  // Same reversal as the built-in case above: an uploaded template's SVGs are its
  // shipped renders, and they are no more mandatory than a built-in's rasters.
  it('hiding everything leaves an uploaded template empty too — no SVG is resurrected', () => {
    const map = {
      grapefruit: {
        base: {
          front: { onProducts: false },
          back: { onProducts: false },
          board: { onProducts: false },
        },
      },
    };
    expect(galleryFor(map, TPL, 'products')).toEqual([]);
  });
});

describe('loadDesignImages — timeout-bounded + fail-safe (never rejects)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns the images map on a 200', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ images: { neon: { base: {} } } }) })
    );
    await expect(loadDesignImages()).resolves.toEqual({ neon: { base: {} } });
  });

  it('resolves to {} on a network error', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('down')));
    await expect(loadDesignImages()).resolves.toEqual({});
  });

  it('resolves to {} on a non-OK status', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    await expect(loadDesignImages()).resolves.toEqual({});
  });

  it('resolves to {} on a malformed body (no images object)', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: 1 }) })
    );
    await expect(loadDesignImages()).resolves.toEqual({});
  });
});
