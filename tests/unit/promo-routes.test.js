// @vitest-environment node
// The "new game" block over the real Express app: the PUBLIC GET /api/promo
// projection, the admin write path that feeds it, and the photo upload.
//
// They are tested together because the whole point of validatePromo is that it
// stands between an admin POST and an unauthenticated response — a rejected write
// must be observable as "the public endpoint never changed".
//
// Same harness as faq-routes.test.js: require the app (it does not listen —
// guarded by require.main===module) and bind an ephemeral port for the test.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
let app;
let server;
let base;
let dataDir;
let DEFAULT_PROMO;

// A 1x1 PNG — real magic bytes, so content.extFromMagic types it as an image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const block = (over = {}) => ({ ...DEFAULT_PROMO, ...over });
const live = (over = {}) => block({ enabled: true, title: 'משחק חדש', ...over });

const setPromo = (value) =>
  fetch(base + '/api/admin/settings?key=' + ADMIN_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'promo', key: 'block', value }),
  });

const getPromo = async () => (await fetch(base + '/api/promo')).json();

// Hand-rolled multipart body — the same shape the admin page's FormData sends,
// built here so the test doesn't depend on a browser FormData implementation.
function multipart(buf, filename = 'photo.png') {
  const b = '----dugritest' + filename.length;
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${b}--\r\n`);
  return { body: Buffer.concat([head, buf, tail]), type: 'multipart/form-data; boundary=' + b };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-promo-routes-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['promo.js', 'faq.js', 'settings.js', 'content.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  ({ DEFAULT_PROMO } = require(path.join(serverDir, 'promo.js')));
  app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.DATA_DIR;
  delete process.env.ADMIN_KEY;
});

beforeEach(async () => {
  await fetch(base + '/api/admin/settings?section=promo&settingKey=block&key=' + ADMIN_KEY, {
    method: 'DELETE',
  });
});

describe('GET /api/promo', () => {
  it('answers { promo: null } out of the box — the section ships off', async () => {
    expect(await getPromo()).toEqual({ promo: null });
  });

  it('needs no admin key', async () => {
    const r = await fetch(base + '/api/promo');
    expect(r.status).toBe(200);
  });

  it('keeps a switched-off block off the wire entirely', async () => {
    const r = await setPromo(block({ title: 'שם סודי', sub: 'טרם הושק' }));
    expect(r.status).toBe(200);
    const body = await getPromo();
    expect(body).toEqual({ promo: null });
    expect(JSON.stringify(body)).not.toContain('סודי');
  });

  it('publishes a live block as the whitelisted projection', async () => {
    await setPromo(live({ sub: 'שתי שורות', position: 'after', background: 'white' }));
    const { promo } = await getPromo();
    expect(promo.title).toBe('משחק חדש');
    expect(promo.sub).toBe('שתי שורות');
    expect(promo.position).toBe('after');
    expect(promo.background).toBe('white');
    expect(promo.cta2).toBeNull();
    // The internal switches never travel.
    expect(promo).not.toHaveProperty('enabled');
    expect(promo).not.toHaveProperty('cta2_enabled');
  });
});

describe('POST /api/admin/settings (promo.block)', () => {
  it('refuses an unauthenticated write', async () => {
    const r = await fetch(base + '/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'promo', key: 'block', value: live() }),
    });
    expect(r.status).toBe(403);
    expect(await getPromo()).toEqual({ promo: null });
  });

  it('rejects a javascript: button, and the public endpoint never changes', async () => {
    await setPromo(live());
    const r = await setPromo(live({ cta_url: 'javascript:alert(1)' }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/cta url must start with/);
    const { promo } = await getPromo();
    expect(promo.cta_url).toBe('/products.html');
  });

  it('rejects an off-site photo', async () => {
    const r = await setPromo(live({ photos: [{ src: 'https://evil.example/x.png', alt: '' }] }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/must be an uploaded/);
  });

  it('refuses to switch on a section with no title', async () => {
    const r = await setPromo(block({ enabled: true }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/title cannot be empty/);
    expect(await getPromo()).toEqual({ promo: null });
  });

  it('round-trips a full block, photos and second button included', async () => {
    const up = await fetch(base + '/api/admin/promo/image?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': multipart(PNG).type },
      body: multipart(PNG).body,
    });
    const { img } = await up.json();
    const r = await setPromo(
      live({
        photos: [{ src: img, alt: 'קלפים' }],
        cta2_enabled: true,
        cta2_text: 'איך משחקים',
        cta2_url: '/how.html',
      })
    );
    expect(r.status).toBe(200);
    const { promo } = await getPromo();
    expect(promo.photos).toEqual([{ src: img, alt: 'קלפים' }]);
    expect(promo.cta2).toEqual({ text: 'איך משחקים', url: '/how.html' });
  });

  it('DELETE puts the section back to off', async () => {
    await setPromo(live());
    expect((await getPromo()).promo).not.toBeNull();
    const r = await fetch(
      base + '/api/admin/settings?section=promo&settingKey=block&key=' + ADMIN_KEY,
      { method: 'DELETE' }
    );
    expect(r.status).toBe(200);
    expect(await getPromo()).toEqual({ promo: null });
  });
});

describe('POST /api/admin/promo/image', () => {
  it('refuses an unauthenticated upload', async () => {
    const { body, type } = multipart(PNG);
    const r = await fetch(base + '/api/admin/promo/image', {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
    });
    expect(r.status).toBe(403);
  });

  it('stores the bytes and returns a path the block will accept', async () => {
    const { body, type } = multipart(PNG);
    const r = await fetch(base + '/api/admin/promo/image?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
    });
    expect(r.status).toBe(200);
    const { img } = await r.json();
    expect(img).toMatch(/^\/content-uploads\/[a-f0-9]{16}\.png$/);
    expect(fs.existsSync(path.join(dataDir, 'content-uploads', path.basename(img)))).toBe(true);
    // And it is servable to a visitor, since the block will point the page at it.
    expect((await fetch(base + img)).status).toBe(200);
  });

  it('de-dupes identical bytes to the same stored file', async () => {
    const send = async () => {
      const { body, type } = multipart(PNG);
      const r = await fetch(base + '/api/admin/promo/image?key=' + ADMIN_KEY, {
        method: 'POST',
        headers: { 'Content-Type': type },
        body,
      });
      return (await r.json()).img;
    };
    expect(await send()).toBe(await send());
  });

  it('rejects a body that is not an image', async () => {
    const { body, type } = multipart(Buffer.from('not an image at all'), 'x.txt');
    const r = await fetch(base + '/api/admin/promo/image?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/unsupported image type/);
  });

  it('rejects a request that is not multipart at all', async () => {
    const r = await fetch(base + '/api/admin/promo/image?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(400);
  });
});
