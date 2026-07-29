// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

// Boots the real Express app to exercise the photo-card FALLBACK PAWN routes:
//   GET    /api/admin/photo-fallback               (the four slots)
//   GET    /api/admin/photo-fallback/default/:slot (the shipped pawn)
//   POST   /api/admin/photo-fallback               (replace one slot)
//   DELETE /api/admin/photo-fallback               (revert one slot)
// server/ is CommonJS, so we require it through createRequire.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const ADMIN_KEY = 'test-admin-key';

// Minimal valid PNG header + a distinguishing tail (magic-byte sniffed as .png),
// padded past content.extFromMagic's 12-byte minimum; the tag makes the bytes
// (and so the content hash) unique.
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

describe('photo-card fallback pawn routes', () => {
  let app, server, base, dataDir, content, photoFallback, designImages;

  const uploadFile = (p) => path.join(dataDir, 'content-uploads', String(p).split('/').pop());

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pawn-route-'));
    process.env.DATA_DIR = dataDir;
    process.env.ADMIN_KEY = ADMIN_KEY;
    for (const f of [
      'db.js',
      'pelecard.js',
      'notify.js',
      'content.js',
      'design-images.js',
      'photo-fallback.js',
      'index.js',
    ]) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
    // Require the stores FIRST so index.js resolves the SAME singletons we
    // inspect here (the cross-store reclaim test manipulates them directly).
    content = require(path.join(serverDir, 'content.js'));
    designImages = require(path.join(serverDir, 'design-images.js'));
    photoFallback = require(path.join(serverDir, 'photo-fallback.js'));
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

  const url = (suffix = '', key = ADMIN_KEY) =>
    base + '/api/admin/photo-fallback' + suffix + (key ? '?key=' + key : '');

  async function uploadPawn({ slot, bytes, key = ADMIN_KEY }) {
    const boundary = '----dugriPawn' + Math.random().toString(16).slice(2);
    const parts = [];
    if (slot != null) parts.push({ name: 'slot', value: slot });
    parts.push({ name: 'file', filename: 'pawn.png', data: bytes });
    const res = await fetch(url('', key), {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: buildMultipart(boundary, parts),
    });
    return { res, json: await res.json().catch(() => ({})) };
  }

  async function resetPawn(slot, key = ADMIN_KEY) {
    const res = await fetch(url('', key), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot }),
    });
    return { res, json: await res.json().catch(() => ({})) };
  }

  it('every route is admin-gated', async () => {
    expect((await fetch(url('', null))).status).toBe(403);
    expect((await fetch(url('/default/1', null))).status).toBe(403);
    expect((await uploadPawn({ slot: '1', bytes: pngWith('nokey'), key: null })).res.status).toBe(
      403
    );
    expect((await resetPawn('1', null)).res.status).toBe(403);
  });

  it('lists four slots, all on their shipped pawn to begin with', async () => {
    const j = await (await fetch(url())).json();
    expect(j.slots.map((s) => s.slot)).toEqual(['1', '2', '3', '4']);
    expect(j.slots.every((s) => s.overridden === false && s.img === null)).toBe(true);
    // The shipped artwork is in the repo, so it must be reported as present.
    expect(j.slots.every((s) => s.shippedExists === true)).toBe(true);
  });

  it('serves the shipped pawn so the panel can show what a slot falls back to', async () => {
    const res = await fetch(url('/default/2'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    expect((await res.text()).trim().length).toBeGreaterThan(0);
    // Only the four real slots resolve.
    expect((await fetch(url('/default/9'))).status).toBe(400);
    expect((await fetch(url('/default/..%2F..%2Fpackage.json'))).status).toBe(400);
  });

  it('an upload overrides that slot and is reported as the image in use', async () => {
    const { res, json } = await uploadPawn({ slot: '2', bytes: pngWith('pawn-two') });
    expect(res.status).toBe(200);
    expect(json.img).toMatch(/^\/content-uploads\/[a-f0-9]{16}\.png$/);
    expect(fs.existsSync(uploadFile(json.img))).toBe(true);

    const list = await (await fetch(url())).json();
    const two = list.slots.find((s) => s.slot === '2');
    expect(two.overridden).toBe(true);
    expect(two.img).toBe(json.img);
    // The others are untouched.
    expect(list.slots.filter((s) => s.overridden).length).toBe(1);
  });

  it('replacing a slot reclaims the file it displaced', async () => {
    const first = await uploadPawn({ slot: '1', bytes: pngWith('first') });
    const second = await uploadPawn({ slot: '1', bytes: pngWith('second') });
    expect(second.json.img).not.toBe(first.json.img);

    expect(fs.existsSync(uploadFile(first.json.img))).toBe(false); // reclaimed
    expect(fs.existsSync(uploadFile(second.json.img))).toBe(true);
    await resetPawn('1');
  });

  it('reset restores the shipped pawn and reclaims the override', async () => {
    const { json } = await uploadPawn({ slot: '3', bytes: pngWith('third') });
    expect(fs.existsSync(uploadFile(json.img))).toBe(true);

    const { res } = await resetPawn('3');
    expect(res.status).toBe(200);

    const list = await (await fetch(url())).json();
    const three = list.slots.find((s) => s.slot === '3');
    expect(three.overridden).toBe(false);
    expect(three.img).toBe(null);
    expect(fs.existsSync(uploadFile(json.img))).toBe(false);
  });

  it('a file still used by ANOTHER slot is not reclaimed', async () => {
    // Uploads are content-addressed: the same bytes in two slots are ONE file.
    const bytes = pngWith('shared-pawn');
    const a = await uploadPawn({ slot: '1', bytes });
    const b = await uploadPawn({ slot: '4', bytes });
    expect(b.json.img).toBe(a.json.img);

    await resetPawn('1');
    expect(fs.existsSync(uploadFile(a.json.img))).toBe(true); // slot 4 still uses it

    await resetPawn('4');
    expect(fs.existsSync(uploadFile(a.json.img))).toBe(false);
  });

  it('a file the GALLERY also uses is not reclaimed when a pawn drops it', async () => {
    // The stores share one content-addressed upload dir, so the reclaim guard has
    // to consult all of them — otherwise resetting a pawn deletes a live gallery
    // picture's bytes.
    const bytes = pngWith('shared-with-gallery');
    const { json } = await uploadPawn({ slot: '2', bytes });
    designImages.setBaseImg('bachelorette', 'front', json.img);

    await resetPawn('2');
    expect(fs.existsSync(uploadFile(json.img))).toBe(true);

    designImages.resetBaseImg('bachelorette', 'front');
  });

  it('a bad slot is refused and the just-written orphan is reclaimed', async () => {
    // The bytes are written BEFORE the slot is validated, so a rejected upload
    // would otherwise leave a file nothing points at sitting on the volume.
    // Its name is the content hash, so we can name it without a response body.
    const bytes = pngWith('orphan');
    const name = createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.png';

    const { res, json } = await uploadPawn({ slot: '9', bytes });
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/slot/);

    expect(fs.existsSync(path.join(dataDir, 'content-uploads', name))).toBe(false);
    expect(photoFallback.isImageReferenced('/content-uploads/' + name)).toBe(false);
  });

  it('a non-image upload is refused', async () => {
    const { res } = await uploadPawn({ slot: '1', bytes: Buffer.from('<svg>not a raster</svg>') });
    expect(res.status).toBe(400);
  });

  it('the store on disk is the shape the generator reads', async () => {
    await resetPawn('1');
    await resetPawn('2');
    await resetPawn('3');
    await resetPawn('4');
    const { json } = await uploadPawn({ slot: '4', bytes: pngWith('contract') });

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'photo-fallback.json'), 'utf8'));
    // docs/photo-fallback-overrides.md — { slots: { "<1-4>": "/content-uploads/..." } }
    expect(onDisk).toEqual({ slots: { 4: json.img } });
    // ...and the path resolves to a real file under DATA_DIR/content-uploads,
    // which is exactly how config.photo_fallback_paths maps it.
    expect(fs.existsSync(path.join(dataDir, 'content-uploads', json.img.split('/').pop()))).toBe(
      true
    );
    expect(content.isImageReferenced(json.img)).toBe(false); // not a content image
  });
});
