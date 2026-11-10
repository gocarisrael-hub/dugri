// @vitest-environment node
// ONE price: the number the shop shows is the number we charge.
//
// Production once showed 259 while buyers paid 239, because the display price
// (`store_now`) was its own setting, edited apart from the charged per-copy price
// (`pickup_price`). The display key is gone; GET /api/pricing `store.now`, the
// sale banner and its "is this a real discount" check, and the SEO Offer all
// derive from pickup_price.
//
// The volume of every environment that ran the old build may still hold a stored
// `pricing.store_now` override (prod held 259). These tests start from exactly
// that file and prove the stale value reaches nothing, and that the admin routes
// the pricing page uses still work around it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;
const ADMIN_KEY = 'test-one-price-key';
const PROD = 'dugri-israel.co.il';
// A value that appears nowhere else in the defaults, so "259" in any output can
// only have come from the stale override.
const STALE = 259;

let settings;
let db;
let server;
let base;
let dir;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-one-price-'));
  process.env.DATA_DIR = dir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  // The bug's own state: the owner raised the display price only.
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      pricing: {
        store_now: STALE,
        pickup_price: 239,
        store_was: 299,
        sale_banner: '{now} ₪ במקום {was} ₪, חוסכים {saving}',
      },
    }),
    'utf8'
  );
  for (const f of ['db.js', 'settings.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  db = require(path.join(serverDir, 'db.js'));
  const app = require(path.join(serverDir, 'index.js'));
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

const admin = (p) => base + p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;
async function pricing() {
  return (await realFetch(base + '/api/pricing')).json();
}
async function post(key, value) {
  const r = await realFetch(admin('/api/admin/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'pricing', key, value }),
  });
  return { status: r.status, body: await r.json() };
}
async function del(key) {
  const r = await realFetch(admin('/api/admin/settings?section=pricing&settingKey=' + key), {
    method: 'DELETE',
  });
  return { status: r.status, body: await r.json() };
}

describe('a stale store_now override on the volume is inert', () => {
  it('the shop shows the charged price, not the stale display price', async () => {
    const p = await pricing();
    expect(p.store.now).toBe(239);
    expect(p.versions.pickup.price).toBe(239);
    expect(p.store.now).toBe(p.versions.pickup.price);
    expect(JSON.stringify(p)).not.toContain(String(STALE));
  });

  it('the banner and the sale check use the charged price', async () => {
    const p = await pricing();
    expect(p.sale.banner).toBe('239 ₪ במקום 299 ₪, חוסכים 60');
    expect(p.sale.on).toBe(true);
  });

  it('the SEO Offer on the production home page carries the charged price', async () => {
    const html = await (
      await realFetch(base + '/', { headers: { 'x-forwarded-host': PROD } })
    ).text();
    const ld = JSON.parse(html.match(/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const product = ld['@graph'].find((n) => n['@type'] === 'Product');
    expect(product.offers.price).toBe('239');
    const llms = await (
      await realFetch(base + '/llms.txt', { headers: { 'x-forwarded-host': PROD } })
    ).text();
    expect(llms).toContain('מחיר: 239 ₪');
  });

  it('the admin settings view lists no store_now among the editable values', async () => {
    const all = await (await realFetch(admin('/api/admin/settings'))).json();
    expect(all.effective.pricing).not.toHaveProperty('store_now');
    expect(all.registry.pricing).not.toHaveProperty('store_now');
    expect(all.effective.pricing.pickup_price).toBe(239);
  });

  it('store_now can no longer be set or reset (unknown key), and that changes nothing', async () => {
    expect((await post('store_now', 199)).status).toBe(400);
    expect((await del('store_now')).status).toBe(400);
    expect((await pricing()).store.now).toBe(239);
  });

  it('the store card save and reset (store_was only) still work beside the stale key', async () => {
    const saved = await post('store_was', 279);
    expect(saved.status).toBe(200);
    expect((await pricing()).store.was).toBe(279);
    const reset = await del('store_was');
    expect(reset.status).toBe(200);
    expect(reset.body.effective).toBe(239);
    // Reset restored the default 239, equal to the charged 239: no fake discount.
    expect((await pricing()).sale.on).toBe(false);
  });

  it('a staging mirror (replaceOverrides) drops the stale key instead of failing', () => {
    const out = settings.replaceOverrides(settings.exportOverrides());
    expect(out.pricing).not.toHaveProperty('store_now');
    expect(out.pricing.pickup_price).toBe(239);
  });
});

describe('changing pickup_price moves every shown price with it', () => {
  it('store.now, the banner and the sale check all follow pickup_price', async () => {
    expect((await post('store_was', 299)).status).toBe(200);
    expect((await post('pickup_price', 259)).status).toBe(200);
    let p = await pricing();
    expect(p.store.now).toBe(259);
    expect(p.versions.pickup.price).toBe(259);
    expect(p.sale.banner).toBe('259 ₪ במקום 299 ₪, חוסכים 40');
    expect(p.sale.on).toBe(true);
    expect(db.effectivePricing().store.now).toBe(259);

    // Raised to the struck price: the discount is gone, so the sale goes quiet.
    expect((await post('pickup_price', 299)).status).toBe(200);
    p = await pricing();
    expect(p.store.now).toBe(299);
    expect(p.sale.on).toBe(false);
  });

  it('an order is charged the same number the shop shows', async () => {
    const shown = (await pricing()).store.now;
    const c = db.createCollection('אחד המחירים');
    const o = db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    expect(o.total).toBe(shown);
  });
});
