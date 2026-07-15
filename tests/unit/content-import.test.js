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
});
