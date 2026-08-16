// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// SHE MOVES HER PHOTO IN ITS CIRCLE, AND KEEPS OR DROPS ITS BACKGROUND.
//
// The automatic framing answers "where is the person?" — a good answer, and the
// wrong question the moment there are two people in the shot or she simply wants
// a face bigger. `pawn_view` is her answer instead, and this file covers the path
// it travels: the store (keyed by photo, clamped, pruned with the photo it
// annotates), the route that writes it, the route that cuts a background out of a
// photo we already hold, and what the generator is finally handed.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pawnview-'));
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

// A collection with `n` real photo files attached.
function withPhotos(n, tag) {
  const c = db.createCollection('בדיקה', {});
  const paths = [];
  for (let i = 0; i < n; i++) {
    const saved = content.saveImageBytes(jpegWith(tag + i));
    paths.push(saved.path);
  }
  db.addPawnImages(c.id, c.owner_token, paths);
  return { c, paths };
}

function putView(id, k, body) {
  return fetch(base + '/api/collections/' + id + '/pawn-view?k=' + encodeURIComponent(k), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postCut(id, k, parts) {
  const boundary = '----dugriView' + Math.random().toString(16).slice(2);
  const res = await fetch(
    base + '/api/collections/' + id + '/pawn-cut?k=' + encodeURIComponent(k),
    {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: buildMultipart(boundary, parts),
    }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('db.setPawnView', () => {
  it('seeds pawn_view: {} on a fresh collection', () => {
    const c = db.createCollection('בדיקה', {});
    expect(db.getCollection(c.id).pawn_view).toEqual({});
  });

  it('stores a view against the photo it belongs to', () => {
    const { c, paths } = withPhotos(2, 'store-');
    db.setPawnView(c.id, c.owner_token, paths[1], { zoom: 1.4, dx: 0.2, dy: -0.1, bg: true });
    const stored = db.getCollection(c.id).pawn_view;
    expect(stored[paths[1]]).toEqual({ zoom: 1.4, dx: 0.2, dy: -0.1, bg: true });
    // The other photo is untouched — a view is per photo, not per order.
    expect(stored[paths[0]]).toBeUndefined();
  });

  it('clamps what it is given, so a hand-made request cannot print off the card', () => {
    const { c, paths } = withPhotos(1, 'clamp-');
    db.setPawnView(c.id, c.owner_token, paths[0], { zoom: 99, dx: -8, dy: 8, bg: 'yes' });
    expect(db.getCollection(c.id).pawn_view[paths[0]]).toEqual({
      zoom: 2.5,
      dx: -1,
      dy: 1,
      bg: true,
    });
  });

  it('reads junk as "she has not moved it"', () => {
    const { c, paths } = withPhotos(1, 'junk-');
    db.setPawnView(c.id, c.owner_token, paths[0], { zoom: 'big', dx: null });
    expect(db.getCollection(c.id).pawn_view[paths[0]]).toEqual({
      zoom: 1,
      dx: 0,
      dy: 0,
      bg: false,
    });
  });

  it('refuses a bad owner token and a photo that is not this order’s', () => {
    const { c, paths } = withPhotos(1, 'gate-');
    expect(db.setPawnView(c.id, 'nope', paths[0], { zoom: 2 })).toBeNull();
    expect(db.setPawnView(c.id, c.owner_token, '/content-uploads/deadbeef.jpg', {})).toBeNull();
    expect(db.getCollection(c.id).pawn_view).toEqual({});
  });

  it('a view goes with its photo when the photo is removed', () => {
    const { c, paths } = withPhotos(2, 'prune-');
    db.setPawnView(c.id, c.owner_token, paths[0], { zoom: 1.5 });
    db.setPawnView(c.id, c.owner_token, paths[1], { zoom: 2 });
    db.setPawnImagesForOwner(c.id, c.owner_token, [paths[1]]);
    const stored = db.getCollection(c.id).pawn_view;
    expect(Object.keys(stored)).toEqual([paths[1]]);
    // …and the survivor keeps its own, which is why the map is keyed by path.
    expect(stored[paths[1]].zoom).toBe(2);
  });

  it('the admin setter prunes it too', () => {
    const { c, paths } = withPhotos(2, 'adminprune-');
    db.setPawnView(c.id, c.owner_token, paths[0], { zoom: 1.5 });
    db.setPawnView(c.id, c.owner_token, paths[1], { zoom: 1.2 });
    db.adminSetPawnImages(c.id, [paths[0]]);
    expect(Object.keys(db.getCollection(c.id).pawn_view)).toEqual([paths[0]]);
  });

  it('a row written before this feature is upgraded, not crashed on', () => {
    const { c, paths } = withPhotos(1, 'legacy-');
    delete db.getCollection(c.id).pawn_view;
    expect(db.setPawnView(c.id, c.owner_token, paths[0], { zoom: 1.3 })).not.toBeNull();
    expect(db.getCollection(c.id).pawn_view[paths[0]].zoom).toBe(1.3);
  });
});

describe('PUT /api/collections/:id/pawn-view', () => {
  it('stores what the page sends and answers with the whole map', async () => {
    const { c, paths } = withPhotos(1, 'route-');
    const res = await putView(c.id, c.owner_token, {
      path: paths[0],
      zoom: 1.6,
      dx: 0.1,
      dy: 0.2,
      bg: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pawn_view[paths[0]]).toEqual({ zoom: 1.6, dx: 0.1, dy: 0.2, bg: true });
  });

  it('is owner-only — these are photographs of her people', async () => {
    const { c, paths } = withPhotos(1, 'auth-');
    expect((await putView(c.id, 'wrong', { path: paths[0], zoom: 2 })).status).toBe(403);
  });

  it('refuses a path this order does not hold', async () => {
    const { c } = withPhotos(1, 'foreign-');
    const res = await putView(c.id, c.owner_token, { path: '/content-uploads/dead.png', zoom: 2 });
    expect(res.status).toBe(403);
  });

  it('wants a path at all', async () => {
    const { c } = withPhotos(1, 'nopath-');
    expect((await putView(c.id, c.owner_token, { zoom: 2 })).status).toBe(400);
  });

  it('refuses once the collection is CLOSED — the deck is in production', async () => {
    const { c, paths } = withPhotos(1, 'closed-');
    db.closeCollection(c.id, c.owner_token);
    const res = await putView(c.id, c.owner_token, { path: paths[0], zoom: 2 });
    expect(res.status).toBe(409);
    expect(db.getCollection(c.id).pawn_view).toEqual({});
  });

  it('rides back to the page in the owner’s own view of the collection', async () => {
    const { c, paths } = withPhotos(1, 'publicview-');
    await putView(c.id, c.owner_token, { path: paths[0], zoom: 1.25 });
    const owner = await fetch(
      base + '/api/collections/' + c.id + '?k=' + encodeURIComponent(c.owner_token)
    ).then((r) => r.json());
    expect(owner.pawn_view[paths[0]].zoom).toBe(1.25);
    expect(owner.pawn_cutouts).toEqual({});
    // A contributor arrives from a WhatsApp group to add one word and gets no
    // hint that any of this exists.
    const guest = await fetch(base + '/api/collections/' + c.id).then((r) => r.json());
    expect(guest.pawn_view).toBeUndefined();
    expect(guest.pawn_cutouts).toBeUndefined();
  });
});

describe('POST /api/collections/:id/pawn-cut — a second chance at the background', () => {
  it('attaches a cutout to a photo already on the order', async () => {
    const { c, paths } = withPhotos(1, 'cutlate-');
    const res = await postCut(c.id, c.owner_token, [
      { name: 'path', value: paths[0] },
      { name: 'cut', filename: 'cut.png', data: pngWith('late-a') },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.pawn_cutouts[paths[0]]).toMatch(/^\/content-uploads\/[a-f0-9]{16}\.png$/);
    // …and that cutout is now what the generator is handed.
    const files = app.pawnPhotoFiles(db.getCollection(c.id));
    expect(path.basename(files[0])).toBe(
      path.basename(db.getCollection(c.id).pawn_cutouts[paths[0]])
    );
  });

  it('takes PNG only — a JPEG has no alpha and would print as a rectangle', async () => {
    const { c, paths } = withPhotos(1, 'cutjpeg-');
    const res = await postCut(c.id, c.owner_token, [
      { name: 'path', value: paths[0] },
      { name: 'cut', filename: 'cut.jpg', data: jpegWith('not-a-cut') },
    ]);
    expect(res.status).toBe(400);
    expect(db.getCollection(c.id).pawn_cutouts).toEqual({});
  });

  it('is owner-only, and refuses a photo that is not this order’s', async () => {
    const { c, paths } = withPhotos(1, 'cutauth-');
    const other = withPhotos(1, 'cutother-');
    expect(
      (
        await postCut(c.id, 'wrong', [
          { name: 'path', value: paths[0] },
          { name: 'cut', filename: 'c.png', data: pngWith('x') },
        ])
      ).status
    ).toBe(403);
    expect(
      (
        await postCut(c.id, c.owner_token, [
          { name: 'path', value: other.paths[0] },
          { name: 'cut', filename: 'c.png', data: pngWith('y') },
        ])
      ).status
    ).toBe(403);
  });

  it('wants both halves', async () => {
    const { c, paths } = withPhotos(1, 'cuthalf-');
    expect((await postCut(c.id, c.owner_token, [{ name: 'path', value: paths[0] }])).status).toBe(
      400
    );
  });
});

describe('what the generator is handed', () => {
  it('keeps the BACKGROUND when she asked for it, cutout or no cutout', async () => {
    const { c, paths } = withPhotos(1, 'bg-');
    await postCut(c.id, c.owner_token, [
      { name: 'path', value: paths[0] },
      { name: 'cut', filename: 'cut.png', data: pngWith('bg-cut') },
    ]);
    // With the cut in place, the cutout is what prints…
    expect(path.basename(app.pawnPhotoFiles(db.getCollection(c.id))[0])).toBe(
      path.basename(db.getCollection(c.id).pawn_cutouts[paths[0]])
    );
    // …until she says she wants the background, and then it is the original.
    await putView(c.id, c.owner_token, { path: paths[0], bg: true });
    expect(path.basename(app.pawnPhotoFiles(db.getCollection(c.id))[0])).toBe(
      path.basename(paths[0])
    );
  });

  it('sends a frame only for a photo she actually moved', async () => {
    const { c, paths } = withPhotos(2, 'frames-');
    await putView(c.id, c.owner_token, { path: paths[1], zoom: 1.5, dx: -0.25, dy: 0.1 });
    // Photo 0 was never touched; photo 1 carries her numbers, in the same order
    // as the files — a frame on the wrong face is worse than no frame.
    expect(app.pawnPhotoFrames(db.getCollection(c.id))).toEqual([null, '1.5,-0.25,0.1']);
  });

  it('treats a view she reset back to default as no frame at all', async () => {
    const { c, paths } = withPhotos(1, 'reset-');
    await putView(c.id, c.owner_token, { path: paths[0], zoom: 1.7 });
    expect(app.pawnPhotoFrames(db.getCollection(c.id))).toEqual(['1.7,0,0']);
    await putView(c.id, c.owner_token, { path: paths[0], zoom: 1, dx: 0, dy: 0 });
    expect(app.pawnPhotoFrames(db.getCollection(c.id))).toEqual([null]);
  });

  it('puts each frame straight after its own --photo in the argv', () => {
    const args = app.orderArgs({
      theme: 'bachelorette',
      name: 'Shira',
      wordsFile: '/tmp/w.txt',
      outPath: '/tmp/out.pdf',
      photos: ['/tmp/a.png', '/tmp/b.png'],
      photoFrames: [null, '1.5,-0.25,0.1'],
    });
    const i = args.indexOf('/tmp/b.png');
    expect(args[i + 1]).toBe('--photo-frame=1.5,-0.25,0.1');
    // The untouched photo gets nothing, so an order nobody framed produces the
    // argv it always produced.
    expect(args[args.indexOf('/tmp/a.png') + 1]).toBe('--photo');
  });

  it('an order with no frames at all is byte-for-byte what it was', () => {
    const BASE = {
      theme: 'bachelorette',
      name: 'Shira',
      wordsFile: '/tmp/w.txt',
      outPath: '/tmp/out.pdf',
      photos: ['/tmp/a.png', '/tmp/b.png'],
    };
    expect(app.orderArgs({ ...BASE, photoFrames: [null, null] })).toEqual(app.orderArgs(BASE));
  });
});
