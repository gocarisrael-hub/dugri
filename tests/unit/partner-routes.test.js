// @vitest-environment node
// THE PARTNER ROUTES over the real Express app.
//
// One of them, GET /api/partner/:token, is UNAUTHENTICATED — a long random token
// in a URL is the whole credential. So the tests that matter most are about what
// it must never hand out: any admin power, and any of the shop's customers.
// A blogger's dashboard is not a place where the buyers who used her code get
// listed by name.
//
// Same harness as faq-routes.test.js: require the app (it does not listen) and
// bind an ephemeral port.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
let app;
let db;
let server;
let base;

const adminUrl = (p) => `${base}${p}${p.includes('?') ? '&' : '?'}key=${ADMIN_KEY}`;
const postJson = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-partner-routes-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['settings.js', 'db.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.DATA_DIR;
  delete process.env.ADMIN_KEY;
});

async function makePartner(code) {
  const r = await postJson(adminUrl('/api/admin/coupons'), {
    code,
    discount_pct: 15,
    partner_name: 'נועה',
    commission_type: 'fixed',
    commission_value: 30,
  });
  expect(r.status).toBe(201);
  return (await r.json()).coupon;
}

// A paid order under `code`, placed by a customer with a real name and contact
// details — the things the public report must never leak.
function paidOrderFor(code) {
  const c = db.createCollection({
    honoree_name: 'שירה כהן',
    owner_email: 'buyer@example.com',
    owner_phone: '0541234567',
  });
  c.order = { version: 'pickup', quantity: 1, delivery_fee: 0, total: 279, paid: false };
  db.markPaid(c.id, { charged_total: 239, coupon: code, discount_pct: 15 });
  return c;
}

describe('the public report', () => {
  it('needs no key, and answers with her own numbers', async () => {
    const coupon = await makePartner('PUB1');
    paidOrderFor('PUB1');
    const r = await fetch(`${base}/api/partner/${coupon.report_token}`);
    expect(r.status).toBe(200);
    const rep = await r.json();
    expect(rep.coupon.code).toBe('PUB1');
    expect(rep.totals.sales).toBe(1);
    expect(rep.totals.earned).toBe(30);
  });

  it('carries NO customer name, email or phone — anywhere in the payload', async () => {
    const coupon = await makePartner('PUB2');
    paidOrderFor('PUB2');
    const body = await (await fetch(`${base}/api/partner/${coupon.report_token}`)).text();
    // Searched over the RAW body, not a field at a time: a leak that arrives in
    // a field nobody thought to check is exactly the one a per-field assertion
    // misses.
    for (const secret of ['שירה כהן', 'buyer@example.com', '0541234567']) {
      expect(body, secret).not.toContain(secret);
    }
  });

  it('404s a bad, blank or plain-coupon token — all alike', async () => {
    // Distinguishing them is a way to hunt for real tokens.
    await postJson(adminUrl('/api/admin/coupons'), { code: 'PLAINX', discount_pct: 10 });
    for (const t of ['nope', 'a'.repeat(48), 'PLAINX', '%20']) {
      const r = await fetch(`${base}/api/partner/${t}`);
      expect(r.status, t).toBe(404);
    }
  });

  it('is not cacheable — earnings are state, and a stale one starts an argument', async () => {
    const coupon = await makePartner('PUB3');
    const r = await fetch(`${base}/api/partner/${coupon.report_token}`);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the admin side', () => {
  it('refuses every partner route without the key', async () => {
    const coupon = await makePartner('ADM1');
    const calls = [
      fetch(`${base}/api/admin/coupons/${coupon.id}/report`),
      postJson(`${base}/api/admin/coupons/${coupon.id}/partner`, { commission_value: 999 }),
      postJson(`${base}/api/admin/coupons/${coupon.id}/payouts`, { amount: 500 }),
      postJson(`${base}/api/admin/coupons/${coupon.id}/rotate-token`, {}),
      fetch(`${base}/api/admin/coupons/${coupon.id}/payouts/x`, { method: 'DELETE' }),
    ];
    for (const r of await Promise.all(calls)) expect(r.status).toBe(403);
    // ...and nothing moved.
    expect(db.getCouponById(coupon.id).commission_value).toBe(30);
  });

  it('sees exactly what she sees', async () => {
    const coupon = await makePartner('ADM2');
    paidOrderFor('ADM2');
    const mine = await (await fetch(adminUrl(`/api/admin/coupons/${coupon.id}/report`))).json();
    const hers = await (await fetch(`${base}/api/partner/${coupon.report_token}`)).json();
    // The commonest way a partnership sours is two dashboards disagreeing about
    // what is owed. They are the same endpoint's output by construction.
    expect(mine.totals).toEqual(hers.totals);
  });

  it('records a payout, and it lands in both reports', async () => {
    const coupon = await makePartner('ADM3');
    paidOrderFor('ADM3');
    const r = await postJson(adminUrl(`/api/admin/coupons/${coupon.id}/payouts`), {
      amount: 30,
      note: 'ביט',
    });
    expect(r.status).toBe(201);
    const hers = await (await fetch(`${base}/api/partner/${coupon.report_token}`)).json();
    expect(hers.totals.paid_out).toBe(30);
    expect(hers.totals.outstanding).toBe(0);
    expect(hers.payouts[0].note).toBe('ביט');
  });

  it('rejects a bad rate without disturbing the existing one', async () => {
    const coupon = await makePartner('ADM4');
    const r = await postJson(adminUrl(`/api/admin/coupons/${coupon.id}/partner`), {
      commission_type: 'percent',
      commission_value: 400,
    });
    expect(r.status).toBe(400);
    expect(db.getCouponById(coupon.id).commission_value).toBe(30);
  });

  it('rotating the link breaks the old one and issues a working new one', async () => {
    const coupon = await makePartner('ADM5');
    const before = coupon.report_token;
    const after = (
      await (await postJson(adminUrl(`/api/admin/coupons/${coupon.id}/rotate-token`), {})).json()
    ).coupon.report_token;
    expect((await fetch(`${base}/api/partner/${before}`)).status).toBe(404);
    expect((await fetch(`${base}/api/partner/${after}`)).status).toBe(200);
  });
});

describe('an ordinary discount code is untouched', () => {
  it('still creates, and gains no partner machinery', async () => {
    const r = await postJson(adminUrl('/api/admin/coupons'), { code: 'PLAIN20', discount_pct: 20 });
    expect(r.status).toBe(201);
    const { coupon } = await r.json();
    expect(coupon.commission_type).toBeNull();
    expect(coupon.report_token).toBeNull();
    expect((await fetch(adminUrl(`/api/admin/coupons/${coupon.id}/report`))).status).toBe(404);
  });
});
