// @vitest-environment node
// The owner's monthly revenue table (server/revenue.js): what counts as money in,
// what nets it back out, which charge is which order, and which month a payment
// belongs to.
//
// The row shapes are the ones production's Tranzila report actually returns
// (read 2026-11-03): a charge is txn_type DEBIT / tranmode A; a refund has an
// EMPTY txn_type and tranmode "C<index it refunds>", with a positive amount.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const revenue = require(path.join(__dirname, '..', '..', 'server', 'revenue.js'));
const { monthlyRevenue, classify, israelMonth, cleanOverride, createRevenueReport } = revenue;

const P = (n) => 'dp' + String(n).padStart(16, '0');
const S = (n) => 'ds' + String(n).padStart(16, '0');
const tokenEnv = (t) => (/^d([a-z])[0-9a-f]{16}$/.exec(t) || [])[1] || null;

function charge(index, date, amountNis, extra = {}) {
  return {
    index: String(index),
    date,
    time: '12:00:00',
    amountAgorot: Math.round(amountNis * 100),
    currency: '1',
    responseCode: '000',
    txnType: 'DEBIT',
    tranmode: 'A',
    tokens: [],
    ...extra,
  };
}
function refund(index, date, amountNis, ofIndex, extra = {}) {
  return charge(index, date, amountNis, { txnType: null, tranmode: 'C' + ofIndex, ...extra });
}
function siteOrder(
  no,
  { index, quantity = 1, total = 279, paid_at = '2026-10-10T10:00:00Z', ...o }
) {
  return {
    id: 'c' + no,
    order_no: 'DG-' + no,
    order: {
      paid: true,
      paid_at,
      paid_method: 'tranzila',
      paid_transaction_id: String(index),
      charged_total: total,
      total,
      quantity,
      ...o,
    },
  };
}
const run = (p) =>
  monthlyRevenue({ env: 'p', tokenEnv, from: '2026-09', to: '2026-11', overrides: {}, ...p });
const month = (out, m) => out.months.find((x) => x.month === m);

describe('classify: what an approved Tranzila row is', () => {
  it('a DEBIT in standard mode is a charge', () => {
    expect(classify(charge(1, '2026-10-01', 279)).kind).toBe('charge');
  });
  it('a refund is tranmode C<index> with no txn_type, and names the charge it refunds', () => {
    expect(classify(refund(2, '2026-10-07', 40, 123456))).toEqual({ kind: 'refund', of: '123456' });
  });
  it('the documented money-back names count as refunds too', () => {
    for (const t of ['CREDIT', 'CANCEL', 'REFUTE', 'REVERSAL']) {
      expect(classify(charge(3, '2026-10-01', 10, { txnType: t, tranmode: null })).kind).toBe(
        'refund'
      );
    }
  });
  it('anything else (a hold, a card check, a foreign currency) is not guessed at', () => {
    expect(classify(charge(4, '2026-10-01', 10, { tranmode: 'V' })).kind).toBe('other');
    expect(classify(charge(5, '2026-10-01', 10, { txnType: 'J2', tranmode: 'N' })).kind).toBe(
      'other'
    );
    expect(classify(charge(6, '2026-10-01', 10, { currency: '2' })).kind).toBe('other');
  });
});

describe('refunds net out of revenue', () => {
  it('a partial refund lowers the month it was made in, and the order still counts', () => {
    const out = run({
      rows: [
        charge(100, '2026-10-07', 518, { tokens: [P(1)] }),
        refund(101, '2026-11-02', 40, 100),
      ],
      collections: [siteOrder(1, { index: 100, total: 518, quantity: 2 })],
    });
    expect(month(out, '2026-10')).toMatchObject({ revenue: 518, orders: 1, copies: 2 });
    expect(month(out, '2026-11')).toMatchObject({
      revenue: -40,
      refunds: 1,
      refunds_total: 40,
      orders: 0,
    });
    expect(out.totals.revenue).toBe(478);
  });

  it('a full refund is not a sale: no order and no copies, and the money nets to zero', () => {
    const out = run({
      rows: [charge(110, '2026-10-07', 279), refund(111, '2026-10-08', 279, 110)],
      collections: [siteOrder(2, { index: 110 })],
    });
    expect(month(out, '2026-10')).toMatchObject({ revenue: 0, charges: 1, orders: 0, copies: 0 });
  });

  it('a CREDIT row nets the same way', () => {
    const out = run({
      rows: [charge(120, '2026-10-01', 239), charge(121, '2026-10-02', 39, { txnType: 'CREDIT' })],
      collections: [siteOrder(3, { index: 120, total: 239 })],
    });
    expect(month(out, '2026-10').revenue).toBe(200);
  });

  it('declined rows are not money at all', () => {
    const out = run({
      rows: [charge(130, '2026-10-01', 279, { responseCode: '141' })],
      collections: [],
    });
    expect(month(out, '2026-10')).toMatchObject({ revenue: 0, charges: 0, orders: 0 });
    expect(out.unmatched).toEqual([]);
  });

  it('an approved row of an unknown shape is listed and counted nowhere', () => {
    const out = run({ rows: [charge(140, '2026-10-01', 279, { tranmode: 'V' })], collections: [] });
    expect(month(out, '2026-10').revenue).toBe(0);
    expect(out.unclassified).toEqual([
      expect.objectContaining({ index: '140', amount: 279, tranmode: 'V' }),
    ]);
  });
});

describe('matching a charge to a site order', () => {
  it('by the transaction index the settle path stored, with its copies', () => {
    const out = run({
      rows: [charge(200, '2026-10-10', 478)],
      collections: [siteOrder(10, { index: 200, total: 478, quantity: 2 })],
    });
    expect(month(out, '2026-10')).toMatchObject({
      orders: 1,
      site_orders: 1,
      copies: 2,
      site_copies: 2,
      b2b_charges: 0,
    });
    expect(out.unmatched).toEqual([]);
  });

  it('never by amount: a charge equal to an order but with another index is unmatched', () => {
    const out = run({
      rows: [charge(300, '2026-10-11', 279)],
      collections: [siteOrder(11, { index: 999, total: 279 })],
    });
    expect(out.unmatched.map((u) => u.index)).toEqual(['300']);
    expect(month(out, '2026-10')).toMatchObject({ site_orders: 0, b2b_charges: 1, copies: 0 });
  });

  it('a delivery upgrade is a charge but not an order and not a copy', () => {
    const o = siteOrder(12, { index: 400, total: 279, quantity: 1 });
    o.order.shipping = {
      paid: true,
      paid_method: 'tranzila',
      paid_transaction_id: '401',
      charged_total: 40,
      paid_at: '2026-10-20T10:00:00Z',
    };
    const out = run({
      rows: [charge(400, '2026-10-10', 239), charge(401, '2026-10-20', 40)],
      collections: [o],
    });
    expect(month(out, '2026-10')).toMatchObject({
      revenue: 279,
      charges: 2,
      orders: 1,
      copies: 1,
      shipping_upgrades: 1,
    });
  });

  it('a charge carrying our token that settled nothing is unmatched, naming the order', () => {
    const out = run({
      rows: [charge(500, '2026-10-12', 279, { tokens: [P(5)] })],
      collections: [siteOrder(13, { index: 499 })],
      findOrderNo: (t) => (t === P(5) ? 'DG-13' : null),
    });
    expect(out.unmatched).toEqual([
      expect.objectContaining({ index: '500', token_order: 'DG-13' }),
    ]);
  });
});

describe('B2B charges and the copies the owner enters', () => {
  const rows = [charge(600, '2026-10-15', 2500), charge(601, '2026-10-16', 1200)];

  it('until filled they count as orders but not as copies, and say how many are unfilled', () => {
    const out = run({ rows, collections: [] });
    expect(month(out, '2026-10')).toMatchObject({
      revenue: 3700,
      orders: 2,
      b2b_charges: 2,
      copies: 0,
      b2b_unfilled: 2,
    });
    expect(out.totals.b2b_unfilled).toBe(2);
    expect(out.unmatched.map((u) => [u.index, u.copies])).toEqual([
      ['601', null],
      ['600', null],
    ]);
  });

  it('an entered number of copies counts, and zero is a real answer', () => {
    const out = run({
      rows,
      collections: [],
      overrides: { 600: { copies: 10 }, 601: { copies: 0 } },
    });
    expect(month(out, '2026-10')).toMatchObject({ copies: 10, b2b_copies: 10, b2b_unfilled: 0 });
  });
});

describe('what is left out, and shown as left out', () => {
  it('staging charges on the shared terminal, and their refunds', () => {
    const out = run({
      rows: [
        charge(700, '2026-09-17', 2, { tokens: [S(1)] }),
        refund(701, '2026-10-07', 2, 700, { tokens: [S(1)] }),
      ],
      collections: [],
    });
    expect(month(out, '2026-09').revenue).toBe(0);
    expect(month(out, '2026-10').revenue).toBe(0);
    expect(out.excluded.map((x) => [x.index, x.reason])).toEqual([
      ['701', 'other_env'],
      ['700', 'other_env'],
    ]);
  });

  it("the owner's own test: an order paid with a 99% coupon, and a refund of it", () => {
    const out = run({
      rows: [charge(800, '2026-10-05', 2), refund(801, '2026-10-06', 2, 800)],
      collections: [siteOrder(20, { index: 800, total: 239, charged_total: 2, discount_pct: 99 })],
    });
    expect(month(out, '2026-10')).toMatchObject({ revenue: 0, orders: 0, copies: 0 });
    expect(out.excluded.map((x) => [x.index, x.reason, x.order || x.refunds])).toEqual([
      ['801', 'of_excluded', '800'],
      ['800', 'test', 'DG-20'],
    ]);
  });

  it('the owner can count an automatic exclusion back in, or leave a charge out', () => {
    const out = run({
      rows: [charge(800, '2026-10-05', 2), charge(900, '2026-10-06', 50)],
      collections: [siteOrder(20, { index: 800, total: 239, charged_total: 2, discount_pct: 99 })],
      overrides: { 800: { excluded: false }, 900: { excluded: true } },
    });
    expect(month(out, '2026-10')).toMatchObject({ revenue: 2, orders: 1, copies: 1 });
    expect(out.excluded.map((x) => [x.index, x.reason])).toEqual([['900', 'manual']]);
  });
});

describe('PeleCard months come from our own orders', () => {
  const pele = (no, paid_at, total, extra = {}) => ({
    id: 'p' + no,
    order_no: 'DG-' + no,
    order: {
      paid: true,
      paid_at,
      paid_method: 'pelecard',
      paid_transaction_id: 'uuid-' + no,
      charged_total: total,
      total,
      quantity: 1,
      ...extra,
    },
  });

  it('counted by paid_at, with copies from the quantity', () => {
    const out = run({
      rows: [],
      collections: [
        pele(1, '2026-09-10T10:00:00Z', 239),
        pele(2, '2026-09-11T10:00:00Z', 478, { quantity: 2 }),
      ],
    });
    expect(month(out, '2026-09')).toMatchObject({
      revenue: 717,
      orders: 2,
      copies: 3,
      sources: ['pelecard'],
    });
  });

  it('an upgrade is taken out of the order and counted in its own month', () => {
    // markShippingPaid folds the upgrade into charged_total; it is its own charge.
    const o = pele(3, '2026-09-28T10:00:00Z', 279, {
      shipping: {
        paid: true,
        paid_method: 'pelecard',
        charged_total: 40,
        paid_at: '2026-10-02T10:00:00Z',
      },
    });
    const out = run({ rows: [], collections: [o] });
    expect(month(out, '2026-09')).toMatchObject({ revenue: 239, orders: 1 });
    expect(month(out, '2026-10')).toMatchObject({ revenue: 40, orders: 0, shipping_upgrades: 1 });
  });

  it('October holds PeleCard days and Tranzila days side by side, and says so', () => {
    const out = run({
      rows: [charge(1000, '2026-10-05', 279)],
      collections: [pele(4, '2026-10-02T10:00:00Z', 239), siteOrder(5, { index: 1000 })],
    });
    expect(month(out, '2026-10')).toMatchObject({
      revenue: 518,
      orders: 2,
      sources: ['pelecard', 'tranzila'],
    });
  });

  it('a Tranzila-paid order is never counted twice; read from the store only when the report failed', () => {
    const cols = [siteOrder(6, { index: 1100, paid_at: '2026-10-12T10:00:00Z' })];
    const withReport = run({ rows: [charge(1100, '2026-10-12', 279)], collections: cols });
    expect(month(withReport, '2026-10')).toMatchObject({ revenue: 279, orders: 1 });
    const noReport = run({ rows: null, collections: cols });
    expect(month(noReport, '2026-10')).toMatchObject({
      revenue: 279,
      orders: 1,
      sources: ['orders'],
    });
  });

  it('a 100% coupon order is not revenue or a counted copy, only noted', () => {
    const out = run({
      rows: [],
      collections: [pele(7, '2026-09-10T10:00:00Z', 0, { paid_method: 'coupon', quantity: 3 })],
    });
    expect(month(out, '2026-09')).toMatchObject({
      revenue: 0,
      orders: 0,
      copies: 0,
      free_orders: 1,
      free_copies: 3,
    });
  });

  it('a free PARTNER-VOUCHER order is noted apart from 100% coupons, not counted as revenue', () => {
    const out = run({
      rows: [],
      collections: [
        pele(8, '2026-11-10T10:00:00Z', 0, {
          paid_method: 'voucher',
          quantity: 1,
          voucher: { code: 'HTZ-AAAA-BBBB-CCCC-DDDD', partner_name: 'Hi Tech Zone' },
        }),
      ],
    });
    expect(month(out, '2026-11')).toMatchObject({
      revenue: 0,
      orders: 0,
      copies: 0,
      free_orders: 0,
      voucher_orders: 1,
      voucher_copies: 1,
    });
  });
});

describe('month boundaries are Israel time', () => {
  it('summer (UTC+3): 21:30Z on Sep 30 is already October in Jerusalem', () => {
    expect(israelMonth('2026-09-30T21:30:00Z')).toBe('2026-10');
    expect(israelMonth('2026-09-30T20:59:59Z')).toBe('2026-09');
  });
  it('winter (UTC+2): 22:30Z on Nov 30 is December; 21:59Z on Dec 31 is still December', () => {
    expect(israelMonth('2026-11-30T22:30:00Z')).toBe('2026-12');
    expect(israelMonth('2026-11-30T21:59:00Z')).toBe('2026-11');
    expect(israelMonth('2026-12-31T21:59:00Z')).toBe('2026-12');
  });
  it('an order paid just after Israeli midnight lands in the new month in the table', () => {
    const out = run({
      rows: [],
      collections: [
        {
          id: 'x',
          order_no: 'DG-9',
          order: {
            paid: true,
            paid_at: '2026-09-30T21:30:00Z',
            paid_method: 'pelecard',
            charged_total: 239,
            total: 239,
            quantity: 1,
          },
        },
      ],
    });
    expect(month(out, '2026-09').orders).toBe(0);
    expect(month(out, '2026-10').orders).toBe(1);
  });
  it("a Tranzila row's own date is already the Israel date and is used as it is", () => {
    const out = run({ rows: [charge(1200, '2026-11-01', 239)], collections: [] });
    expect(month(out, '2026-11').revenue).toBe(239);
    expect(month(out, '2026-10').revenue).toBe(0);
  });
});

describe('the owner entry is validated', () => {
  it('accepts whole copies and true/false/null exclusion', () => {
    expect(cleanOverride({ copies: '12' })).toEqual({ override: { copies: 12 } });
    expect(cleanOverride({ copies: null, excluded: false })).toEqual({
      override: { copies: null, excluded: false },
    });
  });
  it('refuses anything else', () => {
    for (const b of [{ copies: -1 }, { copies: 1.5 }, { copies: 'x' }, { excluded: 'yes' }, {}]) {
      expect(cleanOverride(b).error).toBeTruthy();
    }
  });
});

describe('the report is read once per finished month', () => {
  function fakeTranzila() {
    const calls = [];
    return {
      calls,
      sessionTokenValues: () => [],
      async listTransactions(range) {
        calls.push(range.startDate + '..' + range.endDate);
        return [];
      },
    };
  }

  it('past months are cached for good, the current one only for the TTL', async () => {
    let t = Date.parse('2026-11-10T10:00:00Z');
    const tz = fakeTranzila();
    const rep = createRevenueReport({ tranzila: tz, now: () => t, currentTtlMs: 60000 });
    await rep.rowsFor('2026-10', '2026-11');
    expect(tz.calls).toEqual(['2026-10-01..2026-10-31', '2026-11-01..2026-11-10']);
    t += 30000;
    await rep.rowsFor('2026-10', '2026-11');
    expect(tz.calls.length).toBe(2);
    t += 60000;
    await rep.rowsFor('2026-10', '2026-11');
    expect(tz.calls).toEqual([
      '2026-10-01..2026-10-31',
      '2026-11-01..2026-11-10',
      '2026-11-01..2026-11-10',
    ]);
  });

  it('a month read on the first of the next month is read again later (late rows)', async () => {
    let t = Date.parse('2026-11-01T08:00:00Z');
    const tz = fakeTranzila();
    const rep = createRevenueReport({ tranzila: tz, now: () => t, currentTtlMs: 1000 });
    await rep.rowsFor('2026-10', '2026-10');
    t = Date.parse('2026-11-03T08:00:00Z');
    await rep.rowsFor('2026-10', '2026-10');
    t += 10 * 60 * 1000;
    await rep.rowsFor('2026-10', '2026-10');
    expect(tz.calls).toEqual(['2026-10-01..2026-10-31', '2026-10-01..2026-10-31']);
  });

  it('a failed read is not cached', async () => {
    const tz = fakeTranzila();
    let fail = true;
    tz.listTransactions = async () => {
      if (fail) throw new Error('down');
      return [];
    };
    const rep = createRevenueReport({
      tranzila: tz,
      now: () => Date.parse('2026-11-10T10:00:00Z'),
    });
    await expect(rep.rowsFor('2026-11', '2026-11')).rejects.toThrow('down');
    fail = false;
    await expect(rep.rowsFor('2026-11', '2026-11')).resolves.toEqual([]);
  });
});

// Review of #743: the same order counts the same way from either source, and the
// owner's tests are recognised exactly, never by "a big discount".
describe('the same exclusions on both sources', () => {
  const peleOrder = (no, extra = {}, cExtra = {}) => ({
    id: 'q' + no,
    order_no: 'DG-' + no,
    ...cExtra,
    order: {
      paid: true,
      paid_at: '2026-10-10T10:00:00Z',
      paid_method: 'pelecard',
      paid_transaction_id: 'uuid-' + no,
      charged_total: 279,
      total: 279,
      quantity: 2,
      ...extra,
    },
  });

  it('a real 100% coupon on a delivery order: its card charge (the fee) and copies count', () => {
    // A coupon discounts the game, never the postage, so the card still pays 40.
    const o = siteOrder(30, { index: 3000, total: 279, charged_total: 40, discount_pct: 100 });
    const viaReport = run({ rows: [charge(3000, '2026-10-10', 40)], collections: [o] });
    const viaStore = run({ rows: null, collections: [o] });
    for (const out of [viaReport, viaStore]) {
      expect(month(out, '2026-10')).toMatchObject({ revenue: 40, orders: 1, copies: 1 });
      expect(out.excluded).toEqual([]);
    }
    const pele = run({
      rows: [],
      collections: [peleOrder(31, { charged_total: 40, discount_pct: 100, quantity: 1 })],
    });
    expect(month(pele, '2026-10')).toMatchObject({ revenue: 40, orders: 1, copies: 1 });
  });

  it('a 99% test is excluded on PeleCard and on the store fallback, as on the report', () => {
    const t = siteOrder(32, { index: 3200, total: 239, charged_total: 2, discount_pct: 99 });
    const viaReport = run({ rows: [charge(3200, '2026-10-10', 2)], collections: [t] });
    const viaStore = run({ rows: null, collections: [t] });
    const pele = run({
      rows: [],
      collections: [peleOrder(33, { charged_total: 2, discount_pct: 99, quantity: 1 })],
    });
    for (const out of [viaReport, viaStore, pele]) {
      expect(month(out, '2026-10')).toMatchObject({ revenue: 0, orders: 0, copies: 0 });
      expect(out.excluded.map((x) => x.reason)).toEqual(['test']);
    }
    // Only the terminal row can be counted back in from the page.
    expect(viaReport.excluded[0].toggle).toBe(true);
    expect(pele.excluded[0].toggle).toBeUndefined();
  });

  it('a cancelled order is not a sale on either source', () => {
    const c = siteOrder(34, { index: 3400, total: 478, quantity: 2 });
    c.cancelled = true;
    const viaReport = run({ rows: [charge(3400, '2026-10-10', 478)], collections: [c] });
    const viaStore = run({ rows: null, collections: [c] });
    const pele = run({ rows: [], collections: [peleOrder(35, {}, { cancelled: true })] });
    for (const out of [viaReport, viaStore, pele]) {
      expect(month(out, '2026-10')).toMatchObject({ revenue: 0, orders: 0, copies: 0 });
      expect(out.excluded.map((x) => [x.reason, x.order])).toEqual([
        ['cancelled', expect.stringMatching(/^DG-/)],
      ]);
    }
  });

  it('a cancelled order refunded on the terminal is not subtracted twice', () => {
    const c = siteOrder(36, { index: 3600, total: 279 });
    c.cancelled = true;
    const out = run({
      rows: [charge(3600, '2026-10-10', 279), refund(3601, '2026-10-11', 279, 3600)],
      collections: [c],
    });
    expect(month(out, '2026-10')).toMatchObject({ revenue: 0, refunds: 0 });
  });

  it('an upgrade on an excluded order goes with it, on both sources', () => {
    const shipping = (method, idx) => ({
      paid: true,
      paid_method: method,
      paid_transaction_id: idx,
      charged_total: 40,
      fee: 40,
      paid_at: '2026-10-12T10:00:00Z',
    });
    const t = siteOrder(37, { index: 3700, total: 279, charged_total: 42, discount_pct: 99 });
    t.order.shipping = shipping('tranzila', '3701');
    const viaReport = run({
      rows: [charge(3700, '2026-10-10', 2), charge(3701, '2026-10-12', 40)],
      collections: [t],
    });
    const viaStore = run({ rows: null, collections: [t] });
    const p = peleOrder(38, { charged_total: 42, discount_pct: 99, quantity: 1 });
    p.order.shipping = shipping('pelecard', 'uuid-u38');
    const pele = run({ rows: [], collections: [p] });
    for (const out of [viaReport, viaStore, pele]) {
      expect(month(out, '2026-10')).toMatchObject({ revenue: 0, charges: 0, shipping_upgrades: 0 });
      expect(out.excluded.map((x) => [x.kind, x.reason]).sort()).toEqual([
        ['charge', 'test'],
        ['upgrade', 'test'],
      ]);
    }
  });

  it('a fully refunded upgrade is not counted as an upgrade', () => {
    const o = siteOrder(39, { index: 3900, total: 279, charged_total: 279 });
    o.order.shipping = {
      paid: true,
      paid_method: 'tranzila',
      paid_transaction_id: '3901',
      charged_total: 40,
      paid_at: '2026-10-12T10:00:00Z',
    };
    const out = run({
      rows: [
        charge(3900, '2026-10-10', 239),
        charge(3901, '2026-10-12', 40),
        refund(3902, '2026-10-13', 40, 3901),
      ],
      collections: [o],
    });
    expect(month(out, '2026-10')).toMatchObject({ revenue: 239, shipping_upgrades: 0, orders: 1 });
  });
});

describe('an old order with no charged_total', () => {
  const old = (extra) => ({
    id: 'o',
    order_no: 'DG-1',
    order: {
      paid: true,
      paid_at: '2026-08-10T10:00:00Z',
      paid_method: 'pelecard',
      quantity: 1,
      ...extra,
    },
  });

  it('counts the discounted total, never the pre-discount one', () => {
    const out = run({
      rows: [],
      from: '2026-08',
      collections: [old({ total: 200, discount_pct: 50 })],
    });
    expect(month(out, '2026-08').revenue).toBe(100);
  });

  it('discounts the game only, not the postage', () => {
    const out = run({
      rows: [],
      from: '2026-08',
      collections: [old({ total: 279, delivery_fee: 40, discount_pct: 10 })],
    });
    expect(month(out, '2026-08').revenue).toBe(255.1);
  });

  it('takes an upgrade folded into total back out before discounting', () => {
    const out = run({
      rows: [],
      from: '2026-08',
      collections: [
        old({
          total: 239,
          delivery_fee: 40,
          discount_pct: 50,
          shipping: {
            paid: true,
            paid_method: 'pelecard',
            fee: 40,
            paid_at: '2026-08-12T10:00:00Z',
          },
        }),
      ],
    });
    // The order: (239 − 40) × 50% = 99.5; the upgrade: 40.
    expect(month(out, '2026-08')).toMatchObject({ revenue: 139.5, shipping_upgrades: 1 });
  });
});
