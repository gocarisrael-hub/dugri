import { describe, it, expect, beforeAll } from 'vitest';
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

// A YYYY-MM-DD string offset from today (for expiry cases).
function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
