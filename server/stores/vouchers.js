// Agent A (Commerce): partner voucher pools — the store.
//
// A pool is one reseller's batch of codes (Hi Tech Zone, prefix HTZ, N codes, a
// price per used code). A voucher is one code: unused, used by exactly one paid
// order, or voided by the owner (a code the reseller lost). server/vouchers.js
// has the pure rules; this is the part that reads and writes `_db`.
//
// Spread into the `db` object (server/db.js) like the coupon blocks, so `this`
// is `db` and there is still ONE in-memory store written by ONE saveDb. Requires
// nothing at the top level, for the same reason as server/stores/commerce.js:
// the tests purge require.cache to reload db.js.
//
// LOOKUPS ARE LINEAR SCANS, as with the friend coupons: a reseller batch is
// hundreds to a few thousand rows, and a scan of those is microseconds. Every row
// carries `key` (its compact form) so the scan compares strings, not regexes.

function vouchersBlock({ _db, saveDb, uid, nowIso, rules }) {
  const pools = () => {
    if (!Array.isArray(_db.voucher_pools)) _db.voucher_pools = [];
    return _db.voucher_pools;
  };
  const rows = () => {
    if (!Array.isArray(_db.vouchers)) _db.vouchers = [];
    return _db.vouchers;
  };

  return {
    getVoucherPool(id) {
      return pools().find((p) => p.id === id) || null;
    },

    getVoucherById(id) {
      return rows().find((r) => r.id === id) || null;
    },

    // By what the buyer typed, in any spacing or case.
    getVoucherByCode(code) {
      const k = rules.compactCode(code);
      if (!k) return null;
      return rows().find((r) => r.key === k) || null;
    },

    // Is this code (in compact form) held by ANYTHING in the shop: an owner
    // coupon, a friend coupon or a voucher? The three share one checkout box and
    // validateCoupon tries them in that order, so a voucher that collided with an
    // owner coupon would be shadowed by it — the buyer would get the owner's
    // percentage instead of a free game, and the reseller would never be billed.
    anyCodeTaken(code) {
      const k = rules.compactCode(code);
      if (!k) return false;
      if ((_db.coupons || []).some((c) => rules.compactCode(c.code) === k)) return true;
      if ((_db.friend_coupons || []).some((c) => rules.compactCode(c.code) === k)) return true;
      return rows().some((r) => r.key === k);
    },

    // Does what the buyer typed LOOK like one of the pools' codes — a known
    // prefix and enough characters after it? The miss limiter counts only these,
    // so an owner fumbling her own coupon code is never locked out by it.
    looksLikeVoucher(code) {
      const k = rules.compactCode(code);
      return pools().some((p) => k.startsWith(p.prefix) && k.length >= p.prefix.length + 8);
    },

    // Mint `count` fresh codes into a pool. Does not save: the callers do, once.
    _mintVouchers(pool, count) {
      const batch = uid();
      const at = nowIso();
      const made = [];
      for (let i = 0; i < count; i++) {
        const code = rules.makeVoucherCode(pool.prefix, { taken: (c) => this.anyCodeTaken(c) });
        const row = {
          id: uid(),
          pool_id: pool.id,
          code,
          key: rules.compactCode(code),
          batch,
          created_at: at,
          used_at: null,
          order_id: null,
          voided_at: null,
          void_reason: null,
          // An open card window that carries this code (see holdVoucher).
          held: null,
        };
        rows().push(row);
        made.push(row);
      }
      return made;
    },

    // Create a pool and its first codes. Returns { pool, codes } or { error }:
    // 'bad partner_name' | 'bad prefix' | 'duplicate prefix' | 'bad count' |
    // 'bad price_per_use'.
    //
    // One prefix per pool: the prefix is what the owner reads first on an order
    // row or a support message to know whose code it was.
    createVoucherPool({ partner_name, prefix, count, price_per_use } = {}) {
      const name = rules.normPartnerName(partner_name);
      if (name.error) return { error: name.error };
      const p = rules.normPrefix(prefix);
      if (!rules.isValidPrefix(p)) return { error: 'bad prefix' };
      if (pools().some((x) => x.prefix === p)) return { error: 'duplicate prefix' };
      const n = rules.normCount(count);
      if (n.error) return { error: n.error };
      const price = rules.normPrice(price_per_use);
      if (price.error) return { error: price.error };
      const pool = {
        id: uid(),
        partner_name: name.value,
        prefix: p,
        price_per_use: price.value,
        created_at: nowIso(),
      };
      pools().push(pool);
      const codes = this._mintVouchers(pool, n.value);
      saveDb();
      return { pool, codes };
    },

    // Add more codes to an existing pool. Returns { codes }, null for an unknown
    // pool, or { error: 'bad count' }.
    addVouchers(poolId, count) {
      const pool = this.getVoucherPool(poolId);
      if (!pool) return null;
      const n = rules.normCount(count);
      if (n.error) return { error: n.error };
      const codes = this._mintVouchers(pool, n.value);
      saveDb();
      return { codes };
    },

    // Edit what a pool is called and what each used code is worth. The prefix is
    // not editable: it is printed on every code already handed out.
    updateVoucherPool(poolId, { partner_name, price_per_use } = {}) {
      const pool = this.getVoucherPool(poolId);
      if (!pool) return null;
      if (partner_name !== undefined) {
        const name = rules.normPartnerName(partner_name);
        if (name.error) return { error: name.error };
        pool.partner_name = name.value;
      }
      if (price_per_use !== undefined) {
        const price = rules.normPrice(price_per_use);
        if (price.error) return { error: price.error };
        pool.price_per_use = price.value;
      }
      saveDb();
      return pool;
    },

    vouchersInPool(poolId) {
      return rows().filter((r) => r.pool_id === poolId);
    },

    // Every pool with its numbers, newest first.
    listVoucherPools() {
      return [...pools()]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map((p) => ({ ...p, summary: rules.poolSummary(p, this.vouchersInPool(p.id)) }));
    },

    // A pool's codes, newest first, narrowed by a substring of the code (in any
    // spacing) and/or a status ('unused' | 'used' | 'void').
    listVouchers(poolId, { q, status } = {}) {
      const needle = rules.compactCode(q);
      return this.vouchersInPool(poolId)
        .filter((r) => !needle || r.key.includes(needle))
        .filter((r) => !status || rules.statusOf(r) === status)
        .sort(
          (a, b) =>
            String(b.used_at || b.created_at).localeCompare(String(a.used_at || a.created_at)) ||
            a.code.localeCompare(b.code)
        );
    },

    // Is this a live voucher for this collection? Same answer shape as
    // validateCoupon, so the checkout and pay/init take it through the one door:
    // { valid: true, coupon: { code, discount_pct: 0, voucher: true, pool_id,
    // partner_name } } or { valid: false, reason } with reason 'not_found' |
    // 'used' | 'void' | 'held'.
    //
    // 'held' is a code sitting in ANOTHER collection's open card window (a
    // delivery or an extra copy being paid for). Refused so two buyers cannot
    // both pay the difference on one code; the hold runs out with the window.
    validateVoucher(code, { collectionId = null, now = Date.now() } = {}) {
      const r = this.getVoucherByCode(code);
      if (!r) return { valid: false, reason: 'not_found' };
      if (r.used_at) return { valid: false, reason: 'used' };
      if (r.voided_at) return { valid: false, reason: 'void' };
      if (r.held && r.held.collection_id !== collectionId && Date.parse(r.held.until) > now) {
        return { valid: false, reason: 'held' };
      }
      const pool = this.getVoucherPool(r.pool_id);
      return {
        valid: true,
        coupon: {
          code: r.code,
          discount_pct: 0,
          voucher: true,
          pool_id: r.pool_id,
          partner_name: pool ? pool.partner_name : '',
        },
      };
    },

    // Reserve a code for this collection's card window, until `untilMs`. Called
    // by pay/init in the SAME synchronous step as its validation — before the
    // await on the card provider — so two checkouts cannot both pass validation
    // and then both open a window. Returns false when the code is not free for
    // this collection. Saves.
    holdVoucher(code, collectionId, untilMs, now = Date.now()) {
      const v = this.validateVoucher(code, { collectionId, now });
      if (!v.valid) return false;
      const r = this.getVoucherByCode(code);
      r.held = { collection_id: collectionId, until: new Date(untilMs).toISOString() };
      saveDb();
      return true;
    },

    // Let go of every hold this collection has (its pay window closed, or the
    // card provider refused to open one). Returns how many were released.
    releaseVoucherHolds(collectionId) {
      let n = 0;
      for (const r of rows()) {
        if (r.held && r.held.collection_id === collectionId && !r.used_at) {
          r.held = null;
          n++;
        }
      }
      if (n) saveDb();
      return n;
    },

    // SPEND A VOUCHER ON A PAID ORDER. Called ONLY from markPaid, inside the same
    // synchronous step that sets order.paid and before ITS saveDb — so the order
    // turning paid and the code turning used are one write, and a payment that
    // fails or is abandoned (and so never reaches markPaid) leaves it unused.
    //
    // THE DOUBLE-USE GUARD, the same one the friend coupons use. The store lives
    // in one Node process, so this check-then-set cannot interleave with another:
    // two orders settling on one code are settled one after the other and only
    // the FIRST finds used_at empty. The hold above makes a second one rare (it
    // needs a window that outlived its hold); if it happens anyway, the second
    // order's money has already moved, so it stays paid — but the code is not
    // spent twice, the reseller is billed once, and it comes back as 'conflict'
    // for markPaid to put on the order.
    //
    // A VOIDED code that reaches here was voided while its window was open. The
    // buyer was quoted and charged against it, so it is honoured and recorded as
    // used — voiding is for a lost code, not a way to un-sell a game.
    //
    // Returns 'consumed', 'conflict', 'already' (this same order, a replayed
    // settle) or null (not a voucher). Does not save: markPaid does.
    consumeVoucher(code, orderId) {
      const r = this.getVoucherByCode(code);
      if (!r) return null;
      if (r.used_at) return r.order_id === orderId ? 'already' : 'conflict';
      r.used_at = nowIso();
      r.order_id = orderId;
      r.held = null;
      return 'consumed';
    },

    // Admin: void an unused code (the reseller lost it, or it leaked). Returns the
    // row, null for an unknown id, or { error: 'already_used' }.
    voidVoucher(id, reason) {
      const r = this.getVoucherById(id);
      if (!r) return null;
      if (r.used_at) return { error: 'already_used' };
      if (!r.voided_at) {
        r.voided_at = nowIso();
        r.void_reason = String(reason == null ? '' : reason)
          .trim()
          .slice(0, 200);
      }
      saveDb();
      return r;
    },
  };
}

module.exports = { vouchersBlock };
