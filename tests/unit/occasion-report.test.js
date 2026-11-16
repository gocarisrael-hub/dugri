// @vitest-environment node
//
// "Orders by occasion page" (server/occasion-report.js, GET /api/admin/ads/occasions)
// and what feeds it: the occasion slug on the order (POST /api/collections →
// db.createCollection), the occasion on a visit (POST /api/track → the ledger's
// `oc`), and the wizard's slug → label list (GET /api/occasions), which is read
// from the occasion data files and nowhere else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const { occasionReport } = require(path.join(serverDir, 'occasion-report.js'));

const NOW = Date.parse('2026-11-16T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const PAGES = [
  { slug: 'yom-huledet', label: 'יום הולדת לאמא' },
  { slug: 'yom-huledet-aba', label: 'יום הולדת לאבא' },
];

describe('occasionReport (pure)', () => {
  const order = (over = {}) => ({
    occasion: 'yom-huledet',
    created_at: daysAgo(3),
    order: null,
    ...over,
  });

  it('counts visits, orders started, paid orders and revenue per slug, in the window', () => {
    const out = occasionReport({
      now: NOW,
      days: 30,
      pages: PAGES,
      visits: { 'yom-huledet': 40, 'yom-huledet-aba': 7 },
      collections: [
        order(), // started, unpaid
        order({ order: { paid: true, paid_at: daysAgo(2), total: 199, charged_total: 179 } }),
        order({ order: { paid: true, paid_at: daysAgo(1), total: 239 } }), // no charge recorded
        order({ created_at: daysAgo(40) }), // started before the window
        order({
          created_at: daysAgo(40),
          order: { paid: true, paid_at: daysAgo(35), total: 199 }, // paid before it too
        }),
        order({ occasion: 'yom-huledet-aba' }),
        { created_at: daysAgo(1), order: { paid: true, paid_at: daysAgo(1), total: 199 } }, // no page
      ],
    });
    const mom = out.rows.find((r) => r.slug === 'yom-huledet');
    expect(mom).toEqual({
      slug: 'yom-huledet',
      label: 'יום הולדת לאמא',
      live: true,
      visits: 40,
      started: 3,
      paid: 2,
      // the charge where there is one, the total where there is none (attribution.orderValue)
      revenue: 179 + 239,
    });
    const dad = out.rows.find((r) => r.slug === 'yom-huledet-aba');
    expect(dad).toMatchObject({ visits: 7, started: 1, paid: 0, revenue: 0 });
    expect(out.totals).toEqual({ visits: 47, started: 4, paid: 2, revenue: 418 });
    expect(out.days).toBe(30);
    // money first
    expect(out.rows[0].slug).toBe('yom-huledet');
  });

  it('an order paid in the window counts as paid even when it started before it', () => {
    const out = occasionReport({
      now: NOW,
      days: 7,
      pages: PAGES,
      collections: [
        order({ created_at: daysAgo(10), order: { paid: true, paid_at: daysAgo(2), total: 199 } }),
      ],
    });
    expect(out.rows.find((r) => r.slug === 'yom-huledet')).toMatchObject({
      started: 0,
      paid: 1,
      revenue: 199,
    });
  });

  it('every live page has a row from day one, and a page taken down keeps its orders', () => {
    const out = occasionReport({
      now: NOW,
      pages: PAGES,
      collections: [order({ occasion: 'pensia' })],
    });
    expect(out.rows.map((r) => r.slug).sort()).toEqual([
      'pensia',
      'yom-huledet',
      'yom-huledet-aba',
    ]);
    expect(out.rows.find((r) => r.slug === 'pensia')).toMatchObject({ live: false, started: 1 });
  });

  it('leaves out orders placed from our own addresses, like the ad report', () => {
    const out = occasionReport({
      now: NOW,
      pages: PAGES,
      collections: [
        order({
          arrival: { source: 'direct', i: 1 },
          order: { paid: true, paid_at: daysAgo(1), total: 199 },
        }),
        order({ arrival: { source: 'google', i: 0 } }),
      ],
    });
    expect(out.rows.find((r) => r.slug === 'yom-huledet')).toMatchObject({
      started: 1,
      paid: 0,
      revenue: 0,
    });
  });
});

describe('the routes', () => {
  const ADMIN_KEY = 'test-admin-key';
  let server;
  let base;
  let db;
  let attribution;

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-occasion-report-'));
    process.env.ADMIN_KEY = ADMIN_KEY;
    for (const k of Object.keys(require.cache))
      if (k.startsWith(serverDir)) delete require.cache[k];
    const app = require(path.join(serverDir, 'index.js'));
    db = require(path.join(serverDir, 'db.js'));
    attribution = require(path.join(serverDir, 'attribution.js'));
    await new Promise((res) => {
      server = app.listen(0, res);
    });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(async () => {
    if (server) await new Promise((res) => server.close(res));
  });

  const post = (p, body) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET /api/occasions lists the live pages with the labels of their data files', async () => {
    const occasions = require(path.join(serverDir, 'occasions.js'));
    const r = await fetch(base + '/api/occasions');
    expect(r.status).toBe(200);
    const { occasions: list } = await r.json();
    expect(list.length).toBeGreaterThan(0);
    expect(list).toEqual(
      occasions.live().map((o) => ({ slug: o.slug, label: o.label, audience: o.audience }))
    );
    for (const o of list) {
      const file = JSON.parse(
        fs.readFileSync(path.join(serverDir, 'occasions', o.slug + '.json'), 'utf8')
      );
      expect(o.label).toBe(file.label);
    }
  });

  it('an order keeps the slug of a real occasion page, and nothing else', async () => {
    const make = async (occasion) => {
      const r = await post('/api/collections', {
        honoree_name: 'שירה',
        email: 'occ@example.com',
        occasion,
      });
      expect(r.status).toBe(201);
      return db.getCollection((await r.json()).id);
    };
    expect((await make('yom-huledet')).occasion).toBe('yom-huledet');
    expect((await make('no-such-page')).occasion).toBe(null);
    expect((await make('__proto__')).occasion).toBe(null);
    expect((await make({ slug: 'yom-huledet' })).occasion).toBe(null);
    expect((await make(undefined)).occasion).toBe(null);
  });

  it('a visit made on an occasion page is counted for it; a made-up page is not', async () => {
    const visit = (visitor, occasion) =>
      post('/api/track', {
        kind: 'visit',
        landing: 'https://dugri-israel.co.il/yom-huledet',
        referrer: 'https://www.google.com/',
        visitor,
        occasion,
      });
    await visit('v-occ-1', 'yom-huledet-aba');
    await visit('v-occ-1', 'yom-huledet-aba'); // the same visitor again
    await visit('v-occ-2', 'yom-huledet-aba');
    await visit('v-occ-3', 'invented-page');
    expect(attribution.occasionVisits({ days: 30 })).toMatchObject({ 'yom-huledet-aba': 2 });
    expect(attribution.occasionVisits({ days: 30 })['invented-page']).toBeUndefined();
    // a checkout cannot carry one
    await post('/api/track', { kind: 'checkout', visitor: 'v-occ-4', occasion: 'yom-huledet-aba' });
    expect(attribution.recent(1)[0].oc).toBeUndefined();
  });

  it('GET /api/admin/ads/occasions is the admin’s, and answers per page', async () => {
    expect((await fetch(base + '/api/admin/ads/occasions')).status).toBe(403);
    const r = await fetch(base + '/api/admin/ads/occasions?days=30&key=' + ADMIN_KEY);
    expect(r.status).toBe(200);
    const out = await r.json();
    const dad = out.rows.find((row) => row.slug === 'yom-huledet-aba');
    expect(dad).toMatchObject({ label: 'יום הולדת לאבא', visits: 2 });
    const mom = out.rows.find((row) => row.slug === 'yom-huledet');
    expect(mom.started).toBeGreaterThanOrEqual(1);
    expect(out.days).toBe(30);
  });
});

describe('attribution.orderValue — the one rule every report credits a sale with', () => {
  const { orderValue } = require(path.join(serverDir, 'attribution.js'));
  it('is the charge, or the total where no charge was recorded', () => {
    expect(orderValue({ total: 199, charged_total: 0 })).toBe(0); // a 100% coupon charged nothing
    expect(orderValue({ total: 199, charged_total: 238 })).toBe(238); // + a delivery upgrade
    expect(orderValue({ total: 199 })).toBe(199);
    expect(orderValue({})).toBe(null);
    expect(orderValue(null)).toBe(null);
  });
});
