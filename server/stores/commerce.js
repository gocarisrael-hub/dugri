// Agent A (Commerce): the pricing, coupon, stock and Meta-report state kept by the
// store, moved out of server/db.js (slice 3 of splitting the monolith; see
// docs/agent-partition.md). A VERBATIM move of those blocks.
//
// Two kinds of block, two kinds of factory:
//   - Blocks of the `db` object (Meta report, coupons, stock) return methods that
//     db.js spreads back into `db` at the same position, so every caller keeps
//     calling db.createCoupon(...) etc., `this` is still `db`, key order is
//     unchanged, and there is still ONE in-memory store written by ONE saveDb.
//   - Module-level helper blocks (pricing, order totals, the Meta report helpers,
//     the stock seeds, the coupon helpers) return their functions and constants,
//     which db.js destructures at the line the block used to occupy. db.js code
//     outside Agent A's blocks (setOrder, markPaid, listAllCollections) still
//     calls them by the same names.
// Nothing is required at the top level and nothing is kept at module level, for
// the same reason as server/stores/platform.js: the tests purge require.cache to
// reload db.js, and a cached copy of this file must never hold on to a previous
// load's store or settings.

// ORDER_PRICES and the live pricing reads, the copy cap and the delivery fee.
function pricing({ settings }) {
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
  const {
    prices: ORDER_PRICES,
    enabled: DEFAULT_ENABLED,
    store: STORE_DEFAULTS,
  } = pricingDefaults();

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
      // Where delivery takes longer, as a HEADLINE only — how many localities and
      // how long. Deliberately NOT the towns themselves: /api/pricing is fetched by
      // every storefront page for its prices, and a real courier list is thousands
      // of names, which none of those pages will ever print. The list has its own
      // endpoint (GET /api/delivery-exceptions), fetched only by the checkout,
      // which is the only surface that shows it.
      // `count` is what the checkout needs to decide whether the note exists at
      // all, so the note can be painted from this payload without the names.
      delivery_exceptions: (() => {
        const e = deliveryExceptions();
        return { count: e.towns.length, eta_days: e.eta_days };
      })(),
    };
  }

  // The out-of-the-way localities and their delivery time, as the checkout needs
  // them: { towns: string[], eta_days: number }.
  //
  // An EMPTY towns array is the normal state and means "print nothing" — the note
  // only exists once the owner has filled the list. Every failure mode lands
  // there too: a missing key, a corrupt override, a non-string value. That
  // direction is deliberate. Showing no note understates nothing (the standard
  // delivery estimate beside it still stands), whereas a half-parsed list would
  // print a longer wait next to towns that don't belong to it, which is a promise
  // made to the wrong buyer.
  function deliveryExceptions() {
    let towns = [];
    let etaDays = 11;
    try {
      const raw = settings.get('pricing', 'remote_towns');
      if (typeof raw === 'string') {
        towns = raw
          .split('\n')
          .map((t) => t.trim())
          .filter(Boolean);
        // De-duplicate, preserving the owner's order: she edits this by hand and a
        // town pasted twice is a typo, not an instruction.
        towns = towns.filter((t, i) => towns.indexOf(t) === i);
      }
    } catch {
      /* settings unavailable — no note rather than a guessed one */
    }
    try {
      const d = settings.get('pricing', 'remote_eta_days');
      if (Number.isInteger(d) && d > 0) etaDays = d;
    } catch {
      /* keep the default */
    }
    return { towns, eta_days: etaDays };
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

  return {
    ORDER_PRICES,
    versionEnabled,
    versionPrice,
    effectivePricing,
    deliveryExceptions,
    MAX_COPIES,
    deliveryFee,
  };
}

// The Meta Conversions API report's timing constants and helpers. markPaid (the
// payment path) and listAllCollections use these too.
function metaReportHelpers() {
  // An in-flight Meta report older than this died with the process that started
  // it. Comfortably longer than META_CAPI_TIMEOUT_MS (6s) plus a slow boot.
  const META_REPORT_STALE_MS = Number(process.env.META_REPORT_STALE_MS || 5 * 60 * 1000);

  // How long a report is still worth sending at all. Meta rejects a Purchase whose
  // event_time is more than seven days old, so past this the retry will never go
  // out — and the buyer's device details, which exist for nothing else, stop
  // having any purpose.
  //
  // The same number is used for both windows, but they are NOT the same window:
  // staleMetaReports ages an order from `paid_at`, sweepMetaCtx ages the details
  // from `ctx.seen_at`, which was captured at pay/init. seen_at is always the
  // earlier of the two, so there is a sliver — from seen_at+7d to paid_at+7d — in
  // which a report is still sweepable but its device details are already gone, and
  // the retry goes out with no ip/ua/fbp/fbc and a fallback source_url. That
  // sliver is exactly the gap between opening the card form and the charge
  // landing, which is minutes for anyone who actually pays. Nothing CAPS it,
  // though: SESSION_TTL_MS bounds only the free-coupon in-flight guard, and the
  // PeleCard callback finds its session by token with no age check at all, so a
  // callback that arrives hours late is still honoured and the sliver is however
  // long that gap was. It is a weaker match on a sale at the very edge of the
  // window, never a lost one: external_id is always present.
  const META_REPORT_MAX_AGE_MS = Number(
    process.env.META_REPORT_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000
  );

  // And for a checkout that was NEVER PAID: no report is ever owed for it, so the
  // details are dead the moment the buyer walks away from the card form. This is
  // the common case, not the edge one — most people who open a payment modal do
  // not finish — and without a life of its own every one of them would leave an IP
  // and a user-agent in the store forever.
  const META_CTX_UNPAID_TTL_MS = Number(process.env.META_CTX_UNPAID_TTL_MS || 24 * 60 * 60 * 1000);

  // HOW LONG A FAILED REPORT WAITS BEFORE THE NEXT TRY, by attempt number.
  //
  // The first retry is immediate, and deliberately: the commonest transient
  // failure is a send that died inside the payment callback, and the buyer's own
  // confirmation page — loading seconds later, and knowing things the callback did
  // not — is the best-placed thing to fix it. Everything after that backs off,
  // because the failure most likely to REPEAT is a token that is expired or scoped
  // wrong, and without a brake every paid order in the seven-day window would be
  // re-sent on every boot and on every confirmation-page reload, at two
  // whole-store writes an attempt. Capped rather than unbounded so a fixed token
  // still recovers on its own within hours — which is a promise only because the
  // sweep is armed on an interval, not just at boot (see armMetaCapiTimers): a
  // backoff nothing wakes up for is not a backoff, it is an abandonment.
  const META_RETRY_BACKOFF_MS = [0, 60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 3600 * 1000];
  const META_RETRY_BACKOFF_MAX_MS = 6 * 3600 * 1000;
  const metaRetryDelay = (tries) => {
    const wait = META_RETRY_BACKOFF_MS[Math.max(0, tries - 1)];
    return wait === undefined ? META_RETRY_BACKOFF_MAX_MS : wait;
  };

  // May this order's Meta report be (re)claimed? Not once it has finally succeeded
  // or finally failed, not while a send started moments ago is still running, and
  // not before the backoff from the last failure is up.
  function claimable(report, now = Date.now()) {
    if (!report) return true;
    if (report.ok || report.permanent) return false;
    const next = report.next_at ? Date.parse(report.next_at) : NaN;
    if (Number.isFinite(next) && now < next) return false;
    if (!report.at) return true;
    const at = Date.parse(report.at);
    return !Number.isFinite(at) || now - at >= META_REPORT_STALE_MS;
  }

  // The buyer's device details, gone. Called when a report ENDS — and, because
  // plenty of checkouts never produce a report at all, also by sweepMetaCtx below,
  // which is what actually bounds how long these can exist.
  function dropMetaCtx(c) {
    if (c && c.order && c.order.pelecard) delete c.order.pelecard.meta_ctx;
  }

  // The same details kept OUT of an outbound copy, without touching the stored
  // one — the store still needs them until the report is done.
  function withoutMetaCtx(order) {
    if (!order.pelecard || !order.pelecard.meta_ctx) return order;
    const { meta_ctx, ...pelecard } = order.pelecard;
    void meta_ctx;
    return { ...order, pelecard };
  }

  return {
    META_REPORT_MAX_AGE_MS,
    META_CTX_UNPAID_TTL_MS,
    metaRetryDelay,
    claimable,
    dropMetaCtx,
    withoutMetaCtx,
  };
}

// The opening stock counts and the stock integer coercion.
function stockHelpers() {
  // --- PHYSICAL STOCK -----------------------------------------------------------
  // The things that run out. Boards are printed in batches per design and a deck
  // cannot ship without one; boxes, thank-you notes and stickers are the packing.
  // Nothing in the software consumed any of it before, so "how many Santorini
  // boards are left?" was a question answered by walking to the shelf.
  //
  // WHAT COUNTS AS USING ONE: marking an order READY. That is the moment the deck
  // comes back from Galor and gets packed, which is when a board, a box and a note
  // physically leave the shelf. It is a TOGGLE (db.setOrderReady), so un-marking a
  // row pressed by mistake puts the same things back — see applyOrderStock.
  //
  // THE OPENING COUNT, as the owner counted the shelf. Keyed by the design's
  // HEBREW NAME because that is what she counted, not by theme key: two of these
  // designs do not exist in this checkout at all (their templates live on the
  // Railway volume), so a key-based seed would silently skip them. Resolved
  // against the live theme list the first time each design is seen, and stored by
  // THEME KEY from then on — so renaming a design afterwards moves its stock with
  // it rather than starting a second pile.
  const INITIAL_BOARD_STOCK = {
    סנטוריני: 40,
    קליפורניה: 40,
    פריז: 40,
    דני: 30,
    אואזיס: 20,
    סיישל: 15,
    טוקיו: 5,
    טריפה: 5,
    ברוקלין: 5,
    מרקאנה: 5,
  };

  // The packing supplies, and how many of each one order eats.
  //
  // `per_order` is a NUMBER the owner can change, not a rule baked into the code,
  // because the packing changes faster than a deploy does. It is also how the one
  // genuine ambiguity in the brief is left to her rather than guessed at: she named
  // boxes, stickers and thank-you notes, and then said an order uses "a thank-you
  // note, a packaging and the board" — so stickers start at 0 per order, visibly,
  // with a field she can put a 1 in if they should have been counted all along. A
  // wrong guess here would drift her count quietly, which is the one thing an
  // inventory must never do.
  const SUPPLY_DEFAULTS = [
    { key: 'packaging', label: 'קופסאות אריזה', count: 139, per_order: 1 },
    { key: 'thankyou', label: 'פתקי תודה', count: 80, per_order: 1 },
    { key: 'stickers', label: 'מדבקות', count: 80, per_order: 0 },
  ];

  // Stock is allowed to go NEGATIVE. That is deliberate: a negative number is the
  // truthful statement "you have shipped more of these than you told me you had",
  // which is a thing the owner needs to see and correct. Clamping at zero would
  // hide it and then quietly under-count every restock afterwards.
  function stockInt(v, dflt = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : dflt;
  }

  return { INITIAL_BOARD_STOCK, SUPPLY_DEFAULTS, stockInt };
}

// The copy-count sanitiser and the authoritative order total.
function orderTotals({ MAX_COPIES, versionPrice, deliveryFee }) {
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

  return { sanitizeQuantity, orderTotal };
}

// The boot-time migration of the first-cut Meta report stamp. db.js still calls it
// at the same point in the load, and still exposes it as db.migrateMetaReports.
function metaReportMigration({ _db, saveDb }) {
  // One-time migration for orders stamped by the FIRST cut of the Meta report,
  // which recorded only `meta_reported_at`: a flag that says "a send was claimed",
  // with no way to say whether Meta ever answered.
  //
  // The current code reads such an order as never-claimed (claimable(undefined) is
  // true), so one reload of that buyer's confirmation page would send Meta a sale
  // it already has.
  //
  // AND THE STAMP CANNOT SAY WHETHER META EVER ANSWERED. That build set
  // meta_reported_at BEFORE the request left and removed it again from the .then
  // and the .catch, so a surviving stamp means either "Meta took it" or "the
  // process died between the claim and the answer" — which is the mid-flight case
  // the current design exists to recover. Carrying it across as a SUCCESS would
  // therefore bury exactly those sales: claimable would refuse them for good, and
  // nothing would ever say so.
  //
  // So it is carried across as a TRANSIENT failure instead — an outcome nobody
  // knows, handed to the sweep to decide. The cost of guessing wrong that way is a
  // duplicate send, deduplicated inside Meta's 48-hour event_id window and DOUBLE
  // COUNTED outside it — event_id is the order number, which is stable forever, and
  // the sweep will revive an order paid up to seven days ago whose original send
  // may have been more than 48 hours before that. The cost of guessing wrong the
  // other way is a sale silently never reported at all, which nothing can recover.
  // A double count somebody can see beats a loss nobody can.
  //
  // A no-op (and no write) on a store that never saw that build, which is every
  // store we run. Cheap insurance, not a live bug.
  function migrateMetaReports() {
    let n = 0;
    for (const c of _db.collections) {
      const o = c && c.order;
      if (!o || !o.meta_reported_at || o.meta_report) continue;
      o.meta_report = { error: 'migrated: claim of unknown outcome' };
      delete o.meta_reported_at;
      n += 1;
    }
    if (n) saveDb();
    return n;
  }

  return { migrateMetaReports };
}

// Coupon money helpers: rounding, partner terms, the redemption cap, commission.
function couponHelpers({ sanitizeQuantity }) {
  // Money, to the agora. Commission on a percentage lands on fractions, and a
  // float sum of fractions drifts — every amount that reaches the store or a
  // report goes through here so the two sides can never disagree by a rounding.
  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  // Validate the PARTNER terms on a coupon: who she is, and what she earns.
  // Returns the cleaned fields, or { error } — never throws, and never half-applies
  // (a bad rate must not be able to leave a coupon with a name but no terms).
  //
  // commission_type null/'' means "not a partner coupon", which clears the terms.
  // 'fixed' is shekels per order (1..10000 — a cap so a slipped keypad cannot
  // promise a fortune); 'percent' is 1..100 of the game money.
  function normalizeCommission({ partner_name, commission_type, commission_value } = {}) {
    const name = typeof partner_name === 'string' ? partner_name.trim().slice(0, 80) : '';
    const type = commission_type == null || commission_type === '' ? null : String(commission_type);
    if (type === null) return { partner_name: name, commission_type: null, commission_value: 0 };
    if (type !== 'fixed' && type !== 'percent') return { error: 'bad commission_type' };
    const v = Number(commission_value);
    if (!Number.isFinite(v) || v <= 0) return { error: 'bad commission_value' };
    if (type === 'percent' && v > 100) return { error: 'bad commission_value' };
    if (type === 'fixed' && v > 10000) return { error: 'bad commission_value' };
    return { partner_name: name, commission_type: type, commission_value: round2(v) };
  }

  // A coupon's redemption cap. null/'' means NO limit — the shape every coupon
  // minted before this field existed already has, so an old row keeps working
  // untouched. Anything else must be a whole number of uses, at least one; 0 is
  // refused rather than read as "unlimited", because a cap of zero is far more
  // likely to be a typo than a code deliberately created dead.
  // Returns { value } or { error }.
  function normMaxUses(max_uses) {
    if (max_uses == null || max_uses === '') return { value: null };
    const n = Number(max_uses);
    if (!Number.isInteger(n) || n < 1 || n > 1e6) return { error: 'bad max_uses' };
    return { value: n };
  }

  // Has this coupon been redeemed as many times as it is good for? A coupon with
  // no cap is never spent.
  function couponSpent(c) {
    const cap = c && c.max_uses;
    return Number.isInteger(cap) && cap > 0 && (c.uses || 0) >= cap;
  }

  // What one PAID order earns its partner, given the terms in force at the time.
  // `order` is the stored order; the terms are passed in rather than read, so the
  // caller decides whether they come from the coupon (a new sale) or from the
  // order's own snapshot (history).
  //
  // FIXED is per COPY, so a three-copy order pays three times: one order can be
  // three games sold, and the blogger sold all three. PERCENT already scales with
  // the copies, because the money charged does.
  //
  // THE PERCENT BASE is the game money only: charged_total minus the shipping fee.
  // Postage is the courier's, and paying a cut of it loses money on every parcel.
  // It mirrors the rule the discount itself already follows — a code buys a game,
  // not postage.
  //
  // A FREE order earns nothing whatever the terms say. A 100%-off code takes no
  // money, and a fixed fee on top of it would be the shop paying to give a game
  // away — times the copy count, which is how a generous gift becomes an invoice.
  // The sale is still reported, at zero, rather than hidden.
  //
  // FREE IS MEASURED IN GAME MONEY, not in what the card took. Since a coupon
  // discounts the game and never the postage, a 100% code on a DELIVERY order
  // still charges the fee — so charged_total is 39, not 0, and a "charged > 0"
  // test would read that parcel as a sale and invoice a fixed fee per copy on an
  // order whose every shekel belongs to the courier. The same base serves both
  // terms: zero game money earns nothing, and a percent is a cut of it.
  function commissionFor(order, { type, value }) {
    const charged = Number(order && order.charged_total);
    if (!type || !Number.isFinite(charged)) return 0;
    const fee = Number((order && order.delivery_fee) || 0);
    const base = charged - (Number.isFinite(fee) ? fee : 0);
    if (base <= 0) return 0;
    if (type === 'fixed') return round2(value * sanitizeQuantity(order && order.quantity));
    return round2((base * value) / 100);
  }

  return { round2, normalizeCommission, normMaxUses, couponSpent, commissionFor };
}

// db methods: the Meta Conversions API report state.
function metaReport({
  _db,
  saveDb,
  nowIso,
  claimable,
  dropMetaCtx,
  metaRetryDelay,
  META_REPORT_MAX_AGE_MS,
  META_CTX_UNPAID_TTL_MS,
}) {
  return {
    // --- the Meta Conversions API report, as a state rather than a flag --------
    //
    // A stamp that says "claimed" is not the same as a report that happened, and
    // treating them as one loses sales silently: the claim is written before the
    // request leaves, so a deploy inside the six-second timeout would leave an
    // order marked reported that Meta never heard about, with nothing to retry it.
    //
    // So `order.meta_report` carries what actually happened:
    //   { at }                     a send is in flight (or died in flight)
    //   { at, ok: true }           Meta accepted it. Final.
    //   { at, permanent, error }   Meta refused in a way retrying cannot fix
    //                              (a bad token, a revoked pixel). Final.
    //   { error }                  the last attempt failed transiently — no `at`,
    //                              so the next caller may claim it again.
    // An in-flight claim older than META_REPORT_STALE_MS is treated as died in
    // flight, which is what makes the boot sweep (server/index.js) able to pick it
    // up without a second bookkeeping field.
    claimMetaReport(id, { save = true } = {}) {
      const c = this.getCollection(id);
      if (!c || !c.order || !c.order.paid) return false;
      if (!claimable(c.order.meta_report)) return false;
      // THE ATTEMPT COUNT SURVIVES THE CLAIM. It is the only thing that knows this
      // order has failed before, and a claim that reset it to zero would hand the
      // backoff a fresh start on every attempt — which is no backoff at all.
      const tries = Number((c.order.meta_report && c.order.meta_report.tries) || 0);
      c.order.meta_report = { at: nowIso(), ...(tries ? { tries } : {}) };
      if (save) saveDb();
      return true;
    },

    // Claim a whole BATCH under one write. The boot sweep can have fifty orders to
    // pick up, and claiming them one at a time is fifty whole-store writes back to
    // back — hundreds of milliseconds each at real order counts — twenty seconds
    // after boot, on a box that is already serving. Returns the ids actually
    // claimed, which is what the caller may then send.
    claimMetaReports(ids = []) {
      const claimed = [];
      for (const id of ids) if (this.claimMetaReport(id, { save: false })) claimed.push(id);
      if (claimed.length) saveDb();
      return claimed;
    },

    // Hand a FINAL failure back for another try.
    //
    // "The token was wrong and I fixed it" is a real recovery path, and without
    // this there is no way back from it: a permanent mark stops claimMetaReport,
    // is excluded from staleMetaReports, and nothing else clears it — the sales
    // taken in that window would be lost short of hand-editing the store.
    //
    // The cleared shape is exactly what a TRANSIENT failure leaves behind (an
    // error, no `at`, no verdict), so every existing reader picks it up with no
    // special case of its own. The device details are already gone by then, so a
    // recovered report carries the order number and the money but not the match
    // keys — the sale counts, the attribution is weaker. Pass an `id` for one
    // order, or nothing for every one of them.
    clearPermanentMetaReports({ id = '', limit = 500 } = {}) {
      const cleared = [];
      for (const c of _db.collections) {
        if (id && c.id !== id) continue;
        const r = c.order && c.order.meta_report;
        if (!r || !r.permanent) continue;
        c.order.meta_report = { error: 'cleared: ' + String(r.error || 'permanent') };
        cleared.push(c.id);
        if (cleared.length >= limit) break;
      }
      if (cleared.length) saveDb();
      return cleared;
    },

    // THE BUYER'S DEVICE DETAILS HAVE A LIFE OF THEIR OWN.
    //
    // finishMetaReport deletes them when a report ENDS, and for a long time that
    // was described as the whole story. It is not, because two very ordinary
    // orders never reach it:
    //   • the abandoned checkout — a buyer opens the card form and walks away, so
    //     no payment, no report, no deletion, ever. On any normal abandon rate
    //     these are MOST of the stored rows;
    //   • the report that failed transiently and then aged out of the seven-day
    //     sweep window — kept on purpose for a retry that will now never come.
    // Collections themselves are never purged (expiry only changes their status),
    // so "forever" means forever. This is the sweep that ends both cases.
    //
    // One write for the whole pass, and none at all when there is nothing to drop.
    sweepMetaCtx({ now = Date.now() } = {}) {
      let dropped = 0;
      for (const c of _db.collections) {
        const ctx = c.order && c.order.pelecard && c.order.pelecard.meta_ctx;
        if (!ctx) continue;
        // When we captured them. A row with no usable stamp is treated as already
        // expired: the failure mode of a missing timestamp must be deleting the
        // data, never keeping it indefinitely.
        const seen = Number(ctx.seen_at);
        const age = Number.isFinite(seen) && seen > 0 ? now - seen : Infinity;
        if (age < (c.order.paid ? META_REPORT_MAX_AGE_MS : META_CTX_UNPAID_TTL_MS)) continue;
        dropMetaCtx(c);
        dropped += 1;
      }
      if (dropped) saveDb();
      return dropped;
    },

    // How the attempt ended. ONE write, and it does two jobs: it records the
    // outcome, and on any final outcome it drops the buyer's device details, which
    // exist only to make this one report and have no business outliving it.
    finishMetaReport(id, { ok = false, permanent = false, error = '' } = {}) {
      const c = this.getCollection(id);
      if (!c || !c.order) return false;
      const at = (c.order.meta_report && c.order.meta_report.at) || nowIso();
      if (ok) c.order.meta_report = { at, ok: true };
      else if (permanent) c.order.meta_report = { at, permanent: true, error: String(error || '') };
      // Transient: no `at`, so it is claimable again — by the confirmation page's
      // fallback, or by the sweep at the next boot. The device details STAY, since
      // that retry has no other way to get them — but only until sweepMetaCtx ages
      // them out with the retry window itself.
      //
      // `tries` and `next_at` are the brake. The first retry is free, so the
      // confirmation page can still rescue a send that died in the callback; after
      // that the wait grows, which is what stops a wrong token from re-sending
      // every sale in the window on every boot and every page load.
      else {
        const tries = Number((c.order.meta_report && c.order.meta_report.tries) || 0) + 1;
        const wait = metaRetryDelay(tries);
        c.order.meta_report = {
          error: String(error || ''),
          tries,
          ...(wait ? { next_at: new Date(Date.now() + wait).toISOString() } : {}),
        };
      }
      if (ok || permanent) dropMetaCtx(c);
      saveDb();
      return true;
    },

    // WHAT THE META REPORTS ARE ACTUALLY DOING, in one pass. A retry that backs
    // off is a retry that can be quietly failing for hours, so the admin status
    // card needs to be able to say so — otherwise the one scenario this whole
    // mechanism was built for (a token that is wrong) runs invisibly.
    metaReportCounts({ now = Date.now() } = {}) {
      // `waiting` is a SUBSET of `failing`, not a category beside it: the ones
      // whose backoff has not expired yet. Reading them as separate totals turns
      // twelve broken reports into twenty-four.
      const n = {
        reported: 0,
        failing: 0,
        permanent: 0,
        in_flight: 0,
        waiting: 0,
        oldest_error: '',
      };
      let oldest = Infinity;
      for (const c of _db.collections) {
        const r = c.order && c.order.paid && c.order.meta_report;
        if (!r) continue;
        if (r.ok) n.reported += 1;
        else if (r.permanent) n.permanent += 1;
        else if (r.at && !claimable(r, now)) n.in_flight += 1;
        else {
          n.failing += 1;
          if (!claimable(r, now)) n.waiting += 1;
          // The message from the oldest failing report THAT HAS ONE: how long it
          // has been broken, and why. A report can legitimately carry an empty
          // error (a bare `{ error: '' }` written by an older path), and letting
          // one of those win would blank out the only diagnostic on the card.
          const paidAt = Date.parse(c.order.paid_at || c.created_at || '');
          if (r.error && Number.isFinite(paidAt) && paidAt < oldest) {
            oldest = paidAt;
            n.oldest_error = String(r.error);
          }
        }
      }
      return n;
    },

    // Paid orders whose report was claimed and never finished — a send that died
    // in flight. Newest first, capped, and only ones recent enough to still be
    // worth reporting: an event Meta would reject as too old helps nobody.
    staleMetaReports({ limit = 50, maxAgeMs = META_REPORT_MAX_AGE_MS, now = Date.now() } = {}) {
      return _db.collections
        .filter((c) => {
          if (!c.order || !c.order.paid) return false;
          const r = c.order.meta_report;
          // Never claimed at all is NOT stale: it is an order from before the API
          // was armed, and sweeping those would report the whole back catalogue.
          if (!r) return false;
          // Exactly what claimMetaReport will accept — including the backoff. Two
          // separate readings of "may be claimed" is how a sweep ends up handing
          // ids to a claim that refuses every one of them.
          if (!claimable(r, now)) return false;
          const paidAt = Date.parse(c.order.paid_at || c.created_at || '');
          return Number.isFinite(paidAt) && now - paidAt <= maxAgeMs;
        })
        .sort((a, b) => String(b.order.paid_at || '').localeCompare(String(a.order.paid_at || '')))
        .slice(0, limit)
        .map((c) => c.id);
    },
  };
}

// db methods: discount and partner coupons.
function coupons({
  _db,
  saveDb,
  crypto,
  uid,
  nowIso,
  todayStrIsrael,
  normCode,
  round2,
  normalizeCommission,
  normMaxUses,
  couponSpent,
}) {
  return {
    // --- Discount coupons ---------------------------------------------------
    // A coupon is a percentage-off code the admin creates and the checkout
    // applies. Shape: { id, code, discount_pct, valid_until, max_uses, active,
    // created_at, uses }. `valid_until` is a 'YYYY-MM-DD' string (inclusive) or
    // null = never expires. `uses` counts orders that used the coupon and became
    // paid, and `max_uses` is how many such orders it is good for (null = no
    // limit) — a code handed to one blogger's audience can be capped at 20 sales
    // rather than run until someone remembers to switch it off. A coupon that has
    // reached its cap stops validating; `active` stays the owner's own switch, so
    // raising the cap brings the same code back rather than needing a new one.
    //
    // A coupon becomes a PARTNER coupon — a blogger's code, which earns her money —
    // by gaining `commission_type` ('fixed' | 'percent'), `commission_value`, a
    // `partner_name` and a `report_token` (her private read-only report). Coupons
    // without commission_type are ordinary discount codes and behave exactly as
    // before; nothing here changes for them.
    //
    // 'fixed' is a flat sum PER COPY. A buyer who orders three games has sold
    // three games, and the blogger is paid for three. It is deliberately unrelated
    // to the discount — the owner agrees a number with the blogger ("30 ₪ a game")
    // and the size of the discount her audience gets is a separate lever.
    //
    // `payouts` is what has actually been handed over: [{ id, amount, date, note,
    // created_at }]. Outstanding is earned minus paid, and BOTH sides are derived
    // from the orders — there is no running total to drift out of step with them.

    // Create a coupon. Validates the code shape/uniqueness and the percentage,
    // then persists it. Returns the stored coupon, or { error } on bad input or a
    // duplicate code.
    createCoupon({
      code,
      discount_pct,
      valid_until,
      max_uses,
      partner_name,
      commission_type,
      commission_value,
    } = {}) {
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
      const cap = normMaxUses(max_uses);
      if (cap && cap.error) return { error: cap.error };
      if (_db.coupons.some((x) => x.code === c)) return { error: 'duplicate' };
      const terms = normalizeCommission({ partner_name, commission_type, commission_value });
      if (terms.error) return { error: terms.error };
      const coupon = {
        id: uid(),
        code: c,
        discount_pct,
        valid_until: until,
        max_uses: cap.value,
        active: true,
        created_at: nowIso(),
        uses: 0,
        partner_name: terms.partner_name,
        commission_type: terms.commission_type,
        commission_value: terms.commission_value,
        // Only a partner coupon gets a report link. The token is what stands
        // between the open internet and one blogger's earnings, so it is 24 random
        // bytes — never the code, which is short, uppercase and printed in public.
        report_token: terms.commission_type ? crypto.randomBytes(24).toString('hex') : null,
        payouts: [],
      };
      _db.coupons.push(coupon);
      saveDb();
      return coupon;
    },

    // Edit a coupon's PARTNER terms. The code and the discount are deliberately
    // not editable here: both are printed in the blogger's post and in her
    // audience's screenshots, and an edit would silently change what a customer
    // was promised. Deactivate and issue a new code instead.
    //
    // Changing the rate affects FUTURE sales only — every past order carries the
    // terms it was sold under (see markPaid). Raising a rate must never re-price
    // history into money the owner never agreed to.
    updateCouponPartner(id, { partner_name, commission_type, commission_value } = {}) {
      const c = this.getCouponById(id);
      if (!c) return null;
      const terms = normalizeCommission({ partner_name, commission_type, commission_value });
      if (terms.error) return { error: terms.error };
      c.partner_name = terms.partner_name;
      c.commission_type = terms.commission_type;
      c.commission_value = terms.commission_value;
      // Becoming a partner coupon mints the report link; it survives every later
      // edit, so a link already sent to a blogger keeps working.
      if (terms.commission_type && !c.report_token) {
        c.report_token = crypto.randomBytes(24).toString('hex');
      }
      saveDb();
      return c;
    },

    // Issue a NEW report link, retiring the old one — for a link that leaked, or a
    // partnership that ended. There is no way back to the previous token.
    rotateCouponToken(id) {
      const c = this.getCouponById(id);
      if (!c || !c.commission_type) return null;
      c.report_token = crypto.randomBytes(24).toString('hex');
      saveDb();
      return c;
    },

    getCouponByToken(token) {
      const t = String(token || '');
      // A blank/absent token must never match a coupon that has none.
      if (!/^[a-f0-9]{48}$/.test(t)) return null;
      return _db.coupons.find((x) => x.report_token === t) || null;
    },

    // Record money actually handed to the blogger. Append-only from the owner's
    // side; deleting one is for correcting a mistake, not for hiding a payment.
    addCouponPayout(id, { amount, date, note } = {}) {
      const c = this.getCouponById(id);
      if (!c) return null;
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) return { error: 'bad amount' };
      let d = todayStrIsrael();
      if (date != null && date !== '') {
        const str = String(date).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || Number.isNaN(Date.parse(str))) {
          return { error: 'bad date' };
        }
        d = str;
      }
      if (!Array.isArray(c.payouts)) c.payouts = [];
      const payout = {
        id: uid(),
        amount: round2(amt),
        date: d,
        note: typeof note === 'string' ? note.trim().slice(0, 200) : '',
        created_at: nowIso(),
      };
      c.payouts.push(payout);
      saveDb();
      return payout;
    },

    deleteCouponPayout(id, payoutId) {
      const c = this.getCouponById(id);
      if (!c || !Array.isArray(c.payouts)) return false;
      const before = c.payouts.length;
      c.payouts = c.payouts.filter((p) => p.id !== payoutId);
      if (c.payouts.length === before) return false;
      saveDb();
      return true;
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

    // Change (or lift) a coupon's redemption cap. The alternative to this is
    // deleting a mistyped code and minting another, which is no good once the
    // code is printed in someone's post. Setting it BELOW what is already spent is
    // allowed and simply means "no more" — the past uses stand either way.
    // Returns the coupon, null for an unknown id, { error } for a bad cap.
    setCouponMaxUses(id, max_uses) {
      const c = this.getCouponById(id);
      if (!c) return null;
      const cap = normMaxUses(max_uses);
      if (cap.error) return { error: cap.error };
      c.max_uses = cap.value;
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
      // Spent: the cap counts PAID orders (incrementCouponUses runs at markPaid),
      // so a code capped at 20 stops the 21st buyer, not the 21st person to type
      // it into the box and walk away.
      if (couponSpent(c)) return { valid: false, reason: 'used_up' };
      return { valid: true, coupon: c };
    },

    // ONE partner's earnings, DERIVED from the orders every time. Nothing is
    // stored: a running total is a second version of the truth, and the day it
    // disagrees with the orders there is no way to tell which is wrong.
    //
    // A CANCELLED order is not a sale. It is excluded here — which is also why the
    // blogger's own page can show a number the owner will actually pay, rather
    // than one that shrinks without explanation the first time an order is voided.
    //
    // Returns null for an unknown coupon or one with no partner terms.
    partnerReport(couponId) {
      const cp = this.getCouponById(couponId);
      if (!cp || !cp.commission_type) return null;
      const sales = [];
      for (const c of _db.collections) {
        const o = c.order;
        if (!o || !o.paid || c.cancelled) continue;
        if (!o.coupon || o.coupon !== cp.code) continue;
        // An order paid BEFORE the coupon gained its terms has no snapshot, and
        // must not be paid retroactively at today's rate — it was not sold as a
        // partner sale. Listed at zero so the two sides see the same history.
        const snap = o.commission || null;
        const charged = Number(o.charged_total || 0);
        // What the customer saved: the order's own pre-discount total against what
        // was actually charged. Both are stored, so this needs no arithmetic on a
        // percentage and cannot drift by a rounding.
        const saved = Math.max(0, round2(Number(o.total || 0) - charged));
        sales.push({
          order_no: c.order_no || null,
          paid_at: o.paid_at || null,
          charged_total: charged,
          customer_saved: saved,
          quantity: o.quantity || 1,
          rate: snap ? { type: snap.type, value: snap.value } : null,
          // Copies are what makes a 90 ₪ line under a 30 ₪ rate add up, so the
          // number travels with the row rather than leaving her to guess.

          amount: snap ? round2(snap.amount) : 0,
        });
      }
      sales.sort((a, b) => String(b.paid_at || '').localeCompare(String(a.paid_at || '')));
      const earned = round2(sales.reduce((t, x) => t + x.amount, 0));
      const payouts = Array.isArray(cp.payouts) ? [...cp.payouts] : [];
      payouts.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      const paid_out = round2(payouts.reduce((t, x) => t + Number(x.amount || 0), 0));
      return {
        coupon: {
          code: cp.code,
          partner_name: cp.partner_name || '',
          discount_pct: cp.discount_pct,
          commission_type: cp.commission_type,
          commission_value: cp.commission_value,
          active: !!cp.active,
        },
        sales,
        payouts,
        totals: {
          sales: sales.length,
          customer_saved: round2(sales.reduce((t, x) => t + x.customer_saved, 0)),
          earned,
          paid_out,
          // Can go NEGATIVE, and is shown that way: an overpayment is a fact the
          // owner needs to see, not one to round up to zero.
          outstanding: round2(earned - paid_out),
        },
      };
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
  };
}

// db methods: physical stock.
function stock({
  _db,
  saveDb,
  nowIso,
  sanitizeQuantity,
  INITIAL_BOARD_STOCK,
  SUPPLY_DEFAULTS,
  stockInt,
}) {
  return {
    // --- stock ------------------------------------------------------------------

    // Everything on the shelf, with the boards resolved against the designs that
    // actually exist right now.
    //
    // `designs` is [{ theme, name }] — the live theme list, passed IN rather than
    // read here, because this module knows nothing about themes.json (which lives
    // on the volume in production and is the templates module's to read).
    //
    // Seeds on FIRST SIGHT of each design: a theme with no record yet gets its
    // opening count from INITIAL_BOARD_STOCK by display name, or 0 for a design
    // that was not on the shelf when it was counted. Seeding once per theme key is
    // what makes it safe to call on every page load — a board the owner has since
    // set to 0 has a record, so it is never re-seeded back to 40.
    stockSnapshot(designs = []) {
      if (!_db.stock || typeof _db.stock !== 'object' || Array.isArray(_db.stock)) _db.stock = {};
      const st = _db.stock;
      if (!st.boards || typeof st.boards !== 'object' || Array.isArray(st.boards)) st.boards = {};
      if (!st.supplies || typeof st.supplies !== 'object' || Array.isArray(st.supplies)) {
        st.supplies = {};
      }
      let dirty = false;
      for (const d of Array.isArray(designs) ? designs : []) {
        const theme = d && d.theme;
        if (!theme) continue;
        if (!Object.prototype.hasOwnProperty.call(st.boards, theme)) {
          const seeded = INITIAL_BOARD_STOCK[String((d && d.name) || '').trim()];
          st.boards[theme] = { count: stockInt(seeded, 0) };
          dirty = true;
        }
      }
      for (const def of SUPPLY_DEFAULTS) {
        if (!Object.prototype.hasOwnProperty.call(st.supplies, def.key)) {
          st.supplies[def.key] = { count: def.count, per_order: def.per_order };
          dirty = true;
        }
      }
      if (dirty) saveDb();
      // The boards are answered in the order the designs came in, so the page shows
      // them the way every other admin screen lists designs.
      const boards = (Array.isArray(designs) ? designs : [])
        .filter((d) => d && d.theme)
        .map((d) => ({
          theme: d.theme,
          name: d.name || d.theme,
          count: stockInt(st.boards[d.theme] && st.boards[d.theme].count, 0),
        }));
      // A board with stock whose design has vanished (a template deleted off the
      // volume) is still shown — the boards are on the shelf whether or not the
      // template is still installed, and silently dropping them would look like
      // stock that evaporated.
      const known = new Set(boards.map((b) => b.theme));
      for (const [theme, rec] of Object.entries(st.boards)) {
        if (known.has(theme)) continue;
        boards.push({ theme, name: theme, count: stockInt(rec && rec.count, 0), orphan: true });
      }
      const supplies = SUPPLY_DEFAULTS.map((def) => {
        const rec = st.supplies[def.key] || {};
        return {
          key: def.key,
          label: def.label,
          count: stockInt(rec.count, 0),
          per_order: Math.max(0, stockInt(rec.per_order, 0)),
        };
      });
      return { boards, supplies };
    },

    // Admin: set one board's count by hand — a restock, or a correction after a
    // physical recount. Returns the stored number, or null for an unknown theme
    // (one with no record and not among the live designs the caller passed).
    setBoardStock(theme, count, designs = []) {
      this.stockSnapshot(designs);
      const key = String(theme || '');
      if (!key) return null;
      const known =
        Object.prototype.hasOwnProperty.call(_db.stock.boards, key) ||
        (Array.isArray(designs) && designs.some((d) => d && d.theme === key));
      if (!known) return null;
      _db.stock.boards[key] = { count: stockInt(count, 0) };
      saveDb();
      return _db.stock.boards[key].count;
    },

    // Admin: set a supply's count and/or how many of it an order uses. Either
    // field may be omitted ("restock the boxes" must not reset the per-order
    // number, and vice versa). Returns the stored record, or null for a supply
    // this build does not have.
    setSupplyStock(key, { count, per_order } = {}) {
      this.stockSnapshot();
      const k = String(key || '');
      if (!SUPPLY_DEFAULTS.some((d) => d.key === k)) return null;
      const rec = _db.stock.supplies[k];
      if (count != null) rec.count = stockInt(count, rec.count);
      if (per_order != null) rec.per_order = Math.max(0, stockInt(per_order, rec.per_order));
      saveDb();
      return { ...rec };
    },

    // Take this order's things off the shelf, or put them back.
    //
    // Called from the ready toggle. `take` is true on the way in and false on the
    // way back out, and the two have to be exact opposites — so what was taken is
    // RECORDED ON THE ORDER (order.stock_taken) and the restore reverses that
    // record rather than recomputing it. Recomputing would return the wrong board
    // if the design was edited in between, and the wrong number of boxes if the
    // owner changed `per_order` in between; both are quiet errors that only show
    // up as a shelf that does not match the screen weeks later.
    //
    // Idempotent in both directions: taking twice takes once, and putting back
    // something that was never taken does nothing.
    //
    // Never fails the caller. Marking an order ready is the step that emails the
    // customer, and a stock record must not be able to stand in the way of it.
    applyOrderStock(id, take, designs = []) {
      const c = this.getCollection(id);
      if (!c || !c.order) return null;
      const order = c.order;
      if (take && order.stock_taken) return order.stock_taken;
      if (!take && !order.stock_taken) return null;
      // A DIGITAL order ships nothing: no board, no box, no note. It can still go
      // through the print/ready pipeline (that is how the owner tracks "the file
      // went out"), so without this every PDF sale would quietly drain a shelf it
      // never touched. Checked on the way in only — an order that took nothing has
      // no record to give back, so the way out is already a no-op.
      if (take && order.version === 'pdf') return null;
      this.stockSnapshot(designs);
      const st = _db.stock;
      if (take) {
        const theme = c.theme || null;
        // COPIES. An order may be several identical decks printed from one word
        // list, and each of them is a whole game: its own board, its own box, its
        // own note. The brief said "one" because one is what an order usually is —
        // but shipping five decks with one board between them is not a rounding
        // error, it is four games that cannot be played.
        const copies = sanitizeQuantity(order.quantity);
        const supplies = {};
        for (const def of SUPPLY_DEFAULTS) {
          const n = Math.max(0, stockInt(st.supplies[def.key].per_order, 0)) * copies;
          if (n > 0) supplies[def.key] = n;
        }
        // A board for a design we hold no record of is still a board off the
        // shelf: the record is created (going negative if need be) rather than the
        // deduction being dropped, because a missing row is a bookkeeping gap and
        // the board is gone either way.
        if (theme) {
          const rec = st.boards[theme] || { count: 0 };
          rec.count = stockInt(rec.count, 0) - copies;
          st.boards[theme] = rec;
        }
        for (const [k, n] of Object.entries(supplies)) {
          st.supplies[k].count = stockInt(st.supplies[k].count, 0) - n;
        }
        order.stock_taken = { at: nowIso(), board: theme, boards: copies, supplies };
        saveDb();
        return order.stock_taken;
      }
      const taken = order.stock_taken;
      // `boards` is absent on a record written before copies were counted; one is
      // what those took, so one is what they give back.
      const backBoards = stockInt(taken.boards, 1);
      if (taken.board && st.boards[taken.board]) {
        st.boards[taken.board].count = stockInt(st.boards[taken.board].count, 0) + backBoards;
      } else if (taken.board) {
        st.boards[taken.board] = { count: backBoards };
      }
      for (const [k, n] of Object.entries(taken.supplies || {})) {
        if (st.supplies[k])
          st.supplies[k].count = stockInt(st.supplies[k].count, 0) + stockInt(n, 0);
      }
      order.stock_taken = null;
      saveDb();
      return null;
    },
  };
}

module.exports = {
  pricing,
  metaReportHelpers,
  stockHelpers,
  orderTotals,
  metaReportMigration,
  couponHelpers,
  metaReport,
  coupons,
  stock,
};
