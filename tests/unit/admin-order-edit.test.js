// @vitest-environment node
// The admin ORDER EDIT surface: after checkout the customer settles details with
// the owner on WhatsApp ("make it their 40th", "switch me to pickup", "here's the
// address", "use this photo instead"), and the owner corrects the stored order —
// PATCH /api/admin/collections/:id plus the two pawn-photo routes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';

let app;
let db;
let server;
let base;
let dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-admin-edit-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
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

const withKey = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;

async function send(method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const patch = (urlPath, body) => send('PATCH', urlPath, body);

// A collection with an order on it. `version` defaults to the always-enabled
// digital one; admin:true bypasses the public enable gate for the others.
function seed(name, version = 'pdf', address) {
  const c = db.createCollection(name || 'בדיקה', { email: 'x@example.com' });
  if (version) db.setOrder(c.id, c.owner_token, { version, address }, { admin: true });
  return db.getCollection(c.id);
}

describe('PATCH /api/admin/collections/:id — auth + existence', () => {
  it('403 without the admin key, and changes nothing', async () => {
    const c = seed('לפני');
    const r = await patch('/api/admin/collections/' + c.id, { honoree_name: 'אחרי' });
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).honoree_name).toBe('לפני');
  });

  it('404 for an unknown collection', async () => {
    const r = await patch(withKey('/api/admin/collections/no-such-id'), { honoree_name: 'x' });
    expect(r.status).toBe(404);
  });
});

describe('PATCH /api/admin/collections/:id — the customer’s choices', () => {
  it('edits names, contact, design/colour/theme and the theme extra fields', async () => {
    const c = seed('דנה');
    const r = await patch(withKey('/api/admin/collections/' + c.id), {
      honoree_name: 'דנה ואופיר',
      email: 'new@example.com',
      phone: '0521234567',
      design: 'יום נישואין',
      color: 'מגנטה',
      theme: 'anniversary',
      extra_fields: { YEARS: '6', NAME1: 'דנה', NAME2: 'אופיר' },
      gender: 'female',
      chasers: true,
      custom_title: 'שש שנים  ביחד',
    });
    expect(r.status).toBe(200);
    const after = db.getCollection(c.id);
    expect(after.honoree_name).toBe('דנה ואופיר');
    expect(after.owner_email).toBe('new@example.com');
    expect(after.owner_phone).toBe('0521234567');
    expect(after.design).toBe('יום נישואין');
    expect(after.color).toBe('מגנטה');
    expect(after.theme).toBe('anniversary');
    expect(after.extra_fields).toEqual({ YEARS: '6', NAME1: 'דנה', NAME2: 'אופיר' });
    expect(after.gender).toBe('female');
    expect(after.chasers).toBe(true);
    // custom_title is sanitized exactly like the create path (inner runs collapse).
    expect(after.custom_title).toBe('שש שנים ביחד');
    // The response carries the updated row so the table can re-render.
    expect(r.body.collection.honoree_name).toBe('דנה ואופיר');
    expect(r.body.collection.status).toBe('open');
  });

  it('only touches the keys the body actually carries', async () => {
    const c = seed('שירה');
    db.adminUpdateCollection(c.id, {
      design: 'ניאון',
      theme: 'birthday-girls-neon',
      chasers: true,
    });
    const r = await patch(withKey('/api/admin/collections/' + c.id), { phone: '0500000000' });
    expect(r.status).toBe(200);
    const after = db.getCollection(c.id);
    expect(after.owner_phone).toBe('0500000000');
    expect(after.design).toBe('ניאון');
    expect(after.theme).toBe('birthday-girls-neon');
    expect(after.chasers).toBe(true);
    expect(after.honoree_name).toBe('שירה');
  });

  it('clears an optional field with an empty string, but never blanks the honoree name', async () => {
    const c = seed('נועה');
    const r = await patch(withKey('/api/admin/collections/' + c.id), {
      honoree_name: '   ',
      color: '',
      custom_title: '',
    });
    expect(r.status).toBe(200);
    const after = db.getCollection(c.id);
    expect(after.honoree_name).toBe('נועה');
    expect(after.color).toBe(null);
    expect(after.custom_title).toBe(null);
  });

  it('caps and trims like the create path, and rejects an unknown gender', async () => {
    const c = seed('ארוך');
    await patch(withKey('/api/admin/collections/' + c.id), {
      honoree_name: '  ' + 'א'.repeat(120) + '  ',
      gender: 'other',
      extra_fields: { AGE: '  40  ' },
    });
    const after = db.getCollection(c.id);
    expect(after.honoree_name).toHaveLength(80);
    expect(after.gender).toBe(null);
    expect(after.extra_fields).toEqual({ AGE: '40' });
  });
});

describe('PATCH /api/admin/collections/:id — fulfilment (pickup / delivery)', () => {
  const ADDRESS = { street: 'הרצל 5', city: 'תל אביב', postal: '6100000', apartment: '3' };

  it('switches an UNPAID order to another version and re-prices it', async () => {
    const c = seed('משלוח', 'pdf');
    const priceOf = (v) => db.effectivePricing().versions[v].price;
    const r = await patch(withKey('/api/admin/collections/' + c.id), {
      order: { version: 'pickup' },
    });
    expect(r.status).toBe(200);
    const order = db.getCollection(c.id).order;
    expect(order.version).toBe('pickup');
    expect(order.total).toBe(priceOf('pickup'));
    expect(order.paid).toBe(false);
  });

  it('keeps a PAID order’s total and paid state when the version changes', async () => {
    const c = seed('שולם', 'pickup');
    db.markPaid(c.id, { method: 'card', transactionId: 'tx-1' });
    const paidTotal = db.getCollection(c.id).order.total;
    const r = await patch(withKey('/api/admin/collections/' + c.id), {
      order: { version: 'delivery', address: ADDRESS },
    });
    expect(r.status).toBe(200);
    const order = db.getCollection(c.id).order;
    expect(order.version).toBe('delivery');
    // What was charged is history — an edit never rewrites it.
    expect(order.total).toBe(paidTotal);
    expect(order.paid).toBe(true);
    expect(order.paid_transaction_id).toBe('tx-1');
  });

  it('stores a delivery address, and updates it without changing the version', async () => {
    const c = seed('כתובת', 'delivery', ADDRESS);
    const r = await patch(withKey('/api/admin/collections/' + c.id), {
      order: { version: 'delivery', address: { ...ADDRESS, street: 'ביאליק 12', floor: '2' } },
    });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.address).toEqual({
      street: 'ביאליק 12',
      city: 'תל אביב',
      postal: '6100000',
      apartment: '3',
      floor: '2',
    });
  });

  it('400 when switching to delivery with no address — and no field edit sticks', async () => {
    const c = seed('בלי כתובת', 'pickup');
    const r = await patch(withKey('/api/admin/collections/' + c.id), {
      honoree_name: 'שם חדש',
      order: { version: 'delivery', address: { street: 'רק רחוב' } },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('address required');
    const after = db.getCollection(c.id);
    expect(after.order.version).toBe('pickup');
    // The order patch is applied FIRST, so its rejection aborts the whole edit.
    expect(after.honoree_name).toBe('בלי כתובת');
  });

  it('keeps the stored address when a version-only edit leaves the order on delivery', async () => {
    const c = seed('שומר כתובת', 'delivery', ADDRESS);
    const r = await patch(withKey('/api/admin/collections/' + c.id), {
      order: { version: 'delivery' },
    });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.address.street).toBe('הרצל 5');
  });

  it('400 on an unknown version, and 400 when nothing was ordered yet', async () => {
    const c = seed('גרסה', 'pdf');
    const bad = await patch(withKey('/api/admin/collections/' + c.id), {
      order: { version: 'gold' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad version');
    expect(db.getCollection(c.id).order.version).toBe('pdf');

    const lead = seed('ליד', null);
    const none = await patch(withKey('/api/admin/collections/' + lead.id), {
      order: { version: 'pdf' },
    });
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('no order');
  });

  it('preserves provenance, the pending pay handshake and the production result', async () => {
    const c = seed('שימור', 'custom');
    db.recordPaymentInit(c.id, { paramToken: 'tok-1', charged_total: 599 });
    db.getCollection(c.id).order.production = { state: 'generated', file: 'x.pdf' };
    await patch(withKey('/api/admin/collections/' + c.id), { order: { version: 'pickup' } });
    const order = db.getCollection(c.id).order;
    expect(order.source).toBe('admin');
    expect(order.pelecard.sessions[0].token).toBe('tok-1');
    expect(order.production).toEqual({ state: 'generated', file: 'x.pdf' });
  });
});

describe('PUT /api/admin/collections/:id/pawns — remove / reorder photos', () => {
  const A = '/content-uploads/a.png';
  const B = '/content-uploads/b.png';
  const C = '/content-uploads/c.png';

  function seedPhotos(paths) {
    const c = db.createCollection('פיונים', {});
    db.addPawnImages(c.id, c.owner_token, paths);
    return c;
  }

  it('403 without the admin key', async () => {
    const c = seedPhotos([A, B]);
    const r = await send('PUT', '/api/admin/collections/' + c.id + '/pawns', { pawn_images: [] });
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).pawn_images).toEqual([A, B]);
  });

  it('404 for an unknown collection', async () => {
    const r = await send('PUT', withKey('/api/admin/collections/nope/pawns'), { pawn_images: [] });
    expect(r.status).toBe(404);
  });

  it('removes one photo and reorders the rest', async () => {
    const c = seedPhotos([A, B, C]);
    const r = await send('PUT', withKey('/api/admin/collections/' + c.id + '/pawns'), {
      pawn_images: [C, A],
    });
    expect(r.status).toBe(200);
    expect(r.body.pawn_images).toEqual([C, A]);
    expect(db.getCollection(c.id).pawn_images).toEqual([C, A]);
  });

  it('drops every photo on an empty array', async () => {
    const c = seedPhotos([A]);
    const r = await send('PUT', withKey('/api/admin/collections/' + c.id + '/pawns'), {
      pawn_images: [],
    });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).pawn_images).toEqual([]);
  });

  it('rejects off-origin / traversal paths and de-dupes, keeping at most 4', async () => {
    const c = seedPhotos([A]);
    const r = await send('PUT', withKey('/api/admin/collections/' + c.id + '/pawns'), {
      pawn_images: [
        'https://evil.example.com/x.png',
        '/content-uploads/../../etc/passwd',
        '/assets/designs/kids/front.svg',
        A,
        A,
        B,
        C,
        '/content-uploads/d.png',
        '/content-uploads/e.png',
        '/content-uploads/f.png',
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.pawn_images).toEqual([A, B, C, '/content-uploads/d.png']);
  });
});

describe('POST /api/admin/collections/:id/pawns — add a photo from the orders table', () => {
  function multipart(boundary, parts) {
    const chunks = [];
    for (const p of parts) {
      chunks.push(
        Buffer.from(
          '--' +
            boundary +
            '\r\nContent-Disposition: form-data; name="' +
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
  // extFromMagic sniffs the magic header and needs >= 12 bytes.
  const png = (tag) =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(String(tag).padEnd(8, '.')),
    ]);

  async function upload(urlPath, files) {
    const boundary = '----dugriAdminPawns' + Math.random().toString(16).slice(2);
    const res = await fetch(base + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: multipart(boundary, files),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('403 without the admin key (nothing stored)', async () => {
    const c = db.createCollection('העלאה', {});
    const r = await upload('/api/admin/collections/' + c.id + '/pawns', [
      { name: 'f', filename: 'a.png', data: png('no-key') },
    ]);
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).pawn_images).toEqual([]);
  });

  it('404 for an unknown collection', async () => {
    const r = await upload(withKey('/api/admin/collections/no-such-id/pawns'), [
      { name: 'f', filename: 'a.png', data: png('missing') },
    ]);
    expect(r.status).toBe(404);
  });

  it('appends the uploaded photo to the collection', async () => {
    const c = db.createCollection('העלאה', {});
    db.addPawnImages(c.id, c.owner_token, ['/content-uploads/existing.png']);
    const r = await upload(withKey('/api/admin/collections/' + c.id + '/pawns'), [
      { name: 'f', filename: 'a.png', data: png('admin-add') },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.pawn_images).toHaveLength(2);
    expect(r.body.pawn_images[0]).toBe('/content-uploads/existing.png');
    expect(r.body.pawn_images[1]).toMatch(/^\/content-uploads\/.+\.png$/);
    expect(db.getCollection(c.id).pawn_images).toEqual(r.body.pawn_images);
  });

  it('honours the 4-photo cap', async () => {
    const c = db.createCollection('מלא', {});
    db.addPawnImages(c.id, c.owner_token, [
      '/content-uploads/1.png',
      '/content-uploads/2.png',
      '/content-uploads/3.png',
      '/content-uploads/4.png',
    ]);
    const r = await upload(withKey('/api/admin/collections/' + c.id + '/pawns'), [
      { name: 'f', filename: 'a.png', data: png('over-cap') },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.pawn_images).toHaveLength(4);
  });
});
