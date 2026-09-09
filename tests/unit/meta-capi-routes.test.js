// @vitest-environment node
//
// The Conversions API where it meets the app: a paid order reported to Meta from
// the server, once, with the money read from the order store — and NOT reported
// at all when the owner has not armed it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
const PIXEL = '1234567890123456';
const AD = 'https://dugri-israel.co.il/?fbclid=IwAR_abc&utm_source=instagram&utm_medium=paid';

let app;
let db;
let settings;
let attribution;
let server;
let base;
let realFetch;
let sent; // every call Meta would have received

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-capi-routes-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.META_CAPI_TOKEN = 'EAA-test-token';
  delete process.env.META_CAPI_TEST_CODE;
  for (const f of ['db.js', 'settings.js', 'attribution.js', 'meta-capi.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery']) settings.set('pricing', v + '_enabled', true);
  settings.set('analytics', 'meta_pixel_id', PIXEL);
  db = require(path.join(serverDir, 'db.js'));
  attribution = require(path.join(serverDir, 'attribution.js'));
  app = require(path.join(serverDir, 'index.js'));

  realFetch = globalThis.fetch;
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
  delete process.env.META_CAPI_TOKEN;
});

beforeEach(() => {
  sent = [];
  attribution._setEvents([]);
  // Only graph.facebook.com is intercepted; the test's own requests to the app
  // must still reach it.
  vi.stubGlobal('fetch', async (url, opts) => {
    if (String(url).includes('graph.facebook.com')) {
      sent.push({ url: String(url), body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
    }
    return realFetch(url, opts);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  settings.set('analytics', 'meta_capi_contact', false);
});

async function track(body) {
  const res = await realFetch(base + '/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.status;
}

function paidOrder({ total = 199, email = 'shira@example.com', phone = '052-244-1334' } = {}) {
  const c = db.createCollection('שירה', { email, phone });
  db.setOrder(c.id, c.owner_token, { version: 'pdf' });
  db.markPaid(c.id, { charged_total: total });
  return db.getCollection(c.id);
}

// The send is deliberately not awaited by the route (the buyer is waiting for a
// 204), so the assertion has to give it a moment to land.
const settle = () => vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 2000 });

describe('a paid order reaches Meta from the server', () => {
  it('sends a Purchase carrying the order number as the dedupe key', async () => {
    const c = paidOrder({ total: 238 });
    expect(await track({ kind: 'purchase', landing: AD, collection: c.id, k: c.owner_token })).toBe(
      204
    );
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/' + PIXEL + '/events');
    const event = sent[0].body.data[0];
    expect(event.event_name).toBe('Purchase');
    expect(event.event_id).toBe(db.orderRef(c));
    // The amount is the one on the order, never the one a caller offered.
    expect(event.custom_data).toEqual({ value: 238, currency: 'ILS' });
    expect(event.user_data.fbc).toContain('IwAR_abc');
  });

  it('sends the sale once, however many times the confirmation page is opened', async () => {
    const c = paidOrder();
    for (let i = 0; i < 4; i++) {
      await track({ kind: 'purchase', landing: AD, collection: c.id, k: c.owner_token });
    }
    await settle();
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(1);
  });

  it('sends nothing for an order that cannot be proved, or was never paid', async () => {
    const paid = paidOrder();
    await track({ kind: 'purchase', landing: AD, collection: paid.id, k: 'wrong-token' });
    const unpaid = db.createCollection('דנה', { email: 'a@b.co' });
    db.setOrder(unpaid.id, unpaid.owner_token, { version: 'pdf' });
    const u = db.getCollection(unpaid.id);
    await track({ kind: 'purchase', landing: AD, collection: u.id, k: u.owner_token });
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(0);
  });

  it('sends nothing for a visit or a checkout — only a sale is a conversion', async () => {
    await track({ kind: 'visit', landing: AD, visitor: 'v1' });
    await track({ kind: 'checkout', landing: AD, visitor: 'v1' });
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(0);
  });
});

describe('contact matching is the owner’s decision', () => {
  it('sends no email or phone while the switch is off', async () => {
    const c = paidOrder();
    await track({ kind: 'purchase', landing: AD, collection: c.id, k: c.owner_token });
    await settle();
    const user = sent[0].body.data[0].user_data;
    expect(user.em).toBeUndefined();
    expect(user.ph).toBeUndefined();
    expect(JSON.stringify(sent[0].body)).not.toContain('shira@example.com');
  });

  it('sends them hashed — never in the clear — once she switches it on', async () => {
    settings.set('analytics', 'meta_capi_contact', true);
    const c = paidOrder();
    await track({ kind: 'purchase', landing: AD, collection: c.id, k: c.owner_token });
    await settle();
    const user = sent[0].body.data[0].user_data;
    const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
    expect(user.em).toEqual([sha('shira@example.com')]);
    expect(user.ph).toEqual([sha('972522441334')]);
    const raw = JSON.stringify(sent[0].body);
    expect(raw).not.toContain('shira@example.com');
    expect(raw).not.toContain('2441334');
  });
});

describe('the status endpoint', () => {
  it('says it is armed without ever returning the token', async () => {
    const res = await realFetch(base + '/api/admin/meta-capi/status?key=' + ADMIN_KEY);
    const body = await res.json();
    expect(body).toMatchObject({ armed: true, has_pixel: true, has_token: true });
    expect(JSON.stringify(body)).not.toContain('EAA-test-token');
  });

  it('is admin-only', async () => {
    expect((await realFetch(base + '/api/admin/meta-capi/status')).status).toBe(403);
  });
});
