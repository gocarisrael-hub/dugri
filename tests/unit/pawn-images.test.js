// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// Boots the real Express app (and its db singleton) to exercise pawn images:
// db.addPawnImages (append + max-4 cap + owner-token gate) and the owner-scoped
// POST /api/collections/:id/pawns multipart route. server/ is CommonJS, so we
// require it through createRequire (same boot pattern as content-photos-route.test.js).
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// Minimal valid image byte buffers. extFromMagic needs >= 12 bytes and sniffs by
// magic header, so a header + padding tail is accepted exactly like a real file.
function pngWith(tag) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(String(tag).padEnd(8, '.')),
  ]);
}
function jpegWith(tag) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(String(tag).padEnd(12, '.'))]);
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

let db;
let app;
let server;
let base;
let dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pawns-'));
  process.env.DATA_DIR = dataDir;
  // Fresh module instances bound to this DATA_DIR. Require db FIRST so index.js's
  // own require('./db') resolves to the SAME singleton the db tests manipulate.
  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  db = require(path.join(serverDir, 'db.js'));
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

// POST files (each {name, filename, data}) as multipart to the pawns route with ?k=.
async function uploadPawns(id, k, files) {
  const boundary = '----dugriPawns' + Math.random().toString(16).slice(2);
  const body = buildMultipart(boundary, files);
  const res = await fetch(base + '/api/collections/' + id + '/pawns?k=' + encodeURIComponent(k), {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('db.addPawnImages', () => {
  it('seeds pawn_images: [] on a fresh collection', () => {
    const c = db.createCollection('בדיקה', { email: 'seed@example.com' });
    expect(c.pawn_images).toEqual([]);
  });

  it('appends paths to the collection', () => {
    const c = db.createCollection('בדיקה', {});
    const out = db.addPawnImages(c.id, c.owner_token, ['/content-uploads/a.png']);
    expect(out).toEqual(['/content-uploads/a.png']);
    expect(db.getCollection(c.id).pawn_images).toEqual(['/content-uploads/a.png']);
  });

  it('caps the stored array at 4 total (3 then 3 keeps 4)', () => {
    const c = db.createCollection('בדיקה', {});
    db.addPawnImages(c.id, c.owner_token, ['/1.png', '/2.png', '/3.png']);
    const out = db.addPawnImages(c.id, c.owner_token, ['/4.png', '/5.png', '/6.png']);
    expect(out).toHaveLength(4);
    expect(out).toEqual(['/1.png', '/2.png', '/3.png', '/4.png']);
  });

  it('returns null on a wrong owner_token (and does not mutate)', () => {
    const c = db.createCollection('בדיקה', {});
    expect(db.addPawnImages(c.id, 'wrong-token', ['/x.png'])).toBe(null);
    expect(db.getCollection(c.id).pawn_images).toEqual([]);
  });

  it('returns null on an unknown collection id', () => {
    expect(db.addPawnImages('no-such-id', 'whatever', ['/x.png'])).toBe(null);
  });
});

describe('POST /api/collections/:id/pawns', () => {
  it('403 with no owner token (?k= absent)', async () => {
    const c = db.createCollection('בדיקה', {});
    const boundary = '----x';
    const body = buildMultipart(boundary, [{ name: 'f', filename: 'a.png', data: pngWith('a') }]);
    const res = await fetch(base + '/api/collections/' + c.id + '/pawns', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
    });
    expect(res.status).toBe(403);
  });

  it('403 with a wrong owner token', async () => {
    const c = db.createCollection('בדיקה', {});
    const r = await uploadPawns(c.id, 'wrong', [
      { name: 'f', filename: 'a.png', data: pngWith('a') },
    ]);
    expect(r.status).toBe(403);
  });

  it('stores valid png + jpeg and sets the paths on the collection', async () => {
    const c = db.createCollection('בדיקה', {});
    const r = await uploadPawns(c.id, c.owner_token, [
      { name: 'p1', filename: 'a.png', data: pngWith('one') },
      { name: 'p2', filename: 'b.jpg', data: jpegWith('two') },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.pawn_images).toHaveLength(2);
    expect(r.body.pawn_images[0]).toMatch(/^\/content-uploads\/.+\.png$/);
    expect(r.body.pawn_images[1]).toMatch(/^\/content-uploads\/.+\.jpg$/);
    expect(db.getCollection(c.id).pawn_images).toEqual(r.body.pawn_images);
  });

  it('rejects more than 4 by only storing 4', async () => {
    const c = db.createCollection('בדיקה', {});
    const r = await uploadPawns(c.id, c.owner_token, [
      { name: 'a', filename: 'a.png', data: pngWith('a') },
      { name: 'b', filename: 'b.png', data: pngWith('b') },
      { name: 'c', filename: 'c.png', data: pngWith('c') },
      { name: 'd', filename: 'd.png', data: pngWith('d') },
      { name: 'e', filename: 'e.png', data: pngWith('e') },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.pawn_images).toHaveLength(4);
  });

  it('skips a non-image part (fail-soft) but still stores the valid one', async () => {
    const c = db.createCollection('בדיקה', {});
    const r = await uploadPawns(c.id, c.owner_token, [
      { name: 'bad', filename: 'note.txt', data: Buffer.from('this is not an image at all') },
      { name: 'good', filename: 'a.png', data: pngWith('good') },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.pawn_images).toHaveLength(1);
    expect(r.body.pawn_images[0]).toMatch(/\.png$/);
  });

  it('skips an oversized image (saveImageBytes throws) but still returns 200', async () => {
    const c = db.createCollection('בדיקה', {});
    // > 4MB (IMAGE_CAP) with a valid PNG header → store throws → file skipped.
    const huge = Buffer.concat([pngWith('big'), Buffer.alloc(5 * 1024 * 1024, 0x61)]);
    const r = await uploadPawns(c.id, c.owner_token, [
      { name: 'big', filename: 'big.png', data: huge },
      { name: 'ok', filename: 'ok.png', data: pngWith('ok') },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.pawn_images).toHaveLength(1);
    expect(r.body.pawn_images[0]).toMatch(/\.png$/);
  });

  it('400 when the multipart envelope is malformed (no boundary)', async () => {
    const c = db.createCollection('בדיקה', {});
    // A multipart content-type with NO boundary param: express.raw buffers it, but
    // boundaryFromContentType returns null → the route's own 400 branch.
    const res = await fetch(base + '/api/collections/' + c.id + '/pawns?k=' + c.owner_token, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data' },
      body: 'not multipart',
    });
    expect(res.status).toBe(400);
    const body = await res.json().catch(() => ({}));
    expect(body.error).toMatch(/multipart/);
  });
});
