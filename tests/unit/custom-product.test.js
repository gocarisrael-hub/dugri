// @vitest-environment node
// The "hand-designed just for you" CUSTOM product (599₪): pricing, order flag,
// the paid pay-init paths (free coupon + card), the Dugri custom-order alert,
// and the admin bespoke route.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// ---------------------------------------------------------------------------
// Pure db-level unit tests (no server boot).
// ---------------------------------------------------------------------------
describe('custom product — db pricing + flag', () => {
  let db;
  let ORDER_PRICES;

  beforeAll(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-custom-'));
    // The charge path gates on per-version enable flags (only pickup on by
    // default); this suite orders the custom version, so enable every version.
    delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
    const settings = require(path.join(serverDir, 'settings.js'));
    for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
      settings.set('pricing', v + '_enabled', true);
    delete require.cache[require.resolve(path.join(serverDir, 'db.js'))];
    db = require(path.join(serverDir, 'db.js'));
    ORDER_PRICES = db.ORDER_PRICES;
  });

  function fresh() {
    return db.createCollection('בדיקה מותאמת');
  }

  it('prices the custom product at 599', () => {
    expect(ORDER_PRICES.custom).toBe(599);
  });

  it('setOrder with version:custom sets total 599 and needs no address', () => {
    const c = fresh();
    const o = db.setOrder(c.id, c.owner_token, { version: 'custom' });
    expect(o.error).toBeUndefined();
    expect(o.version).toBe('custom');
    expect(o.total).toBe(599);
    expect(o.address).toBe(null);
    expect(o.paid).toBe(false);
  });

  it('flags a paid custom order for hand-design via a production sub-state', () => {
    const c = fresh();
    db.setOrder(c.id, c.owner_token, { version: 'custom' });
    expect(db.markPaid(c.id, { method: 'coupon' })).toBe(true);
    const stored = db.getCollection(c.id);
    // The order is a custom order (the flag) ...
    expect(stored.order.version).toBe('custom');
    expect(stored.order.paid).toBe(true);
    // ... and markPaid stamped a needs_design production sub-state, mirrored to
    // the collection, so admin sees it needs design work.
    expect(stored.order.production).toMatchObject({ state: 'needs_design', custom: true });
    expect(stored.production).toMatchObject({ state: 'needs_design', custom: true });
  });

  it('does NOT flag a non-custom paid order for hand-design', () => {
    const c = fresh();
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id, { method: 'coupon' });
    const stored = db.getCollection(c.id);
    expect(stored.order.production).toBeUndefined();
    expect(stored.production).toBeUndefined();
  });

  it('never clobbers an already-recorded production state', () => {
    const c = fresh();
    db.setOrder(c.id, c.owner_token, { version: 'custom' });
    db.setProduction(c.id, { state: 'generated', pdf_file: 'x.pdf' });
    db.markPaid(c.id, { method: 'coupon' });
    expect(db.getCollection(c.id).order.production.state).toBe('generated');
  });
});

// ---------------------------------------------------------------------------
// notify: the version label + the Dugri-only custom-order alert builder.
// ---------------------------------------------------------------------------
describe('custom product — notify alert', () => {
  let notify;
  beforeAll(() => {
    delete require.cache[require.resolve(path.join(serverDir, 'notify.js'))];
    notify = require(path.join(serverDir, 'notify.js'));
  });

  const collection = {
    honoree_name: 'דנה',
    order: { version: 'custom', total: 599 },
  };

  it('labels a custom order in the paid email', () => {
    const msg = notify.buildPaidMessage(collection, null, { amountCharged: 599 });
    expect(msg.text).toContain('עיצוב אישי בהתאמה מלאה');
  });

  it('builds a distinct custom-order alert (needs hand-design)', () => {
    const msg = notify.buildCustomOrderAlert(collection, null, { amountCharged: 599 });
    // Distinct subject so it stands out from the normal paid email.
    expect(msg.subject).toContain('התאמה אישית');
    expect(msg.subject).not.toBe(notify.buildPaidMessage(collection, null).subject);
    expect(msg.text).toContain('עיצוב ידני');
    expect(msg.text).toContain('דנה');
  });

  it('exports sendCustomOrderAlert', () => {
    expect(typeof notify.sendCustomOrderAlert).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Server routes: the pay-init free (coupon) + card paths accept custom, and the
// admin bespoke route sets version:custom + returns a pay link.
// ---------------------------------------------------------------------------
describe('custom product — server routes', () => {
  const realFetch = globalThis.fetch;
  let app;
  let db;
  let server;
  let base;
  let nextInit;

  function jsonRes(obj) {
    return { ok: true, status: 200, json: async () => obj };
  }

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-custom-routes-'));
    process.env.PELECARD_TERMINAL = '0962210';
    process.env.PELECARD_USER = 'peletest';
    process.env.PELECARD_PASSWORD = 'secret';
    process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
    process.env.ADMIN_KEY = 'admin-secret';
    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    // Charge path gates on per-version enable flags (only pickup on by default);
    // these routes order the custom version, so enable every version here.
    delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
    const settings = require(path.join(serverDir, 'settings.js'));
    for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
      settings.set('pricing', v + '_enabled', true);
    db = require(path.join(serverDir, 'db.js'));
    app = require(path.join(serverDir, 'index.js'));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('/PaymentGW/init')) return jsonRes(nextInit);
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

  beforeEach(() => {
    nextInit = {
      URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=tx-custom',
      Error: { ErrCode: 0 },
    };
  });

  async function post(urlPath, body) {
    const res = await realFetch(base + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('pay/init CARD path accepts version:custom and charges 599', async () => {
    const c = db.createCollection('כרטיס מותאם');
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'custom',
    });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(599);
    expect(r.body.charged).toBe(599);
    expect(r.body.url).toContain('transactionId=tx-custom');
    expect(db.getCollection(c.id).order.version).toBe('custom');
  });

  it('pay/init FREE (100% coupon) path accepts version:custom and marks it paid', async () => {
    const coupon = db.createCoupon({ code: 'FREECUSTOM', discount_pct: 100 });
    expect(coupon.error).toBeUndefined();
    const c = db.createCollection('קופון מותאם');
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'custom',
      coupon: 'FREECUSTOM',
    });
    expect(r.status).toBe(200);
    expect(r.body.free).toBe(true);
    expect(r.body.paid).toBe(true);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.version).toBe('custom');
    // Paid custom order is flagged for hand-design.
    expect(order.production).toMatchObject({ state: 'needs_design', custom: true });
  });

  it('admin bespoke route sets version:custom and returns a pay link', async () => {
    const c = db.createCollection('בהתאמה מנהל');
    const r = await post('/api/admin/collections/' + c.id + '/custom?key=admin-secret', {});
    expect(r.status).toBe(200);
    expect(r.body.order.version).toBe('custom');
    expect(r.body.order.total).toBe(599);
    expect(r.body.pay_link).toContain('/collect.html?c=' + c.id);
    expect(db.getCollection(c.id).order.version).toBe('custom');
  });

  it('admin bespoke route rejects a missing admin key', async () => {
    const c = db.createCollection('ללא מפתח');
    const r = await post('/api/admin/collections/' + c.id + '/custom', {});
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).order).toBe(null);
  });
});
