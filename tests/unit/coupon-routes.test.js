// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boot the real Express app with PeleCard credentials + ADMIN_KEY set so both
// the admin coupon routes and the pay routes are live, and stub global fetch so
// no request reaches the real gateway. The stub captures the amount POSTed to
// /PaymentGW/init so tests can assert the DISCOUNTED charge.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;
const ADMIN_KEY = 'test-admin-key';

let app;
let db;
let server;
let base;

let nextInit = null;
let nextGetTx = null;
let lastInitTotal = null; // agorot POSTed to /PaymentGW/init

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-coupon-routes-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['db.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
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
      if (u.includes('/PaymentGW/GetTransaction')) {
        if (nextGetTx === 'THROW') throw new Error('network');
        return jsonRes(nextGetTx);
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

beforeEach(() => {
  nextInit = {
    URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=tx-1',
    Error: { ErrCode: 0 },
  };
  nextGetTx = null;
  lastInitTotal = null;
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function del(urlPath) {
  const res = await realFetch(base + urlPath, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(urlPath) {
  const res = await realFetch(base + urlPath);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function tokenOf(id) {
  return db.getCollection(id).order.pelecard.sessions[0].token;
}

const key = (p) => `${p}?key=${ADMIN_KEY}`;

describe('admin coupon CRUD auth', () => {
  it('403 with a wrong key, happy path with the right key', async () => {
    // wrong key
    expect((await get('/api/admin/coupons?key=wrong')).status).toBe(403);
    expect(
      (await post('/api/admin/coupons?key=wrong', { code: 'X', discount_pct: 10 })).status
    ).toBe(403);

    // create
    const created = await post(key('/api/admin/coupons'), {
      code: 'welcome15',
      discount_pct: 15,
      valid_until: null,
    });
    expect(created.status).toBe(201);
    expect(created.body.coupon.code).toBe('WELCOME15');
    const id = created.body.coupon.id;

    // list contains it
    const list = await get(key('/api/admin/coupons'));
    expect(list.status).toBe(200);
    expect(list.body.coupons.some((c) => c.id === id)).toBe(true);

    // toggle active
    const toggled = await post(key('/api/admin/coupons/' + id), { active: false });
    expect(toggled.status).toBe(200);
    expect(toggled.body.coupon.active).toBe(false);

    // delete
    expect((await del(key('/api/admin/coupons/' + id))).status).toBe(200);
    expect((await del(key('/api/admin/coupons/' + id))).status).toBe(404); // gone
  });

  it('400 on invalid input / duplicate code', async () => {
    expect((await post(key('/api/admin/coupons'), { code: 'ok', discount_pct: 200 })).status).toBe(
      400
    );
    await post(key('/api/admin/coupons'), { code: 'DUP', discount_pct: 10 });
    const dup = await post(key('/api/admin/coupons'), { code: 'dup', discount_pct: 10 });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe('duplicate');
  });

  it('404 toggling a missing coupon', async () => {
    expect((await post(key('/api/admin/coupons/nope'), { active: true })).status).toBe(404);
  });
});

describe('POST /api/collections/:id/coupon/validate (owner-scoped)', () => {
  it('returns valid + discount_pct and never leaks other fields', async () => {
    await post(key('/api/admin/coupons'), { code: 'PUB25', discount_pct: 25 });
    const c = db.createCollection('אימות בעלים');
    const r = await post('/api/collections/' + c.id + '/coupon/validate', {
      owner_token: c.owner_token,
      code: 'pub25',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ valid: true, discount_pct: 25 });
  });

  it('returns valid:false + reason for unknown/inactive', async () => {
    const c = db.createCollection('אימות לא קיים');
    const nf = await post('/api/collections/' + c.id + '/coupon/validate', {
      owner_token: c.owner_token,
      code: 'GHOST',
    });
    expect(nf.body).toEqual({ valid: false, reason: 'not_found' });
  });

  it('requires the owner token (403 without it) — not an open oracle', async () => {
    const c = db.createCollection('לא בעלים');
    const r = await post('/api/collections/' + c.id + '/coupon/validate', {
      owner_token: 'nope',
      code: 'PUB25',
    });
    expect(r.status).toBe(403);
  });

  it('rate-limits repeated attempts (429 past the cap)', async () => {
    await post(key('/api/admin/coupons'), { code: 'RL', discount_pct: 10 });
    const c = db.createCollection('הגבלת קצב');
    let saw429 = false;
    // The cap is 20/min per collection; 25 attempts must trip it.
    for (let i = 0; i < 25; i++) {
      const r = await post('/api/collections/' + c.id + '/coupon/validate', {
        owner_token: c.owner_token,
        code: 'RL',
      });
      if (r.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});

describe('pay/init with a coupon', () => {
  it('charges the DISCOUNTED amount and the callback verifies against it', async () => {
    await post(key('/api/admin/coupons'), { code: 'HALF', discount_pct: 50 });
    const c = db.createCollection('קופון חצי');

    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf', // 79 NIS -> 40 after 50% (Math.round(39.5))
      coupon: 'half',
    });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(79);
    expect(r.body.charged).toBe(40);
    // The gateway was asked for the discounted amount, in agorot.
    expect(lastInitTotal).toBe(4000);
    // The pay SESSION stored its own effective charge + coupon for the callback.
    const s0 = db.getCollection(c.id).order.pelecard.sessions[0];
    expect(s0.charged_total).toBe(40);
    expect(s0.coupon).toBe('HALF');

    // Callback verifying against the DISCOUNTED amount marks it paid.
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '000',
        AdditionalDetailsParamX: token,
        DebitTotal: 4000, // discounted agorot
        DebitApproveNumber: '86-001-006',
      },
    };
    const cb = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(cb.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(true);
    // The coupon use was counted once on the paid transition.
    expect(db.getCouponByCode('HALF').uses).toBe(1);
  });

  it('does NOT mark paid when the callback amount is the undiscounted total', async () => {
    await post(key('/api/admin/coupons'), { code: 'HALF2', discount_pct: 50 });
    const c = db.createCollection('קופון סכום מלא');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
      coupon: 'HALF2',
    });
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '000',
        AdditionalDetailsParamX: token,
        DebitTotal: 7900, // full price — must NOT verify against charged_total (4000)
      },
    };
    const cb = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(cb.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
    expect(db.getCouponByCode('HALF2').uses).toBe(0);
  });

  it('rejects an invalid coupon with 400', async () => {
    const c = db.createCollection('קופון שגוי');
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
      coupon: 'DOESNOTEXIST',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid coupon');
  });

  it('a 100% coupon marks the order paid WITHOUT hitting the gateway', async () => {
    await post(key('/api/admin/coupons'), { code: 'FREE100', discount_pct: 100 });
    const c = db.createCollection('חינם');
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
      coupon: 'free100',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ free: true, paid: true, total: 0 });
    // The gateway was never called for this order.
    expect(lastInitTotal).toBe(null);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.paid_method).toBe('coupon');
    expect(db.getCouponByCode('FREE100').uses).toBe(1);
  });

  it('an order without a coupon still stores a numeric charged_total = total', async () => {
    const c = db.createCollection('בלי קופון');
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(r.status).toBe(200);
    expect(r.body.charged).toBe(79);
    const s0 = db.getCollection(c.id).order.pelecard.sessions[0];
    expect(s0.charged_total).toBe(79); // never undefined
    expect(s0.coupon).toBe(null);
  });

  it('two sessions with different coupons: completing the EARLIER one verifies at ITS amount + credits ITS coupon', async () => {
    await post(key('/api/admin/coupons'), { code: 'SESS1', discount_pct: 50 }); // 79 -> 40
    await post(key('/api/admin/coupons'), { code: 'SESS2', discount_pct: 10 }); // 79 -> 71
    const c = db.createCollection('שתי סשנים');

    // First pay session with SESS1 (charged 40).
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
      coupon: 'SESS1',
    });
    const firstToken = db.getCollection(c.id).order.pelecard.sessions[0].token;

    // A later pay session with a DIFFERENT coupon SESS2 (charged 71). Under the
    // old single-order-field design this would have overwritten the amount and
    // broken verification of the first session.
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
      coupon: 'SESS2',
    });
    expect(db.getCollection(c.id).order.pelecard.sessions.length).toBe(2);

    // Complete the EARLIER (SESS1) session at its own amount, 40 (4000 agorot).
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '000',
        AdditionalDetailsParamX: firstToken,
        DebitTotal: 4000,
        DebitApproveNumber: '86-777-000',
      },
    };
    const cb = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(cb.status).toBe(200);

    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    // The order records the coupon the customer ACTUALLY redeemed (SESS1)...
    expect(order.coupon).toBe('SESS1');
    expect(order.charged_total).toBe(40);
    // ...and only SESS1's uses is credited, not the later SESS2.
    expect(db.getCouponByCode('SESS1').uses).toBe(1);
    expect(db.getCouponByCode('SESS2').uses).toBe(0);
  });

  it('refuses the free/coupon path while a real card session is in flight (no double charge)', async () => {
    await post(key('/api/admin/coupons'), { code: 'FREERACE', discount_pct: 100 });
    const c = db.createCollection('מרוץ חינם');

    // A real (non-free) card session is initiated and still in flight.
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });

    // Applying a 100% coupon now must NOT mark the order free/paid — the
    // in-flight real session could still complete and charge the customer.
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
      coupon: 'FREERACE',
    });
    expect(r.status).toBe(409);
    expect(db.getCollection(c.id).order.paid).toBe(false);
    expect(db.getCouponByCode('FREERACE').uses).toBe(0);
  });
});
