// @vitest-environment node
// The admin courier routes: book a delivery order's parcel with HFD, fetch its
// sticker, stand the van down. HFD itself is replaced by a fake fetch that only
// answers its own host, so the test's own requests to our server still go over
// the real one.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
const HFD_HOST = 'https://api.hfd.example';

let app;
let db;
let server;
let base;
let dataDir;
let realFetch;

// What the fake HFD answers next, and what it was asked. Reset per test.
let hfdAnswer;
let hfdCalls;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-hfd-routes-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.HFD_TOKEN = 'test-token';
  process.env.HFD_CLIENT_NUMBER = '4242';
  process.env.HFD_BASE_URL = HFD_HOST + '/rest/v2';

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'hfd.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));

  // Only HFD's host is faked; everything else (the test's own calls into the
  // app) keeps using the real fetch.
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(HFD_HOST)) {
      hfdCalls.push({ url: String(url), init });
      return hfdAnswer(String(url), init);
    }
    return realFetch(url, init);
  };

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (server) server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  hfdCalls = [];
  hfdAnswer = () => json({ shipmentNumber: 987654, randNumber: 'r-1' });
});

const json = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

const withKey = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;

async function send(method, urlPath) {
  const res = await realFetch(base + urlPath, { method });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const ADDRESS = { street: 'הרצל 5', city: 'תל אביב', postal: '6100000' };

// A paid delivery order — the only kind that ever ships.
function seedDelivery(name = 'משלוח', address = ADDRESS, extra = {}) {
  const c = db.createCollection(name, {
    email: 'x@example.com',
    phone: '0521234567',
    ...extra,
  });
  db.setOrder(c.id, c.owner_token, { version: 'delivery', address }, { admin: true });
  return db.getCollection(c.id);
}

describe('POST /api/admin/collections/:id/hfd', () => {
  it('403 without the admin key, and books nothing', async () => {
    const c = seedDelivery();
    const r = await send('POST', '/api/admin/collections/' + c.id + '/hfd');
    expect(r.status).toBe(403);
    expect(hfdCalls).toHaveLength(0);
  });

  it('404 for an unknown collection', async () => {
    const r = await send('POST', withKey('/api/admin/collections/nope/hfd'));
    expect(r.status).toBe(404);
  });

  it('books the parcel and stores the numbers on the order', async () => {
    const c = seedDelivery('דנה');
    const r = await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    expect(r.status).toBe(200);
    expect(r.body.hfd).toMatchObject({ shipment_number: '987654', rand_number: 'r-1' });
    expect(r.body.hfd.tracking_url).toContain('r-1');
    expect(hfdCalls[0].url).toBe(HFD_HOST + '/rest/v2/shipments/create');

    const stored = db.getCollection(c.id).order.hfd;
    expect(stored.shipment_number).toBe('987654');
    expect(stored.sent_at).toBeTruthy();
  });

  // The sticker has to name the design the shop sells TODAY. `c.design` is the
  // label stamped when the order was placed, so a template renamed since would
  // otherwise go out under a name nobody uses any more.
  it('puts the title and the design’s CURRENT public name on the sticker', async () => {
    const c = seedDelivery('מדבקה שם', ADDRESS, {
      custom_title: 'שירה בת 30',
      // Stale on purpose: themes.json calls this theme סיישל now.
      design: 'טיול חזרה',
      theme: 'trip comeback',
    });
    await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    expect(JSON.parse(hfdCalls[0].init.body).shipmentRemarks).toBe('שירה בת 30 · סיישל');
  });

  it('refuses a SECOND booking — one order, one van', async () => {
    const c = seedDelivery('כפול');
    await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    hfdCalls = [];
    const again = await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    expect(again.status).toBe(409);
    expect(again.body.hfd.shipment_number).toBe('987654');
    // The refusal is ours: HFD is never asked a second time.
    expect(hfdCalls).toHaveLength(0);
  });

  it('400 for an order that is not a delivery, without calling HFD', async () => {
    const c = db.createCollection('איסוף', { email: 'x@example.com' });
    db.setOrder(c.id, c.owner_token, { version: 'pickup' }, { admin: true });
    const r = await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('not a delivery order');
    expect(r.body.message).toBeTruthy();
    expect(hfdCalls).toHaveLength(0);
  });

  it('remembers WHY HFD refused, so the row can say it later', async () => {
    const c = seedDelivery('סירוב');
    hfdAnswer = () => json({ errorMessage: 'עיר לא מוכרת' });
    const r = await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    expect(r.status).toBe(502);
    expect(r.body.message).toBe('עיר לא מוכרת');
    const stored = db.getCollection(c.id).order.hfd;
    expect(stored.error).toBe('עיר לא מוכרת');
    expect(stored.shipment_number).toBeUndefined();
  });
});

describe('GET /api/admin/collections/:id/hfd/label', () => {
  it('streams the sticker as a PDF, and never exposes the token', async () => {
    const c = seedDelivery('מדבקה');
    await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    hfdAnswer = () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => Buffer.from('%PDF-1.4 sticker'),
    });
    const res = await realFetch(base + withKey('/api/admin/collections/' + c.id + '/hfd/label'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString()).toBe('%PDF-1.4 sticker');
    // The bearer token stays server-side: it is a request header to HFD, never
    // anything the browser saw.
    expect(hfdCalls.at(-1).init.headers.Authorization).toBe('Bearer test-token');
  });

  it('404 when the order has no shipment yet', async () => {
    const c = seedDelivery('בלי משלוח');
    const r = await send('GET', withKey('/api/admin/collections/' + c.id + '/hfd/label'));
    expect(r.status).toBe(404);
    expect(hfdCalls).toHaveLength(0);
  });
});

describe('DELETE /api/admin/collections/:id/hfd', () => {
  it('cancels at HFD and KEEPS the number, marked cancelled', async () => {
    const c = seedDelivery('ביטול');
    await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    hfdAnswer = () => json({ status: 'OK' });
    const r = await send('DELETE', withKey('/api/admin/collections/' + c.id + '/hfd'));
    expect(r.status).toBe(200);
    const stored = db.getCollection(c.id).order.hfd;
    expect(stored.cancelled_at).toBeTruthy();
    expect(stored.shipment_number).toBe('987654');
  });

  it('a cancelled order can be booked again', async () => {
    const c = seedDelivery('שוב');
    await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    hfdAnswer = () => json({ status: 'OK' });
    await send('DELETE', withKey('/api/admin/collections/' + c.id + '/hfd'));
    hfdAnswer = () => json({ shipmentNumber: 111222, randNumber: 'r-2' });
    const r = await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    expect(r.status).toBe(200);
    const stored = db.getCollection(c.id).order.hfd;
    expect(stored.shipment_number).toBe('111222');
    expect(stored.cancelled_at).toBe(null);
  });

  it('does not mark an order cancelled when HFD refused to cancel', async () => {
    const c = seedDelivery('סירוב ביטול');
    await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    hfdAnswer = () => json({ status: 'ERROR', status_desc: 'כבר נאסף' });
    const r = await send('DELETE', withKey('/api/admin/collections/' + c.id + '/hfd'));
    expect(r.status).toBe(502);
    expect(r.body.message).toBe('כבר נאסף');
    expect(db.getCollection(c.id).order.hfd.cancelled_at).toBeFalsy();
  });

  it('always says SOMETHING when it refuses — never an empty reason', async () => {
    // The owner reported this one as "it just says הפעולה נכשלה", which is what
    // the page falls back to when the response carries no reason at all. A 502
    // from here must always carry a sentence, even when HFD answers with a body
    // that is not JSON and tells us nothing.
    const c = seedDelivery('סירוב בלי מילים');
    await send('POST', withKey('/api/admin/collections/' + c.id + '/hfd'));
    hfdAnswer = () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      json: async () => {
        throw new Error('not json');
      },
    });
    const r = await send('DELETE', withKey('/api/admin/collections/' + c.id + '/hfd'));
    expect(r.status).toBe(502);
    expect(String(r.body.message || '').trim().length).toBeGreaterThan(0);
    expect(db.getCollection(c.id).order.hfd.cancelled_at).toBeFalsy();
  });
});

describe('GET /api/admin/hfd/status', () => {
  it('tells the admin page the courier is armed, without the token', async () => {
    const r = await send('GET', withKey('/api/admin/hfd/status'));
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('test-token');
  });

  it('403 without the admin key', async () => {
    const r = await send('GET', '/api/admin/hfd/status');
    expect(r.status).toBe(403);
  });
});
