// @vitest-environment node
// PARTNER VOUCHERS: the pure rules (server/vouchers.js) and the store
// (server/stores/vouchers.js, spread into db). The checkout, the settle and the
// admin routes are driven through the real app in partner-vouchers-routes.test.js.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const rules = require(path.join(serverDir, 'vouchers.js'));

const CODE_RE = /^HTZ(-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}){4}$/;

describe('the code', () => {
  it('is the prefix and four groups of four from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) expect(rules.makeVoucherCode('htz')).toMatch(CODE_RE);
  });

  it('never uses a character people misread: no 0, O, 1, I or L', () => {
    expect(rules.ALPHABET).not.toMatch(/[01OIL]/);
    const all = Array.from({ length: 500 }, () => rules.makeVoucherCode('AB')).join('');
    expect(all.replace(/^AB-|-AB-/g, '')).not.toMatch(/[01OIL]/);
  });

  it('carries at least 60 bits of randomness', () => {
    expect(rules.RANDOM_LEN).toBe(16);
    expect(rules.ENTROPY_BITS).toBeGreaterThanOrEqual(60);
    // 31^16: the number the admin page prints.
    expect(Math.floor(rules.ENTROPY_BITS)).toBe(79);
  });

  it('draws from crypto, not Math.random (an injected source decides every character)', () => {
    const code = rules.makeVoucherCode('HTZ', { randomInt: () => 0 });
    expect(code).toBe('HTZ-AAAA-AAAA-AAAA-AAAA');
  });

  it('draws again on a collision, and gives up loudly rather than loop', () => {
    let calls = 0;
    const taken = () => {
      calls += 1;
      return calls < 3;
    };
    expect(rules.makeVoucherCode('HTZ', { taken })).toMatch(CODE_RE);
    expect(calls).toBe(3);
    expect(() => rules.makeVoucherCode('HTZ', { taken: () => true })).toThrow(/50 tries/);
  });

  it('refuses a prefix that is not 2–6 Latin letters', () => {
    for (const bad of ['H', 'HTZABCD', 'H1', 'הטז', '', 'H-Z']) {
      expect(rules.isValidPrefix(bad), bad).toBe(false);
      expect(() => rules.makeVoucherCode(bad)).toThrow(/prefix/);
    }
    expect(rules.isValidPrefix(' htz ')).toBe(true);
  });

  it('is the same code however it is typed: case, spaces, missing or odd dashes', () => {
    const k = rules.compactCode('HTZ-7KQ4-M9XR-2WFP-AB3C');
    expect(k).toBe('HTZ7KQ4M9XR2WFPAB3C');
    expect(rules.compactCode(' htz 7kq4 m9xr 2wfp ab3c ')).toBe(k);
    expect(rules.compactCode('HTZ–7KQ4–M9XR–2WFP–AB3C')).toBe(k);
    expect(rules.compactCode(null)).toBe('');
  });
});

describe('what a code is worth on an order (one copy, at most the pickup price)', () => {
  const credit = (unitPrice, gameMoney) =>
    rules.voucherCredit({ unitPrice, pickupPrice: 199, gameMoney });
  it('pickup ×1 — the whole game', () => expect(credit(199, 199)).toBe(199));
  it('pickup ×3 — one copy of three', () => expect(credit(199, 597)).toBe(199));
  it('pdf — cheaper than pickup, so all of it', () => expect(credit(99, 99)).toBe(99));
  it('custom — a pickup copy off the bespoke price', () => expect(credit(599, 599)).toBe(199));
  it('never more than the game money', () => expect(credit(199, 50)).toBe(50));
  it('nothing for a broken price', () => {
    expect(credit(0, 199)).toBe(0);
    expect(rules.voucherCredit({ unitPrice: 199, pickupPrice: NaN, gameMoney: 199 })).toBe(0);
  });
});

describe('the payout', () => {
  const row = (used_at, voided_at = null) => ({ used_at, voided_at });

  it('is used × the pool price, and says "not set" for a 0 price', () => {
    const rows = [
      row('2026-11-02T10:00:00Z'),
      row('2026-11-03T10:00:00Z'),
      row(null),
      row(null, 'x'),
    ];
    const unset = rules.poolSummary({ price_per_use: 0 }, rows);
    expect(unset).toMatchObject({
      issued: 4,
      used: 2,
      unused: 1,
      voided: 1,
      owed: 0,
      price_set: false,
    });
    const set = rules.poolSummary({ price_per_use: 42.5 }, rows);
    expect(set.owed).toBe(85);
    expect(set.price_set).toBe(true);
  });

  it('is billed at TODAY’s price for codes used before the price was set', () => {
    // No snapshot: the price is unknown when the first codes are used.
    const rows = [row('2026-10-01T10:00:00Z')];
    expect(rules.poolSummary({ price_per_use: 0 }, rows).owed).toBe(0);
    expect(rules.poolSummary({ price_per_use: 60 }, rows).owed).toBe(60);
  });

  it('is split by ISRAEL month, newest first', () => {
    const rows = [
      // 23:30 UTC on 31 Oct is 01:30 on 1 Nov in Tel Aviv (UTC+2 in winter).
      row('2026-10-31T23:30:00Z'),
      row('2026-10-15T09:00:00Z'),
      row('2026-11-05T09:00:00Z'),
    ];
    const s = rules.poolSummary({ price_per_use: 10 }, rows);
    expect(s.by_month).toEqual([
      { month: '2026-11', used: 2, owed: 20 },
      { month: '2026-10', used: 1, owed: 10 },
    ]);
  });
});

describe('the CSVs', () => {
  const pool = { partner_name: 'Hi Tech Zone', price_per_use: 50 };
  const rows = [
    { code: 'HTZ-AAAA-BBBB-CCCC-DDDD', created_at: '2026-11-01T08:00:00Z', used_at: null },
    {
      code: 'HTZ-EEEE-FFFF-GGGG-HHHH',
      created_at: '2026-11-01T08:00:00Z',
      used_at: '2026-11-02T08:00:00Z',
      order_id: 'c1',
    },
    { code: 'HTZ-JJJJ-KKKK-MMMM-NNNN', created_at: '2026-11-01T08:00:00Z', voided_at: 'x' },
  ];

  it('codes: a BOM for Excel, a header, one quoted line per code with its status', () => {
    const out = rules.codesCsv(pool, rows);
    expect(out.startsWith('﻿')).toBe(true);
    const lines = out.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('"code","partner","status","created_at"');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      '"HTZ-AAAA-BBBB-CCCC-DDDD","Hi Tech Zone","unused","2026-11-01T08:00:00Z"'
    );
    expect(lines[2]).toContain('"used"');
    expect(lines[3]).toContain('"void"');
  });

  it('usage: only the used codes, with the month, the order and the price', () => {
    const out = rules.usageCsv(pool, rows, (r) => (r.order_id === 'c1' ? '1042' : ''));
    const lines = out.slice(1).trim().split('\r\n');
    expect(lines).toEqual([
      '"code","partner","used_at","month","order","price_per_use"',
      '"HTZ-EEEE-FFFF-GGGG-HHHH","Hi Tech Zone","2026-11-02T08:00:00Z","2026-11","1042","50"',
    ]);
  });

  it('defuses a cell a spreadsheet would run as a formula, and doubles quotes', () => {
    expect(rules.csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(rules.csvCell('+1')).toBe('"\'+1"');
    expect(rules.csvCell('Hi "Tech"')).toBe('"Hi ""Tech"""');
  });
});

describe('the miss limiter', () => {
  it('blocks a key after `limit` misses in the window, and forgets them after it', () => {
    let t = 1000;
    const lim = rules.makeMissLimiter({ limit: 3, windowMs: 100, now: () => t });
    for (let i = 0; i < 3; i++) {
      expect(lim.blocked('a')).toBe(false);
      lim.miss('a');
    }
    expect(lim.blocked('a')).toBe(true);
    expect(lim.blocked('b')).toBe(false);
    t += 101;
    expect(lim.blocked('a')).toBe(false);
  });
});

describe('the store', () => {
  let db;
  beforeAll(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-vouchers-store-'));
    for (const f of ['settings.js', 'db.js', 'vouchers.js', 'stores/vouchers.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    db = require(path.join(serverDir, 'db.js'));
  });

  it('creates a pool with N unique codes under its prefix', () => {
    const r = db.createVoucherPool({
      partner_name: '  Hi   Tech Zone ',
      prefix: 'htz',
      count: 300,
      price_per_use: '',
    });
    expect(r.pool).toMatchObject({ partner_name: 'Hi Tech Zone', prefix: 'HTZ', price_per_use: 0 });
    expect(r.codes).toHaveLength(300);
    expect(new Set(r.codes.map((c) => c.key)).size).toBe(300);
    for (const c of r.codes) expect(c.code).toMatch(CODE_RE);
  });

  it('refuses bad input and a prefix another pool has', () => {
    expect(db.createVoucherPool({ partner_name: '', prefix: 'AB', count: 1 }).error).toBe(
      'bad partner_name'
    );
    expect(db.createVoucherPool({ partner_name: 'x', prefix: 'A1', count: 1 }).error).toBe(
      'bad prefix'
    );
    expect(db.createVoucherPool({ partner_name: 'x', prefix: 'HTZ', count: 1 }).error).toBe(
      'duplicate prefix'
    );
    for (const count of [0, -1, 1.5, 5001, 'x']) {
      expect(db.createVoucherPool({ partner_name: 'x', prefix: 'QQ', count }).error).toBe(
        'bad count'
      );
    }
    expect(
      db.createVoucherPool({ partner_name: 'x', prefix: 'QQ', count: 1, price_per_use: -5 }).error
    ).toBe('bad price_per_use');
  });

  it('is unique across EVERY kind of code: an owner coupon may not equal a voucher', () => {
    const pool = db.createVoucherPool({ partner_name: 'P', prefix: 'UNQ', count: 1 });
    const v = pool.codes[0];
    // The owner-coupon shape is [A-Z0-9]{3,20}; a voucher without its dashes can fit.
    expect(v.key).toHaveLength(19);
    expect(db.createCoupon({ code: v.key, discount_pct: 10 }).error).toBe('duplicate');
    expect(db.anyCodeTaken(v.code.toLowerCase())).toBe(true);
    // …and a new voucher is never minted onto an owner coupon or a friend code.
    db.createCoupon({ code: 'SUMMER20', discount_pct: 20 });
    expect(db.anyCodeTaken('summer-20')).toBe(true);
    const party = db.createCollection('שירה');
    const friend = db.issueFriendCoupon({
      email: 'noa@example.com',
      collectionId: party.id,
      percent: 5,
      expiryDays: 30,
    }).coupon;
    expect(db.anyCodeTaken(friend.code)).toBe(true);
    expect(db.anyCodeTaken('NEVER-ISSUED-1')).toBe(false);
  });

  it('validates by compact form; refuses unknown, used and voided codes', () => {
    const { codes } = db.createVoucherPool({ partner_name: 'P', prefix: 'VAL', count: 3 });
    const [a, b, c] = codes;
    expect(db.validateVoucher(a.key.toLowerCase())).toMatchObject({
      valid: true,
      coupon: { code: a.code, voucher: true, discount_pct: 0, partner_name: 'P' },
    });
    // Through the checkout's one door, too.
    expect(db.validateCoupon(a.code.replace(/-/g, ' ')).coupon.voucher).toBe(true);
    expect(db.validateCoupon('VAL-AAAA-AAAA-AAAA-AAAA')).toEqual({
      valid: false,
      reason: 'not_found',
    });
    expect(db.consumeVoucher(b.code, 'order-b')).toBe('consumed');
    expect(db.validateCoupon(b.code)).toEqual({ valid: false, reason: 'used' });
    expect(db.voidVoucher(c.id, 'lost').voided_at).toBeTruthy();
    expect(db.validateCoupon(c.code)).toEqual({ valid: false, reason: 'void' });
    expect(db.voidVoucher(b.id)).toEqual({ error: 'already_used' });
  });

  it('spends a code once: a second order is a conflict, the same order a replay', () => {
    const { codes } = db.createVoucherPool({ partner_name: 'P', prefix: 'TWICE', count: 1 });
    const code = codes[0].code;
    expect(db.consumeVoucher(code, 'o1')).toBe('consumed');
    expect(db.consumeVoucher(code, 'o1')).toBe('already');
    expect(db.consumeVoucher(code, 'o2')).toBe('conflict');
    expect(db.getVoucherByCode(code).order_id).toBe('o1');
    expect(db.consumeVoucher('NOT-A-VOUCHER', 'o3')).toBe(null);
  });

  it('a hold reserves a code for one collection until it runs out', () => {
    const { codes } = db.createVoucherPool({ partner_name: 'P', prefix: 'HOLD', count: 1 });
    const code = codes[0].code;
    const now = Date.now();
    expect(db.holdVoucher(code, 'c1', now + 60000, now)).toBe(true);
    expect(db.validateVoucher(code, { collectionId: 'c2', now }).reason).toBe('held');
    expect(db.validateVoucher(code, { collectionId: 'c1', now }).valid).toBe(true);
    expect(db.holdVoucher(code, 'c2', now + 60000, now)).toBe(false);
    // Runs out on its own…
    expect(db.validateVoucher(code, { collectionId: 'c2', now: now + 60001 }).valid).toBe(true);
    // …or is let go when the window closes.
    expect(db.releaseVoucherHolds('c1')).toBe(1);
    expect(db.validateVoucher(code, { collectionId: 'c2', now }).valid).toBe(true);
  });

  it('adds codes to a pool, edits its price, and searches its codes', () => {
    const { pool } = db.createVoucherPool({ partner_name: 'P', prefix: 'MORE', count: 2 });
    expect(db.addVouchers(pool.id, 3).codes).toHaveLength(3);
    expect(db.vouchersInPool(pool.id)).toHaveLength(5);
    expect(db.addVouchers('nope', 3)).toBe(null);
    expect(db.updateVoucherPool(pool.id, { price_per_use: '45' }).price_per_use).toBe(45);
    const one = db.vouchersInPool(pool.id)[0];
    expect(db.listVouchers(pool.id, { q: one.code.slice(4, 13).toLowerCase() })[0].id).toBe(one.id);
    expect(db.listVouchers(pool.id, { status: 'used' })).toHaveLength(0);
    const listed = db.listVoucherPools().find((p) => p.id === pool.id);
    expect(listed.summary).toMatchObject({ issued: 5, unused: 5, price_per_use: 45 });
  });

  it('only counts a miss on something shaped like one of the pools’ codes', () => {
    expect(db.looksLikeVoucher('HTZ-ABCD-EFGH')).toBe(true);
    expect(db.looksLikeVoucher('htz abcd efgh jkmn')).toBe(true);
    expect(db.looksLikeVoucher('SUMMER20')).toBe(false);
    expect(db.looksLikeVoucher('HTZ1')).toBe(false);
  });
});
