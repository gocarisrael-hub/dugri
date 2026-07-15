// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Unit tests for the content-editor store (server/content.js): page/key
// sanitization, image magic-byte extension selection, and atomic persistence
// round-trip (mirrors how playbook-save.test.js exercises the playbook store).
// server/ is a CommonJS package, so a dynamic import resolves to module.exports
// on `.default`.

function freshTmpDir() {
  const dir = path.join(
    os.tmpdir(),
    `dugri-content-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

async function loadStore(dir) {
  vi.resetModules();
  process.env.DATA_DIR = dir;
  return (await import('../../server/content.js')).default;
}

// Minimal valid magic-byte headers for each accepted format.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.alloc(16),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe('content store', () => {
  const dirs = [];
  const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
  afterEach(() => {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('sanitizes page names to a safe basename .html (rejects paths/traversal/uppercase)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(store.pageOk('index.html')).toBe('index.html');
    expect(store.pageOk('a/b/collect.html')).toBe('collect.html'); // basename only
    expect(store.pageOk('../../etc/passwd')).toBe(null); // no .html
    expect(store.pageOk('../secret.html')).toBe('secret.html'); // traversal stripped to basename
    expect(store.pageOk('INDEX.HTML')).toBe(null); // uppercase rejected
    expect(store.pageOk('index.php')).toBe(null);
    expect(store.pageOk('')).toBe(null);
  });

  it('validates keys (alnum start, kebab, length cap)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(store.keyOk('index-hero-1')).toBe('index-hero-1');
    expect(store.keyOk('1abc')).toBe('1abc');
    expect(store.keyOk('-abc')).toBe(null); // must start alnum
    expect(store.keyOk('Bad Key')).toBe(null); // no spaces/uppercase
    expect(store.keyOk('a'.repeat(62))).toBe(null); // over the length cap
  });

  it('picks the extension from magic bytes, not any client name', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(store.extFromMagic(PNG)).toBe('.png');
    expect(store.extFromMagic(JPG)).toBe('.jpg');
    expect(store.extFromMagic(WEBP)).toBe('.webp');
    expect(store.extFromMagic(Buffer.from('not an image at all!!'))).toBe(null);
  });

  it('REJECTS svg uploads (stored-XSS surface): raster formats only', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    // An SVG can carry <script> and would be served from our origin, so it must
    // never be accepted — extFromMagic returns null and saveImageBytes throws.
    expect(store.extFromMagic(SVG)).toBe(null);
    const xmlSvg = Buffer.from('<?xml version="1.0"?><svg onload="alert(1)"></svg>');
    expect(store.extFromMagic(xmlSvg)).toBe(null);
    expect(() => store.saveImageBytes(SVG)).toThrow(/unsupported/);
  });

  it('saves image bytes under a content-hash name + sniffed ext, de-dupes, and serves back', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const first = store.saveImageBytes(PNG);
    expect(first.path).toMatch(/^\/content-uploads\/[a-f0-9]{16}\.png$/);
    expect(first.created).toBe(true); // this call actually wrote the file
    // identical bytes -> identical name (content-addressed de-dupe), and no re-write
    const again = store.saveImageBytes(PNG);
    expect(again.path).toBe(first.path);
    expect(again.created).toBe(false); // already on disk → not created again
    // the file really landed on disk under DATA_DIR/content-uploads
    const onDisk = path.join(dir, 'content-uploads', first.path.split('/').pop());
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk).equals(PNG)).toBe(true);
    // a different format gets a .jpg name
    expect(store.saveImageBytes(JPG).path).toMatch(/\.jpg$/);
  });

  it('rejects oversized and unrecognized image uploads', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(() => store.saveImageBytes(Buffer.from('nope'))).toThrow(/unsupported/);
    const huge = Buffer.concat([PNG, Buffer.alloc(store.IMAGE_CAP + 1)]);
    expect(() => store.saveImageBytes(huge)).toThrow(/too large/);
    expect(() => store.saveImageBytes(Buffer.alloc(0))).toThrow(/empty/);
  });

  it('persists text overrides atomically and reloads them from disk (round-trip)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    let store = await loadStore(dir);
    expect(fs.existsSync(dir)).toBe(false); // DATA_DIR does not exist yet
    store.setText('index.html', 'index-hero-1-title', 'שלום עולם');
    store.setImg('index.html', 'index-hero-1', '/content-uploads/deadbeefdeadbeef.png');

    // The atomic write created the dir + file (no ENOENT), no leftover temp.
    const file = path.join(dir, 'content-overrides.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);

    // A fresh module instance (same DATA_DIR) loads what was persisted.
    store = await loadStore(dir);
    const page = store.getPage('index.html');
    expect(page['index-hero-1-title'].text).toBe('שלום עולם');
    expect(page['index-hero-1'].img).toBe('/content-uploads/deadbeefdeadbeef.png');
  });

  it('caps text length, allows blanking, and returns {} for unknown pages', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.setText('index.html', 'k', 'x'.repeat(6000));
    expect(store.getPage('index.html').k.text).toHaveLength(store.TEXT_CAP);
    store.setText('index.html', 'k', ''); // empty string is a valid blank
    expect(store.getPage('index.html').k.text).toBe('');
    expect(store.getPage('nope.php')).toEqual({});
    // a bad page/key write is a no-op (returns null)
    expect(store.setText('bad page', 'k', 'v')).toBe(null);
    expect(store.setText('index.html', 'Bad Key', 'v')).toBe(null);
  });

  it('remove() reverts to the default and prunes an empty page bag', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.setText('how.html', 'how-hero-heading', 'חדש');
    expect(store.remove('how.html', 'how-hero-heading')).toBe(true);
    expect(store.getPage('how.html')).toEqual({}); // pruned
    expect(store.remove('how.html', 'how-hero-heading')).toBe(false); // already gone
  });
});

// Two valid our-own upload paths (16-hex hash + raster ext).
const P1 = '/content-uploads/aaaaaaaaaaaaaaaa.png';
const P2 = '/content-uploads/bbbbbbbbbbbbbbbb.webp';
const P3 = '/content-uploads/cccccccccccccccc.jpg';

describe('content store — per-key photo array (a product carousel)', () => {
  const dirs = [];
  const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
  afterEach(() => {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('sanitizePhotos keeps only distinct our-own upload paths, in order, capped', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    // arbitrary URLs, off-origin paths and dupes are dropped; order preserved.
    expect(
      store.sanitizePhotos([P2, 'https://evil.example/x.png', P1, P2, '/content-uploads/nope.gif'])
    ).toEqual([P2, P1]);
    expect(store.sanitizePhotos('not an array')).toEqual([]);
    // capped at PHOTO_CAP
    const many = Array.from(
      { length: store.PHOTO_CAP + 5 },
      (_, i) => `/content-uploads/${String(i).padStart(16, '0')}.png`
    );
    expect(store.sanitizePhotos(many)).toHaveLength(store.PHOTO_CAP);
  });

  it('addPhoto appends (deduped, validated) and getPhotos returns a copy', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    expect(store.getPhotos('product.html', 'product-neon-photos')).toEqual([]);
    expect(store.addPhoto('product.html', 'product-neon-photos', P1)).toEqual([P1]);
    expect(store.addPhoto('product.html', 'product-neon-photos', P2)).toEqual([P1, P2]);
    // a duplicate is a no-op-append that still returns the current array
    expect(store.addPhoto('product.html', 'product-neon-photos', P1)).toEqual([P1, P2]);
    // an off-origin/garbage path is rejected (null), array untouched
    expect(store.addPhoto('product.html', 'product-neon-photos', 'https://x/y.png')).toBe(null);
    expect(store.getPhotos('product.html', 'product-neon-photos')).toEqual([P1, P2]);
    // getPhotos returns a copy — mutating it can't corrupt the store
    const got = store.getPhotos('product.html', 'product-neon-photos');
    got.push(P3);
    expect(store.getPhotos('product.html', 'product-neon-photos')).toEqual([P1, P2]);
  });

  it('setPhotos replaces the whole array (remove + reorder), sanitized', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.addPhoto('product.html', 'product-kids-photos', P1);
    store.addPhoto('product.html', 'product-kids-photos', P2);
    // reorder + drop garbage in one PUT
    expect(store.setPhotos('product.html', 'product-kids-photos', [P2, P1, 'bad'])).toEqual([
      P2,
      P1,
    ]);
    // empty array is valid (client then falls back to the shipped defaults)
    expect(store.setPhotos('product.html', 'product-kids-photos', [])).toEqual([]);
    expect(store.getPhotos('product.html', 'product-kids-photos')).toEqual([]);
    // bad page/key → null (no write)
    expect(store.setPhotos('bad page', 'k', [P1])).toBe(null);
    expect(store.addPhoto('product.html', 'Bad Key', P1)).toBe(null);
  });

  it('drops an append at the cap / a duplicate, and orphan cleanup is reference-safe', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    // Fill a key to PHOTO_CAP with real (content-hashed) uploads.
    const paths = [];
    for (let i = 0; i < store.PHOTO_CAP; i++) {
      const bytes = Buffer.concat([PNG, Buffer.from([i])]); // distinct bytes → distinct hash
      paths.push(store.saveImageBytes(bytes).path);
    }
    for (const p of paths) store.addPhoto('product.html', 'product-neon-photos', p);
    expect(store.getPhotos('product.html', 'product-neon-photos')).toHaveLength(store.PHOTO_CAP);

    // A NEW upload beyond the cap: the file is written, but addPhoto drops it (the
    // array does not grow) → the route treats it as a drop and reclaims the orphan.
    const overflow = store.saveImageBytes(Buffer.concat([PNG, Buffer.from([99])])).path;
    const before = store.getPhotos('product.html', 'product-neon-photos');
    const after = store.addPhoto('product.html', 'product-neon-photos', overflow);
    expect(after.length).toBe(before.length); // dropped (still at cap)
    expect(after).not.toContain(overflow);
    // The overflow file is unreferenced anywhere → safe to delete (orphan cleanup).
    expect(store.isImageReferenced(overflow)).toBe(false);
    const onDisk = path.join(dir, 'content-uploads', overflow.split('/').pop());
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(store.deleteUpload(overflow)).toBe(true);
    expect(fs.existsSync(onDisk)).toBe(false);

    // A DUPLICATE upload (same bytes → same content-hash as an existing entry) is
    // also dropped, but its file MUST be kept — it is still referenced in the array.
    const dupBytes = Buffer.concat([PNG, Buffer.from([0])]); // same as paths[0]
    const dupPath = store.saveImageBytes(dupBytes).path;
    expect(dupPath).toBe(paths[0]); // content-addressed → same path
    const afterDup = store.addPhoto('product.html', 'product-neon-photos', dupPath);
    expect(afterDup.length).toBe(store.PHOTO_CAP); // no growth (already present)
    expect(store.isImageReferenced(dupPath)).toBe(true); // still in use → never delete
    expect(fs.existsSync(path.join(dir, 'content-uploads', dupPath.split('/').pop()))).toBe(true);
  });

  it('isImageReferenced finds single-img and array references; deleteUpload validates the name', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.setImg('index.html', 'index-hero-1', P1); // single-image override
    store.addPhoto('product.html', 'product-kids-photos', P2); // array override
    expect(store.isImageReferenced(P1)).toBe(true);
    expect(store.isImageReferenced(P2)).toBe(true);
    expect(store.isImageReferenced(P3)).toBe(false);
    // deleteUpload only touches valid hash+ext names (no traversal / arbitrary path)
    expect(store.deleteUpload('/content-uploads/not-a-hash.png')).toBe(false);
    expect(store.deleteUpload('../../etc/passwd')).toBe(false);
  });

  it('persists a photo array atomically and reloads it from disk (round-trip)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    let store = await loadStore(dir);
    store.addPhoto('product.html', 'product-birthday-photos', P1);
    store.addPhoto('product.html', 'product-birthday-photos', P2);
    const file = path.join(dir, 'content-overrides.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    // a fresh module instance (same DATA_DIR) loads the persisted array
    store = await loadStore(dir);
    expect(store.getPage('product.html')['product-birthday-photos'].imgs).toEqual([P1, P2]);
    // remove() reverts that carousel entirely (back to the shipped defaults)
    store.remove('product.html', 'product-birthday-photos');
    expect(store.getPhotos('product.html', 'product-birthday-photos')).toEqual([]);
  });
});

// Full-store mirror helpers used by the cross-service import: replaceAll must never
// let memory diverge from disk on a persist failure, and backup() must not let old
// backups pile up on the volume forever.
describe('content store — full-store mirror (import support)', () => {
  const dirs = [];
  const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('replaceAll rolls memory back to the OLD store when the commit save() fails (no memory/disk divergence)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    // Seed OLD content and let it persist cleanly.
    store.setText('index.html', 'hero', 'תוכן ישן');
    const file = path.join(dir, 'content-overrides.json');
    const oldDisk = fs.readFileSync(file, 'utf8');

    // Make the NEXT overrides persist (the replaceAll commit) fail, as a full volume
    // would — but only the content-overrides write, so nothing else is disturbed.
    const realWrite = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p, ...rest) => {
      if (String(p).includes('content-overrides.json')) {
        throw new Error('ENOSPC: no space left on device');
      }
      return realWrite(p, ...rest);
    });

    const staging = { 'about.html': { 'about-title': { text: 'סטייג׳ינג' } } };
    expect(() => store.replaceAll(staging)).toThrow(/ENOSPC/);

    // Memory rolled back to the OLD content (NOT the staging mirror) …
    expect(store.getAll()).toEqual({ 'index.html': { hero: { text: 'תוכן ישן' } } });
    expect(store.getPage('index.html').hero.text).toBe('תוכן ישן');
    expect(store.getPage('about.html')).toEqual({});
    // … and disk is byte-for-byte the OLD content (never overwritten).
    vi.restoreAllMocks();
    expect(fs.readFileSync(file, 'utf8')).toBe(oldDisk);
  });

  it('backup() prunes old backups, keeping only the most recent 10', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    store.setText('index.html', 'hero', 'x'); // create the overrides file to back up

    // Drive 15 backups with strictly increasing timestamps (a real Date.now() could
    // collide within one millisecond and overwrite same-named files).
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++t);
    const made = [];
    for (let i = 0; i < 15; i++) made.push(store.backup());
    vi.restoreAllMocks();

    const remaining = fs
      .readdirSync(dir)
      .filter((n) => /^content-overrides\.backup-\d+\.json$/.test(n));
    expect(remaining).toHaveLength(10); // capped at BACKUP_KEEP

    // The 10 kept are the NEWEST; the 5 oldest were pruned.
    const kept = new Set(remaining.map((n) => path.join(dir, n)));
    for (const p of made.slice(0, 5)) expect(kept.has(p)).toBe(false); // 5 oldest gone
    for (const p of made.slice(5)) expect(kept.has(p)).toBe(true); // 10 newest kept
  });
});
