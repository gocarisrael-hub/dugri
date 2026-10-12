// Agent A (Commerce): the friend coupon's pure rules.
//
// A friend who adds words through a shared collect link can leave an email and
// get a personal, single-use percentage code (NOA5-K7Q2) for an event of their
// own. The rows live in the JSON store as `friend_coupons` (server/stores/
// commerce.js, friendCouponsBlock), apart from the owner's own `coupons`, so a
// few hundred personal codes never crowd the coupons she manages by hand.
//
// Everything here is PURE and dependency-free — the code format, the email rule,
// the dates, the admin arithmetic — so each rule is unit-tested on its own and
// the store, the routes and the email all answer from the same function.
// Nothing is required at the top level except node's crypto, for the same
// reason as server/stores/*.js: the tests reload server modules by purging
// require.cache.

const crypto = require('crypto');

// The RANDOM half of a code. No 0/O and no 1/I/L: the code is read off a phone
// screen and typed into a box by hand, and those pairs are where people misread.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RANDOM_LEN = 4;
const PREFIX_MAX = 8;
const FALLBACK_PREFIX = 'DUGRI';

// The whole code, as issued: PREFIX (Latin letters, 1–8) + PERCENT + '-' + 4 from
// the alphabet. The dash is what keeps a friend code from ever colliding with an
// owner coupon, whose codes are [A-Z0-9]{3,20} (createCoupon) and can never
// contain one.
const CODE_RE = new RegExp('^[A-Z]{1,' + PREFIX_MAX + '}(\\d{1,3})-[' + ALPHABET + ']{4}$');

// Trim + lowercase. The email is the row's identity ("one coupon per person,
// ever"), so Noa@Gmail.com and noa@gmail.com must be the same person.
function normEmail(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase();
}

// Deliberately plain: one @, something on each side, a dot in the domain, no
// spaces, and the RFC's 254-character ceiling. The browser's type="email" says
// the same thing on the way in; this is the check that cannot be skipped.
function isValidEmail(s) {
  const e = normEmail(s);
  if (!e || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

// The readable half of the code: the email's local part, cut at the first
// . _ + or -, Latin letters only, uppercase, at most 8. noa.cohen@ → NOA.
// Nothing Latin left (0501234567@, or a Hebrew local part) → DUGRI.
function prefixFor(email) {
  const local = normEmail(email).split('@')[0] || '';
  const head = local.split(/[._+-]/)[0] || '';
  const letters = head
    .replace(/[^a-z]/g, '')
    .toUpperCase()
    .slice(0, PREFIX_MAX);
  return letters || FALLBACK_PREFIX;
}

// RANDOM from a crypto-secure source. `randomInt` is injectable so a test can
// force a collision and watch the retry.
function randomPart(randomInt = crypto.randomInt) {
  let s = '';
  for (let i = 0; i < RANDOM_LEN; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

// A fresh code for this email at this percent. `taken(code)` answers whether a
// row already holds it; on a collision only RANDOM is drawn again. 31^4 is
// ~923k per prefix, so a run of 50 collisions means something is wrong rather
// than unlucky — it throws instead of looping forever.
function makeCode(email, percent, { randomInt = crypto.randomInt, taken = () => false } = {}) {
  const head = prefixFor(email) + String(percent) + '-';
  for (let i = 0; i < 50; i++) {
    const code = head + randomPart(randomInt);
    if (!taken(code)) return code;
  }
  throw new Error('friend coupon: no free code after 50 tries');
}

// Is this string SHAPED like a friend code? Says nothing about whether one was
// issued. Used to route a lookup and by the landing banner (site/js/
// friend-coupon.js mirrors it) to read the percent printed in the code.
function isFriendCodeShape(code) {
  return CODE_RE.test(
    String(code == null ? '' : code)
      .trim()
      .toUpperCase()
  );
}

// The percent printed inside a code, or null. The banner shows this rather than
// asking the server: the code IS the record of what was promised when it was
// issued, and today's setting may have changed since.
function percentInCode(code) {
  const m = CODE_RE.exec(
    String(code == null ? '' : code)
      .trim()
      .toUpperCase()
  );
  return m ? Number(m[1]) : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function expiresAtFor(createdIso, days) {
  return new Date(Date.parse(createdIso) + Number(days) * DAY_MS).toISOString();
}

// DD.MM.YYYY in ISRAEL time. Railway runs UTC, so a coupon expiring just after
// midnight in Tel Aviv would otherwise print as the day before.
function formatIsraelDate(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date(iso));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return get('day') + '.' + get('month') + '.' + get('year');
}

// The link in the email. Built from the deployment's own origin, never a
// hand-written domain (dugri.co.il is dead; staging is not production). The UTM
// tags here are the ONLY ones in the whole feature: an internal link carrying
// them would overwrite the visitor's real source in GA.
function landingLink(baseUrl, code) {
  if (!baseUrl) return null;
  return (
    String(baseUrl).replace(/\/+$/, '') +
    '/?coupon=' +
    encodeURIComponent(code) +
    '&utm_source=coupon&utm_medium=email&utm_campaign=friend_coupon'
  );
}

// The admin's one summary row, from the rows and the orders.
//
//   issued     every row
//   used       rows with used_at (a paid order, or the owner marking it by hand)
//   conversion used / issued, a fraction 0..1 (0 when nothing is issued)
//   orders     PAID, not-cancelled orders whose coupon is a friend code
//   revenue    what those orders were actually CHARGED (charged_total) — the
//              money that came in, after the discount. Never order.total, which
//              is the pre-discount price; adding those up would report money
//              nobody paid.
//
// Revenue is read from the ORDERS, not from the rows' order_id: an order that
// paid with a code someone else had consumed first (the double-use guard below)
// is still a sale the code brought in, and the owner should see it.
function summarize(rows, collections) {
  const list = Array.isArray(rows) ? rows : [];
  const codes = new Set(list.map((r) => r.code));
  const issued = list.length;
  const used = list.filter((r) => r.used_at).length;
  let orders = 0;
  let revenue = 0;
  for (const c of Array.isArray(collections) ? collections : []) {
    const o = c && c.order;
    if (!o || !o.paid || c.cancelled || !o.coupon || !codes.has(o.coupon)) continue;
    orders += 1;
    revenue += Number(o.charged_total || 0);
  }
  return {
    issued,
    used,
    conversion: issued ? used / issued : 0,
    orders,
    revenue: Math.round(revenue * 100) / 100,
  };
}

module.exports = {
  ALPHABET,
  CODE_RE,
  normEmail,
  isValidEmail,
  prefixFor,
  randomPart,
  makeCode,
  isFriendCodeShape,
  percentInCode,
  expiresAtFor,
  formatIsraelDate,
  landingLink,
  summarize,
};
