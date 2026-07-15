// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// Boots the real Express app to exercise the photos upload route's reclaim guard
// (POST /api/admin/content/photos). When an AT-CAP upload's bytes match a PRE-EXISTING
// unreferenced orphan already on the volume, content.saveImageBytes reports
// created:false (content-addressed dedup — no write). The route drops the upload (the
// array is full) but must NOT delete that file: it predates this request. Only files
// THIS request actually created may be reclaimed. server/ is CommonJS, so we require it
// through createRequire (same boot pattern as admin-templates.test.js).
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

describe('POST /api/admin/content/photos — reclaim guard (created-only)', () => {
  let app;
  let server;
  let base;
  let content;
  let dataDir;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-photos-'));
    process.env.DATA_DIR = dataDir;
    process.env.ADMIN_KEY = ADMIN_KEY;
    // Fresh module instances bound to this DATA_DIR. Require content FIRST so index.js's
    // own require('./content') resolves to the SAME singleton we manipulate here.
    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'index.js']) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
    content = require(path.join(serverDir, 'content.js'));
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

  async function uploadPhoto(page, key, bytes) {
    const boundary = '----dugriPhotos' + Math.random().toString(16).slice(2);
    const body = buildMultipart(boundary, [
      { name: 'page', value: page },
      { name: 'key', value: key },
      { name: 'file', filename: 'photo.png', data: bytes },
    ]);
    const res = await fetch(base + '/api/admin/content/photos?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('does NOT delete a pre-existing orphan when an at-cap upload matches its bytes', async () => {
    const page = 'product.html';
    const key = 'product-neon-photos';

    // Fill the carousel to PHOTO_CAP with distinct real uploads (all referenced).
    for (let i = 0; i < content.PHOTO_CAP; i++) {
      const p = content.saveImageBytes(pngWith('cap-' + i)).path;
      content.addPhoto(page, key, p);
    }
    expect(content.getPhotos(page, key)).toHaveLength(content.PHOTO_CAP);

    // A PRE-EXISTING orphan already sits on the volume, referenced by nothing.
    const orphanBytes = pngWith('pre-existing-orphan');
    const { path: orphanPath, created } = content.saveImageBytes(orphanBytes);
    expect(created).toBe(true); // we just wrote it (first time)
    expect(content.isImageReferenced(orphanPath)).toBe(false);
    const onDisk = path.join(dataDir, 'content-uploads', orphanPath.split('/').pop());
    expect(fs.existsSync(onDisk)).toBe(true);

    // Upload bytes whose hash EQUALS the orphan while the array is at cap. saveImageBytes
    // returns created:false (no write); addPhoto drops it (still at cap) → the route hits
    // the reclaim branch, but must NOT delete the file since THIS request did not create it.
    const r = await uploadPhoto(page, key, orphanBytes);
    expect(r.status).toBe(409); // dropped (array already full)
    // The pre-existing orphan survives — its bytes predate this request.
    expect(fs.existsSync(onDisk)).toBe(true);
  });
});
