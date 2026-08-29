import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// db.js is CommonJS and writes a JSON file under DATA_DIR — point it at a
// throwaway temp dir (set before require) so the test never touches real data.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDbPath = path.join(__dirname, '..', '..', 'server', 'db.js');

let db;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-coupons-'));
  db = require(serverDbPath);
});

// A YYYY-MM-DD string offset (in days) from TODAY IN ISRAEL — matching the
// timezone validateCoupon compares against, so these cases are stable no matter
// what timezone the test runner is in. Anchors at noon UTC to dodge DST edges.
function dateOffset(days) {
  const todayIsrael = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(
    new Date()
  );
  const d = new Date(todayIsrael + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(d);
}

describe('createCoupon validation', () => {
  it('creates a valid coupon and normalizes the code to uppercase', () => {
    const c = db.createCoupon({ code: 'save20', discount_pct: 20, valid_until: null });
    expect(c.error).toBeUndefined();
    expect(c.code).toBe('SAVE20');
    expect(c.discount_pct).toBe(20);
    expect(c.valid_until).toBe(null);
    expect(c.active).toBe(true);
    expect(c.uses).toBe(0);
    expect(typeof c.id).toBe('string');
    expect(typeof c.created_at).toBe('string');
  });

  it('rejects a discount_pct outside 1..100 or non-integer', () => {
    expect(db.createCoupon({ code: 'ZERO', discount_pct: 0 }).error).toBe('bad discount_pct');
    expect(db.createCoupon({ code: 'OVER', discount_pct: 101 }).error).toBe('bad discount_pct');
    expect(db.createCoupon({ code: 'FLOAT', discount_pct: 12.5 }).error).toBe('bad discount_pct');
    expect(db.createCoupon({ code: 'MISSING' }).error).toBe('bad discount_pct');
  });

  it('rejects bad code chars or length', () => {
    expect(db.createCoupon({ code: 'ab', discount_pct: 10 }).error).toBe('bad code'); // too short
    expect(db.createCoupon({ code: 'a'.repeat(21), discount_pct: 10 }).error).toBe('bad code'); // too long
    expect(db.createCoupon({ code: 'SA VE', discount_pct: 10 }).error).toBe('bad code'); // space
    expect(db.createCoupon({ code: 'SAVE-20', discount_pct: 10 }).error).toBe('bad code'); // dash
  });

  it('rejects a malformed valid_until', () => {
    expect(
      db.createCoupon({ code: 'BADDATE', discount_pct: 10, valid_until: '2026/01/01' }).error
    ).toBe('bad valid_until');
    expect(
      db.createCoupon({ code: 'BADDATE2', discount_pct: 10, valid_until: '2026-13-40' }).error
    ).toBe('bad valid_until');
  });

  it('stores max_uses when given, and null (no limit) when not', () => {
    const capped = db.createCoupon({ code: 'CAP20', discount_pct: 10, max_uses: 20 });
    expect(capped.max_uses).toBe(20);
    // The three ways of saying "no limit" — including the shape every coupon
    // minted before the field existed already has.
    expect(db.createCoupon({ code: 'NOCAP1', discount_pct: 10 }).max_uses).toBe(null);
    expect(db.createCoupon({ code: 'NOCAP2', discount_pct: 10, max_uses: null }).max_uses).toBe(
      null
    );
    expect(db.createCoupon({ code: 'NOCAP3', discount_pct: 10, max_uses: '' }).max_uses).toBe(null);
  });

  it('rejects a max_uses that is not a whole number of at least one', () => {
    // Zero is a typo, not "unlimited" — a code created dead helps nobody.
    expect(db.createCoupon({ code: 'CAPZERO', discount_pct: 10, max_uses: 0 }).error).toBe(
      'bad max_uses'
    );
    expect(db.createCoupon({ code: 'CAPNEG', discount_pct: 10, max_uses: -3 }).error).toBe(
      'bad max_uses'
    );
    expect(db.createCoupon({ code: 'CAPFRAC', discount_pct: 10, max_uses: 2.5 }).error).toBe(
      'bad max_uses'
    );
    expect(db.createCoupon({ code: 'CAPTEXT', discount_pct: 10, max_uses: 'many' }).error).toBe(
      'bad max_uses'
    );
    // …and a rejected coupon is not half-created.
    expect(db.getCouponByCode('CAPZERO')).toBe(null);
  });

  it('rejects a duplicate code (case-insensitive)', () => {
    expect(db.createCoupon({ code: 'UNIQUE1', discount_pct: 10 }).error).toBeUndefined();
    expect(db.createCoupon({ code: 'unique1', discount_pct: 15 }).error).toBe('duplicate');
  });
});

describe('validateCoupon', () => {
  it('returns valid + the coupon for an active, unexpired code', () => {
    db.createCoupon({ code: 'VALID10', discount_pct: 10, valid_until: dateOffset(30) });
    const r = db.validateCoupon('valid10');
    expect(r.valid).toBe(true);
    expect(r.coupon.code).toBe('VALID10');
    expect(r.coupon.discount_pct).toBe(10);
  });

  it('returns valid for a coupon whose valid_until is today (inclusive)', () => {
    db.createCoupon({ code: 'TODAY', discount_pct: 10, valid_until: dateOffset(0) });
    expect(db.validateCoupon('TODAY').valid).toBe(true);
  });

  it('returns not_found for an unknown code', () => {
    expect(db.validateCoupon('NOPE')).toEqual({ valid: false, reason: 'not_found' });
  });

  it('returns inactive when the coupon is disabled', () => {
    const c = db.createCoupon({ code: 'OFF', discount_pct: 10 });
    db.setCouponActive(c.id, false);
    expect(db.validateCoupon('OFF')).toEqual({ valid: false, reason: 'inactive' });
  });

  it('returns expired when today is after valid_until', () => {
    db.createCoupon({ code: 'PAST', discount_pct: 10, valid_until: dateOffset(-1) });
    expect(db.validateCoupon('PAST')).toEqual({ valid: false, reason: 'expired' });
  });

  it('is good for exactly max_uses redemptions, then reads used_up', () => {
    db.createCoupon({ code: 'TWICE', discount_pct: 10, max_uses: 2 });
    expect(db.validateCoupon('TWICE').valid).toBe(true);
    db.incrementCouponUses('TWICE');
    // Still good ON the last use — the cap is how many sales it buys, not how
    // many it stops short of.
    expect(db.validateCoupon('TWICE').valid).toBe(true);
    db.incrementCouponUses('TWICE');
    expect(db.validateCoupon('TWICE')).toEqual({ valid: false, reason: 'used_up' });
  });

  it('never runs out without a cap', () => {
    db.createCoupon({ code: 'FOREVER', discount_pct: 10 });
    for (let i = 0; i < 50; i++) db.incrementCouponUses('FOREVER');
    expect(db.validateCoupon('FOREVER').valid).toBe(true);
  });

  it('reports inactive rather than used_up for a spent coupon that is also off', () => {
    // The owner's switch is the fact she acted on; it is answered first so that
    // turning a code back on is not reported as a cap problem.
    const c = db.createCoupon({ code: 'OFFSPENT', discount_pct: 10, max_uses: 1 });
    db.incrementCouponUses('OFFSPENT');
    db.setCouponActive(c.id, false);
    expect(db.validateCoupon('OFFSPENT')).toEqual({ valid: false, reason: 'inactive' });
  });
});

describe('setCouponMaxUses', () => {
  it('raises a spent coupon back into use, and lifts the cap entirely', () => {
    const c = db.createCoupon({ code: 'RAISE', discount_pct: 10, max_uses: 1 });
    db.incrementCouponUses('RAISE');
    expect(db.validateCoupon('RAISE').reason).toBe('used_up');
    // Raising the cap brings the SAME code back — the point of editing it rather
    // than minting a replacement for a code already printed in someone's post.
    expect(db.setCouponMaxUses(c.id, 3).max_uses).toBe(3);
    expect(db.validateCoupon('RAISE').valid).toBe(true);
    expect(db.setCouponMaxUses(c.id, null).max_uses).toBe(null);
    expect(db.validateCoupon('RAISE').valid).toBe(true);
  });

  it('accepts a cap below what is already spent — it means "no more"', () => {
    const c = db.createCoupon({ code: 'LOWER', discount_pct: 10 });
    db.incrementCouponUses('LOWER');
    db.incrementCouponUses('LOWER');
    expect(db.setCouponMaxUses(c.id, 1).max_uses).toBe(1);
    // The two uses already made stand; the code simply sells nothing further.
    expect(db.getCouponByCode('LOWER').uses).toBe(2);
    expect(db.validateCoupon('LOWER')).toEqual({ valid: false, reason: 'used_up' });
  });

  it('null for an unknown id, { error } for a bad cap — and leaves the cap alone', () => {
    const c = db.createCoupon({ code: 'KEEPCAP', discount_pct: 10, max_uses: 5 });
    expect(db.setCouponMaxUses('nope', 5)).toBe(null);
    expect(db.setCouponMaxUses(c.id, 0).error).toBe('bad max_uses');
    expect(db.getCouponByCode('KEEPCAP').max_uses).toBe(5);
  });
});

describe('validateCoupon expiry uses the Israel calendar date', () => {
  afterEach(() => vi.useRealTimers());

  it('expires by Asia/Jerusalem date, not the server/UTC date', () => {
    // 2026-07-01T22:30:00Z is still July 1 in UTC, but already 01:30 on July 2
    // in Israel (IDT, UTC+3). A coupon valid through 2026-07-01 must therefore
    // read as EXPIRED, while one through 2026-07-02 is still valid (inclusive).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T22:30:00Z'));
    db.createCoupon({ code: 'TZJUL1', discount_pct: 10, valid_until: '2026-07-01' });
    db.createCoupon({ code: 'TZJUL2', discount_pct: 10, valid_until: '2026-07-02' });
    expect(db.validateCoupon('TZJUL1')).toEqual({ valid: false, reason: 'expired' });
    expect(db.validateCoupon('TZJUL2').valid).toBe(true);
  });
});

describe('setCouponActive / deleteCoupon / listCoupons', () => {
  it('toggles active and returns the coupon; null for unknown id', () => {
    const c = db.createCoupon({ code: 'TOGGLE', discount_pct: 10 });
    expect(db.setCouponActive(c.id, false).active).toBe(false);
    expect(db.setCouponActive(c.id, true).active).toBe(true);
    expect(db.setCouponActive('nope', false)).toBe(null);
  });

  it('deletes a coupon; false for unknown id', () => {
    const c = db.createCoupon({ code: 'DELME', discount_pct: 10 });
    expect(db.deleteCoupon(c.id)).toBe(true);
    expect(db.getCouponByCode('DELME')).toBe(null);
    expect(db.deleteCoupon('nope')).toBe(false);
  });

  it('lists coupons newest first', () => {
    const list = db.listCoupons();
    expect(Array.isArray(list)).toBe(true);
    // created_at descending
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].created_at.localeCompare(list[i].created_at)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('incrementCouponUses', () => {
  it('bumps the use counter and returns false for an unknown code', () => {
    db.createCoupon({ code: 'USES', discount_pct: 10 });
    expect(db.incrementCouponUses('USES')).toBe(true);
    expect(db.getCouponByCode('USES').uses).toBe(1);
    expect(db.incrementCouponUses('USES')).toBe(true);
    expect(db.getCouponByCode('USES').uses).toBe(2);
    expect(db.incrementCouponUses('NOPE')).toBe(false);
  });
});
