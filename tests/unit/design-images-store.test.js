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
