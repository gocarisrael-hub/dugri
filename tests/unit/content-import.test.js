// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Unit tests for the cross-service content import (server/content-import.js): given
// a MOCK staging overrides payload + MOCK image bytes (fetch stubbed), the prod store
// ends up MIRRORING staging (fields + images present, paths valid), a backup is
// written before the overwrite, and the refusals (missing STAGING_URL / self-import /
// staging error) never touch the live store. server/ is CommonJS, so a dynamic import
// resolves module.exports on `.default` (same pattern as content-store.test.js).

function freshTmpDir() {
  const dir = path.join(
    os.tmpdir(),
    `dugri-import-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

async function loadStore(dir) {
  vi.resetModules();
  process.env.DATA_DIR = dir;
  return (await import('../../server/content.js')).default;
}
async function loadImport() {
  return (await import('../../server/content-import.js')).default;
}

// Minimal valid PNG bytes + a distinguishing tail, and the content-addressed path
// content.saveImageBytes would produce for them (sha256[:16] + .png).
function pngWith(tag) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(String(tag)),
  ]);
}
function pathFor(buf) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  return '/content-uploads/' + hash + '.png';
}

// A stubbed fetch: the /api/admin/content/all URL returns { overrides }; a
// /content-uploads/<name> URL returns the matching bytes as an arrayBuffer; anything
// else 404s. `calls` records every requested URL.
function makeFetch(overrides, imageByPath, calls) {
  return async (url) => {
    if (calls) calls.push(url);
    if (url.includes('/api/admin/content/all')) {
      return { ok: true, status: 200, json: async () => ({ overrides }) };
    }
    for (const p of Object.keys(imageByPath || {})) {
      if (url.endsWith(p)) {
        const buf = imageByPath[p];
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(buf).buffer };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
}

describe('content import from staging', () => {
  const dirs = [];
  const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
  afterEach(() => {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('mirrors staging: fields + images land, paths stay valid, old prod content is replaced, backup written', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const imp = await loadImport();

    // Seed the LIVE (prod) store with content that staging does NOT have, so we can
    // prove the import MIRRORS (replaces), not merges — and that a backup captures it.
    store.setText('how.html', 'how-old-heading', 'תוכן ישן של פרוד');

    // A mock staging store: text + a single-image override + a photo array, both
    // referencing one content-addressed image the stubbed fetch will serve.
    const png = pngWith('staging-image-A');
    const imgPath = pathFor(png);
    const overrides = {
      'index.html': {
        'index-hero-title': { text: 'כותרת מהסטייג׳ינג' },
        'index-hero-bg': { img: imgPath },
      },
      'product.html': {
        'product-neon-photos': { imgs: [imgPath] },
      },
    };

    const calls = [];
    const result = await imp.importFromStaging({
      stagingUrl: 'https://staging.example/',
      ownOrigins: ['https://prod.example'],
      adminKey: 'STAGEKEY',
      fetchImpl: makeFetch(overrides, { [imgPath]: png }, calls),
      content: store,
    });

    expect(result.ok).toBe(true);
    expect(result.pages).toBe(2);
    expect(result.fields).toBe(3); // 2 keys on index + 1 on product
    expect(result.images).toBe(1); // one distinct image, de-duped across refs

    // The overrides fetch carried the staging admin key.
    expect(calls.some((u) => u.includes('/api/admin/content/all?key=STAGEKEY'))).toBe(true);

    // The store now MIRRORS staging …
    expect(store.getPage('index.html')['index-hero-title'].text).toBe('כותרת מהסטייג׳ינג');
    expect(store.getPage('index.html')['index-hero-bg'].img).toBe(imgPath);
    expect(store.getPhotos('product.html', 'product-neon-photos')).toEqual([imgPath]);
    // … and the OLD prod-only content is gone (replaced, not merged).
    expect(store.getPage('how.html')).toEqual({});

    // The referenced image was re-saved on disk at the SAME content-addressed path.
    const onDisk = path.join(dir, 'content-uploads', imgPath.split('/').pop());
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk).equals(png)).toBe(true);

    // A backup was written BEFORE the overwrite, and it holds the OLD prod content.
    expect(result.backup).toBeTruthy();
    expect(fs.existsSync(result.backup)).toBe(true);
    const backedUp = JSON.parse(fs.readFileSync(result.backup, 'utf8'));
    expect(backedUp['how.html']['how-old-heading'].text).toBe('תוכן ישן של פרוד');
  });

  it('refuses a missing STAGING_URL without touching the store', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const imp = await loadImport();
    store.setText('index.html', 'k', 'keepme');

    const result = await imp.importFromStaging({
      stagingUrl: '',
      ownOrigins: ['https://prod.example'],
      content: store,
      fetchImpl: () => {
        throw new Error('should not fetch when STAGING_URL is unset');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/STAGING_URL/);
    expect(store.getPage('index.html').k.text).toBe('keepme'); // untouched
  });

  it('refuses a self-import (STAGING_URL == own origin) without touching the store', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const imp = await loadImport();
    store.setText('index.html', 'k', 'keepme');

    const result = await imp.importFromStaging({
      // trailing slash + case must not defeat the self-origin check
      stagingUrl: 'https://PROD.example/',
      ownOrigins: ['https://prod.example'],
      adminKey: 'x',
      content: store,
      fetchImpl: () => {
        throw new Error('should not fetch on a self-import');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/self-import/i);
    expect(store.getPage('index.html').k.text).toBe('keepme'); // untouched
  });

  it('fails soft on a non-200 from staging and leaves the live store intact', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const imp = await loadImport();
    store.setText('index.html', 'k', 'keepme');

    const result = await imp.importFromStaging({
      stagingUrl: 'https://staging.example',
      ownOrigins: ['https://prod.example'],
      adminKey: 'x',
      content: store,
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(store.getPage('index.html').k.text).toBe('keepme'); // untouched
  });

  it('fails soft when a referenced staging image cannot be fetched (store untouched)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const imp = await loadImport();
    store.setText('index.html', 'k', 'keepme');

    const png = pngWith('missing-on-staging');
    const overrides = { 'index.html': { 'index-hero-bg': { img: pathFor(png) } } };
    const result = await imp.importFromStaging({
      stagingUrl: 'https://staging.example',
      ownOrigins: ['https://prod.example'],
      adminKey: 'x',
      content: store,
      // overrides resolve, but the image 404s → abort before any overwrite
      fetchImpl: makeFetch(overrides, {}, null),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    // The live store was NOT replaced (the missing staging text never landed).
    expect(store.getPage('index.html').k.text).toBe('keepme');
    expect(store.getPage('index.html')['index-hero-bg']).toBeUndefined();
  });

  it('REFUSES an empty staging store (a reset staging volume must never wipe prod)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const imp = await loadImport();
    // Prod has real content; staging's overrides come back EMPTY (e.g. its volume was
    // reset on redeploy → getAll() returns {}). Mirroring {} would wipe every prod
    // text + image — so the import must refuse and leave prod untouched.
    store.setText('index.html', 'hero', 'תוכן אמיתי');
    store.setImg('index.html', 'hero-bg', '/content-uploads/aaaaaaaaaaaaaaaa.png');

    const result = await imp.importFromStaging({
      stagingUrl: 'https://staging.example',
      ownOrigins: ['https://prod.example'],
      adminKey: 'x',
      content: store,
      fetchImpl: makeFetch({}, {}, null), // /all → { overrides: {} }
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/no content to import/i);
    // Prod is exactly as it was — nothing overwritten.
    expect(store.getPage('index.html').hero.text).toBe('תוכן אמיתי');
    expect(store.getPage('index.html')['hero-bg'].img).toBe(
      '/content-uploads/aaaaaaaaaaaaaaaa.png'
    );
  });

  it('ABORTS when the backup FAILS and prod had content (never overwrite without a recovery point)', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const imp = await loadImport();
    // Prod already has content → an overrides file exists on disk, so backup() would
    // normally copy it. Simulate a real backup failure (full/failing volume) by making
    // backup() throw. The import must abort WITHOUT overwriting, and leave no image
    // orphan behind (the staging image it fetched before the backup step is reclaimed).
    store.setText('index.html', 'k', 'keepme');
    const png = pngWith('image-fetched-before-backup');
    const imgPath = pathFor(png);
    const overrides = { 'index.html': { 'index-hero-bg': { img: imgPath } } };

    const contentWithBadBackup = Object.assign({}, store, {
      backup() {
        throw new Error('ENOSPC: no space left on device');
      },
    });

    const result = await imp.importFromStaging({
      stagingUrl: 'https://staging.example',
      ownOrigins: ['https://prod.example'],
      adminKey: 'x',
      content: contentWithBadBackup,
      fetchImpl: makeFetch(overrides, { [imgPath]: png }, null),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toMatch(/back ?up/i);
    // Prod store untouched (not overwritten with staging's single override) …
    expect(store.getPage('index.html').k.text).toBe('keepme');
    expect(store.getPage('index.html')['index-hero-bg']).toBeUndefined();
    // … and the image fetched before the backup step was cleaned back off the volume.
    const onDisk = path.join(dir, 'content-uploads', imgPath.split('/').pop());
    expect(fs.existsSync(onDisk)).toBe(false);
  });

  it('leaves NO orphan image on the volume when a mid-import image fetch fails', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const imp = await loadImport();
    store.setText('index.html', 'k', 'keepme');

    // Two distinct images: staging serves the first, 404s the second. The first is
    // saved to the volume during the (concurrent) fetch; when the second fails the
    // import aborts — and the already-written first image must be reclaimed so the
    // volume ends exactly as it started (no orphan).
    const good = pngWith('served-ok');
    const bad = pngWith('never-served');
    const goodPath = pathFor(good);
    const badPath = pathFor(bad);
    const overrides = {
      'product.html': {
        'product-neon-photos': { imgs: [goodPath, badPath] },
      },
    };
    const result = await imp.importFromStaging({
      stagingUrl: 'https://staging.example',
      ownOrigins: ['https://prod.example'],
      adminKey: 'x',
      content: store,
      fetchImpl: makeFetch(overrides, { [goodPath]: good }, null), // badPath 404s
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    // Store untouched …
    expect(store.getPage('index.html').k.text).toBe('keepme');
    expect(store.getPhotos('product.html', 'product-neon-photos')).toEqual([]);
    // … and NEITHER image file lingers on the volume (the successful one was reclaimed).
    expect(fs.existsSync(path.join(dir, 'content-uploads', goodPath.split('/').pop()))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'content-uploads', badPath.split('/').pop()))).toBe(false);
  });

  it('does NOT reclaim a shared image the live prod store already references', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const imp = await loadImport();

    // A shared image already lives on prod and is referenced by the live store. Staging
    // references the SAME (content-addressed) image plus one that 404s → the import
    // aborts. Cleanup must NOT delete the shared file, since the live store still uses it.
    const shared = pngWith('shared-across-both');
    const sharedPath = store.saveImageBytes(shared); // now on disk AND referenced below
    store.setImg('index.html', 'hero-bg', sharedPath);
    const bad = pngWith('missing');
    const badPath = pathFor(bad);
    const overrides = {
      'index.html': { 'hero-bg': { img: sharedPath }, other: { img: badPath } },
    };

    const result = await imp.importFromStaging({
      stagingUrl: 'https://staging.example',
      ownOrigins: ['https://prod.example'],
      adminKey: 'x',
      content: store,
      fetchImpl: makeFetch(overrides, { [sharedPath]: shared }, null), // badPath 404s
    });
    expect(result.ok).toBe(false);
    // The shared image is still on disk — the live store references it, so cleanup skipped it.
    expect(fs.existsSync(path.join(dir, 'content-uploads', sharedPath.split('/').pop()))).toBe(
      true
    );
    expect(store.getPage('index.html')['hero-bg'].img).toBe(sharedPath);
  });

  it('refuses self-import for :443 / www / apex spellings of the prod origin', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const store = await loadStore(dir);
    const imp = await loadImport();

    // Direct helper checks: default-port, www/apex, and trailing-slash spellings of the
    // prod host all count as "self"; a genuinely different host does not.
    expect(imp.isSelfOrigin('https://prod.example:443', ['https://prod.example'])).toBe(true);
    expect(imp.isSelfOrigin('https://www.prod.example', ['https://prod.example'])).toBe(true);
    expect(imp.isSelfOrigin('https://prod.example/', ['https://www.prod.example'])).toBe(true);
    expect(imp.isSelfOrigin('https://staging.example', ['https://prod.example'])).toBe(false);

    // …and end-to-end: an explicit :443 spelling is refused without any fetch.
    const result = await imp.importFromStaging({
      stagingUrl: 'https://prod.example:443/',
      ownOrigins: ['https://prod.example'],
      adminKey: 'x',
      content: store,
      fetchImpl: () => {
        throw new Error('should not fetch on a self-import');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/self-import/i);
  });
});
