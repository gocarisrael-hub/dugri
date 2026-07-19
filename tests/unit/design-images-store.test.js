// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Unit tests for the per-design GALLERY store (server/design-images.js): design/
// slot validation, base-slot override set/reset, per-surface visibility flags,
// extra named photos (add/update/remove), ordering, the reclaim guard, and atomic
// persistence round-trip. server/ is CommonJS, so a dynamic import resolves to
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
const P3 = '/content-uploads/cccccccccccccccc.jpg';

describe('design-images gallery store', () => {
  const dirs = [];
  const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
  afterEach(() => {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  async function store() {
    const dir = freshTmpDir();
    dirs.push(dir);
    return loadStore(dir);
  }

  it('validates design ids (alnum start, kebab) and the four base slots', async () => {
    const s = await store();
    expect(s.designOk('posttrip')).toBe('posttrip');
    expect(s.designOk('kids-2')).toBe('kids-2');
    expect(s.designOk('-bad')).toBe(null);
    expect(s.designOk('Bad Id')).toBe(null);
    expect(s.designOk('')).toBe(null);
    for (const slot of ['store', 'front', 'back', 'board']) expect(s.slotOk(slot)).toBe(slot);
    expect(s.slotOk('cover')).toBe(null);
    expect(s.slotOk('')).toBe(null);
  });

  it('setBaseImg stores an our-own upload path; getForDesign/getAll reflect it', async () => {
    const s = await store();
    expect(s.getForDesign('posttrip')).toEqual({});
    expect(s.getAll()).toEqual({});

    expect(s.setBaseImg('posttrip', 'board', P1)).toEqual({ ok: true, prev: null });
    expect(s.getForDesign('posttrip')).toEqual({ base: { board: { img: P1 } } });
    // Replacing returns the displaced path so the route can reclaim it.
    expect(s.setBaseImg('posttrip', 'board', P2)).toEqual({ ok: true, prev: P1 });
    expect(s.getForDesign('posttrip')).toEqual({ base: { board: { img: P2 } } });
    expect(s.getAll()).toEqual({ posttrip: { base: { board: { img: P2 } } } });
  });

  it('setBaseImg REJECTS off-origin / malformed paths and bad design/slot (no write)', async () => {
    const s = await store();
    expect(s.setBaseImg('posttrip', 'board', 'https://evil.example/x.png')).toEqual({
      ok: false,
      prev: null,
    });
    expect(s.setBaseImg('posttrip', 'board', '/content-uploads/not-a-hash.png').ok).toBe(false);
    expect(s.setBaseImg('posttrip', 'board', '/content-uploads/aaaaaaaaaaaaaaaa.gif').ok).toBe(
      false
    );
    expect(s.setBaseImg('Bad Id', 'board', P1).ok).toBe(false);
    expect(s.setBaseImg('posttrip', 'cover', P1).ok).toBe(false);
    expect(s.getAll()).toEqual({});
  });

  it('resetBaseImg clears only the override img, prunes an empty bag, no-op when gone', async () => {
    const s = await store();
    s.setBaseImg('posttrip', 'board', P1);
    expect(s.resetBaseImg('posttrip', 'board')).toEqual({ ok: true, prev: P1 });
    expect(s.getForDesign('posttrip')).toEqual({});
    expect(s.getAll()).toEqual({}); // pruned
    expect(s.resetBaseImg('posttrip', 'board')).toEqual({ ok: false, prev: null });
  });

  it('setBaseFlags stores only DEVIATIONS from the slot default', async () => {
    const s = await store();
    s.setBaseFlags('neon', 'store', { onProducts: false });
    expect(s.getForDesign('neon')).toEqual({ base: { store: { onProducts: false } } });
    // Re-enabling clears the deviation and prunes the bag.
    s.setBaseFlags('neon', 'store', { onProducts: true });
    expect(s.getAll()).toEqual({});
    // store is hidden on the product page BY DEFAULT: onProduct:false stores nothing,
    // while opting it IN (onProduct:true) is the deviation that persists.
    s.setBaseFlags('neon', 'store', { onProduct: false });
    expect(s.getAll()).toEqual({});
    s.setBaseFlags('neon', 'store', { onProduct: true });
    expect(s.getForDesign('neon')).toEqual({ base: { store: { onProduct: true } } });
    // A hide + an override img coexist on the same slot (front hidden on product page).
    s.setBaseImg('neon', 'front', P1);
    s.setBaseFlags('neon', 'front', { onProduct: false });
    expect(s.getForDesign('neon').base.front).toEqual({ img: P1, onProduct: false });
  });

  it('addPhoto appends a named extra photo with default-on visibility and a stable id', async () => {
    const s = await store();
    const a = s.addPhoto('posttrip', P1, '  וריאציה ראשונה  ');
    expect(a).toMatchObject({
      id: 'p1',
      img: P1,
      name: 'וריאציה ראשונה',
      onProducts: true,
      onProduct: true,
    });
    const b = s.addPhoto('posttrip', P2, '');
    expect(b.id).toBe('p2');
    expect(s.getForDesign('posttrip').photos.map((p) => p.id)).toEqual(['p1', 'p2']);
    // Bad design / path → null, no write.
    expect(s.addPhoto('Bad Id', P3)).toBe(null);
    expect(s.addPhoto('posttrip', 'https://evil/x.png')).toBe(null);
  });

  it('updatePhoto patches name + visibility; removePhoto returns the freed path', async () => {
    const s = await store();
    const a = s.addPhoto('posttrip', P1, 'first');
    const up = s.updatePhoto('posttrip', a.id, { name: 'renamed', onProducts: false });
    expect(up).toMatchObject({ id: a.id, name: 'renamed', onProducts: false, onProduct: true });
    expect(s.updatePhoto('posttrip', 'nope', { name: 'x' })).toBe(null);
    expect(s.removePhoto('posttrip', a.id)).toBe(P1);
    expect(s.getForDesign('posttrip')).toEqual({});
    expect(s.removePhoto('posttrip', a.id)).toBe(null);
  });

  it('setOrder keeps only known keys (base slots + photo ids), dedups, and prunes empty', async () => {
    const s = await store();
    const a = s.addPhoto('posttrip', P1, 'x');
    const out = s.setOrder('posttrip', ['board', a.id, 'front', 'bogus', 'board', 'store']);
    expect(out).toEqual(['board', a.id, 'front', 'store']);
    expect(s.getForDesign('posttrip').order).toEqual(['board', a.id, 'front', 'store']);
    // Removing the photo drops it from the order too.
    s.removePhoto('posttrip', a.id);
    expect(s.getForDesign('posttrip').order).toEqual(['board', 'front', 'store']);
    // An empty order prunes.
    s.setOrder('posttrip', []);
    expect(s.getAll()).toEqual({});
  });

  it('isImageReferenced finds a path in any base override OR extra photo', async () => {
    const s = await store();
    s.setBaseImg('posttrip', 'board', P1);
    s.addPhoto('birthday', P1, 'shared'); // same file, another design (content-addressed)
    s.addPhoto('neon', P2, 'y');
    expect(s.isImageReferenced(P1)).toBe(true);
    expect(s.isImageReferenced(P2)).toBe(true);
    expect(s.isImageReferenced(P3)).toBe(false);
    expect(s.isImageReferenced('')).toBe(false);
    // Reset ONE of the two references to P1 → still referenced by the other.
    s.resetBaseImg('posttrip', 'board');
    expect(s.isImageReferenced(P1)).toBe(true);
  });

  it('getForDesign returns a deep COPY (mutating it cannot corrupt the store)', async () => {
    const s = await store();
    s.addPhoto('neon', P1, 'a');
    const got = s.getForDesign('neon');
    got.photos[0].name = 'tampered';
    got.photos.push({ id: 'pX' });
    expect(s.getForDesign('neon').photos).toEqual([
      { id: 'p1', img: P1, name: 'a', onProducts: true, onProduct: true },
    ]);
  });

  it('persists atomically and reloads from disk (round-trip)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    let s = await loadStore(dir);
    expect(fs.existsSync(dir)).toBe(false);
    s.setBaseImg('posttrip', 'board', P1);
    s.addPhoto('birthday', P2, 'named');

    const file = path.join(dir, 'design-images.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);

    s = await loadStore(dir);
    expect(s.getForDesign('posttrip')).toEqual({ base: { board: { img: P1 } } });
    expect(s.getForDesign('birthday').photos[0]).toMatchObject({ img: P2, name: 'named' });
  });

  it('sanitizes a corrupt / hand-edited file on load (drops garbage, keeps valid)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'design-images.json'),
      JSON.stringify({
        'Bad Id': { base: { front: { img: P1 } } }, // bad design id → dropped
        posttrip: {
          base: { front: { img: P1 }, cover: { img: P2 } }, // 'cover' not a slot → dropped
          photos: [
            { id: 'p1', img: P2, name: 'ok' },
            { id: 'bad', img: P3 }, // bad id shape → dropped
            { id: 'p2', img: 'https://evil/x.png' }, // off-origin → dropped
          ],
          order: ['front', 'p1', 'ghost'], // unknown key dropped
        },
      }),
      'utf8'
    );
    const s = await loadStore(dir);
    expect(s.getAll()).toEqual({
      posttrip: {
        base: { front: { img: P1 } },
        photos: [{ id: 'p1', img: P2, name: 'ok', onProducts: true, onProduct: true }],
        order: ['front', 'p1'],
      },
    });
  });
});
