// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// Automatic background removal for the pawn photos, at UPLOAD time.
//
// The deck's photo card traces each sticker's white outline from the image's OWN
// alpha (docs/photo-card.md), so an opaque phone photo prints as a white-bordered
// rectangle. server/cutout.js turns a photo into a transparent RGBA PNG; this file
// pins the four behaviours that matter and NEVER touches the network — the provider
// module is replaced in require.cache before the app is booted.
//
//   1. happy path      — both files kept, the collection records original → cutout,
//                        and the generator is handed the CUTOUT;
//   2. provider failure — the upload still succeeds, the miss is recorded, and the
//                        generator falls back to the ORIGINAL;
//   3. unconfigured    — nothing is attempted and nothing is recorded (today's
//                        behaviour, byte for byte);
//   4. alpha survives  — the transparent PNG is stored verbatim, not re-encoded.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// A REAL 4x4 RGBA PNG: mostly transparent, two opaque pixels. Standing in for what
// the provider returns, it lets us assert that alpha is still there after the round
// trip through the upload store.
const CUTOUT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGNgwAb+gxGmKBZBBgYGAIa9A/0e+NXIAAAAAElFTkSuQmCC',
  'base64'
);

function jpegWith(tag) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(String(tag).padEnd(12, '.'))]);
}

function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from('--' + boundary + '\r\n'));
    chunks.push(
      Buffer.from(
        'Content-Disposition: form-data; name="' +
          p.name +
          '"; filename="' +
          p.filename +
          '"\r\nContent-Type: application/octet-stream\r\n\r\n'
      )
    );
    chunks.push(p.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return Buffer.concat(chunks);
}

// The stubbed provider. `state` is rewritten per test, so one booted app covers
// configured / unconfigured / failing without re-requiring the whole server.
const state = { configured: true, calls: 0, impl: null };
const fakeCutout = {
  isConfigured: () => state.configured,
  async removeBackground(buf) {
    state.calls++;
    return state.impl ? state.impl(buf) : CUTOUT_PNG;
  },
  // The real module's temporary-source surface, so the route index.js mounts for it
  // is registered with the same path shape it would have in production.
  SOURCE_ROUTE: '/api/pawn-cutout/src',
  serveSource: () => null,
};

let db;
let content;
let app;
let server;
let base;
let dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-cutout-'));
  process.env.DATA_DIR = dataDir;
  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'cutout.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  // Swap the provider BEFORE index.js requires it — no key, no network, ever.
  const cutoutPath = require.resolve(path.join(serverDir, 'cutout.js'));
  require.cache[cutoutPath] = {
    id: cutoutPath,
    filename: cutoutPath,
    loaded: true,
    exports: fakeCutout,
  };
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

beforeEach(() => {
  state.configured = true;
  state.calls = 0;
  state.impl = null;
});

async function uploadPawns(id, k, files) {
  const boundary = '----dugriCut' + Math.random().toString(16).slice(2);
  const body = buildMultipart(boundary, files);
  const res = await fetch(base + '/api/collections/' + id + '/pawns?k=' + encodeURIComponent(k), {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const onDisk = (p) => path.join(content._uploadDir, path.basename(p));

describe('pawn cutouts at upload time', () => {
  it('keeps BOTH files and records original → cutout', async () => {
    const c = db.createCollection('בדיקה', {});
    const r = await uploadPawns(c.id, c.owner_token, [
      { name: 'p0', filename: 'a.jpg', data: jpegWith('cut-a') },
      { name: 'p1', filename: 'b.jpg', data: jpegWith('cut-b') },
    ]);
    expect(r.status).toBe(200);
    expect(state.calls).toBe(2);
    const stored = db.getCollection(c.id);
    // The ORIGINALS are what pawn_images holds — a cut can always be redone from
    // them without asking the buyer for the photo again.
    expect(stored.pawn_images).toHaveLength(2);
    expect(stored.pawn_images.every((p) => /\.jpg$/.test(p))).toBe(true);
    for (const orig of stored.pawn_images) {
      const cut = stored.pawn_cutouts[orig];
      expect(cut).toMatch(/^\/content-uploads\/[a-f0-9]{16}\.png$/);
      expect(fs.existsSync(onDisk(orig))).toBe(true); // original kept
      expect(fs.existsSync(onDisk(cut))).toBe(true); // cutout kept
    }
    expect(r.body.pawn_cutouts).toEqual(stored.pawn_cutouts);
  });

  it('hands the GENERATOR the cutout, not the original', async () => {
    const c = db.createCollection('בדיקה', {});
    await uploadPawns(c.id, c.owner_token, [
      { name: 'p0', filename: 'a.jpg', data: jpegWith('gen-a') },
    ]);
    const stored = db.getCollection(c.id);
    const files = app.pawnPhotoFiles(stored);
    expect(files).toEqual([onDisk(stored.pawn_cutouts[stored.pawn_images[0]])]);
  });

  it('stores the transparent PNG VERBATIM — the alpha channel survives', async () => {
    const c = db.createCollection('בדיקה', {});
    await uploadPawns(c.id, c.owner_token, [
      { name: 'p0', filename: 'a.jpg', data: jpegWith('alpha') },
    ]);
    const stored = db.getCollection(c.id);
    const bytes = fs.readFileSync(onDisk(stored.pawn_cutouts[stored.pawn_images[0]]));
    expect(bytes.equals(CUTOUT_PNG)).toBe(true);
    // PNG colour type 6 == truecolour WITH alpha (IHDR byte 25).
    expect(bytes[25]).toBe(6);
  });

  it('never loses an order to the provider: a failure keeps the upload and records the miss', async () => {
    state.impl = () => {
      throw new Error('adobe is down');
    };
    const c = db.createCollection('בדיקה', {});
    const r = await uploadPawns(c.id, c.owner_token, [
      { name: 'p0', filename: 'a.jpg', data: jpegWith('fail-a') },
    ]);
    expect(r.status).toBe(200);
    const stored = db.getCollection(c.id);
    expect(stored.pawn_images).toHaveLength(1);
    // The key EXISTS with a null value: "we tried and could not" — that is what the
    // admin table flags in red, as opposed to "never attempted".
    const orig = stored.pawn_images[0];
    expect(Object.prototype.hasOwnProperty.call(stored.pawn_cutouts, orig)).toBe(true);
    expect(stored.pawn_cutouts[orig]).toBe(null);
    // ...and the generator falls back to the original rather than getting nothing.
    expect(app.pawnPhotoFiles(stored)).toEqual([onDisk(orig)]);
  });

  it('records the miss when the provider simply returns nothing', async () => {
    state.impl = () => null;
    const c = db.createCollection('בדיקה', {});
    await uploadPawns(c.id, c.owner_token, [
      { name: 'p0', filename: 'a.jpg', data: jpegWith('null-a') },
    ]);
    const stored = db.getCollection(c.id);
    expect(stored.pawn_cutouts[stored.pawn_images[0]]).toBe(null);
  });

  it('unconfigured: nothing is attempted and nothing is recorded', async () => {
    state.configured = false;
    const c = db.createCollection('בדיקה', {});
    const r = await uploadPawns(c.id, c.owner_token, [
      { name: 'p0', filename: 'a.jpg', data: jpegWith('off-a') },
    ]);
    expect(r.status).toBe(200);
    expect(state.calls).toBe(0);
    const stored = db.getCollection(c.id);
    expect(stored.pawn_images).toHaveLength(1);
    expect(stored.pawn_cutouts).toEqual({});
    // Byte for byte today's behaviour: the generator gets the original photo.
    expect(app.pawnPhotoFiles(stored)).toEqual([onDisk(stored.pawn_images[0])]);
  });

  it('re-uploading the same photo does not pay for a second cut', async () => {
    const c = db.createCollection('בדיקה', {});
    const same = jpegWith('same-photo');
    await uploadPawns(c.id, c.owner_token, [{ name: 'p0', filename: 'a.jpg', data: same }]);
    expect(state.calls).toBe(1);
    // Content-addressed: the identical bytes de-dupe to the SAME stored path, which
    // already carries a cutout — so the provider is not called again.
    await uploadPawns(c.id, c.owner_token, [{ name: 'p0', filename: 'a.jpg', data: same }]);
    expect(state.calls).toBe(1);
  });
});

describe('db.setPawnCutout', () => {
  it('refuses a wrong owner token', () => {
    const c = db.createCollection('בדיקה', {});
    db.addPawnImages(c.id, c.owner_token, ['/content-uploads/aaaaaaaaaaaaaaaa.jpg']);
    expect(
      db.setPawnCutout(
        c.id,
        'wrong',
        '/content-uploads/aaaaaaaaaaaaaaaa.jpg',
        '/content-uploads/bbbbbbbbbbbbbbbb.png'
      )
    ).toBe(null);
    expect(db.getCollection(c.id).pawn_cutouts).toEqual({});
  });

  it('refuses a photo the collection does not hold', () => {
    const c = db.createCollection('בדיקה', {});
    expect(
      db.setPawnCutout(
        c.id,
        c.owner_token,
        '/content-uploads/cccccccccccccccc.jpg',
        '/content-uploads/dddddddddddddddd.png'
      )
    ).toBe(null);
  });

  it('refuses a cutout path that is not one of our own uploads', () => {
    const c = db.createCollection('בדיקה', {});
    const orig = '/content-uploads/eeeeeeeeeeeeeeee.jpg';
    db.addPawnImages(c.id, c.owner_token, [orig]);
    expect(db.setPawnCutout(c.id, c.owner_token, orig, 'https://evil.example/x.png')).toBe(null);
    expect(db.getCollection(c.id).pawn_cutouts).toEqual({});
  });

  it('keyed by PATH, so an admin reorder cannot mis-pair photo and cutout', () => {
    const c = db.createCollection('בדיקה', {});
    const a = '/content-uploads/1111111111111111.jpg';
    const b = '/content-uploads/2222222222222222.jpg';
    const cutA = '/content-uploads/aaaa111111111111.png';
    const cutB = '/content-uploads/bbbb222222222222.png';
    db.addPawnImages(c.id, c.owner_token, [a, b]);
    db.setPawnCutout(c.id, c.owner_token, a, cutA);
    db.setPawnCutout(c.id, c.owner_token, b, cutB);
    // Reverse the order and drop nothing: each photo keeps ITS OWN cutout.
    db.adminSetPawnImages(c.id, [b, a]);
    const stored = db.getCollection(c.id);
    expect(stored.pawn_images).toEqual([b, a]);
    expect(stored.pawn_cutouts).toEqual({ [a]: cutA, [b]: cutB });
  });

  it('drops the cutout record of a photo the admin removed', () => {
    const c = db.createCollection('בדיקה', {});
    const a = '/content-uploads/3333333333333333.jpg';
    const b = '/content-uploads/4444444444444444.jpg';
    db.addPawnImages(c.id, c.owner_token, [a, b]);
    db.setPawnCutout(c.id, c.owner_token, a, '/content-uploads/aaaa333333333333.png');
    db.setPawnCutout(c.id, c.owner_token, b, null);
    db.adminSetPawnImages(c.id, [a]);
    const stored = db.getCollection(c.id);
    expect(Object.keys(stored.pawn_cutouts)).toEqual([a]);
  });
});

describe('POST /api/pawn-cutout (the wizard preview)', () => {
  async function preview(data, filename = 'a.jpg') {
    const boundary = '----dugriPrev' + Math.random().toString(16).slice(2);
    const res = await fetch(base + '/api/pawn-cutout', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: buildMultipart(boundary, [{ name: 'photo', filename, data }]),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('returns the cut as a transparent-PNG data URL and stores NOTHING', async () => {
    const before = fs.readdirSync(content._uploadDir).length;
    const r = await preview(jpegWith('prev-a'));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.cutout).toBe('data:image/png;base64,' + CUTOUT_PNG.toString('base64'));
    expect(fs.readdirSync(content._uploadDir).length).toBe(before);
  });

  it('answers "unconfigured" (200) when background removal is switched off', async () => {
    state.configured = false;
    const r = await preview(jpegWith('prev-off'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, reason: 'unconfigured' });
    expect(state.calls).toBe(0);
  });

  it('answers ok:false (never a 5xx) when the provider fails', async () => {
    state.impl = () => {
      throw new Error('boom');
    };
    const r = await preview(jpegWith('prev-fail'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, reason: 'failed' });
  });

  it('400s on a part that is not an image (magic-byte typed, like the real upload)', async () => {
    const r = await preview(Buffer.from('this is not an image at all'), 'note.txt');
    expect(r.status).toBe(400);
    expect(state.calls).toBe(0);
  });

  it('400s on an oversized image before it ever reaches the provider', async () => {
    const huge = Buffer.concat([jpegWith('big'), Buffer.alloc(5 * 1024 * 1024, 0x61)]);
    const r = await preview(huge);
    expect(r.status).toBe(400);
    expect(state.calls).toBe(0);
  });
});
