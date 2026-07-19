// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// Boots the real Express app to exercise the per-design GALLERY routes:
//   GET    /api/design-images                       (public read)
//   POST   /api/admin/design-images/base/image      (replace a base render)
//   DELETE /api/admin/design-images/base            (revert a base render)
//   POST   /api/admin/design-images/base/flags      (base visibility)
//   POST   /api/admin/design-images/photo           (add a named extra photo)
//   POST   /api/admin/design-images/photo/update    (patch name/visibility)
//   DELETE /api/admin/design-images/photo           (remove an extra photo)
//   POST   /api/admin/design-images/order           (reorder)
// server/ is CommonJS, so we require it through createRequire.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const ADMIN_KEY = 'test-admin-key';

// Minimal valid PNG header + a distinguishing tail (magic-byte sniffed as .png),
// padded past content.extFromMagic's 12-byte minimum; the tag makes the bytes
// (and thus the content-hash) unique.
function pngWith(tag) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(String(tag)),
    Buffer.alloc(8),
  ]);
}

function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from('--' + boundary + '\r\n'));
    if (p.filename != null) {
      chunks.push(
        Buffer.from(
          'Content-Disposition: form-data; name="' +
            p.name +
            '"; filename="' +
            p.filename +
            '"\r\nContent-Type: application/octet-stream\r\n\r\n'
        )
      );
      chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data)));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(
        Buffer.from(
          'Content-Disposition: form-data; name="' + p.name + '"\r\n\r\n' + p.value + '\r\n'
        )
      );
    }
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return Buffer.concat(chunks);
}

describe('per-design gallery routes', () => {
  let app, server, base, dataDir, content, designImages;

  function uploadFile(p) {
    return path.join(dataDir, 'content-uploads', String(p).split('/').pop());
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dimg-route-'));
    process.env.DATA_DIR = dataDir;
    process.env.ADMIN_KEY = ADMIN_KEY;
    for (const f of [
      'db.js',
      'pelecard.js',
      'notify.js',
      'content.js',
      'design-images.js',
      'index.js',
    ]) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
    // Require content + design-images FIRST so index.js resolves the SAME singletons
    // we inspect here (cross-store reclaim test manipulates the content store).
    content = require(path.join(serverDir, 'content.js'));
    designImages = require(path.join(serverDir, 'design-images.js'));
    app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function upUrl(kind, key = ADMIN_KEY) {
    return base + '/api/admin/design-images/' + kind + (key ? '?key=' + key : '');
  }
  async function uploadBase({ designId, slot, bytes, key = ADMIN_KEY }) {
    const boundary = '----dugriDimg' + Math.random().toString(16).slice(2);
    const parts = [];
    if (designId != null) parts.push({ name: 'designId', value: designId });
    if (slot != null) parts.push({ name: 'slot', value: slot });
    if (bytes != null) parts.push({ name: 'file', filename: 'x.png', data: bytes });
    const r = await fetch(upUrl('base/image', key), {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: buildMultipart(boundary, parts),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }
  async function uploadPhoto({ designId, name, bytes, key = ADMIN_KEY }) {
    const boundary = '----dugriDimg' + Math.random().toString(16).slice(2);
    const parts = [];
    if (designId != null) parts.push({ name: 'designId', value: designId });
    if (name != null) parts.push({ name: 'name', value: name });
    if (bytes != null) parts.push({ name: 'file', filename: 'x.png', data: bytes });
    const r = await fetch(upUrl('photo', key), {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: buildMultipart(boundary, parts),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }
  async function jsonReq(method, kind, body, key = ADMIN_KEY) {
    const r = await fetch(base + '/api/admin/design-images/' + kind + (key ? '?key=' + key : ''), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }
  async function getImages() {
    const r = await fetch(base + '/api/design-images');
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }

  it('public GET returns an empty map before anything is curated', async () => {
    const { status, json } = await getImages();
    expect(status).toBe(200);
    expect(json.images).toEqual({});
  });

  it('replacing a base render sets an override the public GET reports', async () => {
    const up = await uploadBase({ designId: 'posttrip', slot: 'board', bytes: pngWith('board1') });
    expect(up.status).toBe(200);
    expect(up.json.img).toMatch(/^\/content-uploads\/[a-f0-9]{16}\.png$/);
    expect(up.json.gallery.base.board.img).toBe(up.json.img);
    const { json } = await getImages();
    expect(json.images.posttrip.base.board.img).toBe(up.json.img);
  });

  it('rejects an unauthenticated upload (403) and never mutates the store', async () => {
    const up = await uploadBase({
      designId: 'birthday',
      slot: 'store',
      bytes: pngWith('x'),
      key: '',
    });
    expect(up.status).toBe(403);
    const { json } = await getImages();
    expect(json.images.birthday).toBeUndefined();
  });

  it('rejects a bad slot (400) and garbage bytes (400, via content.saveImageBytes)', async () => {
    const badSlot = await uploadBase({ designId: 'posttrip', slot: 'cover', bytes: pngWith('y') });
    expect(badSlot.status).toBe(400);
    const badBytes = await uploadBase({
      designId: 'posttrip',
      slot: 'front',
      bytes: Buffer.from('this is not an image'),
    });
    expect(badBytes.status).toBe(400);
    const { json } = await getImages();
    expect(json.images.posttrip.base.front).toBeUndefined();
  });

  it('#163: an oversized upload is rejected by the shared content.js storage cap', async () => {
    // Gallery uploads reuse content.saveImageBytes, which enforces a size cap
    // (IMAGE_CAP, ~4MB) — a bigger file is rejected (400), never stored. This is the
    // same storage guard the content editor + template uploads rely on.
    const oversized = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(5 * 1024 * 1024),
    ]);
    const up = await uploadBase({ designId: 'posttrip', slot: 'store', bytes: oversized });
    expect(up.status).toBe(400);
    const { json } = await getImages();
    expect(
      json.images.posttrip && json.images.posttrip.base && json.images.posttrip.base.store
    ).toBeUndefined();
  });

  it('base flags + delete revert a slot to its shipped render', async () => {
    await uploadBase({ designId: 'neon', slot: 'store', bytes: pngWith('neon1') });
    let { json } = await getImages();
    expect(json.images.neon.base.store.img).toBeDefined();

    const del = await jsonReq('DELETE', 'base', { designId: 'neon', slot: 'store' });
    expect(del.status).toBe(200);
    ({ json } = await getImages());
    expect(json.images.neon).toBeUndefined(); // pruned → static asset

    // A hide flag persists on its own.
    const flags = await jsonReq('POST', 'base/flags', {
      designId: 'neon',
      slot: 'store',
      onProducts: false,
    });
    expect(flags.status).toBe(200);
    ({ json } = await getImages());
    expect(json.images.neon.base.store).toEqual({ onProducts: false });
  });

  it('adds a named extra photo, patches it, reorders, and removes it', async () => {
    const add = await uploadPhoto({ designId: 'japanese', name: 'וריאציה', bytes: pngWith('jp1') });
    expect(add.status).toBe(200);
    expect(add.json.photo).toMatchObject({
      id: 'p1',
      name: 'וריאציה',
      onProducts: true,
      onProduct: true,
    });

    const patch = await jsonReq('POST', 'photo/update', {
      designId: 'japanese',
      photoId: 'p1',
      name: 'חדש',
      onProduct: false,
    });
    expect(patch.status).toBe(200);
    expect(patch.json.photo).toMatchObject({ name: 'חדש', onProduct: false });

    const order = await jsonReq('POST', 'order', {
      designId: 'japanese',
      order: ['p1', 'front', 'back'],
    });
    expect(order.status).toBe(200);
    expect(order.json.gallery.order).toEqual(['p1', 'front', 'back']);

    const del = await jsonReq('DELETE', 'photo', { designId: 'japanese', photoId: 'p1' });
    expect(del.status).toBe(200);
    const { json } = await getImages();
    expect(json.images.japanese && json.images.japanese.photos).toBeUndefined();
  });

  it('replacing a base override reclaims the displaced (now-orphan) upload file', async () => {
    const first = await uploadBase({ designId: 'marriage', slot: 'board', bytes: pngWith('m1') });
    const oldPath = first.json.img;
    expect(fs.existsSync(uploadFile(oldPath))).toBe(true);

    const second = await uploadBase({ designId: 'marriage', slot: 'board', bytes: pngWith('m2') });
    const newPath = second.json.img;
    expect(newPath).not.toBe(oldPath);
    expect(fs.existsSync(uploadFile(oldPath))).toBe(false); // reclaimed
    expect(fs.existsSync(uploadFile(newPath))).toBe(true);
  });

  it('removing a photo reclaims its upload file', async () => {
    const add = await uploadPhoto({ designId: 'graduation', name: 'x', bytes: pngWith('grad1') });
    const p = add.json.photo.img;
    expect(fs.existsSync(uploadFile(p))).toBe(true);
    await jsonReq('DELETE', 'photo', { designId: 'graduation', photoId: add.json.photo.id });
    expect(fs.existsSync(uploadFile(p))).toBe(false); // reclaimed
  });

  it('does NOT reclaim a file still referenced by ANOTHER design (shared, content-addressed)', async () => {
    const shared = pngWith('shared-bytes');
    const a = await uploadPhoto({ designId: 'birthday', name: 'a', bytes: shared });
    const b = await uploadBase({ designId: 'kids', slot: 'front', bytes: shared });
    const sharedPath = a.json.photo.img;
    expect(b.json.img).toBe(sharedPath); // content-addressed dedupe

    // Remove the birthday photo → the file is STILL used by kids/front, so it survives.
    await jsonReq('DELETE', 'photo', { designId: 'birthday', photoId: a.json.photo.id });
    expect(designImages.isImageReferenced(sharedPath)).toBe(true);
    expect(fs.existsSync(uploadFile(sharedPath))).toBe(true);
  });

  it('does NOT reclaim a file still referenced by the CONTENT store (cross-store share)', async () => {
    const up = await uploadBase({ designId: 'retirement', slot: 'store', bytes: pngWith('cross') });
    const p = up.json.img;
    content.setImg('index.html', 'index-hero-1', p);
    expect(content.isImageReferenced(p)).toBe(true);

    await jsonReq('DELETE', 'base', { designId: 'retirement', slot: 'store' });
    expect(fs.existsSync(uploadFile(p))).toBe(true); // content store still needs it
    content.remove('index.html', 'index-hero-1');
  });
});
