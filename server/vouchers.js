// Agent A (Commerce): partner voucher pools — the pure rules.
//
// A RESELLER (the first is Hi Tech Zone) sells Dugri to its own customers, takes
// their money itself, and hands each one a code. The code buys ONE copy of the
// self-pickup game at 0 ₪ in our normal checkout. The reseller then owes the
// owner a fixed price per code that was actually USED. So a code is a bearer
// instrument worth a whole game: it has to be unguessable, single-use, and
// counted exactly once.
//
// The rows live in the JSON store as `voucher_pools` and `vouchers`
// (server/stores/vouchers.js). Everything here is PURE — the code format, the
// credit a code is worth on an order, the payout arithmetic, the CSVs and the
// miss limiter — so each rule is unit-tested on its own and the store, the
// routes and the admin page all answer from the same function. Nothing is
// required at the top level except node's crypto, for the same reason as
// server/friend-coupons.js: the tests reload server modules by purging
// require.cache.

const crypto = require('crypto');

// The random part's alphabet. No 0/O and no 1/I/L: a code is read off a receipt
// or a phone screen and typed by hand, and those pairs are where people misread.
// The same alphabet as the friend coupons, so the shop has one rule about it.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// FOUR GROUPS OF FOUR. 31^16 is about 2^79. The brief's floor was ~60 bits, and
// 12 characters of this alphabet is 59.4 — just under — so the code is a group
// longer rather than a character short of the promise. At 79 bits a guesser
// allowed a million tries a second for a year finds a live code with odds around
// 10^-12 even with a hundred thousand codes out; the rate limit on the checkout
// is a second wall, not the first.
const GROUPS = 4;
const GROUP_LEN = 4;
const RANDOM_LEN = GROUPS * GROUP_LEN;
const ENTROPY_BITS = RANDOM_LEN * Math.log2(ALPHABET.length);

// The pool's prefix: 2–6 Latin letters (HTZ). Letters only, so a code's compact
// form (below) cannot be read two ways.
const PREFIX_RE = /^[A-Z]{2,6}$/;

// The most codes one request may mint. A pool can grow by any number of
// requests; the cap is so a typo (50000 for 500) is a refusal, not a 10MB store.
const MAX_BATCH = 5000;

// THE IDENTITY OF A CODE: uppercase, with every non-alphanumeric dropped. A
// buyer types `htz 7kq4m9xr2wfpab3c`, or pastes it with a trailing space, or
// with the dashes as en-dashes from a WhatsApp message — and every one of those
// is the same code. Lookups compare compact forms; the dashed form is only how
// it is printed.
function compactCode(s) {
  return String(s == null ? '' : s)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normPrefix(s) {
  return String(s == null ? '' : s)
    .trim()
    .toUpperCase();
}

function isValidPrefix(s) {
  return PREFIX_RE.test(normPrefix(s));
}

// The random groups, from a crypto-secure source. `randomInt` is injectable so a
// test can force a collision and watch the retry.
function randomGroups(randomInt = crypto.randomInt) {
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    let s = '';
    for (let i = 0; i < GROUP_LEN; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups;
}

// A fresh code for this prefix: PREFIX-XXXX-XXXX-XXXX-XXXX. `taken(code)`
// answers whether ANY code in the shop — owner coupon, friend coupon or voucher —
// already holds it (compared in compact form by the caller). On a collision the
// random part is drawn again; fifty collisions in a row at 79 bits means the
// source is broken, so it throws instead of looping.
function makeVoucherCode(prefix, { randomInt = crypto.randomInt, taken = () => false } = {}) {
  const p = normPrefix(prefix);
  if (!PREFIX_RE.test(p)) throw new Error('voucher: bad prefix');
  for (let i = 0; i < 50; i++) {
    const code = [p, ...randomGroups(randomInt)].join('-');
    if (!taken(code)) return code;
  }
  throw new Error('voucher: no free code after 50 tries');
}

// WHAT A CODE IS WORTH ON THIS ORDER: one copy, at most the self-pickup price.
//
//   pickup            one copy free; more copies are paid in full
//   delivery          the same game (delivery shares pickup's price), so the
//                     buyer pays the shipping and any extra copies
//   pdf               cheaper than pickup, so the code covers it in full — the
//                     reseller sold "a Dugri", and the digital one is a Dugri
//   custom            the bespoke design: worth a pickup copy off its price, and
//                     the buyer pays the rest by card
//
// `unitPrice` is the order's own per-copy price (an admin quote keeps its own);
// `pickupPrice` is today's pickup price. Never more than the game money on the
// order, so a credit can never go negative into the postage.
function voucherCredit({ unitPrice, pickupPrice, gameMoney }) {
  const unit = Number(unitPrice);
  const pickup = Number(pickupPrice);
  if (!(unit > 0) || !(pickup > 0)) return 0;
  const credit = Math.min(unit, pickup);
  const cap = Number(gameMoney);
  return Number.isFinite(cap) ? Math.max(0, Math.min(credit, cap)) : credit;
}

// Price per used code, as the owner typed it: a whole or half shekel amount
// from 0 up to 10,000. 0 is a real, legal value and also what "not set yet"
// looks like — the page says "not set" for it rather than inventing a number.
function normPrice(v) {
  if (v === '' || v == null) return { value: 0 };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000) return { error: 'bad price_per_use' };
  return { value: Math.round(n * 100) / 100 };
}

function normCount(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH) return { error: 'bad count' };
  return { value: n };
}

function normPartnerName(v) {
  const s = String(v == null ? '' : v)
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  return s ? { value: s } : { error: 'bad partner_name' };
}

// YYYY-MM in ISRAEL time. Railway runs UTC, so a code used at 01:00 on the 1st
// in Tel Aviv would otherwise land in the previous month's invoice.
function israelMonth(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return get('year') + '-' + get('month');
}

function statusOf(row) {
  if (row.used_at) return 'used';
  if (row.voided_at) return 'void';
  return 'unused';
}

const round2 = (n) => Math.round(n * 100) / 100;

// THE POOL'S NUMBERS, derived from its rows every time — nothing stored, so
// there is no running total to drift from the codes themselves.
//
//   owed = used × the pool's CURRENT price. Deliberately not a per-use snapshot
//   (contrast partner coupons, which freeze the rate on the order): the owner
//   does not know the price yet, and codes used before she types it must be
//   billed at it, not at the 0 that stood in for "not agreed".
//
//   A code used on an order that was later CANCELLED (row.order_cancelled, set
//   by the store from the live collection) is not billed: no game was sold. It
//   is counted apart as `cancelled`, out of `used`, `owed` and the months — the
//   owner can restore it to unused from the partners page.
function poolSummary(pool, rows) {
  const price = Number(pool && pool.price_per_use) || 0;
  let used = 0;
  let cancelled = 0;
  let voided = 0;
  // Unused codes sitting in a card window that can still settle (row.held_live,
  // set by the store). Part of `unused`; shown so a hold nobody will pay can be
  // found and released without paging through every code.
  let held = 0;
  const months = new Map();
  for (const r of rows) {
    if (r.used_at && r.order_cancelled) {
      cancelled++;
    } else if (r.used_at) {
      used++;
      const m = israelMonth(r.used_at);
      months.set(m, (months.get(m) || 0) + 1);
    } else if (r.voided_at) {
      voided++;
    } else if (r.held_live) {
      held++;
    }
  }
  const by_month = [...months.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, n]) => ({ month, used: n, owed: round2(n * price) }));
  return {
    issued: rows.length,
    used,
    cancelled,
    unused: rows.length - used - cancelled - voided,
    held,
    voided,
    price_per_use: price,
    price_set: price > 0,
    owed: round2(used * price),
    by_month,
  };
}

// A CSV cell. Quoted always; quotes doubled; and a cell that a spreadsheet
// would run as a formula (= + - @, or a leading tab/CR) is defused with a
// leading apostrophe — this file is opened in Excel by the reseller's office,
// and a partner name is free text.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function csv(rows) {
  // The BOM is what makes Excel read the Hebrew headers as UTF-8.
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// The codes to hand the reseller: one per line, with the pool and the status.
function codesCsv(pool, rows) {
  return csv([
    ['code', 'partner', 'status', 'created_at'],
    ...rows.map((r) => [r.code, pool.partner_name, statusOf(r), r.created_at]),
  ]);
}

// What the reseller is invoiced for: every USED code, when, which order, and
// the price. A code whose order was cancelled stays on the list — the reseller
// may ask about it — but says so, and is priced 0. `orderRefOf(row)` turns a row into the printed order number (the
// route knows the collections; this module does not).
function usageCsv(pool, rows, orderRefOf = () => '') {
  const price = Number(pool.price_per_use) || 0;
  const used = rows
    .filter((r) => r.used_at)
    .sort((a, b) => String(a.used_at).localeCompare(String(b.used_at)));
  return csv([
    ['code', 'partner', 'used_at', 'month', 'order', 'price_per_use', 'note'],
    ...used.map((r) => [
      r.code,
      pool.partner_name,
      r.used_at,
      israelMonth(r.used_at),
      orderRefOf(r) || '',
      r.order_cancelled ? 0 : price,
      r.order_cancelled ? 'order cancelled, not billed' : '',
    ]),
  ]);
}

// A LIMITER ON WRONG GUESSES, not on attempts. The checkout's preview already
// caps every attempt per client; this one counts only MISSES on codes that look
// like a voucher, so an owner retyping her own coupon is never touched, while a
// script walking the code space hits the wall after a handful. Per process and
// in memory, like every limiter here: it resets on a deploy, which is fine for a
// 79-bit space.
function makeMissLimiter({
  limit = 10,
  windowMs = 60 * 60 * 1000,
  maxKeys = 10000,
  now = Date.now,
} = {}) {
  const buckets = new Map();
  const fresh = (key) => (buckets.get(key) || []).filter((t) => now() - t < windowMs);
  return {
    blocked(key) {
      return fresh(key).length >= limit;
    },
    miss(key) {
      const hits = fresh(key);
      hits.push(now());
      buckets.delete(key);
      buckets.set(key, hits);
      if (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value);
    },
    _buckets: buckets,
  };
}

// AN ORDER AS THE STAFF KEY MAY SEE IT. Every coupon, friend code and partner
// voucher on a collection is a bearer code — whoever reads it can spend it — and
// a voucher left in an abandoned card window is still unused. The staff key
// works the orders, not the money, so the codes and the partner come out of
// everything the orders routes hand it. Pure: returns a copy, never mutates.
function collectionForStaff(c) {
  if (!c || !c.order) return c;
  const strip = (holder) =>
    holder && Array.isArray(holder.sessions)
      ? { ...holder, sessions: holder.sessions.map((s) => ({ ...s, coupon: null })) }
      : holder;
  const order = { ...c.order, coupon: null, discount_pct: null, pelecard: strip(c.order.pelecard) };
  delete order.voucher;
  delete order.voucher_conflict;
  delete order.friend_coupon_conflict;
  // The box QR's token is a bearer secret worth a code (server/friend-coupons.js),
  // and which kind of code paid is the owner's business like the code itself.
  delete order.box_qr;
  delete order.coupon_source;
  delete order.voucher_restored;
  delete order.commission;
  if (order.shipping)
    order.shipping = { ...order.shipping, pelecard: strip(order.shipping.pelecard) };
  return { ...c, order };
}

module.exports = {
  collectionForStaff,
  ALPHABET,
  GROUPS,
  GROUP_LEN,
  RANDOM_LEN,
  ENTROPY_BITS,
  MAX_BATCH,
  compactCode,
  normPrefix,
  isValidPrefix,
  makeVoucherCode,
  voucherCredit,
  normPrice,
  normCount,
  normPartnerName,
  israelMonth,
  statusOf,
  poolSummary,
  csvCell,
  codesCsv,
  usageCsv,
  makeMissLimiter,
};
