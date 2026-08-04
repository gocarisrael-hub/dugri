// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// The BUYER'S BROWSER produces the transparent cutout (site/js/pawn-cutout.js);
// the server's job is to keep the original and its cutout straight, and to make a
// FAILED cut visible instead of silently shipping a photo that will print as a
// white rectangle (docs/photo-card.md). That contract is what this file covers:
//
//   * db.setPawnCutout — the three states, keyed BY PATH
//   * the upload route — pairing "cut:<name>" parts with their originals, the
//     `cutfail` marker, and rejecting anything that isn't a PNG
//   * pawnPhotoFiles — the generator gets the cutout when we have one
//   * the vendored runtime is actually present and served (brotli included)
//
// Boots the real Express app the same way pawn-images.test.js does.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const siteDir = path.join(__dirname, '..', '..', 'site');

// Minimal real image bytes. extFromMagic sniffs the magic header and needs >= 12
// bytes, so a header plus a padding tail is accepted exactly like a real file.
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
let content;
let app;
let server;
let base;
let dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-cutout-'));
  process.env.DATA_DIR = dataDir;
  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  db = require(path.join(serverDir, 'db.js'));
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

async function uploadPawns(id, k, parts) {
  const boundary = '----dugriCut' + Math.random().toString(16).slice(2);
  const body = buildMultipart(boundary, parts);
  const res = await fetch(base + '/api/collections/' + id + '/pawns?k=' + encodeURIComponent(k), {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('db.setPawnCutout', () => {
  it('seeds pawn_cutouts: {} on a fresh collection', () => {
    const c = db.createCollection('בדיקה', { email: 'cut@example.com' });
    expect(c.pawn_cutouts).toEqual({});
  });

  it('records a cutout path against the ORIGINAL photo path', () => {
    const c = db.createCollection('בדיקה', {});
    db.addPawnImages(c.id, c.owner_token, ['/content-uploads/aaa.jpg']);
    const out = db.setPawnCutout(
      c.id,
      c.owner_token,
      '/content-uploads/aaa.jpg',
      '/content-uploads/bbb.png'
    );
    expect(out).toEqual({ '/content-uploads/aaa.jpg': '/content-uploads/bbb.png' });
  });

  it('records null for a cut that was ATTEMPTED and failed', () => {
    const c = db.createCollection('בדיקה', {});
    db.addPawnImages(c.id, c.owner_token, ['/content-uploads/aaa.jpg']);
    db.setPawnCutout(c.id, c.owner_token, '/content-uploads/aaa.jpg', null);
    const stored = db.getCollection(c.id).pawn_cutouts;
    // null is NOT the same as absent — the owner has to see this one.
    expect(Object.prototype.hasOwnProperty.call(stored, '/content-uploads/aaa.jpg')).toBe(true);
    expect(stored['/content-uploads/aaa.jpg']).toBe(null);
  });

  it('refuses a photo path the collection does not hold', () => {
    const c = db.createCollection('בדיקה', {});
    db.addPawnImages(c.id, c.owner_token, ['/content-uploads/aaa.jpg']);
    expect(
      db.setPawnCutout(c.id, c.owner_token, '/content-uploads/nope.jpg', '/content-uploads/x.png')
    ).toBe(null);
    expect(db.getCollection(c.id).pawn_cutouts).toEqual({});
  });

  it('refuses a cutout path that is not one of our own uploads', () => {
    const c = db.createCollection('בדיקה', {});
    db.addPawnImages(c.id, c.owner_token, ['/content-uploads/aaa.jpg']);
    expect(
      db.setPawnCutout(c.id, c.owner_token, '/content-uploads/aaa.jpg', 'https://evil/x.png')
    ).toBe(null);
    expect(
      db.setPawnCutout(c.id, c.owner_token, '/content-uploads/aaa.jpg', '/content-uploads/../x')
    ).toBe(null);
  });

  it('refuses a wrong owner token and an unknown collection', () => {
    const c = db.createCollection('בדיקה', {});
    db.addPawnImages(c.id, c.owner_token, ['/content-uploads/aaa.jpg']);
    expect(
      db.setPawnCutout(c.id, 'wrong', '/content-uploads/aaa.jpg', '/content-uploads/b.png')
    ).toBe(null);
    expect(db.setPawnCutout('no-such-id', 'x', '/content-uploads/aaa.jpg', null)).toBe(null);
  });
});

describe('adminSetPawnImages keeps cutouts paired with their photo', () => {
  it('a REORDER keeps every surviving photo its own cutout', () => {
    const c = db.createCollection('בדיקה', {});
    db.addPawnImages(c.id, c.owner_token, ['/content-uploads/a.jpg', '/content-uploads/b.jpg']);
    db.setPawnCutout(c.id, c.owner_token, '/content-uploads/a.jpg', '/content-uploads/ac.png');
    db.setPawnCutout(c.id, c.owner_token, '/content-uploads/b.jpg', '/content-uploads/bc.png');
    db.adminSetPawnImages(c.id, ['/content-uploads/b.jpg', '/content-uploads/a.jpg']);
    // Keyed by path, so swapping the order cannot hand b.jpg the cutout of a.jpg.
    expect(db.getCollection(c.id).pawn_cutouts).toEqual({
      '/content-uploads/a.jpg': '/content-uploads/ac.png',
      '/content-uploads/b.jpg': '/content-uploads/bc.png',
    });
  });

  it('a REMOVAL drops only the removed photo’s cutout record', () => {
    const c = db.createCollection('בדיקה', {});
    db.addPawnImages(c.id, c.owner_token, ['/content-uploads/a.jpg', '/content-uploads/b.jpg']);
    db.setPawnCutout(c.id, c.owner_token, '/content-uploads/a.jpg', '/content-uploads/ac.png');
    db.setPawnCutout(c.id, c.owner_token, '/content-uploads/b.jpg', null);
    db.adminSetPawnImages(c.id, ['/content-uploads/a.jpg']);
    expect(db.getCollection(c.id).pawn_cutouts).toEqual({
      '/content-uploads/a.jpg': '/content-uploads/ac.png',
    });
  });
});

describe('POST /api/collections/:id/pawns — originals + their cutouts', () => {
  it('stores the ORIGINAL and records the cutout that came with it', async () => {
    const c = db.createCollection('בדיקה', {});
    const orig = jpegWith('orig-1');
    const cut = pngWith('cut-1');
    const res = await uploadPawns(c.id, c.owner_token, [
      { name: 'pawn0', filename: 'a.jpg', data: orig },
      { name: 'cut:pawn0', filename: 'a-cut.png', data: cut },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.pawn_images).toHaveLength(1);
    const origPath = res.body.pawn_images[0];
    // The stored ORIGINAL is the jpeg, untouched.
    expect(origPath.endsWith('.jpg') || origPath.endsWith('.jpeg')).toBe(true);
    const cutPath = res.body.pawn_cutouts[origPath];
    expect(cutPath).toMatch(/^\/content-uploads\/[a-f0-9]{16}\.png$/);
    expect(cutPath).not.toBe(origPath);
    // Both files are really on disk.
    for (const p of [origPath, cutPath]) {
      expect(fs.existsSync(path.join(content._uploadDir, path.basename(p)))).toBe(true);
    }
  });

  it('pairs each cutout with ITS OWN original, not by position', async () => {
    const c = db.createCollection('בדיקה', {});
    const res = await uploadPawns(c.id, c.owner_token, [
      { name: 'pawn0', filename: 'a.jpg', data: jpegWith('two-a') },
      { name: 'pawn1', filename: 'b.jpg', data: jpegWith('two-b') },
      // deliberately out of order, and only the SECOND photo has a cutout
      { name: 'cut:pawn1', filename: 'b-cut.png', data: pngWith('two-bc') },
      { name: 'cutfail', value: 'pawn0' },
    ]);
    const [a, b] = res.body.pawn_images;
    expect(res.body.pawn_cutouts[a]).toBe(null); // attempted, failed
    expect(res.body.pawn_cutouts[b]).toMatch(/\.png$/);
  });

  it('`cutfail` records a MISS so the owner can cut it by hand', async () => {
    const c = db.createCollection('בדיקה', {});
    const res = await uploadPawns(c.id, c.owner_token, [
      { name: 'pawn0', filename: 'a.jpg', data: jpegWith('miss-1') },
      { name: 'cutfail', value: 'pawn0' },
    ]);
    const p = res.body.pawn_images[0];
    expect(Object.prototype.hasOwnProperty.call(res.body.pawn_cutouts, p)).toBe(true);
    expect(res.body.pawn_cutouts[p]).toBe(null);
  });

  it('a client that sends no cutout at all leaves the map untouched', async () => {
    // The pre-cutout wizard, or any browser too old to segment: "never attempted"
    // must stay distinguishable from "attempted and failed".
    const c = db.createCollection('בדיקה', {});
    const res = await uploadPawns(c.id, c.owner_token, [
      { name: 'pawn0', filename: 'a.jpg', data: jpegWith('legacy-1') },
    ]);
    expect(res.body.pawn_images).toHaveLength(1);
    expect(res.body.pawn_cutouts).toEqual({});
  });

  it('REJECTS a non-PNG cutout and records it as a miss', async () => {
    // A JPEG cannot carry alpha, so accepting one would flag "cut ✓" for an image
    // that still prints as a white rectangle — the one silent failure to avoid.
    const c = db.createCollection('בדיקה', {});
    const res = await uploadPawns(c.id, c.owner_token, [
      { name: 'pawn0', filename: 'a.jpg', data: jpegWith('badcut-1') },
      { name: 'cut:pawn0', filename: 'a-cut.jpg', data: jpegWith('badcut-c') },
    ]);
    const p = res.body.pawn_images[0];
    expect(res.body.pawn_cutouts[p]).toBe(null);
  });

  it('accepts a full batch of 4 photos WITH their cutouts (body-size ceiling)', async () => {
    // Each photo now travels with a cutout PNG, so a full batch is far bigger than
    // it used to be. If the body parser rejected it the buyer would lose every
    // photo at once, so the ceiling has to clear four near-cap originals plus cuts.
    const big = (head, mb) => Buffer.concat([head, Buffer.alloc(Math.round(mb * 1024 * 1024))]);
    const parts = [];
    for (let i = 0; i < 4; i++) {
      parts.push({
        name: 'pawn' + i,
        filename: `p${i}.jpg`,
        data: big(jpegWith('big-' + i), 3.8),
      });
      parts.push({
        name: 'cut:pawn' + i,
        filename: `p${i}-cut.png`,
        data: big(pngWith('bigc-' + i), 1.6),
      });
    }
    const c = db.createCollection('בדיקה', {});
    const res = await uploadPawns(c.id, c.owner_token, parts); // ~21.6MB body
    expect(res.status).toBe(200);
    expect(res.body.pawn_images).toHaveLength(4);
    expect(Object.values(res.body.pawn_cutouts).filter(Boolean)).toHaveLength(4);
  });

  it('does not count cutouts against the 4-image cap', async () => {
    const c = db.createCollection('בדיקה', {});
    const parts = [];
    for (let i = 0; i < 4; i++) {
      parts.push({ name: 'pawn' + i, filename: `p${i}.jpg`, data: jpegWith('cap-' + i) });
      parts.push({ name: 'cut:pawn' + i, filename: `p${i}-cut.png`, data: pngWith('capc-' + i) });
    }
    const res = await uploadPawns(c.id, c.owner_token, parts);
    expect(res.status).toBe(200);
    expect(res.body.pawn_images).toHaveLength(4);
    expect(Object.keys(res.body.pawn_cutouts)).toHaveLength(4);
  });

  it('still rejects more than 4 ORIGINALS', async () => {
    const c = db.createCollection('בדיקה', {});
    const parts = [];
    for (let i = 0; i < 5; i++) {
      parts.push({ name: 'pawn' + i, filename: `p${i}.jpg`, data: jpegWith('over-' + i) });
    }
    const res = await uploadPawns(c.id, c.owner_token, parts);
    expect(res.status).toBe(400);
  });
});

describe('pawnPhotoFiles — what the generator is actually handed', () => {
  it('prefers the cutout, falls back to the original, and skips a missing file', async () => {
    const c = db.createCollection('בדיקה', {});
    await uploadPawns(c.id, c.owner_token, [
      { name: 'pawn0', filename: 'a.jpg', data: jpegWith('gen-a') },
      { name: 'cut:pawn0', filename: 'a-cut.png', data: pngWith('gen-ac') },
      { name: 'pawn1', filename: 'b.jpg', data: jpegWith('gen-b') },
      { name: 'cutfail', value: 'pawn1' },
    ]);
    const fresh = db.getCollection(c.id);
    const [a, b] = fresh.pawn_images;
    const files = app.pawnPhotoFiles(fresh);
    expect(files).toHaveLength(2);
    expect(path.basename(files[0])).toBe(path.basename(fresh.pawn_cutouts[a]));
    // The failed one degrades to the ORIGINAL rather than dropping out.
    expect(path.basename(files[1])).toBe(path.basename(b));
  });

  it('falls back to the original when the cutout FILE has vanished', () => {
    const c = db.createCollection('בדיקה', {});
    const saved = content.saveImageBytes(jpegWith('vanish-a'));
    db.addPawnImages(c.id, c.owner_token, [saved.path]);
    db.setPawnCutout(c.id, c.owner_token, saved.path, '/content-uploads/0123456789abcdef.png');
    const files = app.pawnPhotoFiles(db.getCollection(c.id));
    expect(files).toHaveLength(1);
    expect(path.basename(files[0])).toBe(path.basename(saved.path));
  });

  it('a collection with no cutouts behaves exactly as it did before', () => {
    const c = db.createCollection('בדיקה', {});
    const saved = content.saveImageBytes(jpegWith('legacy-gen'));
    db.addPawnImages(c.id, c.owner_token, [saved.path]);
    delete db.getCollection(c.id).pawn_cutouts; // a row written before this feature
    const files = app.pawnPhotoFiles(db.getCollection(c.id));
    expect(files.map((f) => path.basename(f))).toEqual([path.basename(saved.path)]);
  });
});

describe('the vendored segmenter is present and self-hosted', () => {
  const vendor = path.join(siteDir, 'vendor', 'mediapipe');

  it('ships every file the browser module asks for', () => {
    // A half-finished re-vendor must not merge: pawn-cutout.js fetches exactly
    // these, and a missing one is a silent "no cut" on every order.
    for (const f of [
      'vision_bundle.mjs',
      'vision_wasm_internal.js',
      'vision_wasm_internal.wasm.br',
      'selfie_multiclass_256x256.tflite',
      'LICENSE',
      'README.md',
    ]) {
      expect(fs.existsSync(path.join(vendor, f))).toBe(true);
    }
  });

  it('keeps the Apache-2.0 licence next to the files it covers', () => {
    const licence = fs.readFileSync(path.join(vendor, 'LICENSE'), 'utf8');
    expect(licence).toContain('Apache License');
    expect(licence).toContain('Version 2.0');
  });

  it('serves the wasm brotli-compressed to a client that accepts it', async () => {
    const res = await fetch(base + '/vendor/mediapipe/vision_wasm_internal.wasm', {
      headers: { 'Accept-Encoding': 'br' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/wasm');
    const buf = Buffer.from(await res.arrayBuffer());
    // undici transparently inflates a br response, so what lands here is the real
    // wasm — magic "\0asm" — and it is far bigger than the 2.4MB on disk.
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    expect(buf.length).toBeGreaterThan(
      fs.statSync(path.join(vendor, 'vision_wasm_internal.wasm.br')).size
    );
  });

  it('inflates the wasm for a client that cannot take brotli', async () => {
    const res = await fetch(base + '/vendor/mediapipe/vision_wasm_internal.wasm', {
      headers: { 'Accept-Encoding': 'identity' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe(null);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  });

  it('serves the model and the loader straight off our own origin', async () => {
    for (const [file, type] of [
      ['selfie_multiclass_256x256.tflite', 'application/octet-stream'],
      ['vision_bundle.mjs', 'javascript'],
    ]) {
      const res = await fetch(base + '/vendor/mediapipe/' + file);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain(type.split('/').pop());
    }
  });

  it('refuses to walk out of the vendor directory', async () => {
    const res = await fetch(base + '/vendor/mediapipe/..%2f..%2fserver%2findex.js');
    expect(res.status).toBe(404);
  });
});
