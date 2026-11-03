// @vitest-environment node
// PARTNER VOUCHERS through the real app: the owner's admin routes (and the staff
// key kept out of them), and a voucher redeemed in the ordinary checkout — free
// pickup with no card charge, the difference charged for delivery and extra
// copies, spent ONLY when the order is paid, and never spent twice, including by
// two checkouts racing on one code. Pure rules and the store are in
// partner-vouchers.test.js.
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
const STAFF_KEY = 'test-staff-key';
const PICKUP = 199;
const PDF = 99;
const FEE = 39;
const ADDRESS = { street: 'הרצל 5', city: 'תל אביב', postal: '6100000', apartment: '3' };

let app;
let db;
let server;
let base;
let mails;
let gatewayInits; // amounts (agorot) PeleCard was asked to charge
let nextGetTx = null;
let initFails = false; // the gateway refuses to open a window

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => '' };
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-voucher-routes-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://staging.dugri.example';
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.STAFF_KEY = STAFF_KEY;
  process.env.RESEND_API_KEY = 're_test';
  process.env.NOTIFY_TO = 'owner@example.com';
  process.env.NOTIFY_FROM = 'Dugri <orders@example.com>';
  delete process.env.VOUCHER_MISS_LIMIT;
  for (const f of ['settings.js', 'db.js', 'notify.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery']) settings.set('pricing', v + '_enabled', true);
  settings.set('pricing', 'pickup_price', PICKUP);
  settings.set('pricing', 'pdf_price', PDF);
  settings.set('pricing', 'delivery_fee', FEE);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('api.resend.com')) {
        mails.push(JSON.parse(opts.body));
        return jsonRes({ id: 'm1' });
      }
      if (u.includes('/PaymentGW/init')) {
        if (initFails)
          return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
        gatewayInits.push(JSON.parse(opts.body).Total);
        return jsonRes({
          URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=tx-' + gatewayInits.length,
          Error: { ErrCode: 0 },
        });
      }
      if (u.includes('/PaymentGW/GetTransaction')) return jsonRes(nextGetTx);
      return jsonRes({});
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
  for (const k of [
    'STAFF_KEY',
    'RESEND_API_KEY',
    'NOTIFY_TO',
    'NOTIFY_FROM',
    'PELECARD_TERMINAL',
    'PELECARD_USER',
    'PELECARD_PASSWORD',
  ]) {
    delete process.env[k];
  }
});

let ipSeq = 0;
beforeEach(() => {
  mails = [];
  gatewayInits = [];
  nextGetTx = null;
  initFails = false;
  ipSeq += 1;
});

// Each test is its own client unless it says otherwise (the miss limiter is
// per client, and the client is the rightmost X-Forwarded-For entry).
async function call(method, urlPath, body, ip) {
  const res = await realFetch(base + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip || '10.7.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* a CSV */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}
const post = (p, b, ip) => call('POST', p, b || {}, ip);
const get = (p, ip) => call('GET', p, undefined, ip);
const key = (p, k = ADMIN_KEY) => p + (p.includes('?') ? '&' : '?') + 'key=' + k;

let prefixSeq = 0;
function newPool(count = 3, extra = {}) {
  prefixSeq += 1;
  const prefix = 'P' + 'ABCDEFGHJKMNPQRSTUVWXYZ'[prefixSeq % 23] + 'X'.repeat(prefixSeq % 3);
  return db.createVoucherPool({ partner_name: 'Hi Tech Zone', prefix, count, ...extra });
}

function party(name = 'שירה') {
  return db.createCollection(name);
}

function payInit(c, body, ip) {
  return post(
    '/api/collections/' + c.id + '/pay/init',
    { owner_token: c.owner_token, ...body },
    ip
  );
}

function settle(id) {
  const s = db.getCollection(id).order.pelecard.sessions.slice(-1)[0];
  nextGetTx = {
    StatusCode: '000',
    ResultData: {
      TransactionId: 'tx-' + id,
      ShvaResult: '000',
      AdditionalDetailsParamX: s.token,
      DebitTotal: s.charged_total * 100,
      DebitApproveNumber: '1234567',
    },
  };
  return post('/api/payment/callback', { ResultData: { TransactionId: 'tx-' + id } });
}

describe('the admin routes are the owner’s alone', () => {
  it('refuses the staff key and a wrong key on every path', async () => {
    const paths = [
      ['GET', '/api/admin/partner-pools'],
      ['POST', '/api/admin/partner-pools'],
      ['POST', '/api/admin/partner-pools/x'],
      ['POST', '/api/admin/partner-pools/x/codes'],
      ['GET', '/api/admin/partner-pools/x/codes'],
      ['GET', '/api/admin/partner-pools/x/codes.csv'],
      ['GET', '/api/admin/partner-pools/x/usage.csv'],
      ['POST', '/api/admin/partner-vouchers/x/void'],
    ];
    for (const [m, p] of paths) {
      const staff = await call(m, key(p, STAFF_KEY), m === 'POST' ? {} : undefined);
      expect(staff.status, m + ' ' + p).toBe(403);
      expect(staff.body.reason, p).toBe('staff');
      expect((await call(m, key(p, 'wrong'), m === 'POST' ? {} : undefined)).status).toBe(403);
    }
  });
});

describe('creating and running a pool', () => {
  it('creates a pool, adds codes, edits the price, lists, searches and voids', async () => {
    const created = await post(key('/api/admin/partner-pools'), {
      partner_name: 'Hi Tech Zone',
      prefix: 'htz',
      count: 5,
      price_per_use: '',
    });
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(5);
    const pool = created.body.pool;
    expect(pool).toMatchObject({ prefix: 'HTZ', price_per_use: 0 });

    const dup = await post(key('/api/admin/partner-pools'), {
      partner_name: 'Other',
      prefix: 'HTZ',
      count: 1,
    });
    expect(dup.status).toBe(409);
    expect(
      (await post(key('/api/admin/partner-pools'), { partner_name: 'x', prefix: 'H', count: 1 }))
        .status
    ).toBe(400);

    expect(
      (await post(key('/api/admin/partner-pools/' + pool.id + '/codes'), { count: 3 })).body
    ).toEqual({ created: 3 });
    expect(
      (await post(key('/api/admin/partner-pools/' + pool.id + '/codes'), { count: 0 })).status
    ).toBe(400);
    expect((await post(key('/api/admin/partner-pools/nope/codes'), { count: 1 })).status).toBe(404);

    const listed = await get(key('/api/admin/partner-pools'));
    expect(listed.headers.get('cache-control')).toContain('no-store');
    const mine = listed.body.pools.find((p) => p.id === pool.id);
    expect(mine.summary).toMatchObject({
      issued: 8,
      used: 0,
      unused: 8,
      owed: 0,
      price_set: false,
    });
    expect(listed.body.entropy_bits).toBe(79);

    const priced = await post(key('/api/admin/partner-pools/' + pool.id), { price_per_use: 45 });
    expect(priced.body.pool.price_per_use).toBe(45);

    const codes = await get(key('/api/admin/partner-pools/' + pool.id + '/codes'));
    expect(codes.body.codes).toHaveLength(8);
    const target = codes.body.codes[3];
    const found = await get(
      key(
        '/api/admin/partner-pools/' +
          pool.id +
          '/codes?q=' +
          encodeURIComponent(target.code.slice(4, 14).toLowerCase())
      )
    );
    expect(found.body.codes.map((c) => c.id)).toEqual([target.id]);

    const voided = await post(key('/api/admin/partner-vouchers/' + target.id + '/void'), {
      reason: 'אבד',
    });
    expect(voided.body.code).toMatchObject({ status: 'void', void_reason: 'אבד' });
    const voidList = await get(key('/api/admin/partner-pools/' + pool.id + '/codes?status=void'));
    expect(voidList.body.codes.map((c) => c.id)).toEqual([target.id]);
    expect(voidList.body.summary).toMatchObject({ voided: 1, unused: 7 });
  });

  it('exports the codes to hand over and the usage to invoice, as CSV', async () => {
    const { pool, codes } = newPool(3, { price_per_use: 50 });
    // One of the three is spent on a real free order.
    const buyer = party('קונה');
    expect((await payInit(buyer, { version: 'pickup', coupon: codes[0].code })).body.free).toBe(
      true
    );

    const all = await get(key('/api/admin/partner-pools/' + pool.id + '/codes.csv'));
    expect(all.status).toBe(200);
    expect(all.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(all.headers.get('content-disposition')).toContain(pool.prefix + '-codes.csv');
    expect(all.headers.get('cache-control')).toContain('no-store');
    const lines = all.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(4);
    for (const c of codes) expect(all.text).toContain('"' + c.code + '"');

    const unused = await get(
      key('/api/admin/partner-pools/' + pool.id + '/codes.csv?status=unused')
    );
    expect(unused.text).not.toContain(codes[0].code);
    expect(unused.text).toContain(codes[1].code);

    const usage = await get(key('/api/admin/partner-pools/' + pool.id + '/usage.csv'));
    const u = usage.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(u).toHaveLength(2);
    expect(u[1]).toContain('"' + codes[0].code + '"');
    expect(u[1]).toContain('"' + db.orderRef(db.getCollection(buyer.id)) + '"');
    expect(u[1]).toMatch(/"50",""$/);
  });
});

describe('redeeming at checkout', () => {
  it('the preview says it is a voucher and gives the pickup cap — nothing about the partner', async () => {
    const { codes } = newPool(1);
    const c = party();
    const r = await post('/api/collections/' + c.id + '/coupon/validate', {
      owner_token: c.owner_token,
      code: codes[0].code.toLowerCase().replace(/-/g, ' '),
    });
    expect(r.body).toEqual({ valid: true, voucher: true, discount_pct: 0, credit_cap: PICKUP });
  });

  it('ONE PICKUP COPY is a free order: paid with no card charge, the code spent, the partner on the order', async () => {
    const { pool, codes } = newPool(1);
    const c = party();
    const r = await payInit(c, { version: 'pickup', coupon: codes[0].code.toLowerCase() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ free: true, paid: true, total: 0 });
    // No card window was ever asked for.
    expect(gatewayInits).toEqual([]);
    const order = db.getCollection(c.id).order;
    expect(order).toMatchObject({
      paid: true,
      paid_method: 'voucher',
      charged_total: 0,
      coupon: codes[0].code,
      discount_pct: null,
    });
    expect(order.voucher).toEqual({
      code: codes[0].code,
      pool_id: pool.id,
      partner_name: 'Hi Tech Zone',
      credit: PICKUP,
    });
    const row = db.getVoucherByCode(codes[0].code);
    expect(row.used_at).toBeTruthy();
    expect(row.order_id).toBe(c.id);
    // The orders list (owner) carries the tag's data.
    const admin = await get(key('/api/admin/collections'));
    expect(admin.body.collections.find((x) => x.id === c.id).order.voucher.partner_name).toBe(
      'Hi Tech Zone'
    );
  });

  it('the PDF version is covered in full (it costs less than pickup)', async () => {
    const { codes } = newPool(1);
    const c = party();
    const r = await payInit(c, { version: 'pdf', coupon: codes[0].code });
    expect(r.body.free).toBe(true);
    expect(db.getCollection(c.id).order.voucher.credit).toBe(PDF);
  });

  it('EXTRA COPIES are charged: three pickup copies pay for two', async () => {
    const { codes } = newPool(1);
    const c = party();
    const r = await payInit(c, { version: 'pickup', quantity: 3, coupon: codes[0].code });
    expect(r.status).toBe(200);
    expect(r.body.charged).toBe(2 * PICKUP);
    expect(gatewayInits).toEqual([2 * PICKUP * 100]);
    const s = db.getCollection(c.id).order.pelecard.sessions.slice(-1)[0];
    expect(s).toMatchObject({ coupon: codes[0].code, voucher_credit: PICKUP, discount_pct: null });
    // The settle path's own formula agrees with what was charged.
    expect(app.expectedChargeNow(db.getCollection(c.id).order, s)).toBe(2 * PICKUP);
  });

  it('DELIVERY is charged the shipping only — and the code is spent only when that payment lands', async () => {
    const { pool, codes } = newPool(1);
    const c = party();
    const r = await payInit(c, { version: 'delivery', address: ADDRESS, coupon: codes[0].code });
    expect(r.status).toBe(200);
    expect(r.body.charged).toBe(FEE);
    expect(gatewayInits).toEqual([FEE * 100]);
    // A window is open: held for this collection, not spent, not counted.
    const held = db.getVoucherByCode(codes[0].code);
    expect(held.used_at).toBe(null);
    expect(held.held.collection_id).toBe(c.id);
    expect(db.listVoucherPools().find((p) => p.id === pool.id).summary.used).toBe(0);

    const cb = await settle(c.id);
    expect(cb.status).toBe(200);
    const order = db.getCollection(c.id).order;
    expect(order).toMatchObject({ paid: true, paid_method: 'pelecard', charged_total: FEE });
    expect(order.voucher).toMatchObject({ code: codes[0].code, partner_name: 'Hi Tech Zone' });
    expect(db.getVoucherByCode(codes[0].code).order_id).toBe(c.id);
    expect(db.listVoucherPools().find((p) => p.id === pool.id).summary.used).toBe(1);
  });

  it('a CLOSED window keeps the code: closing is not proof the payment will not land', async () => {
    // On Tranzila the buyer closes the window before the sweep settles her charge.
    const { codes } = newPool(1);
    const a = party('א');
    await payInit(a, { version: 'delivery', address: ADDRESS, coupon: codes[0].code });
    await post('/api/collections/' + a.id + '/pay/cancel', { owner_token: a.owner_token });
    const row = db.getVoucherByCode(codes[0].code);
    expect(row.used_at).toBe(null);
    // Another collection cannot redeem it, not even as a free pickup…
    const b = party('ב');
    const r = await payInit(b, { version: 'pickup', coupon: codes[0].code });
    expect(r.body).toEqual({ error: 'invalid coupon', reason: 'held' });
    // …and A's late charge still spends it, on A.
    await settle(a.id);
    expect(db.getVoucherByCode(codes[0].code).order_id).toBe(a.id);
    expect(db.getCollection(b.id).order.paid).toBe(false);
  });

  it('a failed window opening lets go of ITS hold only, not an earlier window’s', async () => {
    const { codes } = newPool(1);
    const a = party('א');
    expect(
      (await payInit(a, { version: 'delivery', address: ADDRESS, coupon: codes[0].code })).status
    ).toBe(200);
    initFails = true;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await payInit(a, {
      version: 'delivery',
      address: ADDRESS,
      coupon: codes[0].code,
    });
    quiet.mockRestore();
    expect(failed.status).toBe(502);
    expect(db.getVoucherByCode(codes[0].code).held.tokens).toHaveLength(1);
    const b = party('ב');
    expect((await payInit(b, { version: 'pickup', coupon: codes[0].code })).body.reason).toBe(
      'held'
    );
  });

  it('a failed only window frees the code', async () => {
    const { codes } = newPool(1);
    const a = party('א');
    initFails = true;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      (await payInit(a, { version: 'delivery', address: ADDRESS, coupon: codes[0].code })).status
    ).toBe(502);
    quiet.mockRestore();
    expect(db.getVoucherByCode(codes[0].code).held).toBe(null);
  });

  it('refuses an unknown, a used and a voided code, with the reason', async () => {
    const { pool, codes } = newPool(3);
    const used = party();
    await payInit(used, { version: 'pickup', coupon: codes[0].code });
    db.voidVoucher(codes[1].id, 'lost');
    const c = party();
    const cases = [
      [pool.prefix + '-AAAA-AAAA-AAAA-AAAA', 'not_found'],
      [codes[0].code, 'used'],
      [codes[1].code, 'void'],
    ];
    for (const [code, reason] of cases) {
      const r = await payInit(c, { version: 'pickup', coupon: code });
      expect(r.status, code).toBe(400);
      expect(r.body).toEqual({ error: 'invalid coupon', reason });
    }
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });
});

describe('never spent twice', () => {
  it('two FREE checkouts racing on one code: exactly one gets the game', async () => {
    const { codes } = newPool(1);
    const a = party('א');
    const b = party('ב');
    const [ra, rb] = await Promise.all([
      payInit(a, { version: 'pickup', coupon: codes[0].code }),
      payInit(b, { version: 'pickup', coupon: codes[0].code }),
    ]);
    const results = [ra, rb].map((r) => (r.body.free ? 'free' : r.body.reason));
    expect(results.sort()).toEqual(['free', 'used']);
    const paid = [a, b].filter((x) => db.getCollection(x.id).order.paid);
    expect(paid).toHaveLength(1);
    expect(db.getVoucherByCode(codes[0].code).order_id).toBe(paid[0].id);
  });

  it('two CARD checkouts racing on one code: the second is refused while the first holds it', async () => {
    const { codes } = newPool(1);
    const a = party('א');
    const b = party('ב');
    const [ra, rb] = await Promise.all([
      payInit(a, { version: 'delivery', address: ADDRESS, coupon: codes[0].code }),
      payInit(b, { version: 'delivery', address: ADDRESS, coupon: codes[0].code }),
    ]);
    const statuses = [ra, rb].map((r) => (r.status === 200 ? 'ok' : r.body.reason));
    expect(statuses.sort()).toEqual(['held', 'ok']);
    expect(gatewayInits).toHaveLength(1);
  });

  it('a window the owner released that settles anyway is flagged, not spent again, and the owner is told', async () => {
    const { pool, codes } = newPool(1, { price_per_use: 30 });
    const a = party('א');
    const b = party('ב');
    expect(
      (await payInit(a, { version: 'delivery', address: ADDRESS, coupon: codes[0].code })).status
    ).toBe(200);
    // The owner frees A's hold (she believed the window dead); B opens a window.
    const row = db.getVoucherByCode(codes[0].code);
    const freed = await post(key('/api/admin/partner-vouchers/' + row.id + '/release-hold'));
    expect(freed.body.code.held).toBe(false);
    expect(
      (await post(key('/api/admin/partner-vouchers/' + row.id + '/release-hold'))).status
    ).toBe(409);
    expect(
      (await payInit(b, { version: 'delivery', address: ADDRESS, coupon: codes[0].code })).status
    ).toBe(200);

    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await settle(b.id);
    await settle(a.id);
    quiet.mockRestore();

    expect(db.getCollection(a.id).order.paid).toBe(true);
    expect(db.getCollection(b.id).order.paid).toBe(true);
    expect(db.getVoucherByCode(codes[0].code).order_id).toBe(b.id);
    const late = db.getCollection(a.id).order;
    expect(late.voucher).toBeUndefined();
    expect(late.voucher_conflict.code).toBe(codes[0].code);
    // Billed once.
    const s = db.listVoucherPools().find((p) => p.id === pool.id).summary;
    expect(s).toMatchObject({ used: 1, owed: 30 });
    await vi.waitFor(() =>
      expect(mails.some((m) => String(m.subject).includes('קוד שותף נוצל פעמיים'))).toBe(true)
    );
  });

  it('a replayed callback does not re-spend or re-flag', async () => {
    const { codes } = newPool(1);
    const c = party();
    await payInit(c, { version: 'delivery', address: ADDRESS, coupon: codes[0].code });
    await settle(c.id);
    const usedAt = db.getVoucherByCode(codes[0].code).used_at;
    await settle(c.id);
    expect(db.getVoucherByCode(codes[0].code).used_at).toBe(usedAt);
    expect(db.getCollection(c.id).order.voucher_conflict).toBeUndefined();
  });
});

describe('the staff key sees no codes', () => {
  it('neither the orders list nor the order edit hands it a voucher, a coupon or the partner', async () => {
    const { codes } = newPool(2);
    const paid = party('שולם');
    await payInit(paid, { version: 'pickup', coupon: codes[0].code });
    // A code left in an abandoned card window: still unused, the one worth stealing.
    const open = party('פתוח');
    await payInit(open, { version: 'delivery', address: ADDRESS, coupon: codes[1].code });
    await post('/api/collections/' + open.id + '/pay/cancel', { owner_token: open.owner_token });

    const staff = await get(key('/api/admin/collections', STAFF_KEY));
    expect(staff.status).toBe(200);
    for (const c of codes) expect(staff.text).not.toContain(c.code);
    expect(staff.text).not.toContain('Hi Tech Zone');
    expect(staff.body.collections.find((x) => x.id === paid.id).order.paid).toBe(true);

    const owner = await get(key('/api/admin/collections'));
    expect(owner.text).toContain(codes[0].code);
    expect(owner.text).toContain(codes[1].code);

    const patched = await call('PATCH', key('/api/admin/collections/' + paid.id, STAFF_KEY), {
      owner_note: 'x',
    });
    expect(patched.status).toBe(200);
    expect(patched.text).not.toContain(codes[0].code);
    expect(patched.text).not.toContain('Hi Tech Zone');
  });
});

describe('a cancelled order', () => {
  it('is not billed, is marked in the usage CSV, and its code can be restored', async () => {
    const { pool, codes } = newPool(2, { price_per_use: 40 });
    const a = party('א');
    await payInit(a, { version: 'pickup', coupon: codes[0].code });
    const row = db.getVoucherByCode(codes[0].code);
    // While the order stands, the code cannot come back.
    expect((await post(key('/api/admin/partner-vouchers/' + row.id + '/restore'))).body).toEqual({
      error: 'order_active',
    });
    let s = (await get(key('/api/admin/partner-pools/' + pool.id + '/codes'))).body.summary;
    expect(s).toMatchObject({ used: 1, cancelled: 0, owed: 40 });

    await post(key('/api/admin/collections/' + a.id + '/cancel'));
    s = (await get(key('/api/admin/partner-pools/' + pool.id + '/codes'))).body.summary;
    expect(s).toMatchObject({ used: 0, cancelled: 1, owed: 0, by_month: [] });
    const usage = await get(key('/api/admin/partner-pools/' + pool.id + '/usage.csv'));
    expect(usage.text).toContain('"0","order cancelled, not billed"');

    const restored = await post(key('/api/admin/partner-vouchers/' + row.id + '/restore'));
    expect(restored.body.code).toMatchObject({ status: 'unused', restored: 1 });
    expect(db.getVoucherByCode(codes[0].code).restored[0].order_id).toBe(a.id);
    // Unused again: another order can redeem it.
    const b = party('ב');
    expect((await payInit(b, { version: 'pickup', coupon: codes[0].code })).body.free).toBe(true);
  });

  it('restore and release-hold are the owner’s alone', async () => {
    for (const a of ['restore', 'release-hold']) {
      expect((await post(key('/api/admin/partner-vouchers/x/' + a, STAFF_KEY))).status).toBe(403);
    }
  });
});

describe('guessing is rate-limited', () => {
  it('ten wrong voucher-shaped guesses lock that client out of the preview AND pay/init', async () => {
    const { pool, codes } = newPool(1);
    const c = party();
    const ip = '203.0.113.77';
    const guess = (i) => pool.prefix + '-AAAA-BBBB-CCCC-' + 'DEFG'.slice(0, 3) + 'HJKMNPQRST'[i];
    for (let i = 0; i < 10; i++) {
      const r = await post(
        '/api/collections/' + c.id + '/coupon/validate',
        { owner_token: c.owner_token, code: guess(i) },
        ip
      );
      expect(r.body).toEqual({ valid: false, reason: 'not_found' });
    }
    const blocked = await post(
      '/api/collections/' + c.id + '/coupon/validate',
      { owner_token: c.owner_token, code: codes[0].code },
      ip
    );
    expect(blocked.status).toBe(429);
    expect((await payInit(c, { version: 'pickup', coupon: codes[0].code }, ip)).status).toBe(429);
    // Another client is unaffected, and the code itself was never touched.
    const other = await post(
      '/api/collections/' + c.id + '/coupon/validate',
      { owner_token: c.owner_token, code: codes[0].code },
      '203.0.113.78'
    );
    expect(other.body.valid).toBe(true);
  });

  it('wrong ordinary coupon codes do not count against a client', async () => {
    newPool(1);
    const c = party();
    const ip = '203.0.113.90';
    for (let i = 0; i < 12; i++) {
      const r = await post(
        '/api/collections/' + c.id + '/coupon/validate',
        { owner_token: c.owner_token, code: 'NOPE' + i },
        ip
      );
      expect(r.status).toBe(200);
    }
  });
});
