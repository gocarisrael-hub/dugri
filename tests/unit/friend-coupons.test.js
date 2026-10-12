// @vitest-environment node
// The friend coupon's rules and its store: the code format, the email rule, the
// checkout lookup order, single use, and the admin arithmetic. The routes that
// call these are in friend-coupon-routes.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const rules = require(path.join(serverDir, 'friend-coupons.js'));

function freshDb() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-friend-coupons-'));
  for (const f of ['settings.js', 'db.js', 'stores/commerce.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  return require(path.join(serverDir, 'db.js'));
}

describe('the code prefix', () => {
  it.each([
    ['noa.cohen@gmail.com', 'NOA'],
    ['Noa_Cohen@gmail.com', 'NOA'],
    ['dana+parties@x.co', 'DANA'],
    ['yael-levi@x.co', 'YAEL'],
    ['dana123@x.co', 'DANA'],
    ['abcdefghijkl@x.co', 'ABCDEFGH'],
    ['0501234567@gmail.com', 'DUGRI'],
    ['שירה@x.co', 'DUGRI'],
    ['.noa@x.co', 'DUGRI'],
  ])('%s -> %s', (email, prefix) => {
    expect(rules.prefixFor(email)).toBe(prefix);
  });
});

describe('the code', () => {
  it('is PREFIX + PERCENT + "-" + 4 from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = rules.makeCode('noa.cohen@gmail.com', 5);
      expect(code).toMatch(/^NOA5-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
      expect(rules.isFriendCodeShape(code)).toBe(true);
    }
    expect(rules.makeCode('0501234567@gmail.com', 10)).toMatch(/^DUGRI10-/);
  });

  it('never uses 0/O or 1/I/L', () => {
    for (const ch of '0O1IL') expect(rules.ALPHABET).not.toContain(ch);
    expect(rules.ALPHABET).toHaveLength(31);
  });

  it('draws RANDOM from a crypto source, and only RANDOM again on a collision', () => {
    // Forced: the first draw gives AAAA (taken), the second BBBB.
    const seq = [0, 0, 0, 0, 1, 1, 1, 1];
    const randomInt = vi.fn(() => seq.shift());
    const taken = vi.fn((code) => code === 'NOA5-AAAA');
    expect(rules.makeCode('noa@x.co', 5, { randomInt, taken })).toBe('NOA5-BBBB');
    expect(taken).toHaveBeenCalledTimes(2);
    expect(randomInt).toHaveBeenCalledWith(31);
  });

  it('gives up loudly rather than looping forever', () => {
    expect(() => rules.makeCode('noa@x.co', 5, { taken: () => true })).toThrow();
  });

  it('carries the percent it was issued at, which is what the landing note reads', () => {
    expect(rules.percentInCode('noa5-k7q2')).toBe(5);
    expect(rules.percentInCode('DUGRI15-K7Q2')).toBe(15);
    expect(rules.percentInCode('SUMMER10')).toBe(null);
  });
});

describe('the email rule', () => {
  it.each(['noa@gmail.com', ' Noa.Cohen@Gmail.COM ', 'a+b@x.co.il'])('accepts %s', (e) => {
    expect(rules.isValidEmail(e)).toBe(true);
  });
  it.each([
    '',
    'noa',
    'noa@',
    '@x.co',
    'noa@x',
    'no a@x.co',
    'noa@x.c',
    'a@' + 'x'.repeat(260) + '.co',
  ])('refuses %s', (e) => {
    expect(rules.isValidEmail(e)).toBe(false);
  });
});

describe('dates and the link', () => {
  it('prints the expiry in ISRAEL time, DD.MM.YYYY', () => {
    // 22:30 UTC on 31 Dec is already 1 Jan in Tel Aviv.
    expect(rules.formatIsraelDate('2026-12-31T22:30:00.000Z')).toBe('01.01.2027');
  });

  it('builds the landing link from the given base, with the UTM tags', () => {
    expect(rules.landingLink('https://staging.example/', 'NOA5-K7Q2')).toBe(
      'https://staging.example/?coupon=NOA5-K7Q2&utm_source=coupon&utm_medium=email&utm_campaign=friend_coupon'
    );
    expect(rules.landingLink(null, 'NOA5-K7Q2')).toBe(null);
  });
});

describe('the store', () => {
  let db;
  let col;
  beforeEach(() => {
    db = freshDb();
    col = db.createCollection('שירה');
  });
  const issue = (email, extra = {}) =>
    db.issueFriendCoupon({
      email,
      collectionId: col.id,
      percent: 5,
      expiryDays: 90,
      ...extra,
    });

  it('issues one row per email, ever — the same email gets the same row back', () => {
    const a = issue('Noa.Cohen@gmail.com ');
    expect(a.created).toBe(true);
    expect(a.coupon.email).toBe('noa.cohen@gmail.com');
    expect(a.coupon.code).toMatch(/^NOA5-/);
    expect(a.coupon.collection_id).toBe(col.id);
    expect(a.coupon.discount_percent).toBe(5);
    expect(a.coupon.used_at).toBe(null);
    const other = db.createCollection('דנה');
    const b = db.issueFriendCoupon({
      email: 'noa.cohen@GMAIL.com',
      collectionId: other.id,
      percent: 10,
      expiryDays: 30,
      marketingConsent: true,
    });
    expect(b.created).toBe(false);
    expect(b.coupon.code).toBe(a.coupon.code);
    // The first issue's terms and consent stand.
    expect(b.coupon.discount_percent).toBe(5);
    expect(b.coupon.marketing_consent).toBe(false);
    expect(db.listFriendCoupons()).toHaveLength(1);
  });

  it('refuses a bad email and an unknown collection', () => {
    expect(issue('nope')).toEqual({ error: 'bad_email' });
    expect(issue('a@b.co', { collectionId: 'no-such-id' })).toEqual({ error: 'no_collection' });
    expect(db.listFriendCoupons()).toHaveLength(0);
  });

  it('stores consent only when it was given, with when', () => {
    const no = issue('a@x.co', { marketingConsent: 'true' }).coupon;
    expect(no.marketing_consent).toBe(false);
    expect(no.consent_at).toBe(null);
    const yes = issue('b@x.co', { marketingConsent: true }).coupon;
    expect(yes.marketing_consent).toBe(true);
    expect(yes.consent_at).toBe(yes.created_at);
  });

  it('expires_at is created_at + the expiry days', () => {
    const c = issue('a@x.co', { expiryDays: 90 }).coupon;
    expect(Date.parse(c.expires_at) - Date.parse(c.created_at)).toBe(90 * 24 * 3600 * 1000);
  });

  it('checkout looks in the owner coupons first, then the friend coupons, case-insensitively', () => {
    const fc = issue('noa@x.co').coupon;
    const v = db.validateCoupon(fc.code.toLowerCase());
    expect(v).toEqual({
      valid: true,
      coupon: { code: fc.code, discount_pct: 5, friend: true },
    });
    // An owner coupon is found by its own path and never reaches the friend list.
    db.createCoupon({ code: 'SUMMER10', discount_pct: 10 });
    const spy = vi.spyOn(db, 'validateFriendCoupon');
    expect(db.validateCoupon('summer10').coupon.code).toBe('SUMMER10');
    expect(spy).not.toHaveBeenCalled();
    expect(db.validateCoupon('NOPE5-AAAA')).toEqual({ valid: false, reason: 'not_found' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a used or expired friend code does not validate, each with its own reason', () => {
    const fc = issue('noa@x.co').coupon;
    expect(db.validateFriendCoupon(fc.code, Date.parse(fc.expires_at) + 1)).toEqual({
      valid: false,
      reason: 'expired',
    });
    expect(db.consumeFriendCoupon(fc.code, 'order-1')).toBe('consumed');
    expect(db.validateCoupon(fc.code)).toEqual({ valid: false, reason: 'used' });
  });

  it('consume is check-and-set: a second order cannot spend it again', () => {
    const fc = issue('noa@x.co').coupon;
    expect(db.consumeFriendCoupon(fc.code, 'order-1')).toBe('consumed');
    expect(db.consumeFriendCoupon(fc.code, 'order-2')).toBe('conflict');
    expect(db.consumeFriendCoupon(fc.code, 'order-1')).toBe('already');
    expect(db.getFriendCouponByCode(fc.code).order_id).toBe('order-1');
    expect(db.consumeFriendCoupon('SUMMER10', 'order-3')).toBe(null);
  });

  it('marks used by hand once; the list is newest first and searchable', async () => {
    const a = issue('noa@x.co').coupon;
    await new Promise((r) => setTimeout(r, 5));
    const b = issue('dana@x.co').coupon;
    expect(db.listFriendCoupons().map((r) => r.code)).toEqual([b.code, a.code]);
    expect(db.listFriendCoupons({ q: 'NOA' }).map((r) => r.email)).toEqual(['noa@x.co']);
    expect(db.listFriendCoupons({ q: b.code.toLowerCase() }).map((r) => r.id)).toEqual([b.id]);
    const m = db.markFriendCouponUsed(a.id);
    expect(m.used_at).toBeTruthy();
    expect(m.used_manually).toBe(true);
    expect(db.markFriendCouponUsed(a.id)).toEqual({ error: 'already_used' });
    expect(db.markFriendCouponUsed('nope')).toBe(null);
  });

  it('the summary: issued, used, conversion, and revenue as CHARGED on paid orders', () => {
    const a = issue('a@x.co').coupon;
    const b = issue('b@x.co').coupon;
    issue('c@x.co');
    issue('d@x.co');
    // Order 1: 199 pickup with a's code, charged 189.
    const o1 = db.createCollection('הזמנה 1');
    db.setOrder(o1.id, o1.owner_token, { version: 'pickup' });
    db.markPaid(o1.id, { method: 'card', charged_total: 189, coupon: a.code, discount_pct: 5 });
    // Order 2: paid with b's code, then CANCELLED — not a sale.
    const o2 = db.createCollection('הזמנה 2');
    db.setOrder(o2.id, o2.owner_token, { version: 'pickup' });
    db.markPaid(o2.id, { method: 'card', charged_total: 189, coupon: b.code, discount_pct: 5 });
    db.getCollection(o2.id).cancelled = true;
    // Order 3: unpaid with a code typed — nothing.
    const o3 = db.createCollection('הזמנה 3');
    db.setOrder(o3.id, o3.owner_token, { version: 'pickup' });
    const s = db.friendCouponSummary();
    expect(s.issued).toBe(4);
    expect(s.used).toBe(2); // both consumed at markPaid, cancelled or not
    expect(s.conversion).toBe(0.5);
    expect(s.orders).toBe(1);
    expect(s.revenue).toBe(189);
  });

  it('an empty list sums to zeros, not NaN', () => {
    expect(db.friendCouponSummary()).toEqual({
      issued: 0,
      used: 0,
      conversion: 0,
      orders: 0,
      revenue: 0,
    });
  });
});

describe('markPaid spends the code', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
  });

  it('in the same step that marks the order paid', () => {
    const col = db.createCollection('שירה');
    const fc = db.issueFriendCoupon({
      email: 'noa@x.co',
      collectionId: col.id,
      percent: 5,
      expiryDays: 90,
    }).coupon;
    const o = db.createCollection('הזמנה');
    db.setOrder(o.id, o.owner_token, { version: 'pickup' });
    expect(db.getFriendCouponByCode(fc.code).used_at).toBe(null);
    db.markPaid(o.id, { method: 'card', charged_total: 189, coupon: fc.code, discount_pct: 5 });
    const row = db.getFriendCouponByCode(fc.code);
    expect(row.used_at).toBeTruthy();
    expect(row.order_id).toBe(o.id);
    // ...and it is on disk, written by markPaid's own save.
    const disk = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'dugri-data.json')));
    expect(disk.friend_coupons[0].order_id).toBe(o.id);
  });

  it('a second order paid with a spent code stays paid, is flagged, and does not re-spend it', () => {
    const col = db.createCollection('שירה');
    const fc = db.issueFriendCoupon({
      email: 'noa@x.co',
      collectionId: col.id,
      percent: 5,
      expiryDays: 90,
    }).coupon;
    const first = db.createCollection('ראשונה');
    const second = db.createCollection('שנייה');
    for (const o of [first, second]) db.setOrder(o.id, o.owner_token, { version: 'pickup' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.markPaid(first.id, { method: 'card', charged_total: 189, coupon: fc.code });
    db.markPaid(second.id, { method: 'card', charged_total: 189, coupon: fc.code });
    expect(db.getCollection(second.id).order.paid).toBe(true);
    expect(db.getCollection(second.id).order.friend_coupon_conflict.code).toBe(fc.code);
    expect(db.getCollection(first.id).order.friend_coupon_conflict).toBeUndefined();
    expect(db.getFriendCouponByCode(fc.code).order_id).toBe(first.id);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
