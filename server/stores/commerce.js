// Agent A (Commerce): the coupons and the physical stock, moved out of
// server/db.js (slice 3 of splitting the monolith; see docs/agent-partition.md).
// A VERBATIM move of those two blocks of the `db` object.
//
// TWO factories, because the block was never contiguous: Agent B's design-access
// codes sit between A's coupons and A's stock. db.js spreads each back at its own
// position, which keeps the `db` key order unchanged — every caller keeps calling
// db.createCoupon(...) / db.stockSnapshot(...), `this` is still `db`, and there is
// still ONE in-memory store written by ONE saveDb. Nothing is required at the top
// level, for the same reason as server/stores/platform.js: the tests purge
// require.cache to reload db.js, and a cached copy of this file must never hold on
// to a previous load's store.
//
// NOT here, deliberately: the ORDER and PAYMENT methods, the pay sessions, and the
// pricing/order-total helpers. Pricing helpers are shared with setOrder/markPaid,
// which stay in db.js, so they stay there too and are passed in where needed.

function couponsBlock({
  _db,
  saveDb,
  crypto,
  normCode,
  couponSpent,
  normalizeCommission,
  normMaxUses,
  round2,
  uid,
  nowIso,
  todayStrIsrael,
}) {
  return {
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
      // A partner voucher typed without its dashes is a valid owner-code shape,
      // and validateCoupon tries owner coupons FIRST — so an owner coupon equal to
      // a voucher's compact form would shadow that voucher at the checkout.
      if (this.getVoucherByCode && this.getVoucherByCode(c)) return { error: 'duplicate' };
      // …and the same for a personal code (a friend's, or one claimed from a box
      // QR) typed without its dash: unique across EVERY kind of code, compared in
      // compact form (anyCodeTaken, server/stores/vouchers.js).
      if (this.anyCodeTaken && this.anyCodeTaken(c)) return { error: 'duplicate' };
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
    // { valid:false, reason } with reason in 'not_found'|'inactive'|'expired'|
    // 'used_up', or — for a friend code — 'used', or — for a partner voucher —
    // 'used' | 'void' | 'held'.
    //
    // After the friend coupons come the PARTNER VOUCHERS (server/stores/
    // vouchers.js): a reseller's single-use code worth one pickup copy. Last in
    // line, and createCoupon / the voucher minting both refuse a code another
    // kind already holds, so the order never decides which one a buyer gets.
    // `opts.collectionId` is the checkout asking: a voucher held in ANOTHER
    // collection's open card window is refused, its own is not.
    //
    // A code that is not an owner coupon is then looked up among the FRIEND
    // coupons (friendCouponsBlock below) — owner coupons first, always — so the
    // checkout, its preview and pay/init take a friend code through this one
    // door, with no second path to keep in step. Friend codes carry a dash and
    // owner codes cannot, so the order only matters in principle.
    validateCoupon(code, opts = {}) {
      const c = this.getCouponByCode(code);
      if (!c) {
        const friend = this.validateFriendCoupon(code, Date.now(), opts);
        if (friend.valid || friend.reason !== 'not_found') return friend;
        return this.validateVoucher(code, opts);
      }
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
          // Copies are what makes a 90 ₪ line under a 30 ₪ rate add up, so the
          // number travels with the row rather than leaving her to guess.
          quantity: o.quantity || 1,
          rate: snap ? { type: snap.type, value: snap.value } : null,
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

// The friend coupons: personal single-use codes a friend gets for adding words
// (server/friend-coupons.js has the rules and the why). A third factory rather
// than more methods in couponsBlock, because nothing here edits an owner coupon
// and the two lists must never be confused for one another.
//
// LOOKUPS ARE LINEAR SCANS over `_db.friend_coupons`, on purpose. At this
// shop's scale (hundreds of rows, a few thousand at most) a scan is
// microseconds, and an index would be a second copy of the truth to keep in step
// with every write, every store import and every reload. If the list ever runs
// to six figures, add a Map keyed by code and email here — nowhere else reads
// the array.
function friendCouponsBlock({ _db, saveDb, uid, nowIso, normCode, rules }) {
  const rows = () => {
    if (!Array.isArray(_db.friend_coupons)) _db.friend_coupons = [];
    return _db.friend_coupons;
  };
  return {
    // A FRIEND's row for this email. Box-QR rows are not counted: "one coupon
    // per email" is the friend offer's rule, and the code an order earned on the
    // box QR must not use up the code you would get for adding words.
    getFriendCouponByEmail(email) {
      const e = rules.normEmail(email);
      if (!e) return null;
      return rows().find((r) => r.email === e && rules.sourceOf(r) === 'friend') || null;
    },

    // --- The box QR (a second source of these codes; server/friend-coupons.js) --

    // The code already claimed for this order, or null. THE one-per-order rule is
    // this lookup: keyed by the ORDER (the collection), not by the phone or the
    // email, so a second claim for the same order always finds the same row.
    getQrCouponForCollection(collectionId) {
      if (!collectionId) return null;
      return (
        rows().find((r) => rules.sourceOf(r) === 'qr' && r.collection_id === collectionId) || null
      );
    },

    // The orders of this phone number that EARN a code (rules.orderEarnsQrCode:
    // paid, not cancelled, produced), OLDEST first. The number is compared in
    // normalised form on both sides, so it matches however either was typed. A
    // scan over the collections, like every lookup in this block (see the note
    // above it).
    qrOrdersForPhone(phone) {
      const want = rules.normPhone(phone);
      if (!want) return [];
      return (_db.collections || [])
        .filter((c) => c && rules.normPhone(c.owner_phone) === want && rules.orderEarnsQrCode(c))
        .sort((x, y) => String(x.created_at || '').localeCompare(String(y.created_at || '')));
    },

    // Claim ONE code for this phone number: for its OLDEST produced order that has
    // no code yet. One code per produced order, so a number with two produced
    // orders can claim twice in all. Synchronous from the lookup to the push, so
    // two claims racing for one order cannot both mint.
    //
    // Returns { error: 'bad_phone' } | { found: false } (no produced order for
    // this number) | { all_claimed: true } (every one already has its code) |
    // { coupon, collection, created: true, remaining } (remaining: how many more
    // this number can still claim).
    //
    // The row's email is the ORDER's address (the code is mailed there), or ''
    // when the order has none. percent / expiryMonths come from the live box_qr
    // settings and are COPIED onto the row, like the friend offer: a later change
    // re-prices nothing that has already been issued.
    claimQrCouponForPhone({ phone, marketingConsent, percent, expiryMonths } = {}) {
      if (!rules.normPhone(phone)) return { error: 'bad_phone' };
      const orders = this.qrOrdersForPhone(phone);
      if (!orders.length) return { found: false };
      const open = orders.filter((c) => !this.getQrCouponForCollection(c.id));
      if (!open.length) return { all_claimed: true };
      const c = open[0];
      const e = rules.isValidEmail(c.owner_email) ? rules.normEmail(c.owner_email) : '';
      const createdAt = nowIso();
      const consent = marketingConsent === true && !!e;
      const row = {
        id: uid(),
        source: 'qr',
        email: e,
        // NOT read from the address, unlike a friend's code: this one is shown
        // on screen to whoever typed the number, and a prefix taken from the
        // email would spell out the very part maskEmail hides. Every QR code is
        // DUGRI<percent>-XXXX.
        code: rules.makeCode('', percent, { taken: (code) => this._personalCodeTaken(code) }),
        // The order that earned it — the order this code can NOT be spent on
        // (validateFriendCoupon, reason 'own_order').
        collection_id: c.id,
        discount_percent: percent,
        marketing_consent: consent,
        consent_at: consent ? createdAt : null,
        created_at: createdAt,
        expires_at: rules.expiresAtForMonths(createdAt, expiryMonths),
        used_at: null,
        order_id: null,
        email_sent_at: null,
        email_failed_at: null,
        email_sends: 0,
      };
      rows().push(row);
      saveDb();
      return { coupon: row, collection: c, created: true, remaining: open.length - 1 };
    },

    // Is `code` held by ANY code in the shop — owner coupon, personal code or
    // partner voucher? anyCodeTaken (the vouchers block) compares compact forms
    // across all three; without that block loaded, the personal codes alone.
    _personalCodeTaken(code) {
      if (this.anyCodeTaken) return this.anyCodeTaken(code);
      return !!this.getFriendCouponByCode(code);
    },

    getFriendCouponByCode(code) {
      const c = normCode(code);
      if (!c) return null;
      return rows().find((r) => r.code === c) || null;
    },

    getFriendCouponById(id) {
      return rows().find((r) => r.id === id) || null;
    },

    // Issue a coupon for this email, or hand back the one it already has.
    //
    // ONE COUPON PER EMAIL, EVER: a second request — from another party, a week
    // later, with the box ticked this time — returns the SAME row untouched
    // (created: false), and the caller resends that code. Consent is not
    // upgraded on a repeat: the row records what was agreed when it was made,
    // and a marketing list built from a later, unrelated click is not consent.
    //
    // `percent` and `expiryDays` are passed in (the route reads them from the
    // live settings) and COPIED onto the row, so a later change to the setting
    // never re-prices a code already in someone's inbox.
    //
    // Returns { coupon, created } or { error } — 'bad_email', 'no_collection'.
    issueFriendCoupon({ email, collectionId, marketingConsent, percent, expiryDays } = {}) {
      if (!rules.isValidEmail(email)) return { error: 'bad_email' };
      if (!collectionId || !this.getCollection(collectionId)) return { error: 'no_collection' };
      const e = rules.normEmail(email);
      const existing = this.getFriendCouponByEmail(e);
      if (existing) return { coupon: existing, created: false };
      const createdAt = nowIso();
      const consent = marketingConsent === true;
      const row = {
        id: uid(),
        email: e,
        code: rules.makeCode(e, percent, { taken: (code) => this._personalCodeTaken(code) }),
        collection_id: collectionId,
        discount_percent: percent,
        // Separate from getting the coupon, unticked by default, and only ever
        // true when the box was ticked (a strict === true: "true", 1 and "on" are
        // not consent). consent_at is when it was given, null when it was not.
        marketing_consent: consent,
        consent_at: consent ? createdAt : null,
        created_at: createdAt,
        expires_at: rules.expiresAtFor(createdAt, expiryDays),
        used_at: null,
        order_id: null,
        // The email trail, so a failed send is visible and retryable from the
        // admin ("שליחה חוזרת" is the retry).
        email_sent_at: null,
        email_failed_at: null,
        email_sends: 0,
      };
      rows().push(row);
      saveDb();
      return { coupon: row, created: true };
    },

    // What happened to the last attempt to email this row's code.
    recordFriendCouponEmail(id, ok) {
      const r = this.getFriendCouponById(id);
      if (!r) return null;
      if (ok) {
        r.email_sent_at = nowIso();
        r.email_failed_at = null;
        r.email_sends = (r.email_sends || 0) + 1;
      } else {
        r.email_failed_at = nowIso();
      }
      saveDb();
      return r;
    },

    // Is this a live friend code? Same answer shape as validateCoupon, so the
    // checkout and pay/init treat it exactly like an owner coupon:
    // { valid: true, coupon: { code, discount_pct, friend: true } } or
    // { valid: false, reason } with reason 'not_found' | 'used' | 'expired' |
    // 'own_order'.
    //
    // 'own_order': a code claimed from the box QR is for the NEXT order, so it is
    // refused on the order that earned it (`opts.collectionId` is the
    // checkout asking; every caller of validateCoupon passes it).
    validateFriendCoupon(code, now = Date.now(), opts = {}) {
      const r = this.getFriendCouponByCode(code);
      if (!r) return { valid: false, reason: 'not_found' };
      if (r.used_at) return { valid: false, reason: 'used' };
      if (!(Date.parse(r.expires_at) > now)) return { valid: false, reason: 'expired' };
      const source = rules.sourceOf(r);
      if (source === 'qr' && opts && opts.collectionId && opts.collectionId === r.collection_id) {
        return { valid: false, reason: 'own_order' };
      }
      return {
        valid: true,
        coupon: { code: r.code, discount_pct: r.discount_percent, friend: true, source },
      };
    },

    // Spend a friend code on a paid order. Called ONLY from markPaid, inside the
    // same synchronous step that sets order.paid and before ITS saveDb — so the
    // order turning paid and the code turning used are one write, and a failed or
    // abandoned payment (which never reaches markPaid) leaves the code untouched.
    //
    // THE DOUBLE-USE GUARD. The JSON store runs in one Node process, so this
    // check-then-set cannot interleave with another one: two buyers who both
    // opened a payment window with the same code are settled one after the other,
    // and only the FIRST finds used_at empty. The second has already been charged
    // the discounted price by then (the provider settled it before telling us),
    // so it is not refused — the money moved — but it does NOT consume the code
    // again, and it comes back as 'conflict' for the caller to put on record.
    //
    // Returns 'consumed', 'conflict', 'already' (this same order, a replayed
    // settle) or null (not a friend code). Does not save: markPaid does.
    consumeFriendCoupon(code, orderId) {
      const r = this.getFriendCouponByCode(code);
      if (!r) return null;
      if (r.used_at) return r.order_id === orderId ? 'already' : 'conflict';
      r.used_at = nowIso();
      r.order_id = orderId;
      return 'consumed';
    },

    // Admin: mark a code used by hand — a customer support fix (she paid by bank
    // transfer with it, say). No order is attached; `used_manually` says why the
    // order column is empty. Returns the row, null for an unknown id, or
    // { error: 'already_used' }.
    markFriendCouponUsed(id) {
      const r = this.getFriendCouponById(id);
      if (!r) return null;
      if (r.used_at) return { error: 'already_used' };
      r.used_at = nowIso();
      r.order_id = null;
      r.used_manually = true;
      saveDb();
      return r;
    },

    // Every row, newest first, optionally narrowed by a case-insensitive
    // substring of the email or the code.
    // `source` is 'friend' (the default: the friend section of the admin) or
    // 'qr' (the box-QR section).
    listFriendCoupons({ q, source = 'friend' } = {}) {
      const needle = String(q == null ? '' : q)
        .trim()
        .toLowerCase();
      return rows()
        .filter((r) => rules.sourceOf(r) === source)
        .filter((r) => !needle || r.email.includes(needle) || r.code.toLowerCase().includes(needle))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },

    friendCouponSummary(source = 'friend') {
      return rules.summarize(rows(), _db.collections, source);
    },
  };
}

function stockBlock({
  _db,
  saveDb,
  stockInt,
  sanitizeQuantity,
  nowIso,
  SUPPLY_DEFAULTS,
  INITIAL_BOARD_STOCK,
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

// The owner's entries on the revenue page (site/admin-revenue.html), keyed by
// Tranzila transaction index: how many copies a charge typed straight into the
// terminal was (B2B — no site order says), and whether a charge is left out of the
// totals (a test). Absent from every store written before it existed.
function revenueBlock({ _db, saveDb, nowIso }) {
  const entries = () => {
    if (!_db.revenue_charges || typeof _db.revenue_charges !== 'object') _db.revenue_charges = {};
    return _db.revenue_charges;
  };
  return {
    revenueOverrides() {
      return entries();
    },
    // `override` is already validated (server/revenue.js cleanOverride). A null
    // value clears that field; an entry left with nothing in it is removed.
    setRevenueOverride(index, override) {
      const all = entries();
      const cur = { ...(all[index] || {}) };
      for (const [k, v] of Object.entries(override)) {
        if (v === null) delete cur[k];
        else cur[k] = v;
      }
      delete cur.updated_at;
      if (Object.keys(cur).length) all[index] = { ...cur, updated_at: nowIso() };
      else delete all[index];
      saveDb();
      return all[index] || null;
    },
    // The collections the revenue table is built from, read as they are.
    revenueCollections() {
      return _db.collections;
    },
  };
}

module.exports = { couponsBlock, friendCouponsBlock, stockBlock, revenueBlock };
