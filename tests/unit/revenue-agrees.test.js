// @vitest-environment node
//
// TWO PAGES SHOW "הכנסות", AND THEY DISAGREED BY 1,050 ₪.
//
// ניהול הזמנות summed `order.total` — the LIST price — while לוח בקרה summed
// `order.charged_total`, what actually reached the card. Every discounted order
// therefore counted at full price on one page and at its real value on the
// other, and a 100%-coupon order counted as a full sale on one and as nothing on
// the other. Measured on production the day it was found: 61,331 vs 60,281
// across seven coupon orders, five of them free.
//
// Neither page was obviously wrong to read; the number was just quietly
// different depending which one the owner happened to open.
//
// This test does not compare the two files as TEXT — that would pass the moment
// someone pasted the same wrong formula into both. It lifts the real expression
// out of each page and RUNS it over one fixture, so what is asserted is the
// money each page would actually put on screen.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(__dirname, '..', '..', 'site');

// The pages that put a revenue figure in front of the owner.
const PAGES = ['admin.html', 'dashboard.html'];

// `const revenue = <expression>;` — the whole reducer, however it is wrapped or
// line-broken by the formatter.
const REVENUE_RE = /const revenue = ([\s\S]*?);\n/;

// Lift the expression out of a page and turn it into a callable, so the test
// exercises the page's own arithmetic rather than a copy of it that could drift.
function revenueFnOf(file) {
  const html = fs.readFileSync(path.join(SITE, file), 'utf8');
  const m = html.match(REVENUE_RE);
  if (!m) throw new Error(`no revenue expression found in ${file}`);
  // Both pages define these identically; they are supplied here so the
  // expression can run outside its page. isSale is the one revenue uses: paid,
  // and not since cancelled.
  const fn = new Function('cols', 'isPaid', 'isSale', `return ${m[1]};`);
  const isPaid = (c) => !!(c.order && c.order.paid);
  return (cols) => fn(cols, isPaid, (c) => isPaid(c) && !c.cancelled);
}

const order = (o) => ({ order: o });

// One of every shape the till actually sees.
const FIXTURE = [
  // Paid at full price — charged and list agree.
  order({ paid: true, total: 239, charged_total: 239 }),
  // Paid with a partial coupon: 15% off 239.
  order({ paid: true, total: 239, charged_total: 203, coupon: 'HELP15' }),
  // A 100% coupon. Real money: zero. This is the one that moved the number most.
  order({ paid: true, total: 199, charged_total: 0, coupon: 'FREE100' }),
  // Never paid — not revenue on any reading.
  order({ paid: false, total: 239, charged_total: null }),
  // A row from before charged_total was recorded. None exist in production, but
  // the list price is the right answer for an order that predates coupons.
  order({ paid: true, total: 79 }),
  // Not an order at all: a lead that never checked out.
  {},
  // PAID, THEN CANCELLED. The money came in and went back out; counting it would
  // mean a refunded order inflated the takings for ever. `paid` stays true —
  // it did happen — so revenue has to ask a different question.
  { cancelled: true, order: { paid: true, total: 239, charged_total: 239 } },
];

// 239 + 203 + 0 + 79. The unpaid order and the bare lead contribute nothing.
const TRUE_REVENUE = 521;

describe('the revenue figure', () => {
  it('is the same number on every page that shows it', () => {
    const results = PAGES.map((p) => [p, revenueFnOf(p)(FIXTURE)]);
    const [first] = results;
    for (const [page, value] of results) {
      expect(value, `${page} disagrees with ${first[0]}`).toBe(first[1]);
    }
  });

  it('is what the customer was CHARGED, not what the order was worth', () => {
    for (const page of PAGES) {
      expect(revenueFnOf(page)(FIXTURE), page).toBe(TRUE_REVENUE);
    }
  });

  it('counts a 100%-coupon order as the zero it was', () => {
    // The bug in one line: a free order must not read as a full sale.
    const free = [order({ paid: true, total: 199, charged_total: 0, coupon: 'FREE100' })];
    for (const page of PAGES) {
      expect(revenueFnOf(page)(free), page).toBe(0);
    }
  });

  it('falls back to the list price when no charge was recorded', () => {
    const legacy = [order({ paid: true, total: 79 })];
    for (const page of PAGES) {
      expect(revenueFnOf(page)(legacy), page).toBe(79);
    }
  });

  it('drops an order that was paid and then cancelled', () => {
    // The rule server/db.js already applies to a partner's earnings: "a cancelled
    // order is not a sale". The revenue tiles now agree with it.
    const voided = [{ cancelled: true, order: { paid: true, total: 239, charged_total: 239 } }];
    for (const page of PAGES) {
      expect(revenueFnOf(page)(voided), page).toBe(0);
    }
  });

  it('ignores an unpaid order and a collection with no order at all', () => {
    const none = [order({ paid: false, total: 239, charged_total: 239 }), {}];
    for (const page of PAGES) {
      expect(revenueFnOf(page)(none), page).toBe(0);
    }
  });
});
