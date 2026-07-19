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

  it('falls back to the shipped renders when the owner hid everything', () => {
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
    expect(keys(galleryFor(map, BOARDED, 'products'))).toEqual(['store', 'front', 'back', 'board']);
  });

  it('tolerates a garbage map and a design without an id', () => {
    expect(galleryFor(null, BOARDED, 'products').length).toBe(4);
    expect(galleryFor({ posttrip: 'nope' }, BOARDED, 'products').length).toBe(4);
    expect(galleryFor({}, {}, 'products')).toEqual([]); // no id → nothing
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
