// @vitest-environment node
//
// POST /api/track and the admin report behind it. The route is public — anyone
// can post to it — so most of what matters here is what a caller is NOT allowed
// to do: name its own campaign, name its own revenue, or claim a sale on an
// order it cannot prove it owns.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
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

  // The wizard hands its touch to the collection it creates; the confirmation
  // page is then opened from the email, on a laptop, through Gmail.
  it('credits the sale to how the order was placed, not the browser that paid', async () => {
    const res = await fetch(base + '/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        honoree_name: 'מאיה',
        email: 'a@b.co',
        arrival: { landing: AD + '&k=should-not-be-kept', referrer: '' },
      }),
    });
    expect(res.status).toBe(201);
    const { id, owner_token: token } = await res.json();
    db.setOrder(id, token, { version: 'pdf' });
    db.markPaid(id, { charged_total: 199 });

    await track({
      kind: 'purchase',
      landing: 'https://dugri-israel.co.il/pay-success.html',
      referrer: 'https://mail.google.com/',
      collection: id,
      k: token,
    });
    const { rows } = (await report()).body;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'instagram',
      medium: 'paid',
      campaign: 'rovakot',
      orders: 1,
      revenue: 199,
    });

    // Stored as a parsed touch, never a URL, and set once.
    const arrival = db.getCollection(id).arrival;
    expect(JSON.stringify(arrival)).not.toMatch(/http|should-not-be-kept/);
    expect(db.setArrival(id, { source: 'google', medium: 'referral' })).toBe(false);
    expect(db.getCollection(id).arrival.campaign).toBe('rovakot');
  });

  // An arrival with nothing in it must leave the order UNATTRIBUTED, not carrying a
  // bogus 'direct'. parseTouch always names something, the arrival is first-write-
  // wins, and it outranks the landing at purchase time — so a direct written here
  // would bury, permanently, the real touch the paying browser still has. `[]`
  // matters on its own: typeof [] === 'object', so the route's guard lets it past.
  it('stores nothing for an arrival that carries no evidence', async () => {
    for (const arrival of ['instagram', [], {}, { landing: '', referrer: '' }, 7, null]) {
      const res = await fetch(base + '/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ honoree_name: 'נועה', email: 'a@b.co', arrival }),
      });
      expect(res.status).toBe(201);
      const stored = db.getCollection((await res.json()).id).arrival;
      expect({ arrival, stored }).toEqual({ arrival, stored: null });
    }
  });

  // saveDb serialises the WHOLE store and writes it — ~300ms at a thousand orders.
  // The arrival rides along in createCollection's own save; a second write for it
  // would double that cost on the request path of every lead.
  it('writes the store once for a lead that reports an arrival', async () => {
    const renames = [];
    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('dugri-data.json')) renames.push(String(to));
      return realRename(from, to);
    });
    try {
      const c = db.createCollection('מאיה', {
        email: 'a@b.co',
        arrival: attribution.arrivalTouch({ landing: AD }),
      });
      expect(renames).toHaveLength(1);
      expect(db.getCollection(c.id).arrival).toMatchObject({
        source: 'instagram',
        campaign: 'rovakot',
      });
    } finally {
      spy.mockRestore();
    }
  });

  // Both spellings of the order pages are SERVED (express.static extensions:['html']
  // plus the HTML route ahead of it), which is why attribution.js lists both in
  // OWN_LINK_PATHS. If one ever stopped resolving, the entry would become dead and
  // the comment beside it wrong.
  it('serves the order pages by their extension-less names too', async () => {
    for (const p of ['/collect', '/collect.html', '/pay-success', '/pay-success.html']) {
      const res = await fetch(base + p);
      expect({ p, status: res.status }).toEqual({ p, status: 200 });
    }
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

// Events are queued in memory for up to a second and a half, and Railway ends
// the old container with SIGTERM on every deploy. Node's default action for that
// signal runs no exit handler at all, so unless the server handles it the queue
// goes with the container — and a deploy is exactly when the owner is watching
// this page.
describe('the ledger survives a shutdown', () => {
  it('writes what is queued when the process is told to stop', async () => {
    const file = path.join(process.env.DATA_DIR, 'attribution-events.json');
    fs.rmSync(file, { force: true });
    // A visit that is now queued and not yet on disk (the throttle is seconds
    // away, and nothing else is going to fire it).
    await track({ kind: 'visit', landing: AD, visitor: 'v-shutdown' });
    expect(fs.existsSync(file)).toBe(false);

    expect(process.listeners('SIGTERM').length).toBeGreaterThan(0);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      process.emit('SIGTERM');
      expect(exit).toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.some((e) => e.v === 'v-shutdown')).toBe(true);
  });
});
