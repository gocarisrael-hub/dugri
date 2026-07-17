// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Unit tests for the per-design product-image override store
// (server/design-images.js): design/slot validation, set/get/reset, the public
// full-map read, and atomic persistence round-trip. Mirrors the loadStore pattern
// in content-store.test.js. server/ is CommonJS, so a dynamic import resolves to
// module.exports on `.default`.

function freshTmpDir() {
  const dir = path.join(
    os.tmpdir(),
    `dugri-dimg-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}
async function loadStore(dir) {
  vi.resetModules();
  process.env.DATA_DIR = dir;
  return (await import('../../server/design-images.js')).default;
}

// Valid our-own upload paths (16-hex hash + raster ext) — the only shape allowed.
const P1 = '/content-uploads/aaaaaaaaaaaaaaaa.png';
const P2 = '/content-uploads/bbbbbbbbbbbbbbbb.webp';

describe('design-images store', () => {
  const dirs = [];
  const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
  afterEach(() => {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('validates design ids (alnum start, kebab) and the four slots', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(store.designOk('posttrip')).toBe('posttrip');
    expect(store.designOk('kids-2')).toBe('kids-2');
    expect(store.designOk('-bad')).toBe(null);
    expect(store.designOk('Bad Id')).toBe(null);
    expect(store.designOk('')).toBe(null);
    for (const s of ['store', 'board', 'front', 'back']) expect(store.slotOk(s)).toBe(s);
    expect(store.slotOk('cover')).toBe(null);
    expect(store.slotOk('')).toBe(null);
  });

  it('set stores an our-own upload path; get/getForDesign read it back; getAll reflects it', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    // Nothing set yet → public read is blank.
    expect(store.get('posttrip', 'board')).toBe(null);
    expect(store.getForDesign('posttrip')).toEqual({});
    expect(store.getAll()).toEqual({});

    expect(store.set('posttrip', 'board', P1)).toEqual({ board: P1 });
    expect(store.set('posttrip', 'store', P2)).toEqual({ board: P1, store: P2 });
    expect(store.get('posttrip', 'board')).toBe(P1);
    expect(store.get('posttrip', 'store')).toBe(P2);
    expect(store.getForDesign('posttrip')).toEqual({ board: P1, store: P2 });
    expect(store.getAll()).toEqual({ posttrip: { board: P1, store: P2 } });
  });

  it('accepts + returns a board override for a BOARDLESS design id (e.g. kids)', async () => {
    // Slots are NOT gated per-design server-side (board ∈ SLOTS), so a design that
    // ships no board (kids) can still carry a board override — this is what lets the
    // owner upload a board for it and the product page surface the slide.
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(store.get('kids', 'board')).toBe(null); // nothing yet
    expect(store.set('kids', 'board', P1)).toEqual({ board: P1 });
    expect(store.get('kids', 'board')).toBe(P1);
    expect(store.getForDesign('kids')).toEqual({ board: P1 });
    expect(store.getAll()).toEqual({ kids: { board: P1 } });
    // And it can be reset back like any other slot.
    expect(store.reset('kids', 'board')).toBe(true);
    expect(store.get('kids', 'board')).toBe(null);
    expect(store.getAll()).toEqual({});
  });

  it('set REJECTS an off-origin / malformed path and a bad design/slot (returns null, no write)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(store.set('posttrip', 'board', 'https://evil.example/x.png')).toBe(null);
    expect(store.set('posttrip', 'board', '/content-uploads/not-a-hash.png')).toBe(null);
    expect(store.set('posttrip', 'board', '/content-uploads/aaaaaaaaaaaaaaaa.gif')).toBe(null);
    expect(store.set('Bad Id', 'board', P1)).toBe(null);
    expect(store.set('posttrip', 'cover', P1)).toBe(null);
    expect(store.getAll()).toEqual({}); // nothing persisted
  });

  it('get returns null for a slot that was never set (fallback to static asset)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.set('posttrip', 'board', P1);
    expect(store.get('posttrip', 'front')).toBe(null); // unset slot
    expect(store.get('birthday', 'board')).toBe(null); // unset design
  });

  it('getForDesign returns a COPY (mutating it cannot corrupt the store)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.set('neon', 'store', P1);
    const got = store.getForDesign('neon');
    got.store = 'tampered';
    got.board = 'tampered';
    expect(store.getForDesign('neon')).toEqual({ store: P1 });
  });

  it('reset removes one slot, prunes an empty design bag, and is a no-op when already gone', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.set('posttrip', 'board', P1);
    store.set('posttrip', 'store', P2);
    expect(store.reset('posttrip', 'board')).toBe(true);
    expect(store.getForDesign('posttrip')).toEqual({ store: P2 });
    expect(store.reset('posttrip', 'store')).toBe(true);
    expect(store.getForDesign('posttrip')).toEqual({});
    expect(store.getAll()).toEqual({}); // design bag pruned when empty
    expect(store.reset('posttrip', 'store')).toBe(false); // already gone
    expect(store.reset('Bad Id', 'store')).toBe(false);
  });

  it('isImageReferenced finds a path in ANY design/slot (orphan-reclaim guard)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.set('posttrip', 'board', P1);
    store.set('birthday', 'store', P1); // same file, another slot (shared/content-addressed)
    store.set('neon', 'front', P2);
    expect(store.isImageReferenced(P1)).toBe(true);
    expect(store.isImageReferenced(P2)).toBe(true);
    expect(store.isImageReferenced('/content-uploads/cccccccccccccccc.jpg')).toBe(false);
    expect(store.isImageReferenced('')).toBe(false);
    // Reset ONE of the two slots that share P1 → still referenced by the other.
    store.reset('posttrip', 'board');
    expect(store.isImageReferenced(P1)).toBe(true);
    store.reset('birthday', 'store');
    expect(store.isImageReferenced(P1)).toBe(false); // last reference gone → reclaimable
  });

  it('persists overrides atomically and reloads them from disk (round-trip)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    let store = await loadStore(dir);
    expect(fs.existsSync(dir)).toBe(false); // DATA_DIR does not exist yet
    store.set('posttrip', 'board', P1);
    store.set('birthday', 'store', P2);

    const file = path.join(dir, 'design-images.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false); // no leftover temp

    // A fresh module instance (same DATA_DIR) loads what was persisted.
    store = await loadStore(dir);
    expect(store.get('posttrip', 'board')).toBe(P1);
    expect(store.get('birthday', 'store')).toBe(P2);
  });
});

const P3 = '/content-uploads/cccccccccccccccc.jpg';

describe('design-images store — per-design carousel array', () => {
  const dirs = [];
  const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
  afterEach(() => {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('appends our-own upload paths in order and getCarousel reads a COPY', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(store.getCarousel('birthday')).toEqual([]);
    expect(store.addCarouselImage('birthday', P1)).toEqual([P1]);
    expect(store.addCarouselImage('birthday', P2)).toEqual([P1, P2]);
    expect(store.getCarousel('birthday')).toEqual([P1, P2]);
    // Mutating the returned copy can't corrupt the store.
    const got = store.getCarousel('birthday');
    got.push('tampered');
    expect(store.getCarousel('birthday')).toEqual([P1, P2]);
  });

  it('dedupes an already-present path (no growth, order preserved)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.addCarouselImage('neon', P1);
    store.addCarouselImage('neon', P2);
    expect(store.addCarouselImage('neon', P1)).toEqual([P1, P2]); // dup ignored
    expect(store.getCarousel('neon')).toEqual([P1, P2]);
  });

  it('caps the carousel at CAROUSEL_CAP', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const cap = store.CAROUSEL_CAP;
    expect(cap).toBeGreaterThan(0);
    let last;
    for (let i = 0; i < cap + 4; i++) {
      const hex = i.toString(16).padStart(16, '0').slice(0, 16);
      last = store.addCarouselImage('kids', `/content-uploads/${hex}.png`);
    }
    expect(last.length).toBe(cap);
    expect(store.getCarousel('kids').length).toBe(cap);
  });

  it('rejects a bad design id / off-origin path (returns null, no write)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(store.addCarouselImage('Bad Id', P1)).toBe(null);
    expect(store.addCarouselImage('neon', 'https://evil.example/x.png')).toBe(null);
    expect(store.addCarouselImage('neon', '/content-uploads/not-a-hash.png')).toBe(null);
    expect(store.getAll()).toEqual({});
  });

  it('remove takes out one entry from ONLY that design; prunes an emptied carousel + bag', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.addCarouselImage('birthday', P1);
    store.addCarouselImage('birthday', P2);
    store.addCarouselImage('neon', P1); // same path, DIFFERENT design
    expect(store.removeCarouselImage('birthday', P1)).toEqual([P2]);
    expect(store.getCarousel('birthday')).toEqual([P2]); // only birthday's P1 gone
    expect(store.getCarousel('neon')).toEqual([P1]); // neon untouched
    // Removing the last entry prunes the carousel key AND the (otherwise empty) bag.
    expect(store.removeCarouselImage('birthday', P2)).toEqual([]);
    expect(store.getAll().birthday).toBeUndefined();
    // A no-op remove of an absent path returns the unchanged array.
    expect(store.removeCarouselImage('neon', P3)).toEqual([P1]);
    expect(store.removeCarouselImage('Bad Id', P1)).toBe(null); // bad design → null
  });

  it('carousel survives a per-slot reset (independent of the slot overrides)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.set('posttrip', 'store', P1);
    store.addCarouselImage('posttrip', P2);
    store.reset('posttrip', 'store'); // clears the slot only
    expect(store.get('posttrip', 'store')).toBe(null);
    expect(store.getCarousel('posttrip')).toEqual([P2]); // carousel kept
    expect(store.getAll().posttrip).toEqual({ carousel: [P2] }); // bag not pruned
  });

  it('isImageReferenced finds a path inside a carousel array (orphan-reclaim guard)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.addCarouselImage('birthday', P1);
    store.set('neon', 'store', P2); // slot path still detected too
    expect(store.isImageReferenced(P1)).toBe(true);
    expect(store.isImageReferenced(P2)).toBe(true);
    expect(store.isImageReferenced(P3)).toBe(false);
    store.removeCarouselImage('birthday', P1);
    expect(store.isImageReferenced(P1)).toBe(false); // last reference gone → reclaimable
  });

  it('persists the carousel array and reloads it from disk (round-trip)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    let store = await loadStore(dir);
    store.addCarouselImage('birthday', P1);
    store.addCarouselImage('birthday', P2);
    store = await loadStore(dir); // fresh instance, same DATA_DIR
    expect(store.getCarousel('birthday')).toEqual([P1, P2]);
  });

  it('getForDesign returns an INDEPENDENT carousel copy (mutating it cannot corrupt the store)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.set('birthday', 'store', P1);
    store.addCarouselImage('birthday', P2);
    store.addCarouselImage('birthday', P3);
    const got = store.getForDesign('birthday');
    expect(got).toEqual({ store: P1, carousel: [P2, P3] });
    // Mutating the returned object AND its nested carousel array must not leak back.
    got.store = 'tampered';
    got.carousel.push('tampered');
    got.carousel.sort();
    expect(store.getForDesign('birthday')).toEqual({ store: P1, carousel: [P2, P3] });
    expect(store.getCarousel('birthday')).toEqual([P2, P3]);
  });

  it('a no-op append (duplicate) does NOT rewrite the store file', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.addCarouselImage('neon', P1);
    const file = path.join(dir, 'design-images.json');
    const mtime1 = fs.statSync(file).mtimeMs;
    // A duplicate append returns the unchanged array WITHOUT touching disk.
    expect(store.addCarouselImage('neon', P1)).toEqual([P1]);
    const mtime2 = fs.statSync(file).mtimeMs;
    expect(mtime2).toBe(mtime1); // no serialize/tmp-write/rename happened
  });

  it('sanitizeCarousel keeps valid distinct paths, drops junk, caps length', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(
      store.sanitizeCarousel([P1, P2, P1, 'https://evil/x.png', '/content-uploads/x.png'])
    ).toEqual([P1, P2]);
    expect(store.sanitizeCarousel('nope')).toEqual([]);
  });
});
