// @vitest-environment node
//
// A SECOND ADMIN KEY, FOR SOMEONE WHO IS NOT THE OWNER.
//
// The worker runs the orders and the typography editor; the money — coupons,
// pricing, the revenue dashboard's own endpoints, bespoke 599 ₪ orders — stays
// the owner's. What matters here is that the boundary is enforced on the SERVER:
// the nav-trimming in js/admin-role.js is courtesy, and a test that only proved
// a link was hidden would prove nothing at all.
//
// The scope is an ALLOWLIST, so the most valuable test in this file is the last
// one: a route nobody thought about is closed to staff by default.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const OWNER = 'owner-key-for-tests';
const STAFF = 'staff-key-for-tests';

let app;
let db;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-staff-'));
  process.env.ADMIN_KEY = OWNER;
  process.env.STAFF_KEY = STAFF;
  for (const f of ['db.js', 'settings.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const asOwner = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + OWNER;
const asStaff = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + STAFF;

describe('whoami names the role behind the key', () => {
  it('tells each key what it is, and refuses an unknown one', async () => {
    expect((await get(asOwner('/api/admin/whoami'))).body).toEqual({
      role: 'owner',
      staff_enabled: true,
    });
    expect((await get(asStaff('/api/admin/whoami'))).body).toEqual({
      role: 'staff',
      staff_enabled: true,
    });
    expect((await get('/api/admin/whoami?key=neither')).status).toBe(403);
  });
});

describe('the staff key reaches the work', () => {
  it('reads the orders — the page the worker actually lives on', async () => {
    db.createCollection('הזמנה לבדיקת צוות');
    const r = await get(asStaff('/api/admin/collections'));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.collections)).toBe(true);
  });

  it('reaches the template list and the typography editor behind it', async () => {
    // Both pages read this one endpoint; without it the editor is a blank frame.
    expect((await get(asStaff('/api/admin/templates'))).status).toBe(200);
  });

  it('reaches the rest of the orders page: wordlists, designs, stickers, HFD', async () => {
    for (const p of [
      '/api/admin/wordlists',
      '/api/admin/designs',
      '/api/admin/pickup-stickers',
      '/api/admin/hfd/status',
    ]) {
      expect((await get(asStaff(p))).status, p).not.toBe(403);
    }
  });
});

describe('the staff key never reaches the money', () => {
  it('is refused the coupons, in every direction', async () => {
    expect((await get(asStaff('/api/admin/coupons'))).status).toBe(403);
    expect(
      (await post(asStaff('/api/admin/coupons'), { code: 'STAFF1', discount_pct: 90 })).status
    ).toBe(403);
    // …and the refusal did not quietly create it.
    expect(db.getCouponByCode('STAFF1')).toBe(null);
  });

  it('is refused the pricing, which lives in settings', async () => {
    expect((await get(asStaff('/api/admin/settings'))).status).toBe(403);
    expect((await post(asStaff('/api/admin/settings'), { section: 'pricing' })).status).toBe(403);
  });

  it('cannot mint a bespoke 599 ₪ order, even though it sits under an allowed prefix', async () => {
    // /api/admin/collections/* is open to staff; this one child of it is not,
    // because it creates a charge and a payment link.
    const c = db.createCollection('הזמנה בהתאמה');
    const r = await post(asStaff(`/api/admin/collections/${c.id}/custom`), {});
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).order).toBeFalsy();
    // The owner is unaffected by the carve-out.
    expect((await post(asOwner(`/api/admin/collections/${c.id}/custom`), {})).status).toBe(200);
  });

  it('says WHY it refused, so the page never tells her the key is wrong', async () => {
    // A valid key out of scope must not read as a bad key — that sends her
    // hunting for another one.
    const staff = await get(asStaff('/api/admin/coupons'));
    expect(staff.body.reason).toBe('staff');
    const stranger = await get('/api/admin/coupons?key=neither');
    expect(stranger.body.reason).toBeUndefined();
  });
});

describe('the allowlist fails closed', () => {
  it('refuses staff an admin route that is on nobody’s list', async () => {
    // The point of an allowlist: a route added tomorrow is shut to staff without
    // anyone remembering to shut it.
    for (const p of [
      '/api/admin/content/all',
      '/api/admin/playbook',
      '/api/admin/design-codes',
      '/api/admin/stock',
      '/api/admin/unsubscribed',
    ]) {
      expect((await get(asStaff(p))).status, p).toBe(403);
      expect((await get(asOwner(p))).status, p).not.toBe(403);
    }
  });
});

describe('the owner key is untouched by any of this', () => {
  it('still reaches everything, money included', async () => {
    expect((await get(asOwner('/api/admin/coupons'))).status).toBe(200);
    expect((await get(asOwner('/api/admin/settings'))).status).toBe(200);
    expect((await get(asOwner('/api/admin/collections'))).status).toBe(200);
  });
});
