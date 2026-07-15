// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// Boots the real Express app to exercise the per-design image override routes:
//   GET    /api/design-images            (public read)
//   POST   /api/admin/design-images/image (admin upload → sets an override)
//   DELETE /api/admin/design-images       (admin reset → back to static)
// Same boot + multipart helpers as content-photos-route.test.js. server/ is
// CommonJS, so we require it through createRequire.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const ADMIN_KEY = 'test-admin-key';

// Minimal valid PNG header + a distinguishing tail (magic-byte sniffed as .png).
function pngWith(tag) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(String(tag)),
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

describe('per-design image override routes', () => {
  let app, server, base, dataDir;

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

  async function uploadImage({ designId, slot, bytes, key = ADMIN_KEY }) {
    const boundary = '----dugriDimg' + Math.random().toString(16).slice(2);
    const parts = [];
    if (designId != null) parts.push({ name: 'designId', value: designId });
    if (slot != null) parts.push({ name: 'slot', value: slot });
    if (bytes != null) parts.push({ name: 'file', filename: 'x.png', data: bytes });
    const body = buildMultipart(boundary, parts);
    const url = base + '/api/admin/design-images/image' + (key ? '?key=' + key : '');
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }

  async function getImages() {
    const r = await fetch(base + '/api/design-images');
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }

  it('public GET returns an empty map before anything is overridden', async () => {
    const { status, json } = await getImages();
    expect(status).toBe(200);
    expect(json.images).toEqual({});
  });

  it('admin upload sets an override that the public GET then reports', async () => {
    const up = await uploadImage({ designId: 'posttrip', slot: 'board', bytes: pngWith('board1') });
    expect(up.status).toBe(200);
    expect(up.json.img).toMatch(/^\/content-uploads\/[a-f0-9]{16}\.png$/);
    expect(up.json.images.board).toBe(up.json.img);

    const { json } = await getImages();
    expect(json.images.posttrip.board).toBe(up.json.img);
  });

  it('rejects an unauthenticated upload (403) and never mutates the store', async () => {
    const up = await uploadImage({
      designId: 'birthday',
      slot: 'store',
      bytes: pngWith('x'),
      key: '',
    });
    expect(up.status).toBe(403);
    const { json } = await getImages();
    expect(json.images.birthday).toBeUndefined();
  });

  it('rejects a bad slot (400) and reuses content.js image validation for garbage bytes (400)', async () => {
    const badSlot = await uploadImage({ designId: 'posttrip', slot: 'cover', bytes: pngWith('y') });
    expect(badSlot.status).toBe(400);
    // Not an image (fails content.saveImageBytes magic-byte check) → 400, no override.
    const badBytes = await uploadImage({
      designId: 'posttrip',
      slot: 'front',
      bytes: Buffer.from('this is not an image'),
    });
    expect(badBytes.status).toBe(400);
    const { json } = await getImages();
    expect(json.images.posttrip.front).toBeUndefined();
  });

  it('admin reset reverts a slot to its static default', async () => {
    await uploadImage({ designId: 'neon', slot: 'store', bytes: pngWith('neon1') });
    let { json } = await getImages();
    expect(json.images.neon.store).toBeDefined();

    const r = await fetch(base + '/api/admin/design-images?key=' + ADMIN_KEY, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ designId: 'neon', slot: 'store' }),
    });
    expect(r.status).toBe(200);

    ({ json } = await getImages());
    expect(json.images.neon).toBeUndefined(); // pruned back to nothing → static asset
  });
});
