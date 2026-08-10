// Tiny JSON-file store for the word-collection feature.
// Modeled on the meilon backend pattern: an in-memory object loaded at boot,
// mutated through helpers, and written to disk on every change. The data file
// lives under DATA_DIR (a persistent Railway volume in production) so it
// survives redeploys.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// The word-entry cap + its normalizer live in validate.js so the collection
// store, the wordlist pools and the routes all measure entries the same way.
const validate = require('./validate');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'dugri-data.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Collections stay open for a full year — long enough that they effectively never
// expire within the order flow (a customer has all the time they need to gather
// and add words). Used for a new collection's expires_at.
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// A collection with no words earns ONE nudge email this long after it was paid
// (or created, when unpaid): the buyer hasn't sent any words yet and production
// can't start until they do. See collectionsDueForReminder.
const REMINDER_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

// A PeleCard pay session only counts as "in flight" (and thus blocks the free
// coupon path) for a short window — a hosted-iframe session that isn't completed
// is abandoned/declined, and its callback never arrives to resolve it. Without a
// TTL a single closed modal would block every future free coupon forever.
const SESSION_TTL_MS = Number(process.env.PELECARD_SESSION_TTL_MS || 20 * 60 * 1000);
// Cap stored pay sessions, but ONLY ever evict RESOLVED ones — dropping an
// unresolved session would lose the amount a later completing callback needs to
// verify against, leaving a charged customer's order stuck unpaid.
const MAX_SESSIONS = Number(process.env.PELECARD_MAX_SESSIONS || 50);

// `order_seq` is the high-water mark behind the human order number (see
// nextOrderNo) — a plain counter so numbers are never reused, even after a
// collection is deleted.
const DEFAULTS = { collections: [], words: [], coupons: [], design_codes: [], order_seq: 0 };

// Human-quotable order numbers: "DG-1001", "DG-1002", … A collection id is a
// UUID — fine as a database key, useless on a receipt or in a WhatsApp message
// ("what's your order number?" / "8f3c1a2e-…"). Every collection therefore also
// carries a SHORT sequential number, assigned once at creation and never reused.
// Starting at 1001 keeps every number the same width and doesn't advertise that
// the first customer was order #1.
const ORDER_NO_PREFIX = 'DG-';
const ORDER_NO_START = 1001;

// Owner-editable pricing lives in server/settings.js (the `pricing` section) so
// the store price + per-version enable/price change with NO deploy. This module
// reads it as the AUTHORITATIVE charge. settings.js requires nothing from db, so
// this import is cycle-free; it's wrapped so a broken settings module can never
// take the charge path down (we fall back to the built-in defaults below).
let settings = null;
try {
  settings = require('./settings');
} catch {
  settings = null;
}

// The built-in fallback pricing is DERIVED from the settings.js registry defaults
// (single source of truth — no pricing number is hardcoded here). `ORDER_PRICES`
// is also the canonical set of known versions. These are used when a runtime
// settings read fails; if the settings module itself failed to load the maps are
// empty and setOrder fails closed (rejects every version) rather than mischarge.
// pdf = digital PDF; pickup = printed + pickup at גלאור; delivery = door-to-door;
// custom = a "hand-designed just for you" bespoke game we design by hand.
// Every orderable version, and WHICH settings key carries its per-copy price.
//
// pickup and delivery deliberately share `pickup_price`: they are the same
// printed deck, and delivery is that deck PLUS shipping (delivery_fee, added once
// per order) — not a second product. Giving delivery its own price key let the
// two drift apart, and made "the delivery price" ambiguous about whether it
// already contained postage. One product price, one shipping price, and the
// delivered price is their sum.
const VERSION_PRICE_KEY = {
  pdf: 'pdf_price',
  pickup: 'pickup_price',
  delivery: 'pickup_price',
  custom: 'custom_price',
};

function pricingDefaults() {
  const reg = (settings && settings.REGISTRY && settings.REGISTRY.pricing) || {};
  const prices = {};
  const enabled = {};
  const store = {};
  // The canonical version list comes from VERSION_PRICE_KEY, not from scanning
  // for `*_price` keys — delivery no longer has one of its own.
  for (const [version, key] of Object.entries(VERSION_PRICE_KEY)) {
    if (reg[key]) prices[version] = reg[key].default;
  }
  for (const key of Object.keys(reg)) {
    const m = /^(.+)_enabled$/.exec(key);
    if (m) enabled[m[1]] = reg[key].default === true;
    else if (key === 'store_now' || key === 'store_was') store[key] = reg[key].default;
  }
  return { prices, enabled, store };
}
const { prices: ORDER_PRICES, enabled: DEFAULT_ENABLED, store: STORE_DEFAULTS } = pricingDefaults();

// Is a version currently offered? Reads the `<v>_enabled` flag from settings,
// falling back to the built-in launch default if a settings read fails.
function versionEnabled(version) {
  if (!Object.prototype.hasOwnProperty.call(ORDER_PRICES, version)) return false;
  try {
    return settings.get('pricing', version + '_enabled') === true;
  } catch {
    return DEFAULT_ENABLED[version] === true;
  }
}

// The NIS charge for a version — the AUTHORITATIVE amount. Reads `<v>_price` from
// settings; only a POSITIVE integer (>= 1) is honoured, otherwise it falls back to
// the built-in default (which is itself >= 1). This guarantees a base version
// total is never 0/negative even if a corrupt override slipped past validation.
function versionPrice(version) {
  const key = VERSION_PRICE_KEY[version];
  if (!key) return undefined;
  try {
    const p = settings.get('pricing', key);
    if (Number.isInteger(p) && p >= 1) return p;
  } catch {
    /* settings unavailable — use the built-in default below */
  }
  return ORDER_PRICES[version];
}

// Last-resort baked store display defaults, used only if the settings module
// itself failed to load (so the registry-derived STORE_DEFAULTS are empty). This
// guarantees the public projection never emits an `undefined` store price that
// would render as "undefined ₪" on the storefront.
const BAKED_STORE = { store_now: 199, store_was: 239 };

// The effective store display price for `store_now`/`store_was`. Display-only
// (never charged), so 0 is allowed; a corrupt/non-integer override falls back to
// the registry default, and to the baked default if even that is unavailable.
function storeValue(key) {
  try {
    const v = settings.get('pricing', key);
    if (Number.isInteger(v) && v >= 0) return v;
  } catch {
    /* settings unavailable — use the built-in default below */
  }
  const d = STORE_DEFAULTS[key];
  return Number.isInteger(d) ? d : BAKED_STORE[key];
}

// --- sale mode ----------------------------------------------------------------
// The owner's one switch for the whole offer, resolved into what the storefront
// needs: { on, label, banner }. Two independent conditions must BOTH hold for
// `on` to be true:
//
//   1. the owner turned `sale_on` on, and
//   2. the struck price is genuinely higher than the price shown (was > now).
//
// (2) is not a nicety. `store_was` is display-only and freely editable, so a
// typo — or a `store_now` raised above a stale `store_was` — would leave the site
// striking through a price NOBODY is being saved from, i.e. advertising a
// discount that does not exist. Failing closed here means every surface goes
// quiet at once, because they all read this one flag.
//
// The banner text interpolates {now}/{was}/{saving} from the live prices so it
// stays true across a price change with no re-edit; an unreadable settings store
// falls back to the registry defaults, and an empty banner simply means "no
// strip" (a legal owner choice, not an error).
function saleInfo() {
  const now = storeValue('store_now');
  const was = storeValue('store_was');
  let on = false;
  let label = 'מחיר השקה';
  let banner = '';
  try {
    on = settings.get('pricing', 'sale_on') === true;
    const l = settings.get('pricing', 'sale_label');
    if (typeof l === 'string') label = l;
    const b = settings.get('pricing', 'sale_banner');
    if (typeof b === 'string') {
      banner = settings.interpolate(b, { now, was, saving: was - now });
    }
  } catch {
    /* settings unavailable — no sale (never claim a discount we can't verify) */
    return { on: false, label, banner: '' };
  }
  return { on: on && was > now, label, banner };
}

// The single source for the PUBLIC /api/pricing projection AND the charge path:
// both read these same functions, so what the buyer is SHOWN can never disagree
// with what the server CHARGES. Shape: { store:{now,was}, versions:{<v>:{enabled,
// price}} }.
function effectivePricing() {
  const versions = {};
  for (const v of Object.keys(ORDER_PRICES)) {
    versions[v] = { enabled: versionEnabled(v), price: versionPrice(v) };
  }
  return {
    store: { now: storeValue('store_now'), was: storeValue('store_was') },
    // Whether the struck price / picture flags / home strip are shown at all.
    // `store.was` still travels when the sale is off: the number is display data,
    // and the client decides what to paint from `sale.on` alone.
    sale: saleInfo(),
    versions,
    // Charged once per order, not per copy (see deliveryFee). The checkout needs
    // it to show the same arithmetic the server is about to perform.
    delivery_fee: deliveryFee(),
  };
}

// --- copies -------------------------------------------------------------------
// An order may contain several copies of the SAME game: identical decks printed
// from one word list. Each copy is charged the full per-version price; shipping
// is charged ONCE, because every copy travels in the same parcel.
//
// There is deliberately NO business cap on copies (the owner asked for none).
// This bound is input validation, not policy: it stops a slipped keypress — 555
// where 5 was meant — from becoming a five-figure charge attempt.
const MAX_COPIES = Number(process.env.MAX_COPIES || 999);

// The one-time shipping fee. Only a NON-NEGATIVE integer is honoured; anything
// else falls back to 0, so a corrupt override can never inflate a charge.
function deliveryFee() {
  try {
    const v = settings.get('pricing', 'delivery_fee');
    if (Number.isInteger(v) && v >= 0) return v;
  } catch {
    /* settings unavailable — no fee rather than a guessed one */
  }
  return 0;
}

// Coerce anything a client might send into a usable copy count. Absent/garbage
// means 1 — never 0 (a 0-copy order would charge only shipping) and never a
// float (0.5 copies would undercharge).
function sanitizeQuantity(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return 1;
  const i = Math.floor(n);
  if (i < 1) return 1;
  return Math.min(i, MAX_COPIES);
}

// THE authoritative charge for an order. The browser never sends a total — it
// sends at most a version and a copy count, and this recomputes from settings.
// `unitPrice` overrides the settings price for an order that carries its own
// quoted per-copy price (an admin custom quote must keep the price it was quoted
// at, even if settings move afterwards).
function orderTotal(version, quantity, unitPrice) {
  const unit = Number.isInteger(unitPrice) && unitPrice >= 1 ? unitPrice : versionPrice(version);
  const fee = version === 'delivery' ? deliveryFee() : 0;
  return unit * sanitizeQuantity(quantity) + fee;
}

// --- free word quota ---------------------------------------------------------
// A collection may gather `pricing.free_word_limit` words before payment; past
// that, adding is blocked until the order is paid. Both knobs are owner-editable
// (see the pricing registry). A corrupt/non-integer override falls back to the
// registry default rather than to "no limit" OR to 0 — a 0 would lock every
// collection at its first word.
const FREE_WORD_LIMIT_DEFAULT = (() => {
  const reg = (settings && settings.REGISTRY && settings.REGISTRY.pricing) || {};
  const d = reg.free_word_limit && reg.free_word_limit.default;
  return Number.isInteger(d) && d >= 1 ? d : 20;
})();

function freeWordLimit() {
  try {
    const v = settings.get('pricing', 'free_word_limit');
    if (Number.isInteger(v) && v >= 1) return v;
  } catch {
    /* settings unavailable — use the built-in default below */
  }
  return FREE_WORD_LIMIT_DEFAULT;
}

// Is the quota ENFORCED right now? Off => the counter still shows but adds are
// never blocked. Fails closed to the registry default (on) only if the read throws.
function freeLimitEnforced() {
  try {
    return settings.get('pricing', 'lock_after_free_limit') === true;
  } catch {
    return true;
  }
}

// The quota state for one collection, given its current word count.
//   applies   — is this collection subject to the quota at all? Collections
//               created BEFORE the feature shipped carry no `free_limit_applies`
//               stamp and are grandfathered in (never locked). A paid order is
//               likewise exempt — payment is exactly what lifts the gate.
//   remaining — how many more words may still be added (Infinity when exempt).
//   locked    — the gate is closed right now: adding anything is refused.
function freeLimitState(c, count) {
  const limit = freeWordLimit();
  const paid = !!(c && c.order && c.order.paid);
  const applies = !!(c && c.free_limit_applies) && !paid && freeLimitEnforced();
  const n = Number.isInteger(count) ? count : 0;
  return {
    limit,
    applies,
    paid,
    remaining: applies ? Math.max(0, limit - n) : Infinity,
    locked: applies && n >= limit,
  };
}

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

let _db = loadDb();

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Write to a temp file then rename over the real one. rename() on the same
  // filesystem is atomic, so a crash mid-write can never leave a truncated or
  // corrupt data file — readers always see either the old file or the new one.
  // A fixed temp name (not per-pid) means the next save overwrites any leftover
  // from a crash in the write→rename window, so orphan temps can't accumulate.
  // Safe because saveDb is synchronous and the service runs a single process.
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

// Claim the next order number, advancing the stored counter. Callers must save.
function nextOrderNo() {
  const seq = Number.isFinite(_db.order_seq) ? _db.order_seq : 0;
  _db.order_seq = Math.max(seq, ORDER_NO_START - 1) + 1;
  return ORDER_NO_PREFIX + _db.order_seq;
}

// One-time backfill for collections created BEFORE order numbers existed. Runs
// at boot, oldest first, so the numbering follows the order the collections were
// actually placed in. A no-op (and no write) once every row has one.
function backfillOrderNumbers() {
  const missing = _db.collections.filter((c) => c && !c.order_no);
  if (!missing.length) return;
  missing.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  for (const c of missing) c.order_no = nextOrderNo();
  saveDb();
}

backfillOrderNumbers();

// The reference a human quotes back at us. Prefers the short order number and
// falls back to the raw id, so a row that somehow missed the backfill still
// yields SOMETHING printable rather than an empty receipt line.
function orderRef(c) {
  return (c && c.order_no) || (c && c.id) || '';
}

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
// Today as 'YYYY-MM-DD' in Israel time. Coupon expiry is inclusive through the
// end of that Israel day, so the comparison must use the Asia/Jerusalem calendar
// date — not the server's local/UTC date (Railway runs UTC, where a coupon set
// to expire 2026-07-01 would otherwise keep working ~3h into July 2 Israel time).
// ISO date strings sort lexicographically, so a plain string compare is correct.
const todayStrIsrael = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

// Normalize a coupon code: trim + uppercase. Callers validate the [A-Z0-9] shape.
const normCode = (s) =>
  String(s == null ? '' : s)
    .trim()
    .toUpperCase();

// Normalize a word for dedupe: trim, collapse inner whitespace, lowercase.
function norm(s) {
  return String(s).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Theme extra fields (e.g. AGE, or YEARS + NAME1 + NAME2) collected in the order
// flow. Stored as a flat object of trimmed string values, each capped. Non-object
// input (missing, array, primitive) normalizes to an empty object so the field is
// always a plain object on the collection.
function sanitizeExtraFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v == null) continue;
    const key = String(k).trim().slice(0, 40);
    if (!key) continue;
    out[key] = String(v).trim().slice(0, 80);
  }
  return out;
}

// F7 custom title: an OPTIONAL per-order free-form title that OVERRIDES the
// theme-derived title on the cards + board. Normalizes newlines, trims and
// collapses inner spaces per line, drops blank lines, and caps the total length.
// Empty/whitespace input -> null (absent), so the theme's own title is used
// unchanged. Newlines are preserved as deliberate line breaks (the generator
// splits on them); the cap guards against an unbounded stored string.
const CUSTOM_TITLE_MAX = 120;
// A note the buyer types with her order — "אל תשלחו לפני יום שלישי", "זה לאבא
// שלי, אל תספרו". Long enough to say something real and short enough to read at
// a glance in the admin table.
const COMMENT_MAX = 500;
function sanitizeCustomTitle(input) {
  if (input == null) return null;
  const lines = String(input)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((ln) => ln.trim().replace(/\s+/g, ' '))
    .filter((ln) => ln.length);
  if (!lines.length) return null;
  // Cap by code point (Array.from splits on astral chars) so the 120 boundary
  // never bisects an emoji/surrogate pair and emits a lone surrogate.
  return Array.from(lines.join('\n')).slice(0, CUSTOM_TITLE_MAX).join('');
}

// The two SHORT free-text answers the buyer gives beside her email and phone:
// who she is ("דנה כהן") and what she is throwing ("בת מצווה של אחותי"). Like
// the note they are never printed on anything, so they need no fitting — but
// unlike the note they are single-line answers, so every newline collapses to a
// space: a paste out of a WhatsApp message must land in the admin table as one
// readable line, not as a block that pushes the row apart.
const SHORT_TEXT_MAX = 80;
function sanitizeShortText(input) {
  if (input == null) return null;
  const text = String(input).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // Capped by code point (Array.from splits on astral chars) so the boundary can
  // never bisect an emoji and leave a lone surrogate in the store.
  return Array.from(text).slice(0, SHORT_TEXT_MAX).join('');
}

// The buyer's own note on the order. Unlike the custom title this is never
// printed on anything — it is a message to the owner — so the only shaping it
// needs is trimming, a cap, and empty-means-absent. Line breaks are KEPT (a note
// is often a short list); runs of blank lines are collapsed so a stray paste
// cannot push the rest of an admin row off the screen.
function sanitizeComment(input) {
  if (input == null) return null;
  const text = String(input)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((ln) => ln.trim().replace(/[^\S\n]+/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;
  // Capped by code point so the boundary can never bisect an emoji.
  return Array.from(text).slice(0, COMMENT_MAX).join('');
}

// A delivery shipping address. street + city + postal are REQUIRED (a parcel
// can't ship without them) — returns null when any is missing, so the caller
// rejects the order/edit. apartment + floor are optional. Every field is trimmed
// and capped. Shared by the public setOrder path and the admin order edit.
function sanitizeAddress(a) {
  const src = a || {};
  const street = String(src.street || '').trim();
  const city = String(src.city || '').trim();
  const postal = String(src.postal || '').trim();
  if (!street || !city || !postal) return null;
  return {
    street: street.slice(0, 120),
    city: city.slice(0, 120),
    postal: postal.slice(0, 120),
    apartment: src.apartment ? String(src.apartment).trim().slice(0, 120) : null,
    floor: src.floor ? String(src.floor).trim().slice(0, 120) : null,
  };
}

// A stored pawn-image path must be one of OUR OWN content-addressed uploads
// ("/content-uploads/<file>", no path traversal) — never an arbitrary URL. The
// admin edit route accepts a client-supplied array (remove/reorder), so the
// shape is re-validated here rather than trusted.
function pawnPathOk(p) {
  return (
    typeof p === 'string' &&
    /^\/content-uploads\/[A-Za-z0-9._-]+$/.test(p) &&
    !p.includes('..') &&
    p.length <= 200
  );
}

// 'cancelled' (admin soft-cancel) takes precedence; otherwise open while not
// closed and not past expiry; otherwise 'closed' / 'expired'.
function effectiveStatus(c) {
  if (!c) return null;
  if (c.cancelled) return 'cancelled';
  if (c.status === 'closed') return 'closed';
  if (Date.parse(c.expires_at) < Date.now()) return 'expired';
  return 'open';
}

const db = {
  effectiveStatus,
  // Exposed for the preview route (parity with stored orders) + unit tests.
  sanitizeCustomTitle,

  createCollection(honoreeName, contact = {}) {
    const c = {
      id: uid(),
      // Short, human-quotable order number (DG-1001…). Shown on the payment
      // confirmation page and in every email; the UUID above stays internal.
      order_no: nextOrderNo(),
      owner_token: uid(),
      honoree_name: String(honoreeName || '')
        .trim()
        .slice(0, 80),
      owner_email: contact.email ? String(contact.email).trim().slice(0, 120) : null,
      owner_phone: contact.phone ? String(contact.phone).trim().slice(0, 40) : null,
      // Hebrew display names chosen in the order flow (optional).
      design: contact.design ? String(contact.design).trim().slice(0, 80) : null,
      color: contact.color ? String(contact.color).trim().slice(0, 80) : null,
      // Generator theme (a generator/themes.json key) the chosen design resolves
      // to; drives which template production runs. Capped like other order text.
      theme: contact.theme ? String(contact.theme).trim().slice(0, 80) : null,
      // Theme-required extra fields collected after a design is chosen (AGE, or
      // YEARS + NAME1 + NAME2). Always a plain object; {} when none are needed.
      extra_fields: sanitizeExtraFields(contact.extra_fields),
      // Card word-font the customer picked in the preview (a filename in the
      // shared word-fonts/ pool). Passed to the generator as its word_font
      // override at production time. Capped; null keeps the theme's default font.
      word_font: contact.word_font ? String(contact.word_font).trim().slice(0, 80) : null,
      // Honoree gender for the site's gendered question phrasing. Only 'male' or
      // 'female' are accepted; anything else stores null.
      gender: contact.gender === 'male' || contact.gender === 'female' ? contact.gender : null,
      // Optional drinking-game add-on ("צ'ייסרים") - free; the owner builds the
      // board with special "drink" tiles when this is on.
      chasers: !!contact.chasers,
      // Up to 4 optional customer photos ("פיונים") attached to the collection,
      // stored as public "/content-uploads/<hash>.<ext>" path strings. Appended
      // via addPawnImages (owner-token gated). Empty on a fresh collection.
      // These are always the ORIGINALS exactly as the buyer uploaded them — the
      // background-removed cutouts live beside them in pawn_cutouts, so a cut can
      // always be redone (or reverted) without asking the buyer for the photo again.
      pawn_images: [],
      // Background-removed cutouts, keyed BY THE ORIGINAL'S PATH rather than by
      // slot index, so removing/reordering pawn_images (adminSetPawnImages) can
      // never mis-pair a photo with someone else's cutout. Three states per photo:
      //   • key absent      — never attempted (an older browser, or a legacy order)
      //   • value = path    — the "/content-uploads/<hash>.png" transparent cutout
      //   • value = null    — attempted and FAILED; the original is used instead
      //                       and the admin table flags it for a manual cut.
      pawn_cutouts: {},
      // Optional free-form custom title (F7) overriding the theme's derived title
      // on the cards + board. Sanitized/capped; null when empty so the theme
      // default is used. The generator receives this via its --title CLI arg.
      custom_title: sanitizeCustomTitle(contact.custom_title),
      // THE BUYER'S OWN NAME — the person ordering and paying, which is NOT the
      // honoree_name above. She is buying this FOR somebody, so those two are
      // different people in almost every order, and the owner opening a WhatsApp
      // needs to know which one she is greeting. Optional (see the wizard): the
      // order can be fulfilled without it, so it never blocks a checkout.
      buyer_name: sanitizeShortText(contact.buyer_name),
      // What the party actually is, in her words — "בת מצווה של אחותי", "פרישה",
      // "יום נישואין 25". The chosen DESIGN hints at an occasion, but a design is
      // a picture she liked and this is the event, and the two disagree often
      // enough that the owner asked to be told rather than to infer.
      event_type: sanitizeShortText(contact.event_type),
      // The buyer's own note to the owner, typed with the order. Never printed —
      // see sanitizeComment. null when she wrote nothing.
      comment: sanitizeComment(contact.comment),
      // The owner's own note about this order, written in admin. Never set at
      // creation — nobody has anything to say about an order that is one second
      // old — but declared here so every collection has the field and no reader
      // has to guess whether `undefined` means "no note" or "old record".
      owner_note: null,
      status: 'open',
      created_at: nowIso(),
      expires_at: new Date(Date.now() + YEAR_MS).toISOString(),
      closed_at: null,
      // One-time "you haven't added words yet" nudge timestamp; null until sent.
      reminded_at: null,
      // Per-reminder send state for the owner reminder list (server/reminders.js):
      // { <reminderId>: { count, last_at } }. Feeds the engine's max_total cap +
      // every_days spacing. Empty until the first reminder fires (markReminderSent).
      reminder_state: {},
      // One-time "order received" notification marker (owner + buyer emails and
      // the WhatsApp group fire once, when the order is first created — not on
      // payment). Null until markOrderNotified sets it.
      order_notified_at: null,
      // Payment reminders: how many "complete your payment" nudges have been sent
      // (one per elapsed milestone in the trigger's `delays`, until paid). The
      // legacy one-shot timestamp is kept for continuity (see markPaymentReminderSent).
      payment_reminders_sent: 0,
      payment_reminded_at: null,
      // Free word quota (pricing.free_word_limit): stamped true at creation so the
      // gate applies ONLY to collections started after the feature shipped —
      // older rows lack the field and stay uncapped, exactly as they were sold.
      free_limit_applies: true,
      // One-time "you've hit the free quota, pay to keep adding" email marker.
      // Null until markFreeLimitNotified sets it; keeps the mail to one send.
      free_limit_notified_at: null,
      // Admin soft-cancel (reversible); a hard delete removes the row entirely.
      cancelled: false,
      cancelled_at: null,
      order: null,
    };
    _db.collections.push(c);
    saveDb();
    return c;
  },

  getCollection(id) {
    return _db.collections.find((c) => c.id === id) || null;
  },

  // Count collections whose order is paid (c.order.paid truthy). Feeds the
  // public /api/stats/orders social-proof counter — it exposes ONLY this
  // aggregate, never any order detail.
  countPaidOrders() {
    return _db.collections.filter((c) => c.order && c.order.paid).length;
  },

  // Admin: every collection enriched with word count + effective status,
  // newest first. Includes owner_token so the admin can build owner links.
  listAllCollections() {
    return [..._db.collections]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((c) => ({
        ...c,
        status: effectiveStatus(c),
        word_count: _db.words.filter((w) => w.collection_id === c.id).length,
      }));
  },

  listWords(id) {
    return _db.words
      .filter((w) => w.collection_id === id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  // Cheap word count for a collection: a single O(n) pass with NO array build and
  // NO sort, for hot paths (the inbound WhatsApp message handler) that only need
  // the number, not the ordered list. Prefer this over listWords(id).length there.
  countWords(id) {
    let n = 0;
    for (const w of _db.words) if (w.collection_id === id) n += 1;
    return n;
  },

  // Add a batch of words. Dedupes (case/space-insensitive) within the
  // collection, and stops at the free quota when one applies (see
  // freeLimitState): a 50-word paste onto a collection with 5 slots left stores
  // those 5 and reports the rest as `blocked` — partial acceptance beats
  // rejecting the whole list and losing the buyer's typing. Returns
  // {added, skipped, blocked, tooLong, emoji} or {closed:true} if not open.
  //
  // Entries containing an EMOJI are refused outright (counted in `emoji`). The
  // card fonts have no emoji glyphs, so a 🎉 reaches the printed deck as a blank
  // box — see validate.hasEmoji. It REFUSES rather than strips, deliberately:
  // the contributor typed it on purpose, and a word that quietly loses its emoji
  // is a word nobody knows was changed. Enforcing it in the STORE (not only in
  // the HTTP route) is what covers the WhatsApp webhook, which funnels straight
  // through here — and WhatsApp is where emoji actually come from.
  //
  // Entries over validate.MAX_WORD_LEN are REFUSED (counted in `tooLong`), not
  // truncated. This used to .slice(0, 80) them, which silently changed the
  // buyer's word into a different one — and 80 is exactly the length measured to
  // blow up the renderer's fitting loop. Refusing per-entry rather than
  // per-batch matters for the WhatsApp path, which funnels through here: one
  // over-long sentence in a group message must not discard the good words
  // alongside it.
  addWords(id, words, addedBy) {
    const c = this.getCollection(id);
    if (!c) return null;
    if (effectiveStatus(c) !== 'open') return { closed: true, added: 0, skipped: 0, blocked: 0 };

    const existingWords = _db.words.filter((w) => w.collection_id === id);
    const existing = new Set(existingWords.map((w) => w.norm));
    // Room left under the quota, computed from the CURRENT count (Infinity when
    // the collection is exempt/paid or the gate is switched off).
    let room = freeLimitState(c, existingWords.length).remaining;
    const by = addedBy ? String(addedBy).trim().slice(0, 40) : null;
    let added = 0;
    let skipped = 0;
    let blocked = 0;
    let tooLong = 0;
    let emoji = 0;
    for (const raw of Array.isArray(words) ? words : []) {
      const text = validate.normalizeWordText(raw);
      if (!text) continue;
      // Carries an emoji: refused, never stripped. Counted on its own so the
      // caller can say exactly why it didn't land.
      if (validate.hasEmoji(text)) {
        emoji += 1;
        continue;
      }
      // Over the entry cap: refused outright, never truncated into a different
      // word. Counted separately from `skipped` (duplicates) and `blocked`
      // (quota) so the caller can say WHY it didn't land.
      if (validate.isWordTooLong(text)) {
        tooLong += 1;
        continue;
      }
      const n = norm(text);
      if (existing.has(n)) {
        skipped += 1;
        continue;
      }
      // Quota exhausted: count the remainder as blocked, never stored. A
      // duplicate above is NOT counted here — it was never going to be stored.
      if (room <= 0) {
        blocked += 1;
        continue;
      }
      room -= 1;
      existing.add(n);
      _db.words.push({
        id: uid(),
        collection_id: id,
        text,
        norm: n,
        added_by: by,
        created_at: nowIso(),
      });
      added += 1;
    }
    if (added) saveDb();
    return { added, skipped, blocked, tooLong, emoji };
  },

  // The free-quota state for a collection, from its live word count. Exposed so
  // the API can project it to collect.html and gate the add route.
  freeLimit(id) {
    const c = this.getCollection(id);
    if (!c) return null;
    return freeLimitState(c, this.countWords(id));
  },

  // Mark the one-time "free quota reached" email as sent. Returns true only for
  // the FIRST call — the caller uses that as the send/don't-send decision, so a
  // second word landing on a full collection can never re-trigger the mail.
  markFreeLimitNotified(id) {
    const c = this.getCollection(id);
    if (!c || c.free_limit_notified_at) return false;
    c.free_limit_notified_at = nowIso();
    saveDb();
    return true;
  },

  deleteWord(id, wordId, ownerToken) {
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return false;
    const before = _db.words.length;
    _db.words = _db.words.filter((w) => !(w.id === wordId && w.collection_id === id));
    if (_db.words.length === before) return false;
    saveDb();
    return true;
  },

  // Owner-only: edit ONE word's text (fix a typo). Trims and collapses inner
  // whitespace like addWords, and holds the result to the same entry cap; the
  // word keeps its identity and its added_by/created_at metadata — only `text`
  // (and its dedupe `norm`) change.
  // Returns the updated word, or an { error } object:
  //   'forbidden'  bad owner token
  //   'not_found'  no such word in this collection
  //   'empty'      the new text normalizes away to nothing
  //   'too_long'   the new text is over validate.MAX_WORD_LEN (carries `len`)
  //   'emoji'      the new text contains an emoji (carries `found`, the emoji
  //                themselves, so the route can name them in the refusal)
  //   'duplicate'  another word in the collection already has this normalized text
  // NOTE this gates the NEW text only. A grandfathered over-length word — or one
  // carrying an emoji, stored before that rule existed — is left alone until
  // someone edits it; reading or regenerating it never trips this.
  // Returns null when the collection itself doesn't exist (so the route can 404).
  // Like deleteWord it does NOT gate on open/closed status — the owner can fix a
  // typo at any time. Idempotent: re-saving the same text is a no-op that still
  // succeeds.
  editWord(id, wordId, text, ownerToken) {
    const c = this.getCollection(id);
    if (!c) return null;
    if (c.owner_token !== ownerToken) return { error: 'forbidden' };
    const w = _db.words.find((x) => x.id === wordId && x.collection_id === id);
    if (!w) return { error: 'not_found' };
    const clean = validate.normalizeWordText(text);
    if (!clean) return { error: 'empty' };
    if (validate.hasEmoji(clean)) return { error: 'emoji', found: validate.findEmoji(clean) };
    if (validate.isWordTooLong(clean)) return { error: 'too_long', len: clean.length };
    const n = norm(clean);
    // Reject a collision with a DIFFERENT word that shares the normalized form.
    // Re-casing/re-spacing the word's own text (same norm, own id) is allowed.
    const clash = _db.words.some((x) => x.collection_id === id && x.id !== wordId && x.norm === n);
    if (clash) return { error: 'duplicate' };
    if (w.text === clean && w.norm === n) return w; // no change — idempotent
    w.text = clean;
    w.norm = n;
    saveDb();
    return w;
  },

  // Owner-only close. Idempotent: a repeated close on an already-closed
  // collection still succeeds but reports no change, so the caller can fire the
  // "ready to produce" side effects (e.g. the owner email) only on the real
  // open->closed transition. Returns null on bad/absent owner token.
  closeCollection(id, ownerToken) {
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return null;
    const alreadyClosed = c.status === 'closed';
    if (!alreadyClosed) {
      c.status = 'closed';
      c.closed_at = nowIso();
      saveDb();
    }
    return { changed: !alreadyClosed };
  },

  // THE APPROVED WORD BANK — the 412 words this order gets printed from, frozen
  // at close. server/word-bank.js explains why it is frozen at all; this is only
  // the store side.
  //
  // Written AFTER the close itself has succeeded, so a freeze that cannot run
  // (no Python on the box, an unreadable pool) leaves the order closed and
  // simply un-frozen — which is the behaviour every order had before this
  // existed, not a broken one.
  setWordBank(id, bank) {
    const c = this.getCollection(id);
    if (!c || !bank || !Array.isArray(bank.words) || !bank.words.length) return null;
    // The version comes from a counter kept on the COLLECTION, not from the
    // previous bank — clearWordBank deletes the bank but never the counter, so a
    // reopened-and-reclosed order freezes as v2 rather than resetting to v1 and
    // losing the one thing the number carries: that this order was approved
    // before, and what is on the cards now is not what was approved then.
    c.word_bank_seq = (Number(c.word_bank_seq) > 0 ? Number(c.word_bank_seq) : 0) + 1;
    c.word_bank = { version: c.word_bank_seq, ...bank };
    saveDb();
    return c.word_bank;
  },

  // Throw the bank away. The owner's rule for a reopened collection: "discarded
  // and re-frozen on the next close" — so this runs on reopen, and on any edit
  // that changes a production input the bank was frozen from (today: the seed
  // pool). A bank that no longer matches its inputs is worse than no bank at
  // all, because it still looks authoritative.
  clearWordBank(id) {
    const c = this.getCollection(id);
    if (!c || !c.word_bank) return false;
    delete c.word_bank;
    saveDb();
    return true;
  },

  // Append up to N pawn images (customer pieces) to a collection, owner-token gated.
  // Caps the stored array at 4 total, and DE-DUPES incoming paths both against what's
  // already stored and within the batch — the paths are content-addressed, so the
  // same photo picked into two slots yields the same /content-uploads/<hash> and must
  // not appear twice. Returns the updated array, or null on a bad/absent owner token
  // or unknown collection.
  addPawnImages(id, ownerToken, paths) {
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return null;
    if (!Array.isArray(c.pawn_images)) c.pawn_images = [];
    const seen = new Set(c.pawn_images);
    const incoming = [];
    for (const raw of Array.isArray(paths) ? paths : []) {
      const p = String(raw);
      if (!p || seen.has(p)) continue; // skip empties + duplicates (existing OR batch)
      seen.add(p);
      incoming.push(p);
    }
    if (!incoming.length) return c.pawn_images;
    const room = Math.max(0, 4 - c.pawn_images.length);
    if (room > 0) {
      c.pawn_images.push(...incoming.slice(0, room));
      saveDb();
    }
    return c.pawn_images;
  },

  // Record the background-removed cutout for ONE stored pawn photo, owner-token
  // gated exactly like addPawnImages. `cutPath` is our own "/content-uploads/…"
  // path on success, or null to record "we tried and could not cut this one" —
  // which is what makes a failed cut VISIBLE to the owner instead of silently
  // shipping a photo that will print as a white rectangle (docs/photo-card.md).
  //
  // Keyed by the ORIGINAL's path, and only ever for a path this collection
  // actually stores, so a stale key can't accumulate. Returns the cutout map, or
  // null on a bad owner token / unknown collection / a path we don't hold.
  setPawnCutout(id, ownerToken, origPath, cutPath) {
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return null;
    if (!Array.isArray(c.pawn_images) || !c.pawn_images.includes(origPath)) return null;
    if (cutPath != null && !pawnPathOk(cutPath)) return null;
    if (!c.pawn_cutouts || typeof c.pawn_cutouts !== 'object' || Array.isArray(c.pawn_cutouts)) {
      c.pawn_cutouts = {};
    }
    c.pawn_cutouts[origPath] = cutPath == null ? null : cutPath;
    saveDb();
    return c.pawn_cutouts;
  },

  // Admin: soft-cancel a collection (reversible). With undo=true it restores
  // the collection. Returns false when the collection doesn't exist.
  cancelCollection(id, undo = false) {
    const c = this.getCollection(id);
    if (!c) return false;
    c.cancelled = !undo;
    c.cancelled_at = undo ? null : nowIso();
    saveDb();
    return true;
  },

  // Admin: reopen a collection that stopped accepting words because it was
  // closed (owner finished the list) or its expiry passed, so a customer can add
  // more words. Flips status back to 'open', clears closed_at, and pushes
  // expires_at out a fresh full year (same window a new collection gets). Does
  // NOT touch a soft-cancel — a cancelled order is restored with cancelCollection
  // (undo), and effectiveStatus keeps returning 'cancelled' until it is. Returns
  // the new effective status, or null when the collection doesn't exist.
  reopenCollection(id) {
    const c = this.getCollection(id);
    if (!c) return null;
    // A soft-cancelled collection is reopened by restoring it (cancelCollection
    // undo), never here. Mutating its lifecycle fields would silently drop the
    // original closed_at/expiry (a later restore would then resurface it as
    // freshly open) while effectiveStatus still reported 'cancelled'. No-op.
    if (c.cancelled) return effectiveStatus(c);
    c.status = 'open';
    c.closed_at = null;
    c.expires_at = new Date(Date.now() + YEAR_MS).toISOString();
    saveDb();
    return effectiveStatus(c);
  },

  // Admin: hard-delete a collection and all of its words. Returns false when
  // the collection doesn't exist.
  deleteCollection(id) {
    const before = _db.collections.length;
    _db.collections = _db.collections.filter((c) => c.id !== id);
    if (_db.collections.length === before) return false;
    _db.words = _db.words.filter((w) => w.collection_id !== id);
    saveDb();
    return true;
  },

  // Admin: EDIT the choices a customer made in the wizard — the honoree name(s),
  // contact, design/colour/theme, theme extra fields, word font, gender, chasers
  // and custom title. The owner takes these corrections over WhatsApp ("actually
  // it's their 40th, not 30th") and fixes the order in place before production.
  //
  // PATCH semantics: only keys PRESENT in `patch` are touched, so a partial body
  // never blanks a field it didn't mention. Every value goes through the same
  // sanitizer the create path uses. honoree_name is the one field that cannot be
  // emptied (a collection with no honoree is meaningless) — a blank is ignored.
  // Returns the updated collection, or null when there is no such collection.
  adminUpdateCollection(id, patch = {}) {
    const c = this.getCollection(id);
    if (!c) return null;
    const p = patch && typeof patch === 'object' ? patch : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(p, k);
    // Trim + cap a free-text field; '' means "clear it" (stored as null).
    const text = (v, max) => {
      const s = String(v == null ? '' : v)
        .trim()
        .slice(0, max);
      return s || null;
    };
    if (has('honoree_name')) {
      const n = text(p.honoree_name, 80);
      if (n) c.honoree_name = n;
    }
    if (has('email')) c.owner_email = text(p.email, 120);
    if (has('phone')) c.owner_phone = text(p.phone, 40);
    if (has('design')) c.design = text(p.design, 80);
    if (has('color')) c.color = text(p.color, 80);
    if (has('theme')) c.theme = text(p.theme, 80);
    if (has('word_font')) c.word_font = text(p.word_font, 80);
    if (has('extra_fields')) c.extra_fields = sanitizeExtraFields(p.extra_fields);
    if (has('gender')) {
      c.gender = p.gender === 'male' || p.gender === 'female' ? p.gender : null;
    }
    if (has('chasers')) c.chasers = !!p.chasers;
    // Which seed pool tops this order's deck up, overriding the theme's own.
    // Stored as a bare filename; '' clears it back to the theme default. The
    // CALLER validates the name against the pools that actually exist — this
    // store only shapes and caps it, exactly like the other free-text fields.
    if (has('wordlist')) {
      const next = text(p.wordlist, 120);
      // The seed pool is a PRODUCTION INPUT of the frozen word bank: change it
      // and the stored 412 is no longer what this order's inputs produce. Drop
      // the bank rather than print a list that silently disagrees with the pool
      // the order now names; the next close freezes a fresh one. Only on a real
      // change, so re-saving the dialog untouched cannot cost an order its bank.
      if (c.word_bank && (c.wordlist || '') !== (next || '')) delete c.word_bank;
      c.wordlist = next;
    }
    if (has('custom_title')) c.custom_title = sanitizeCustomTitle(p.custom_title);
    // The two short answers from the details step. Sanitized through the SAME
    // function the wizard's own submission goes through rather than the generic
    // `text()` above, so a value corrected here (typically after a phone call) is
    // shaped exactly like one she typed herself — one line, same cap.
    if (has('buyer_name')) c.buyer_name = sanitizeShortText(p.buyer_name);
    if (has('event_type')) c.event_type = sanitizeShortText(p.event_type);
    if (has('comment')) c.comment = sanitizeComment(p.comment);
    // The OWNER's own note — hers, not the buyer's, and kept in a separate field
    // for exactly that reason: `comment` is what the customer told us, this is
    // what we wrote down about her ("waiting on her photo", "reprinted, second
    // one free"). Merged into one box they become unattributable the first time
    // anyone reads the order back. Shaped by the same sanitizer, because it is
    // the same kind of thing — a short free-text note nobody prints.
    if (has('owner_note')) c.owner_note = sanitizeComment(p.owner_note);
    // Lift (or re-apply) the free word quota for THIS collection only. Admin has
    // deliberately no "mark as paid" — an order becomes paid only through a real
    // payment — so this is the narrow, money-free way to let a particular
    // collection keep collecting: a goodwill exception, or an order settled
    // off-system. Global quota changes live in settings (pricing.free_word_limit).
    if (has('free_limit_applies')) c.free_limit_applies = !!p.free_limit_applies;
    saveDb();
    return c;
  },

  // Admin: REPLACE a collection's pawn images with an explicit list — how the
  // owner removes a photo the customer sent by mistake, or reorders them. Adding
  // photos goes through the upload route (addPawnImages); this only ever narrows
  // or reorders what is already stored, so entries are re-validated to our own
  // /content-uploads paths, de-duped, and capped at 4. An empty array is valid
  // (drops every photo). Returns the stored array, or null for a missing
  // collection. The FILES are intentionally left on disk: they are shared,
  // content-addressed uploads, so deleting one could pull the rug out from under
  // another collection (or the same photo re-sent later).
  adminSetPawnImages(id, paths) {
    const c = this.getCollection(id);
    if (!c) return null;
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(paths) ? paths : []) {
      if (!pawnPathOk(raw) || seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
      if (out.length === 4) break;
    }
    c.pawn_images = out;
    // Drop cutout records for photos that are no longer attached, so the map can
    // never outgrow the (max 4) list it annotates. Keyed by path, so the photos
    // that SURVIVE a removal/reorder keep their own cutout — no re-cut needed.
    const cuts = c.pawn_cutouts;
    if (cuts && typeof cuts === 'object' && !Array.isArray(cuts)) {
      const kept = {};
      for (const p of out) {
        if (Object.prototype.hasOwnProperty.call(cuts, p)) kept[p] = cuts[p];
      }
      c.pawn_cutouts = kept;
    } else {
      c.pawn_cutouts = {};
    }
    saveDb();
    return c.pawn_images;
  },

  // Admin: edit the FULFILMENT of an existing order — its version (digital /
  // pickup / delivery / custom) and, for a delivery, the shipping address. This
  // is the "she asked on WhatsApp to switch to pickup" fix, so unlike setOrder it
  // MUTATES the order in place: payment state, provenance, the pending PeleCard
  // handshake and any production result all survive the edit.
  //
  // Pricing rule:
  //   • UNPAID order — a version change re-prices from settings, exactly like
  //     placing that order fresh, so the pay link charges the right amount.
  //   • PAID order — the total is history (that is what was actually charged) and
  //     is never rewritten. Money owed either way is settled off-system.
  // A delivery version requires a complete address. Switching AWAY from delivery
  // keeps the stored address (a mis-click is then undoable); nothing reads it for
  // a non-delivery order.
  // Returns the updated order, or {error} — 'not found' (no collection), 'no
  // order' (nothing ordered yet), 'bad version', 'address required'.
  adminUpdateOrder(id, { version, address, quantity } = {}) {
    const c = this.getCollection(id);
    if (!c) return { error: 'not found' };
    if (!c.order) return { error: 'no order' };
    const next = version == null ? c.order.version : version;
    if (!Object.prototype.hasOwnProperty.call(ORDER_PRICES, next)) return { error: 'bad version' };
    let addr = c.order.address || null;
    if (next === 'delivery') {
      // An address body is optional when the order ALREADY has one (a version-only
      // edit); a delivery order with neither is rejected.
      addr = address == null ? addr : sanitizeAddress(address);
      if (!addr) return { error: 'address required' };
    }
    const nextQty = sanitizeQuantity(quantity == null ? c.order.quantity || 1 : quantity);
    // An UNPAID order re-prices on any change to what is being bought — version,
    // copy count, or (for delivery) whether the one-time shipping fee applies. A
    // PAID order's total is history: it is what the card was actually charged, and
    // rewriting it would make the receipt lie. Money owed either way is settled
    // off-system, exactly as with a version change.
    if (!c.order.paid) {
      const unit =
        next === c.order.version && Number.isInteger(c.order.unit_price)
          ? c.order.unit_price
          : versionPrice(next);
      c.order.quantity = nextQty;
      c.order.unit_price = unit;
      c.order.delivery_fee = next === 'delivery' ? deliveryFee() : 0;
      c.order.total = orderTotal(next, nextQty, unit);
    }
    c.order.version = next;
    c.order.address = addr;
    saveDb();
    return c.order;
  },

  // Owner-only: attach/replace the order on a collection.
  // Returns the stored order, or an {error} object on bad input/auth.
  //
  // opts.admin — an internal/admin call (e.g. the bespoke custom-order route). It
  //   BYPASSES the public version-enable gate + the version-lock, so the owner can
  //   hand-create a custom (599₪) order even while `custom` is hidden from public
  //   buyers. Public routes (/order, /pay/init) never pass it.
  setOrder(id, ownerToken, { version, address, quantity } = {}, opts = {}) {
    const admin = !!(opts && opts.admin);
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return { error: 'forbidden' };
    if (!Object.prototype.hasOwnProperty.call(ORDER_PRICES, version)) {
      return { error: 'bad version' };
    }
    // Version-lock policy for PUBLIC callers (an admin call bypasses all of this):
    //   • A PAID order is immutable — a completed purchase is never re-charged or
    //     downgraded, whatever version is POSTed.
    //   • An ADMIN-CREATED order (source==='admin', e.g. a bespoke 599₪ custom
    //     quote) is LOCKED to its version: the buyer may re-submit the SAME version
    //     to pay it, but can never switch it to a cheaper one. This is the backstop
    //     against a client downgrading a 599₪ custom order to pickup (199₪).
    //   • An ordinary UNPAID public order is NOT locked — the buyer may still
    //     freely switch to any ENABLED version (re-priced from settings). A buyer
    //     who abandons a card session for one version must be able to order another.
    const cur = c.order || null;
    const curPaid = !!(cur && cur.paid);
    const curAdmin = !!(cur && cur.source === 'admin');
    const sameVersion = !!(cur && cur.version === version);
    if (!admin) {
      if (curPaid) return { error: 'version locked' };
      if (curAdmin && !sameVersion) return { error: 'version locked' };
    }
    // An existing UNPAID order preserves its stored total + pending PeleCard
    // handshake when the SAME version is re-submitted (e.g. paying an admin custom
    // quote, or updating a delivery address without changing the version).
    const existing = cur && !curPaid ? cur : null;
    const sameAsExisting = !!(existing && existing.version === version);
    // Reject a version the owner has turned OFF in admin (settings) exactly like an
    // unknown one — a disabled option can never be charged even if a client POSTs
    // it directly. EXEMPT: an admin call, or re-submitting the order's own locked
    // version (a buyer must be able to pay an admin-created custom order even
    // though `custom` is hidden from the public checkout).
    if (!admin && !sameAsExisting && !versionEnabled(version)) {
      return { error: 'version unavailable' };
    }
    let addr = null;
    if (version === 'delivery') {
      addr = sanitizeAddress(address);
      if (!addr) return { error: 'address required' };
    }
    // Preserve the pending PeleCard handshake (ParamX tokens) when an existing
    // UNPAID order is re-set — an in-flight pay session must still be matchable
    // even if the owner tweaks the version/address before completing payment.
    const prevPelecard = c.order && !c.order.paid ? c.order.pelecard || null : null;
    // How many copies of the same deck. Absent means "don't change it" on a
    // re-submit (an address edit must not silently reset the count to 1) and 1 on
    // a fresh order.
    const copies = sanitizeQuantity(
      quantity == null ? (sameAsExisting && existing.quantity) || 1 : quantity
    );
    // The PER-COPY price, and whether shipping is added on top.
    //
    // An UNPAID order always prices from current settings — including one placed
    // before copies existed, which stored a single all-in total with no separate
    // fee. That is the owner's rule (an unpaid order is re-priced at today's
    // prices, the same rule adminUpdateOrder follows), and it is also what makes
    // the arithmetic safe: collect.html's renderTotal prices from settings too,
    // so the number on the screen and the number charged agree BY CONSTRUCTION
    // rather than by coincidence.
    //
    // The previous attempt special-cased a legacy record by reusing its stored
    // all-in total as the per-copy price. That was one-shot: it then PERSISTED
    // that figure as unit_price, so the next /pay/init no longer recognised the
    // record as legacy and added shipping on top of a number that already
    // contained it — checkout showed 239 and the card was charged 278 on the
    // second press. Pricing every unpaid order the same way removes the case
    // rather than patching it.
    //
    // A quoted per-copy price (an admin custom quote) still survives a re-submit.
    const unitPrice =
      sameAsExisting && Number.isInteger(existing.unit_price)
        ? existing.unit_price
        : versionPrice(version);
    const fee = version === 'delivery' ? deliveryFee() : 0;
    c.order = {
      version,
      // Copies of the same game, and the per-copy price behind the total. Kept as
      // their own fields so a receipt can show the arithmetic rather than a bare
      // sum the buyer has to take on trust.
      quantity: copies,
      unit_price: unitPrice,
      // Shipping, charged ONCE for the whole order (0 for pickup).
      delivery_fee: fee,
      // The authoritative charge. Always recomputed here — never accepted from a
      // client — so a tampered payload cannot buy five decks at the price of one.
      // Summed from the SAME unit/fee stored above rather than via orderTotal(),
      // which would re-derive the fee from settings and re-add shipping to a
      // legacy all-in total.
      total: unitPrice * copies + fee,
      address: addr,
      ordered_at: nowIso(),
      paid: false,
      paid_at: null,
      // Provenance. 'admin' marks a hand-created order (e.g. a custom quote); it
      // is version-locked for public callers (see the lock policy above). A buyer
      // re-submitting an admin order's own version PRESERVES the flag so it stays
      // locked; a brand-new public order is 'public' and freely switchable.
      source: admin ? 'admin' : (existing && existing.source) || 'public',
      // Pending card-payment handshake (PeleCard); null until pay/init runs.
      pelecard: prevPelecard,
    };
    saveDb();
    return c.order;
  },

  // Record a PeleCard init handshake as a SESSION on the order. Each pay/init is
  // its OWN session record { token, charged_total, coupon, discount_pct,
  // transaction_id, resolved } — an owner may open the pay modal more than once
  // (with different coupons), and PeleCard's callback for ANY of those sessions
  // must verify against THAT session's own amount, not a shared order value.
  // Sessions ACCUMULATE (capped). Returns false when there is no order.
  recordPaymentInit(id, { paramToken, transactionId, charged_total, coupon, discount_pct } = {}) {
    const c = this.getCollection(id);
    if (!c || !c.order) return false;
    const p = c.order.pelecard || { sessions: [] };
    if (!Array.isArray(p.sessions)) p.sessions = [];
    if (paramToken && !p.sessions.some((s) => s.token === paramToken)) {
      p.sessions.push({
        token: paramToken,
        // Always a real number so the callback never verifies against undefined.
        charged_total: Number(charged_total),
        coupon: coupon ? normCode(coupon) : null,
        discount_pct: discount_pct != null ? discount_pct : null,
        transaction_id: transactionId || null,
        resolved: false,
        // Per-session timestamp: bounds the in-flight window (see TTL) and is the
        // basis for evicting only OLD, RESOLVED sessions when over the cap.
        initiated_at: nowIso(),
      });
      // Bound growth, but NEVER evict an unresolved session — a payment completed
      // on any still-open modal must always find its own amount to verify. Drop
      // oldest RESOLVED sessions only; if all are unresolved, keep them all.
      if (p.sessions.length > MAX_SESSIONS) {
        let toDrop = p.sessions.length - MAX_SESSIONS;
        p.sessions = p.sessions.filter((s) => {
          if (toDrop > 0 && s.resolved) {
            toDrop -= 1;
            return false;
          }
          return true;
        });
      }
    }
    p.last_transaction_id = transactionId || p.last_transaction_id || null;
    p.initiated_at = nowIso();
    c.order.pelecard = p;
    saveDb();
    return true;
  },

  // Whether an order has a RECENT in-flight REAL (non-free) pay session: one with
  // a gateway transaction_id and a positive charge, not yet resolved, AND started
  // within SESSION_TTL_MS. A free/coupon path must refuse while such a session
  // exists (else the customer could be charged for a "free" order) — but an
  // abandoned session past the TTL must NOT block the free path forever.
  hasInFlightRealSession(order) {
    if (!order || !order.pelecard || !Array.isArray(order.pelecard.sessions)) return false;
    const now = Date.now();
    return order.pelecard.sessions.some(
      (s) =>
        s &&
        !s.resolved &&
        s.transaction_id &&
        Number(s.charged_total) > 0 &&
        s.initiated_at &&
        now - Date.parse(s.initiated_at) < SESSION_TTL_MS
    );
  },

  // Abandon every in-flight pay session on an order: the buyer CLOSED the payment
  // window, so no charge can still land from it. Without this the session stays
  // "in flight" for the whole TTL and deadlocks the free/coupon path — the buyer
  // is told to close a window they have already closed, with no way to clear it
  // (the bug behind "the pay button does nothing").
  //
  // `resolved` here means only "no longer in flight". It does NOT hide the
  // session from the PeleCard callback: getCollectionByPayToken / sessionByToken
  // look sessions up by TOKEN regardless of this flag, so a charge that somehow
  // still completes on an abandoned session is honoured and verified against its
  // own amount exactly as before. Abandoning costs the buyer nothing; leaving it
  // in flight locks them out.
  //
  // Owner-token gated. Returns the number abandoned, or null when not authorised.
  abandonPaySessions(id, ownerToken) {
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return null;
    if (!c.order || !c.order.pelecard || !Array.isArray(c.order.pelecard.sessions)) return 0;
    // A PAID order has nothing in flight worth clearing, and rewriting its
    // sessions would only muddy the payment record.
    if (c.order.paid) return 0;
    let n = 0;
    for (const s of c.order.pelecard.sessions) {
      if (s && !s.resolved) {
        s.resolved = true;
        s.abandoned_at = nowIso();
        n += 1;
      }
    }
    if (n) saveDb();
    return n;
  },

  // Find the collection whose order has a pay SESSION with this ParamX token
  // (the AdditionalDetailsParamX PeleCard echoes back). Returns null if none.
  getCollectionByPayToken(token) {
    if (!token) return null;
    return (
      _db.collections.find(
        (c) =>
          c.order &&
          c.order.pelecard &&
          Array.isArray(c.order.pelecard.sessions) &&
          c.order.pelecard.sessions.some((s) => s.token === token)
      ) || null
    );
  },

  // Resolve a ParamX token to its { collection, session } pair, or null. The
  // callback uses this to verify against the SESSION's own charged_total.
  getPaymentSessionByToken(token) {
    const c = this.getCollectionByPayToken(token);
    if (!c) return null;
    const session = c.order.pelecard.sessions.find((s) => s.token === token) || null;
    return session ? { collection: c, session } : null;
  },

  // Admin: flip an order between "still here" and SENT TO THE PRINT SHOP. The
  // first of the two hand-pressed production steps: the PDF is generated (that
  // is `order.production`, which the generator sets by itself), the owner mails
  // it to the print shop, and she presses this to say she has.
  //
  // A status marker and nothing more — it sends no mail to anybody. The print
  // shop hears from the owner the way it always has; this only records that it
  // happened, so the orders list can answer "what is out at the printer" and so
  // `setOrderReady` has something to gate on.
  //
  // `sent_to_print_at` is both the flag and the record of WHEN, for the same
  // reason `ready_at` is: a countable date can never drift out of step with the
  // orders the way a separate running total could.
  //
  // Returns { order, changed, error } — `error` is set instead of unsetting the
  // flag when the order is already marked ready for the customer, because
  // "ready" is defined as "back from print" and taking the print stamp out from
  // under it would leave a state the pipeline cannot produce. The owner un-marks
  // ready first. Null when there is no such collection or no order on it.
  setOrderSentToPrint(id, sent) {
    const c = this.getCollection(id);
    if (!c || !c.order) return null;
    const want = !!sent;
    const had = !!c.order.sent_to_print_at;
    if (want === had) return { order: c.order, changed: false };
    if (!want && c.order.ready_at) return { order: c.order, changed: false, error: 'ready' };
    c.order.sent_to_print_at = want ? nowIso() : null;
    saveDb();
    return { order: c.order, changed: true };
  },

  // Admin: flip an order between "being made" and READY — printed, and either
  // waiting to be collected or about to go out. A toggle, not a one-way latch:
  // the owner presses it by hand and must be able to take it back when she
  // presses the wrong row.
  //
  // GATED ON THE PRINT SHOP. An order is only "ready" once it is back from
  // Galor, so it cannot be marked ready before it was ever sent — and pressing
  // this is what emails the customer, which is the one step in the pipeline that
  // cannot be taken back. The gate lives HERE rather than only in the admin page
  // because that is what makes it true of the data: a stale tab, a replayed
  // request or a future caller all meet the same rule.
  //
  // `ready_at` is both the flag and the record of WHEN, which is what makes the
  // "how many printed" tally on the dashboard countable rather than a separate
  // number that could drift out of step with the orders themselves.
  //
  // Returns { order, changed, error } — `changed` false when it was already in
  // the requested state, so the caller can avoid re-sending the customer's email
  // on a double-tap; `error: 'not_sent_to_print'` when the gate refused it. Null
  // when there is no such collection or no order on it.
  setOrderReady(id, ready) {
    const c = this.getCollection(id);
    if (!c || !c.order) return null;
    const want = !!ready;
    const had = !!c.order.ready_at;
    if (want === had) return { order: c.order, changed: false };
    // Undo is never gated: taking a wrong press back must always be possible,
    // and it only ever moves the order backwards through the pipeline.
    if (want && !c.order.sent_to_print_at) {
      return { order: c.order, changed: false, error: 'not_sent_to_print' };
    }
    c.order.ready_at = want ? nowIso() : null;
    saveDb();
    return { order: c.order, changed: true };
  },

  // How many orders are out at the print shop and not yet back — the two stamps
  // read together, because an order that has come back is no longer "at Galor"
  // even though its sent stamp stays on it as the record that it went.
  countSentToPrintOrders() {
    return _db.collections.filter((c) => c.order && c.order.sent_to_print_at && !c.order.ready_at)
      .length;
  },

  // How many orders have been marked ready (i.e. printed). Counted from the
  // orders themselves rather than kept as a running total, so it can never
  // disagree with what the list shows — an undo lowers it by construction.
  countReadyOrders() {
    return _db.collections.filter((c) => c.order && c.order.ready_at).length;
  },

  // Mark an existing order as paid. Used by the PeleCard callback and the
  // free-coupon path — the only two real money events. Nothing marks an order
  // paid by hand (there is no admin mark-paid route). meta carries the method +
  // transaction details, the applied coupon/charge (for the order record), and
  // optionally the session `token` to mark that session resolved.
  markPaid(id, meta = {}) {
    const c = this.getCollection(id);
    if (!c || !c.order) return false;
    c.order.paid = true;
    c.order.paid_at = nowIso();
    if (meta.method) c.order.paid_method = meta.method;
    if (meta.transactionId) c.order.paid_transaction_id = meta.transactionId;
    if (meta.approvalNo) c.order.paid_approval_no = meta.approvalNo;
    // Record what was actually charged + which coupon on the order for display.
    if (meta.charged_total != null) c.order.charged_total = Number(meta.charged_total);
    if (meta.coupon !== undefined) c.order.coupon = meta.coupon ? normCode(meta.coupon) : null;
    if (meta.discount_pct !== undefined) c.order.discount_pct = meta.discount_pct;
    // Mark the matched pay session resolved so it's no longer "in flight".
    if (meta.token && c.order.pelecard && Array.isArray(c.order.pelecard.sessions)) {
      const s = c.order.pelecard.sessions.find((x) => x.token === meta.token);
      if (s) s.resolved = true;
    }
    // A custom ("hand-designed just for you") order needs manual design work once
    // paid — flag a production sub-state so the admin dashboard surfaces it as
    // awaiting design. Mirrored to the collection (like setProduction) and never
    // clobbers an already-recorded production state.
    if (c.order.version === 'custom' && !c.order.production) {
      const rec = { state: 'needs_design', custom: true, flagged_at: c.order.paid_at };
      c.order.production = rec;
      c.production = rec;
    }
    saveDb();
    return true;
  },

  // Record the PDF-production state for a collection. Shape:
  // { state:'generated', pdf_file, board_file, generated_at, theme?, pages? } —
  // board_file is the order's SECOND artifact (the game board, generated as its
  // own file beside the deck) and is null when the run produced none. Stored on the
  // order when one exists (order.production, per the order model) and always
  // mirrored to the collection (c.production) so an order that was generated
  // before a version was chosen still surfaces its production state. Returns the
  // stored production object, or false when the collection is unknown.
  setProduction(id, production) {
    const c = this.getCollection(id);
    if (!c) return false;
    const rec = { ...production };
    // A successfully generated PDF gets a per-collection capability token so the
    // customer can be emailed a download link that never carries the admin key.
    // Reuse an existing token across regenerations so any already-sent link keeps
    // working; only mint one the first time this collection produces a PDF.
    if (rec.state === 'generated' && !rec.pdf_token) {
      const prev = (c.order && c.order.production) || c.production || null;
      rec.pdf_token = (prev && prev.pdf_token) || crypto.randomBytes(24).toString('hex');
    }
    c.production = rec;
    if (c.order) c.order.production = rec;
    saveDb();
    return rec;
  },

  // --- Discount coupons ---------------------------------------------------
  // A coupon is a percentage-off code the admin creates and the checkout
  // applies. Shape: { id, code, discount_pct, valid_until, active, created_at,
  // uses }. `valid_until` is a 'YYYY-MM-DD' string (inclusive) or null = never
  // expires. `uses` counts orders that used the coupon and became paid.

  // Create a coupon. Validates the code shape/uniqueness and the percentage,
  // then persists it. Returns the stored coupon, or { error } on bad input or a
  // duplicate code.
  createCoupon({ code, discount_pct, valid_until } = {}) {
    const c = normCode(code);
    if (!/^[A-Z0-9]{3,20}$/.test(c)) return { error: 'bad code' };
    if (!Number.isInteger(discount_pct) || discount_pct < 1 || discount_pct > 100) {
      return { error: 'bad discount_pct' };
    }
    let until = null;
    if (valid_until != null && valid_until !== '') {
      const s = String(valid_until).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
        return { error: 'bad valid_until' };
      }
      until = s;
    }
    if (_db.coupons.some((x) => x.code === c)) return { error: 'duplicate' };
    const coupon = {
      id: uid(),
      code: c,
      discount_pct,
      valid_until: until,
      active: true,
      created_at: nowIso(),
      uses: 0,
    };
    _db.coupons.push(coupon);
    saveDb();
    return coupon;
  },

  // All coupons, newest first.
  listCoupons() {
    return [..._db.coupons].sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  getCouponByCode(code) {
    const c = normCode(code);
    return _db.coupons.find((x) => x.code === c) || null;
  },

  getCouponById(id) {
    return _db.coupons.find((x) => x.id === id) || null;
  },

  setCouponActive(id, active) {
    const c = this.getCouponById(id);
    if (!c) return null;
    c.active = !!active;
    saveDb();
    return c;
  },

  deleteCoupon(id) {
    const before = _db.coupons.length;
    _db.coupons = _db.coupons.filter((x) => x.id !== id);
    if (_db.coupons.length === before) return false;
    saveDb();
    return true;
  },

  // Validate a code for use at checkout. Returns { valid:true, coupon } or
  // { valid:false, reason } with reason in 'not_found'|'inactive'|'expired'.
  validateCoupon(code) {
    const c = this.getCouponByCode(code);
    if (!c) return { valid: false, reason: 'not_found' };
    if (!c.active) return { valid: false, reason: 'inactive' };
    // valid_until is inclusive: expired only once today (Israel) is after it.
    if (c.valid_until && todayStrIsrael() > c.valid_until) {
      return { valid: false, reason: 'expired' };
    }
    return { valid: true, coupon: c };
  },

  // Increment a coupon's use counter (called when an order that used it is
  // marked paid). No-op/false when the code is unknown.
  incrementCouponUses(code) {
    const c = this.getCouponByCode(code);
    if (!c) return false;
    c.uses = (c.uses || 0) + 1;
    saveDb();
    return true;
  },

  // --- Words reminder ------------------------------------------------------
  // Mark a collection as having received its one-time "add your words" nudge.
  markReminded(id) {
    const c = this.getCollection(id);
    if (!c) return false;
    c.reminded_at = nowIso();
    saveDb();
    return true;
  },

  // --- Owner reminder list send-state (server/reminders.js) ----------------
  // Per-reminder { count, last_at } for one collection. Empty object when none
  // sent yet. Read-only; the engine uses it for max_total + every_days.
  reminderState(id) {
    const c = this.getCollection(id);
    return c && c.reminder_state && typeof c.reminder_state === 'object' ? c.reminder_state : {};
  },

  // Record that reminder `reminderId` was ATTEMPTED for this collection at `atMs`:
  // bump its count + set last_at. Called BEFORE the send result is known (an
  // ambient reminder must fire at most once per its window — never retry on a
  // failed-looking send, which is what spammed the group before). Returns the new
  // per-reminder state, or null for an unknown collection / empty id.
  markReminderSent(id, reminderId, atMs) {
    const c = this.getCollection(id);
    const rid = String(reminderId || '');
    if (!c || !rid) return null;
    if (!c.reminder_state || typeof c.reminder_state !== 'object') c.reminder_state = {};
    const cur = c.reminder_state[rid] || { count: 0, last_at: null };
    cur.count = (Number(cur.count) || 0) + 1;
    const ms = Number(atMs);
    cur.last_at = new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
    c.reminder_state[rid] = cur;
    saveDb();
    return cur;
  },

  // Ms of the collection's LAST activity — the most recent word add, falling back
  // to the collection's creation time. Feeds the engine's only_if_idle_hours.
  // Returns NaN for an unknown collection (the engine then treats it as idle).
  lastActivityMs(id) {
    const c = this.getCollection(id);
    if (!c) return NaN;
    let last = Date.parse(c.created_at || '');
    for (const w of _db.words) {
      if (w.collection_id !== id) continue;
      const t = Date.parse(w.created_at || '');
      if (Number.isFinite(t) && (!Number.isFinite(last) || t > last)) last = t;
    }
    return last;
  },

  // --- Order-created notification (idempotent) -----------------------------
  // Atomically claim the one-time "order received" notification for a collection:
  // returns true ONLY on the first call (and stamps order_notified_at), false
  // every time after. Callers gate the owner/buyer emails + WhatsApp group on a
  // true return, so re-setting the order version or re-opening the pay modal never
  // re-notifies. The check-and-set is synchronous (single process), so two near-
  // simultaneous order writes can't both win.
  markOrderNotified(id) {
    const c = this.getCollection(id);
    if (!c) return false;
    if (c.order_notified_at) return false;
    c.order_notified_at = nowIso();
    saveDb();
    return true;
  },

  // The collections DUE for the one-time words reminder (read-only query).
  collectionsDueForReminder(now = Date.now()) {
    const cutoff = now - REMINDER_AFTER_MS;
    return _db.collections.filter((c) => {
      if (!c || !c.owner_email) return false;
      if (c.cancelled) return false;
      if (c.reminded_at) return false;
      const hasWords = _db.words.some((w) => w.collection_id === c.id);
      if (hasWords) return false;
      const paidAt = c.order && c.order.paid && c.order.paid_at ? c.order.paid_at : null;
      const basis = paidAt || c.created_at;
      const basisMs = Date.parse(basis);
      if (Number.isNaN(basisMs)) return false;
      return basisMs < cutoff;
    });
  },

  // --- Payment reminder ----------------------------------------------------
  // How many payment reminders a collection has already received. Prefers the
  // stage counter; falls back to the legacy one-shot flag so a collection
  // reminded before multi-stage shipped counts as 1 (never re-sends stage 1).
  paymentRemindersSent(c) {
    if (!c) return 0;
    if (Number.isInteger(c.payment_reminders_sent)) return c.payment_reminders_sent;
    return c.payment_reminded_at ? 1 : 0;
  },

  // Record that ONE more payment reminder was sent (advances the stage counter).
  // Also stamps the legacy payment_reminded_at on the first send for continuity.
  markPaymentReminderSent(id) {
    const c = this.getCollection(id);
    if (!c) return false;
    c.payment_reminders_sent = this.paymentRemindersSent(c) + 1;
    if (!c.payment_reminded_at) c.payment_reminded_at = nowIso();
    saveDb();
    return true;
  },

  // The collections DUE for the NEXT payment reminder (read-only query): an order
  // EXISTS, is NOT paid, the collection isn't cancelled, it has a buyer contact,
  // and MORE reminder milestones have elapsed than have been sent. `delays` is the
  // sorted list of milestone hours (from the owner-editable trigger timing); a
  // collection is due when the number of elapsed milestones exceeds how many
  // reminders it has already received — so each milestone fires exactly once.
  collectionsDueForPaymentReminder(now = Date.now(), delays = [24]) {
    const list = (Array.isArray(delays) ? delays : [24])
      .map((d) => Math.max(1, Number(d) || 0))
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    return _db.collections.filter((c) => {
      if (!c || c.cancelled) return false;
      const o = c.order;
      if (!o || o.paid) return false;
      if (!c.owner_email && !c.owner_phone) return false;
      const orderedMs = Date.parse(o.ordered_at || c.created_at || '');
      if (Number.isNaN(orderedMs)) return false;
      const ageHours = (now - orderedMs) / (60 * 60 * 1000);
      const elapsed = list.filter((d) => ageHours >= d).length;
      return elapsed > this.paymentRemindersSent(c);
    });
  },

  // --- Private-design access codes ----------------------------------------
  createDesignCode({ code, design_id, valid_until } = {}) {
    const c = normCode(code);
    if (!/^[A-Z0-9]{3,20}$/.test(c)) return { error: 'bad code' };
    const design = String(design_id == null ? '' : design_id)
      .trim()
      .slice(0, 80);
    if (!design) return { error: 'bad design_id' };
    let until = null;
    if (valid_until != null && valid_until !== '') {
      const s = String(valid_until).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
        return { error: 'bad valid_until' };
      }
      until = s;
    }
    if (_db.design_codes.some((x) => x.code === c)) return { error: 'duplicate' };
    const rec = {
      id: uid(),
      code: c,
      design_id: design,
      valid_until: until,
      active: true,
      created_at: nowIso(),
      uses: 0,
    };
    _db.design_codes.push(rec);
    saveDb();
    return rec;
  },

  listDesignCodes() {
    return [..._db.design_codes].sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  getDesignCodeByCode(code) {
    const c = normCode(code);
    return _db.design_codes.find((x) => x.code === c) || null;
  },

  getDesignCodeById(id) {
    return _db.design_codes.find((x) => x.id === id) || null;
  },

  setDesignCodeActive(id, active) {
    const c = this.getDesignCodeById(id);
    if (!c) return null;
    c.active = !!active;
    saveDb();
    return c;
  },

  deleteDesignCode(id) {
    const before = _db.design_codes.length;
    _db.design_codes = _db.design_codes.filter((x) => x.id !== id);
    if (_db.design_codes.length === before) return false;
    saveDb();
    return true;
  },

  validateDesignCode(code) {
    const c = this.getDesignCodeByCode(code);
    if (!c) return { valid: false, reason: 'not_found' };
    if (!c.active) return { valid: false, reason: 'inactive' };
    if (c.valid_until && todayStrIsrael() > c.valid_until) {
      return { valid: false, reason: 'expired' };
    }
    return { valid: true, design_id: c.design_id };
  },

  incrementDesignCodeUses(code) {
    const c = this.getDesignCodeByCode(code);
    if (!c) return false;
    c.uses = (c.uses || 0) + 1;
    saveDb();
    return true;
  },
};

module.exports = db;
module.exports.ORDER_PRICES = ORDER_PRICES;
// The effective pricing projection (store + per-version enabled/price), read by
// the public GET /api/pricing so the DISPLAY always matches the CHARGE path.
module.exports.effectivePricing = effectivePricing;
// The short order number to print for a collection (falls back to its id).
module.exports.orderRef = orderRef;
// The one-time shipping fee + the copy-count sanitiser + the authoritative
// total, exposed for the routes (which must never trust a client's number) and
// for unit tests.
module.exports.deliveryFee = deliveryFee;
module.exports.sanitizeQuantity = sanitizeQuantity;
module.exports.orderTotal = orderTotal;
module.exports.MAX_COPIES = MAX_COPIES;
// Pure free-quota projection (collection + word count -> {limit, applies, paid,
// remaining, locked}), exposed for the API's public view and for unit tests.
module.exports.freeLimitState = freeLimitState;
