// MONTHLY REVENUE AND COPIES, for the owner's revenue page (site/admin-revenue.html).
//
// Two sources, and every month says which it came from:
//
//   • TRANZILA — the terminal's own rows from the Reports API, the same rows the
//     settlement sweep reads (server/tranzila-sweep.js). Production switched to
//     Tranzila on 2026-10-05, and the terminal also carries charges the owner
//     types straight into My Tranzila for business customers (B2B). Those match
//     no site order, so they are listed for her to say how many copies each was.
//   • PELECARD — the site orders paid through PeleCard, read from our own store
//     (order.paid_at / charged_total / quantity). We never read a PeleCard report,
//     only single transactions (server/pelecard.js getTransaction), so charges
//     made in PeleCard outside the site are NOT here.
//
// A PeleCard payment never appears on the Tranzila terminal and the other way
// round, so a month is simply the sum of both — October 2026 has PeleCard orders
// from the 1st to the 4th and Tranzila from the 5th.
//
// WHAT THE ROWS LOOK LIKE, read from production on 2026-11-03 (types and amounts
// only, no card data) rather than from the docs, which leave them unconfirmed:
//   • a charge:  txn_type "DEBIT", tranmode "A", processor_response_code "000";
//   • a refund:  txn_type EMPTY, tranmode "C<index of the charge it refunds>"
//                (e.g. "C123456"), amount POSITIVE, response "000";
//   • a decline: txn_type "DEBIT", response other than "000" (141, 026, 006, 004).
//   • amount is in agorot (27900 = 279 ₪), transaction_date is the Israel date.
// The docs' money-back names (CREDIT/CANCEL/REFUTE/REVERSAL) are kept as refunds
// too. An approved row that is neither shape is not guessed at: it is listed as
// unclassified and left out of every total, so the page shows it instead of
// silently counting or dropping it.
//
// MATCHING a row to a site order is by the transaction index the settle path
// stored on the order when it marked it paid (order.paid_transaction_id, or
// order.shipping.paid_transaction_id for a delivery upgrade) — never by amount.
// A row that carries one of our session tokens but settled nothing (a second
// charge, say) is NOT matched; it is listed with the order its token points to.

const CURRENCY_ILS = '1';
const SUCCESS_CODE = '000';
const REFUND_TYPES = new Set(['CREDIT', 'CANCEL', 'REFUTE', 'REVERSAL']);
const REFUND_TRANMODE = /^C(\d*)$/;
// A coupon this deep is the owner's own test recipe (server/TRANZILA.md: "create
// a 99% coupon … and pay with your own card"), which is how the go-live tests on
// production were paid. Excluded by default, shown as such, and she can count
// one back in.
const TEST_DISCOUNT_PCT = 99;
const MAX_COPIES_ENTRY = 10000;

const TZ = 'Asia/Jerusalem';

// 'YYYY-MM-DD' in Israel for an instant.
function israelDate(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}
function israelMonth(when) {
  const s = israelDate(when);
  return s ? s.slice(0, 7) : null;
}

// Every 'YYYY-MM' from `from` to `to`, inclusive.
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function lastDayOf(month) {
  const [y, m] = month.split('-').map(Number);
  // Day 0 of the next month is the last day of this one (UTC, no zone involved).
  return month + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? y + 1 + '-01' : y + '-' + String(m + 1).padStart(2, '0');
}

// The fields the page needs from one Reports row, and nothing else: the raw row
// carries card-holder details that have no business in a cache or a response.
function slimRow(tx, sessionTokenValues) {
  const raw = tx.raw || {};
  return {
    index: String(tx.index),
    date: raw.transaction_date ? String(raw.transaction_date) : null,
    time: raw.transaction_time ? String(raw.transaction_time) : null,
    amountAgorot: tx.amountAgorot,
    currency: tx.currency,
    responseCode: tx.responseCode,
    txnType: tx.txnType,
    tranmode: tx.tranmode,
    tokens: sessionTokenValues(raw),
  };
}

// What an approved row IS: 'charge', 'refund' (with the index it refunds, when
// the row names it) or 'other'. Unapproved rows never reach here.
function classify(row) {
  if (row.currency !== CURRENCY_ILS || row.amountAgorot == null) return { kind: 'other' };
  const mode = row.tranmode || '';
  const refund = REFUND_TRANMODE.exec(mode);
  if (refund && !row.txnType) return { kind: 'refund', of: refund[1] || null };
  if (row.txnType && REFUND_TYPES.has(row.txnType)) {
    return { kind: 'refund', of: refund && refund[1] ? refund[1] : null };
  }
  if (row.txnType === 'DEBIT' && (!mode || mode === 'A')) return { kind: 'charge' };
  return { kind: 'other' };
}

function copiesOf(order) {
  const n = Math.floor(Number(order && order.quantity));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

const agorot = (nis) => Math.round(Number(nis) * 100);

// The upgrade's own charge, when the order bought delivery after paying.
function upgradeAgorot(sh) {
  if (!sh || !sh.paid) return 0;
  return agorot(sh.charged_total != null ? sh.charged_total : sh.fee || 0);
}

// The order's OWN charge. markShippingPaid adds an upgrade into charged_total
// (the one number a receipt shows), so it is taken back out here: the upgrade is
// its own transaction, in its own month, and on Tranzila its own row.
function orderChargeAgorot(order) {
  const total = agorot(order.charged_total != null ? order.charged_total : order.total || 0);
  return Math.max(0, total - upgradeAgorot(order.shipping));
}

function emptyMonth(month) {
  return {
    month,
    revenue: 0, // agorot until the end
    charges: 0,
    refunds: 0,
    refunds_total: 0,
    orders: 0,
    copies: 0,
    site_orders: 0,
    site_copies: 0,
    b2b_charges: 0,
    b2b_copies: 0,
    b2b_unfilled: 0,
    shipping_upgrades: 0,
    free_orders: 0,
    free_copies: 0,
    sources: new Set(),
  };
}

/**
 * The monthly table.
 *
 * @param {object}   p
 * @param {Array}    p.rows         slim Tranzila rows (slimRow), or null when the
 *                                  report could not be read (then Tranzila-paid
 *                                  site orders are counted from the store instead)
 * @param {Array}    p.collections  the store's collections
 * @param {object}   p.overrides    { [index]: { copies?, excluded? } }, the owner's entries
 * @param {string}   p.env          this environment's token letter (tranzila.envTag())
 * @param {Function} p.tokenEnv     token → environment letter
 * @param {Function} p.findOrderNo  token → order number of the session, or null
 * @param {string}   p.from         first month shown, 'YYYY-MM'
 * @param {string}   p.to           last month shown (the current Israel month)
 */
function monthlyRevenue({
  rows,
  collections,
  overrides = {},
  env,
  tokenEnv,
  findOrderNo = () => null,
  from,
  to,
}) {
  const months = new Map();
  const monthOf = (m) => {
    if (!months.has(m)) months.set(m, emptyMonth(m));
    return months.get(m);
  };
  for (const m of monthsBetween(from, to)) monthOf(m);

  const tranzilaRead = Array.isArray(rows);
  const byOrderIndex = new Map();
  const byShipIndex = new Map();

  // SITE ORDERS FROM THE STORE: PeleCard always; Tranzila only when its report
  // could not be read (otherwise the terminal's rows are the record, and counting
  // the store as well would count every Tranzila order twice).
  for (const c of collections || []) {
    const o = c && c.order;
    if (!o) continue;
    const ref = c.order_no || c.id;
    if (o.paid && o.paid_method === 'tranzila' && o.paid_transaction_id != null) {
      byOrderIndex.set(String(o.paid_transaction_id), { c, ref });
    }
    const sh = o.shipping;
    if (sh && sh.paid && sh.paid_method === 'tranzila' && sh.paid_transaction_id != null) {
      byShipIndex.set(String(sh.paid_transaction_id), { c, ref });
    }
    if (o.paid && o.paid_at) {
      const month = israelMonth(o.paid_at);
      const fromStore =
        o.paid_method === 'pelecard' || (o.paid_method === 'tranzila' && !tranzilaRead);
      if (month && fromStore) {
        const mo = monthOf(month);
        mo.revenue += orderChargeAgorot(o);
        mo.charges += 1;
        mo.orders += 1;
        mo.site_orders += 1;
        mo.copies += copiesOf(o);
        mo.site_copies += copiesOf(o);
        mo.sources.add(o.paid_method === 'pelecard' ? 'pelecard' : 'orders');
      } else if (month && o.paid_method === 'coupon') {
        // A 100% coupon: no money moved, so it is not revenue, a charge or a
        // counted copy. Shown beside the month so the copies are not invisible.
        const mo = monthOf(month);
        mo.free_orders += 1;
        mo.free_copies += copiesOf(o);
      }
    }
    if (sh && sh.paid && sh.paid_at) {
      const month = israelMonth(sh.paid_at);
      const fromStore =
        sh.paid_method === 'pelecard' || (sh.paid_method === 'tranzila' && !tranzilaRead);
      if (month && fromStore) {
        const mo = monthOf(month);
        mo.revenue += upgradeAgorot(sh);
        mo.charges += 1;
        mo.shipping_upgrades += 1;
        mo.sources.add(sh.paid_method === 'pelecard' ? 'pelecard' : 'orders');
      }
    }
  }

  const unmatched = [];
  const excluded = [];
  const unclassified = [];

  if (tranzilaRead) {
    const approved = rows.filter((r) => r && r.responseCode === SUCCESS_CODE && r.date);
    // First pass: decide every charge, so a refund can follow the charge it names.
    const chargeState = new Map(); // index → { excluded, refunded, row, entry }
    const decided = approved.map((r) => ({ r, cls: classify(r) }));
    const ownToken = (r) => (r.tokens || []).some((t) => tokenEnv(t) === env);
    const otherEnv = (r) => (r.tokens || []).length > 0 && !ownToken(r);
    const override = (index) => {
      const o = overrides && overrides[index];
      return o && typeof o === 'object' ? o : {};
    };

    for (const { r, cls } of decided) {
      if (cls.kind !== 'charge') continue;
      const ov = override(r.index);
      const site = byOrderIndex.get(r.index);
      const ship = byShipIndex.get(r.index);
      let reason = null;
      if (otherEnv(r)) reason = 'other_env';
      else if (site && Number(site.c.order.discount_pct) >= TEST_DISCOUNT_PCT) reason = 'test';
      if (ov.excluded === true) reason = reason || 'manual';
      if (ov.excluded === false) reason = null;
      chargeState.set(r.index, { r, site, ship, reason, refunded: 0 });
    }
    // Refunds net against the charge they name; a FULL refund also takes that
    // charge out of the order and copy counts (it was not a sale).
    for (const { r, cls } of decided) {
      if (cls.kind !== 'refund' || !cls.of) continue;
      const ch = chargeState.get(cls.of);
      if (ch) ch.refunded += r.amountAgorot;
    }

    for (const { r, cls } of decided) {
      const month = r.date.slice(0, 7);
      if (cls.kind === 'other') {
        unclassified.push({
          index: r.index,
          date: r.date,
          amount: r.amountAgorot != null ? r.amountAgorot / 100 : null,
          txn_type: r.txnType,
          tranmode: r.tranmode,
          currency: r.currency,
        });
        continue;
      }
      if (cls.kind === 'refund') {
        const ch = cls.of ? chargeState.get(cls.of) : null;
        const ov = override(r.index);
        let reason = null;
        if (otherEnv(r)) reason = 'other_env';
        else if (ch && ch.reason) reason = 'of_excluded';
        if (ov.excluded === true) reason = reason || 'manual';
        if (ov.excluded === false) reason = null;
        if (reason) {
          excluded.push({
            index: r.index,
            date: r.date,
            kind: 'refund',
            amount: -r.amountAgorot / 100,
            reason,
            refunds: cls.of,
          });
          continue;
        }
        const mo = monthOf(month);
        mo.revenue -= r.amountAgorot;
        mo.refunds += 1;
        mo.refunds_total += r.amountAgorot;
        mo.sources.add('tranzila');
        continue;
      }
      // A charge.
      const ch = chargeState.get(r.index);
      const ref = ch.site ? ch.site.ref : ch.ship ? ch.ship.ref : null;
      if (ch.reason) {
        excluded.push({
          index: r.index,
          date: r.date,
          kind: 'charge',
          amount: r.amountAgorot / 100,
          reason: ch.reason,
          order: ref,
        });
        continue;
      }
      const mo = monthOf(month);
      mo.revenue += r.amountAgorot;
      mo.charges += 1;
      mo.sources.add('tranzila');
      const fullyRefunded = ch.refunded >= r.amountAgorot;
      if (ch.ship) {
        mo.shipping_upgrades += 1;
        continue;
      }
      if (ch.site) {
        if (fullyRefunded) continue;
        mo.orders += 1;
        mo.site_orders += 1;
        mo.copies += copiesOf(ch.site.c.order);
        mo.site_copies += copiesOf(ch.site.c.order);
        continue;
      }
      // No site order recorded this index: a B2B charge typed into the terminal,
      // or a charge from the site that settled nothing. The owner says how many
      // copies it was; until then it is an order with no copies.
      const ov = override(r.index);
      const copies = Number.isInteger(ov.copies) ? ov.copies : null;
      const tokenOrders = (r.tokens || [])
        .filter((t) => tokenEnv(t) === env)
        .map((t) => findOrderNo(t))
        .filter(Boolean);
      unmatched.push({
        index: r.index,
        date: r.date,
        time: r.time,
        month,
        amount: r.amountAgorot / 100,
        copies,
        refunded: ch.refunded / 100,
        token_order: tokenOrders[0] || null,
      });
      if (fullyRefunded) continue;
      mo.orders += 1;
      mo.b2b_charges += 1;
      if (copies == null) mo.b2b_unfilled += 1;
      else {
        mo.copies += copies;
        mo.b2b_copies += copies;
      }
    }
  }

  const list = [...months.values()]
    .filter((m) => m.month >= from && m.month <= to)
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((m) => ({
      ...m,
      revenue: m.revenue / 100,
      refunds_total: m.refunds_total / 100,
      sources: [...m.sources].sort(),
    }));
  const totals = list.reduce(
    (t, m) => {
      t.revenue += Math.round(m.revenue * 100);
      t.charges += m.charges;
      t.orders += m.orders;
      t.copies += m.copies;
      t.b2b_unfilled += m.b2b_unfilled;
      return t;
    },
    { revenue: 0, charges: 0, orders: 0, copies: 0, b2b_unfilled: 0 }
  );
  totals.revenue /= 100;
  const newestFirst = (a, b) =>
    (b.date || '') + (b.time || '') < (a.date || '') + (a.time || '') ? -1 : 1;
  return {
    months: list,
    totals,
    unmatched: unmatched.sort(newestFirst),
    excluded: excluded.sort(newestFirst),
    unclassified: unclassified.sort(newestFirst),
  };
}

// Validate one owner entry. Returns the clean override, or { error }.
function cleanOverride(body = {}) {
  const out = {};
  if ('copies' in body) {
    const v = body.copies;
    if (v === null || v === '') out.copies = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > MAX_COPIES_ENTRY) return { error: 'bad copies' };
      out.copies = n;
    }
  }
  if ('excluded' in body) {
    const v = body.excluded;
    if (v !== null && typeof v !== 'boolean') return { error: 'bad excluded' };
    out.excluded = v;
  }
  if (!Object.keys(out).length) return { error: 'nothing to set' };
  return { override: out };
}

// THE REPORT, CACHED PER MONTH. A month that ended (with a day's grace for rows
// posted late) never changes, so it is read once per process; the current month
// is re-read at most every `currentTtlMs`. One read per month at a time.
function createRevenueReport({ tranzila, now = () => Date.now(), currentTtlMs = 2 * 60 * 1000 }) {
  const cache = new Map(); // month → { rows, final, at }
  const inflight = new Map();

  async function readMonth(month, today) {
    const hit = cache.get(month);
    if (hit && (hit.final || now() - hit.at < currentTtlMs)) return hit.rows;
    if (inflight.has(month)) return inflight.get(month);
    const end = lastDayOf(month) < today ? lastDayOf(month) : today;
    const p = tranzila
      .listTransactions({ startDate: month + '-01', endDate: end })
      .then((list) => {
        const rows = list.map((tx) => slimRow(tx, tranzila.sessionTokenValues));
        // Final once the Israel date is past the 1st of the following month.
        const final = today > nextMonth(month) + '-01';
        cache.set(month, { rows, final, at: now() });
        return rows;
      })
      .finally(() => inflight.delete(month));
    inflight.set(month, p);
    return p;
  }

  async function rowsFor(from, to) {
    const today = israelDate(new Date(now()));
    const out = [];
    for (const m of monthsBetween(from, to)) out.push(...(await readMonth(m, today)));
    return out;
  }

  return { rowsFor, _cache: cache };
}

module.exports = {
  monthlyRevenue,
  createRevenueReport,
  cleanOverride,
  classify,
  slimRow,
  israelMonth,
  israelDate,
  monthsBetween,
  TEST_DISCOUNT_PCT,
};
