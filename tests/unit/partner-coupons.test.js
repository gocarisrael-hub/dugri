// @vitest-environment node
// A BLOGGER'S COUPON — a discount code that also earns its owner money.
//
// The money rules matter more than the plumbing, and three of them are the
// difference between a partnership that works and an argument:
//
//   • the terms are FROZEN at payment. Raising a rate must never re-price what
//     was already sold, or the owner wakes up owing money she never agreed to;
//   • a CANCELLED order is not a sale;
//   • a FREE order earns nothing — a 100%-off code takes no money, and a fixed
//     fee on top of it is the shop paying to give a game away.
//
// The report is DERIVED from the orders every time, so there is no stored total
// that can drift away from them.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let db;

beforeEach(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-partner-'));
  for (const f of ['settings.js', 'db.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
});

// A paid order carrying `code`, charged `charged` with `fee` of that being
// postage. Returns the collection id.
function paidOrder(code, { charged = 239, fee = 0, total = 279 } = {}) {
  const c = db.createCollection({ honoree_name: 'ש', owner_email: 'b@example.com' });
  c.order = {
    version: fee ? 'delivery' : 'pickup',
    quantity: 1,
    delivery_fee: fee,
    total,
    paid: false,
  };
  db.markPaid(c.id, { charged_total: charged, coupon: code, discount_pct: 15 });
  return c.id;
}

const partner = (over = {}) =>
  db.createCoupon({
    code: 'BLOG',
    discount_pct: 15,
    partner_name: 'נועה',
    commission_type: 'fixed',
    commission_value: 30,
    ...over,
  });

describe('creating a partner coupon', () => {
  it('mints a report token for a partner code, and none for a plain one', () => {
    const p = partner();
    expect(p.report_token).toMatch(/^[a-f0-9]{48}$/);
    const plain = db.createCoupon({ code: 'PLAIN10', discount_pct: 10 });
    expect(plain.report_token).toBeNull();
    // The token is not derivable from the code, which is short and printed in
    // public — that is the whole reason it exists.
    expect(p.report_token).not.toContain('BLOG');
  });

  it('refuses terms that are not terms', () => {
    for (const bad of [
      { commission_type: 'gift' },
      { commission_type: 'percent', commission_value: 101 },
      { commission_type: 'fixed', commission_value: 0 },
      { commission_type: 'fixed', commission_value: -5 },
      { commission_type: 'fixed', commission_value: 99999 },
    ]) {
      const r = db.createCoupon({
        code: 'X' + Math.random().toString(36).slice(2, 6).toUpperCase(),
        discount_pct: 10,
        ...bad,
      });
      expect(r.error, JSON.stringify(bad)).toBeTruthy();
    }
  });
});

describe('what a sale earns', () => {
  it('a fixed rate is per ORDER, whatever the discount was', () => {
    partner();
    paidOrder('BLOG', { charged: 203 });
    const rep = db.partnerReport(db.getCouponByCode('BLOG').id);
    expect(rep.totals.sales).toBe(1);
    expect(rep.totals.earned).toBe(30);
  });

  it('a percent rate is on the game money — never on the postage', () => {
    partner({ code: 'PCT', commission_type: 'percent', commission_value: 20 });
    // 242 charged, of which 39 is the courier's.
    paidOrder('PCT', { charged: 242, fee: 39 });
    const rep = db.partnerReport(db.getCouponByCode('PCT').id);
    // 20% of 203, not of 242 — paying a cut of postage loses money per parcel.
    expect(rep.totals.earned).toBe(40.6);
  });

  it('a FREE order earns nothing, and still appears', () => {
    partner();
    paidOrder('BLOG', { charged: 0, total: 279 });
    const rep = db.partnerReport(db.getCouponByCode('BLOG').id);
    expect(rep.totals.sales).toBe(1);
    expect(rep.totals.earned).toBe(0);
  });

  it('reports what the customer saved, from the order’s own numbers', () => {
    partner();
    paidOrder('BLOG', { charged: 203, total: 239 });
    const rep = db.partnerReport(db.getCouponByCode('BLOG').id);
    expect(rep.totals.customer_saved).toBe(36);
  });
});

describe('the terms are frozen at payment', () => {
  it('raising the rate leaves every earlier sale exactly as it was sold', () => {
    partner();
    paidOrder('BLOG', { charged: 203 });
    const id = db.getCouponByCode('BLOG').id;
    expect(db.partnerReport(id).totals.earned).toBe(30);

    db.updateCouponPartner(id, {
      partner_name: 'נועה',
      commission_type: 'fixed',
      commission_value: 50,
    });
    // The old sale is still worth 30 — a live recomputation would invent a debt.
    expect(db.partnerReport(id).totals.earned).toBe(30);

    paidOrder('BLOG', { charged: 203 });
    expect(db.partnerReport(id).totals.earned).toBe(80);
  });

  it('an order paid BEFORE the coupon became a partner’s earns nothing', () => {
    db.createCoupon({ code: 'LATE', discount_pct: 10 });
    paidOrder('LATE', { charged: 215 });
    const id = db.getCouponByCode('LATE').id;
    db.updateCouponPartner(id, { commission_type: 'fixed', commission_value: 30 });
    const rep = db.partnerReport(id);
    // Listed, so both sides see the same history — but not paid retroactively
    // for a sale that was never made as a partner sale.
    expect(rep.totals.sales).toBe(1);
    expect(rep.totals.earned).toBe(0);
  });
});

describe('what is not a sale', () => {
  it('a cancelled order drops out of the earnings', () => {
    partner();
    const id = paidOrder('BLOG', { charged: 203 });
    paidOrder('BLOG', { charged: 203 });
    const cid = db.getCouponByCode('BLOG').id;
    expect(db.partnerReport(cid).totals.earned).toBe(60);
    db.cancelCollection(id);
    expect(db.partnerReport(cid).totals.sales).toBe(1);
    expect(db.partnerReport(cid).totals.earned).toBe(30);
  });

  it('another blogger’s sales are not hers', () => {
    partner();
    partner({ code: 'OTHER', partner_name: 'דנה' });
    paidOrder('OTHER', { charged: 203 });
    expect(db.partnerReport(db.getCouponByCode('BLOG').id).totals.sales).toBe(0);
    expect(db.partnerReport(db.getCouponByCode('OTHER').id).totals.sales).toBe(1);
  });

  it('an UNPAID order is not a sale', () => {
    partner();
    const c = db.createCollection({ honoree_name: 'ש', owner_email: 'b@example.com' });
    c.order = { version: 'pickup', quantity: 1, total: 239, paid: false, coupon: 'BLOG' };
    expect(db.partnerReport(db.getCouponByCode('BLOG').id).totals.sales).toBe(0);
  });
});

describe('payouts', () => {
  it('outstanding is earned minus paid, and an overpayment shows as negative', () => {
    partner();
    paidOrder('BLOG', { charged: 203 });
    const id = db.getCouponByCode('BLOG').id;
    db.addCouponPayout(id, { amount: 50, note: 'ביט' });
    const rep = db.partnerReport(id);
    expect(rep.totals.paid_out).toBe(50);
    // Shown, not floored at zero: an overpayment is a fact the owner needs.
    expect(rep.totals.outstanding).toBe(-20);
  });

  it('refuses a payout that is not money, and can undo one', () => {
    partner();
    const id = db.getCouponByCode('BLOG').id;
    for (const bad of [0, -5, 'x', null]) {
      expect(db.addCouponPayout(id, { amount: bad }).error).toBeTruthy();
    }
    const p = db.addCouponPayout(id, { amount: 30 });
    expect(db.partnerReport(id).totals.paid_out).toBe(30);
    expect(db.deleteCouponPayout(id, p.id)).toBe(true);
    expect(db.partnerReport(id).totals.paid_out).toBe(0);
  });
});

describe('the report link', () => {
  it('finds the coupon by token, and refuses anything else', () => {
    const p = partner();
    expect(db.getCouponByToken(p.report_token).code).toBe('BLOG');
    // A blank token must never match the plain coupon that has none.
    db.createCoupon({ code: 'PLAIN10', discount_pct: 10 });
    for (const bad of ['', null, undefined, 'BLOG', 'z'.repeat(48), 'a'.repeat(47)]) {
      expect(db.getCouponByToken(bad), String(bad)).toBeNull();
    }
  });

  it('rotating issues a new link and kills the old one', () => {
    const p = partner();
    const before = p.report_token;
    const after = db.rotateCouponToken(p.id).report_token;
    expect(after).not.toBe(before);
    expect(db.getCouponByToken(before)).toBeNull();
    expect(db.getCouponByToken(after).code).toBe('BLOG');
  });

  it('a plain coupon has no report at all', () => {
    const plain = db.createCoupon({ code: 'PLAIN10', discount_pct: 10 });
    expect(db.partnerReport(plain.id)).toBeNull();
    expect(db.rotateCouponToken(plain.id)).toBeNull();
  });
});
