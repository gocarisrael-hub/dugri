// @vitest-environment node
// Sale mode at the SERVER: the owner's one switch, projected onto /api/pricing.
//
// Two conditions must both hold for the storefront to advertise a sale, and the
// second one is the point of these tests: `store_was` is display-only and freely
// editable, so a switch alone would let a typo (or a `store_now` raised past a
// stale `store_was`) put a struck-through price on the site that saves the buyer
// nothing. db.saleInfo() fails closed on that, and every surface reads this one
// flag — so they all go quiet together.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;
const ADMIN_KEY = 'test-sale-key';
const KEYS = ['store_now', 'store_was', 'sale_on', 'sale_label', 'sale_banner'];

let app;
let settings;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-sale-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['db.js', 'settings.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
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
  for (const k of KEYS) settings.reset('pricing', k);
});

async function pricing() {
  const res = await realFetch(base + '/api/pricing');
  return res.json();
}
async function setKey(key, value) {
  const res = await realFetch(base + '/api/admin/settings?key=' + ADMIN_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'pricing', key, value }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('GET /api/pricing — the sale projection', () => {
  it('ships ON out of the box, matching the storefront the site already had', async () => {
    const p = await pricing();
    expect(p.sale.on).toBe(true);
    expect(p.sale.label).toBe('מחיר השקה');
  });

  it('interpolates the live prices into the banner ({now}/{was}/{saving})', async () => {
    await setKey('sale_banner', 'השקה: {now} במקום {was}, חוסכים {saving}');
    const p = await pricing();
    expect(p.sale.banner).toBe('השקה: 199 במקום 239, חוסכים 40');
  });

  it('re-interpolates after a price change — the banner text needs no re-edit', async () => {
    await setKey('sale_banner', '{now} במקום {was}');
    await setKey('store_now', 249);
    const p = await pricing();
    expect(p.sale.banner).toBe('249 במקום 239');
  });

  it('an empty banner keeps the sale on — it only drops the home strip', async () => {
    await setKey('sale_banner', '');
    const p = await pricing();
    expect(p.sale.on).toBe(true);
    expect(p.sale.banner).toBe('');
  });

  it('the switch off reports no sale (the prices themselves still travel)', async () => {
    await setKey('sale_on', false);
    const p = await pricing();
    expect(p.sale.on).toBe(false);
    // store.was is display DATA, not a claim — the client decides from sale.on
    // alone, so the number keeps travelling.
    expect(p.store).toEqual({ now: 199, was: 239 });
  });

  it('refuses to advertise a sale when the struck price is not higher (was === now)', async () => {
    await setKey('store_was', 199);
    const p = await pricing();
    expect(p.sale.on).toBe(false);
  });

  it('refuses to advertise a sale when the struck price is LOWER than the price shown', async () => {
    await setKey('store_now', 299);
    const p = await pricing();
    expect(p.store).toEqual({ now: 299, was: 239 });
    expect(p.sale.on).toBe(false);
  });
});

describe('the sale text keys are validated before they reach the storefront', () => {
  it('accepts a normal label', async () => {
    expect((await setKey('sale_label', 'מבצע קיץ')).status).toBe(200);
    expect((await pricing()).sale.label).toBe('מבצע קיץ');
  });

  it('rejects a multi-line value (these render in one-line slots)', async () => {
    const r = await setKey('sale_banner', 'שורה\nשנייה');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('value must be a single line');
  });

  it('rejects an over-long label', async () => {
    const r = await setKey('sale_label', 'א'.repeat(41));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('value must be at most 40 characters');
  });

  it('rejects a non-string (a bad write can never blank the label)', async () => {
    const r = await setKey('sale_label', 7);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('value must be a string');
    expect((await pricing()).sale.label).toBe('מחיר השקה');
  });
});
