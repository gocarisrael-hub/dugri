// @vitest-environment node
// The owner-editable pricing feature end-to-end at the server:
//   1. GET /api/pricing (PUBLIC): the whitelisted store + versions projection,
//      defaults out of the box, reflecting an admin override, leaking nothing else.
//   2. The authoritative charge path (server/db.js setOrder + the /order route):
//      charges the settings price, rejects a DISABLED version, still requires a
//      delivery address, and a coupon discounts off the settings price.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;
const ADMIN_KEY = 'test-admin-key';

let app;
let db;
let settings;
let server;
let base;

let nextInit = null;
let lastInitTotal = null; // agorot POSTed to /PaymentGW/init

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

// All ten pricing keys, so beforeEach can restore a pristine default state.
const PRICING_KEYS = [
  'store_now',
  'store_was',
  'pdf_enabled',
  'pdf_price',
  'pickup_enabled',
  'pickup_price',
  'delivery_enabled',
  'delivery_price',
  'custom_enabled',
  'custom_price',
];

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pricing-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['db.js', 'pelecard.js', 'settings.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('/PaymentGW/init')) {
        try {
          lastInitTotal = JSON.parse(opts.body).Total;
        } catch {
          lastInitTotal = null;
        }
        return jsonRes(nextInit);
      }
      throw new Error('unexpected fetch ' + u);
    })
  );

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (server) server.close();
});

// Restore pristine defaults before every test so each one is independent.
beforeEach(() => {
  for (const k of PRICING_KEYS) settings.reset('pricing', k);
  nextInit = {
    URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=tx-price',
    Error: { ErrCode: 0 },
  };
  lastInitTotal = null;
});

async function get(urlPath) {
  const res = await realFetch(base + urlPath);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}
const adminUrl = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;
function freshCollection() {
  return db.createCollection('בדיקת מחיר', { design: 'יום הולדת', color: 'ירוק' });
}

describe('GET /api/pricing (public)', () => {
  it('is reachable without an admin key and returns the launch defaults', async () => {
    const { status, body } = await get('/api/pricing');
    expect(status).toBe(200);
    expect(body.store).toEqual({ now: 199, was: 239 });
    expect(body.versions.pdf).toEqual({ enabled: false, price: 79 });
    expect(body.versions.pickup).toEqual({ enabled: true, price: 199 });
    expect(body.versions.delivery).toEqual({ enabled: false, price: 199 });
    expect(body.versions.custom).toEqual({ enabled: false, price: 599 });
  });

  it('exposes ONLY the pricing projection — no other settings section leaks', async () => {
    const { body } = await get('/api/pricing');
    // Exactly the two whitelisted top-level keys.
    expect(Object.keys(body).sort()).toEqual(['store', 'versions']);
    // Exactly the four known versions, each just { enabled, price }.
    expect(Object.keys(body.versions).sort()).toEqual(['custom', 'delivery', 'pdf', 'pickup']);
    for (const v of Object.values(body.versions)) {
      expect(Object.keys(v).sort()).toEqual(['enabled', 'price']);
    }
    // None of the other settings sections (email/wa) appear anywhere.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('subject');
    expect(serialized).not.toContain('trigger');
  });

  it('reflects an admin override', async () => {
    await post(adminUrl('/api/admin/settings'), {
      section: 'pricing',
      key: 'store_now',
      value: 249,
    });
    await post(adminUrl('/api/admin/settings'), {
      section: 'pricing',
      key: 'pdf_enabled',
      value: true,
    });
    const { body } = await get('/api/pricing');
    expect(body.store.now).toBe(249);
    expect(body.versions.pdf.enabled).toBe(true);
    // Untouched keys keep their defaults.
    expect(body.store.was).toBe(239);
    expect(body.versions.pickup).toEqual({ enabled: true, price: 199 });
  });

  it('the admin API refuses to set a version price to 0 (a 0 total would be a free order)', async () => {
    const r = await post(adminUrl('/api/admin/settings'), {
      section: 'pricing',
      key: 'pickup_price',
      value: 0,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('value must be a positive integer');
    // The endpoint still shows (and the server still charges) the real price.
    const { body } = await get('/api/pricing');
    expect(body.versions.pickup.price).toBe(199);
  });
});

describe('charge path reads settings (db.setOrder + /order route)', () => {
  it('charges the default pickup price (199)', async () => {
    const c = freshCollection();
    const o = db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    expect(o.total).toBe(199);
  });

  it('charges the OVERRIDDEN pickup price', async () => {
    settings.set('pricing', 'pickup_price', 249);
    const c = freshCollection();
    expect(db.setOrder(c.id, c.owner_token, { version: 'pickup' }).total).toBe(249);
  });

  it('rejects a DISABLED version with 400 via the /order route', async () => {
    const c = freshCollection();
    // pdf/delivery/custom are all disabled by default.
    for (const version of ['pdf', 'delivery', 'custom']) {
      const r = await post('/api/collections/' + c.id + '/order', {
        owner_token: c.owner_token,
        version,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('version unavailable');
    }
  });

  it('accepts a version once the owner enables it', async () => {
    settings.set('pricing', 'pdf_enabled', true);
    const c = freshCollection();
    const r = await post('/api/collections/' + c.id + '/order', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ version: 'pdf', total: 79 });
  });

  it('still requires a delivery address when delivery is enabled', async () => {
    settings.set('pricing', 'delivery_enabled', true);
    const c = freshCollection();
    // No address → rejected.
    expect(db.setOrder(c.id, c.owner_token, { version: 'delivery' }).error).toBe(
      'address required'
    );
    // With a full address → priced at the settings delivery price.
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' },
    });
    expect(o.total).toBe(199);
    expect(o.address.city).toBe('תל אביב');
  });

  it('a coupon discounts off the settings price (not a hardcoded one)', async () => {
    db.createCoupon({ code: 'HALF', discount_pct: 50 });
    const c = freshCollection();
    // Default pickup = 199; a 50% coupon charges round(199 * 0.5) = 100.
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
      coupon: 'HALF',
    });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(199);
    expect(r.body.charged).toBe(100);
    // The amount actually sent to the gateway (agorot) matches the discount.
    expect(lastInitTotal).toBe(10000);
  });

  it('the free/skip-charge path is reachable ONLY via a coupon (a 100% coupon), never a base price', async () => {
    // A 100% coupon zeroes the charge → the free path marks it paid, no PeleCard.
    db.createCoupon({ code: 'ALLFREE', discount_pct: 100 });
    const c = freshCollection();
    const free = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pickup',
      coupon: 'ALLFREE',
    });
    expect(free.status).toBe(200);
    expect(free.body).toEqual({ free: true, paid: true, total: 0 });
    // Without a coupon the base pickup total is 199 (never 0) — a real charge.
    const c2 = freshCollection();
    const paid = await post('/api/collections/' + c2.id + '/pay/init', {
      owner_token: c2.owner_token,
      version: 'pickup',
    });
    expect(paid.status).toBe(200);
    expect(paid.body.charged).toBe(199);
    expect(paid.body.free).toBeUndefined();
  });

  it('setOrder admin bypass creates a disabled version; a public downgrade of it is locked', async () => {
    // custom is disabled by default. The admin bypass creates it anyway...
    const c = freshCollection();
    expect(db.setOrder(c.id, c.owner_token, { version: 'custom' }).error).toBe(
      'version unavailable'
    );
    const created = db.setOrder(c.id, c.owner_token, { version: 'custom' }, { admin: true });
    expect(created.version).toBe('custom');
    expect(created.total).toBe(599);
    // ...and a public caller can't downgrade the locked order to a cheaper version.
    expect(db.setOrder(c.id, c.owner_token, { version: 'pickup' }).error).toBe('version locked');
    expect(db.getCollection(c.id).order.total).toBe(599);
  });
});

// The public collection view drives collect.html's checkout: a `locked` flag +
// (owner-only) the delivery address so a locked order can be prefilled on reload.
describe('GET /api/collections/:id — order projection (locked + owner address)', () => {
  it('marks an admin-created order locked; an ordinary unpaid public order is NOT locked', async () => {
    const admin = freshCollection();
    db.setOrder(admin.id, admin.owner_token, { version: 'custom' }, { admin: true });
    const av = await get('/api/collections/' + admin.id);
    expect(av.body.order.locked).toBe(true);

    const pub = freshCollection();
    db.setOrder(pub.id, pub.owner_token, { version: 'pickup' });
    const pv = await get('/api/collections/' + pub.id);
    expect(pv.body.order.locked).toBe(false);
  });

  it('returns the delivery address ONLY to the owner (owner_token), never to the public view', async () => {
    settings.set('pricing', 'delivery_enabled', true);
    const c = freshCollection();
    const address = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    db.setOrder(c.id, c.owner_token, { version: 'delivery', address });

    // Public (no key): address withheld.
    const pub = await get('/api/collections/' + c.id);
    expect(pub.body.order.version).toBe('delivery');
    expect(pub.body.order.address).toBeUndefined();

    // Owner (correct key): address returned so the form can prefill.
    const owner = await get('/api/collections/' + c.id + '?k=' + c.owner_token);
    expect(owner.body.order.address).toMatchObject({
      street: 'הרצל 1',
      city: 'תל אביב',
      postal: '6100000',
    });

    // A WRONG key is treated as public — no address leak.
    const wrong = await get('/api/collections/' + c.id + '?k=not-the-token');
    expect(wrong.body.order.address).toBeUndefined();
  });
});
