// @vitest-environment node
//
// POST /api/track and the admin report behind it. The route is public — anyone
// can post to it — so most of what matters here is what a caller is NOT allowed
// to do: name its own campaign, name its own revenue, or claim a sale on an
// order it cannot prove it owns.
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
const AD = 'https://dugri-israel.co.il/?utm_source=instagram&utm_medium=paid&utm_campaign=rovakot';

let app;
let db;
let attribution;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-track-routes-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['db.js', 'settings.js', 'attribution.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery']) settings.set('pricing', v + '_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  attribution = require(path.join(serverDir, 'attribution.js'));
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
});

beforeEach(() => {
  attribution._setEvents([]);
});

async function track(body) {
  const res = await fetch(base + '/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.status;
}

async function report(qs = '') {
  const res = await fetch(base + '/api/admin/ads?key=' + ADMIN_KEY + qs);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// A real paid order, made the way the app makes one.
function paidOrder({ total = 199 } = {}) {
  const c = db.createCollection('שירה', { email: 'a@b.co' });
  db.setOrder(c.id, c.owner_token, { version: 'pdf' });
  db.markPaid(c.id, { charged_total: total });
  return db.getCollection(c.id);
}

describe('POST /api/track', () => {
  it('records a visit under the campaign parsed from the landing URL', async () => {
    expect(await track({ kind: 'visit', landing: AD, visitor: 'v1' })).toBe(204);
    const { body } = await report();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      source: 'instagram',
      medium: 'paid',
      campaign: 'rovakot',
      visits: 1,
    });
  });

  // The browser sends the URL it arrived on, nothing else. A payload that tries
  // to declare its own source/campaign is not consulted: the parse happens on
  // the server, from the URL, and there is no other way in.
  it('ignores a campaign a caller tries to declare for itself', async () => {
    await track({
      kind: 'visit',
      landing: 'https://dugri-israel.co.il/',
      visitor: 'v1',
      source: 'instagram',
      medium: 'paid',
      campaign: 'not-mine',
    });
    const { body } = await report();
    expect(body.rows[0]).toMatchObject({ source: 'direct', medium: 'none', campaign: '' });
  });

  it('refuses an unknown event kind without saying so', async () => {
    expect(await track({ kind: 'admin_visit', landing: AD })).toBe(204);
    expect((await report()).body.rows).toHaveLength(0);
  });
});

describe('POST /api/track — a purchase', () => {
  it('takes the amount from the order store, not from the caller', async () => {
    const c = paidOrder({ total: 199 });
    expect(
      await track({
        kind: 'purchase',
        landing: AD,
        collection: c.id,
        k: c.owner_token,
        value: 99999,
      })
    ).toBe(204);
    const { body } = await report();
    expect(body.totals).toMatchObject({ orders: 1, revenue: 199 });
  });

  // Knowing a collection id is not enough. The confirmation page holds the owner
  // token anyway (it needs it for the summary), so requiring it costs nothing and
  // stops a guessed id from writing a sale into the report.
  it('records nothing without the order’s own owner token', async () => {
    const c = paidOrder();
    expect(await track({ kind: 'purchase', landing: AD, collection: c.id, k: 'wrong' })).toBe(204);
    expect(await track({ kind: 'purchase', landing: AD, collection: c.id })).toBe(204);
    expect((await report()).body.totals.orders).toBe(0);
  });

  it('records nothing for an order that was never paid', async () => {
    const c = db.createCollection('דנה', { email: 'a@b.co' });
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    const col = db.getCollection(c.id);
    expect(
      await track({ kind: 'purchase', landing: AD, collection: col.id, k: col.owner_token })
    ).toBe(204);
    expect((await report()).body.totals.orders).toBe(0);
  });

  it('records nothing for a collection that does not exist', async () => {
    expect(await track({ kind: 'purchase', landing: AD, collection: 'nope', k: 'nope' })).toBe(204);
    expect((await report()).body.totals.orders).toBe(0);
  });

  it('counts one sale however many times the confirmation page is opened', async () => {
    const c = paidOrder({ total: 239 });
    for (let i = 0; i < 4; i++) {
      await track({ kind: 'purchase', landing: AD, collection: c.id, k: c.owner_token });
    }
    expect((await report()).body.totals).toMatchObject({ orders: 1, revenue: 239 });
  });
});

describe('the report is admin-only', () => {
  it('refuses both report endpoints without the admin key', async () => {
    const a = await fetch(base + '/api/admin/ads');
    const b = await fetch(base + '/api/admin/ads/live');
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
  });

  it('serves the live feed newest-first for the admin', async () => {
    await track({ kind: 'visit', landing: AD, visitor: 'v1' });
    await track({ kind: 'checkout', landing: AD, visitor: 'v1' });
    const res = await fetch(base + '/api/admin/ads/live?key=' + ADMIN_KEY);
    const body = await res.json();
    expect(body.events.map((e) => e.k)).toEqual(['checkout', 'visit']);
  });

  it('honours the days window', async () => {
    attribution.record({
      kind: 'visit',
      landing: AD,
      visitor: 'old',
      at: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await track({ kind: 'visit', landing: AD, visitor: 'new' });
    expect((await report('&days=7')).body.totals.visits).toBe(1);
    expect((await report('&days=90')).body.totals.visits).toBe(2);
  });
});
