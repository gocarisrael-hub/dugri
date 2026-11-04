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

// How long a hold may wait for its pay session to be RECORDED. pay/init takes the
// hold before awaiting the card provider and records the session only after the
// provider answers, so for those few seconds the session does not exist yet. A
// provider call that never answers is cut off long before this.
const HOLD_INIT_GRACE_MS = 5 * 60 * 1000;
// How many of one collection's windows a hold remembers (newest kept).
const MAX_HOLD_TOKENS = 20;

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

    // The pool's rows as the money is counted: each a copy carrying
    // `order_cancelled` — a code used on an order the owner has since cancelled
    // (or deleted) is not billed to the reseller (rules.poolSummary, usageCsv).
    // Read live from the collection, so un-cancelling an order whose code is
    // still on it bills it again. A RESTORED code is no longer on its order at all
    // (order_id cleared); un-cancelling that order goes through
    // reclaimRestoredVoucher, which puts the code back or refuses.
    billingRows(poolId) {
      const now = Date.now();
      return this.vouchersInPool(poolId).map((r) => {
        if (!r.used_at) {
          return {
            ...r,
            order_cancelled: false,
            held_live: !r.voided_at && this.holdIsLive(r, now),
          };
        }
        const c = r.order_id ? this.getCollection(r.order_id) : null;
        return { ...r, order_cancelled: !c || !!c.cancelled };
      });
    },

    // Every pool with its numbers, newest first.
    listVoucherPools() {
      return [...pools()]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map((p) => ({ ...p, summary: rules.poolSummary(p, this.billingRows(p.id)) }));
    },

    // A pool's codes, newest first, narrowed by a substring of the code (in any
    // spacing) and/or a status ('unused' | 'used' | 'void').
    listVouchers(poolId, { q, status } = {}) {
      const needle = rules.compactCode(q);
      return this.vouchersInPool(poolId)
        .filter((r) => !needle || r.key.includes(needle))
        .filter((r) =>
          !status
            ? true
            : status === 'held'
              ? !r.used_at && !r.voided_at && this.holdIsLive(r)
              : rules.statusOf(r) === status
        )
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
    // 'held' is a code sitting in ANOTHER collection's card window (a delivery
    // or an extra copy being paid for) that can still settle — see holdIsLive.
    // Refused so two buyers cannot both pay the difference on one code.
    validateVoucher(code, { collectionId = null, now = Date.now() } = {}) {
      const r = this.getVoucherByCode(code);
      if (!r) return { valid: false, reason: 'not_found' };
      if (r.used_at) return { valid: false, reason: 'used' };
      if (r.voided_at) return { valid: false, reason: 'void' };
      if (r.held && r.held.collection_id !== collectionId && this.holdIsLive(r, now)) {
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

    // CAN THE WINDOW HOLDING THIS CODE STILL SETTLE? A hold is TIED TO ITS PAY
    // SESSIONS, not to a clock, because nothing on the settle path has an age
    // limit: PeleCard's callback finds its session by token however late it
    // comes, and the Tranzila sweep settles a window the buyer closed long ago.
    // Closing the window (pay/cancel) proves nothing either — on Tranzila the
    // buyer closes it BEFORE the sweep settles the charge. So the hold lives
    // while any of its sessions could still turn into a paid order:
    //
    //   dead  the holding collection is gone, or has no order;
    //   dead  that order is PAID — by this code (then it is used) or by another
    //         window, after which no session of it can settle again;
    //   live  a session it took is on that order, resolved or not (an
    //         abandoned session can still settle);
    //   live  a session it took is not recorded YET — pay/init is awaiting the
    //         card provider — for HOLD_INIT_GRACE_MS;
    //   dead  otherwise: a session evicted from the order can never be found
    //         by a settle again.
    //
    // A hold on a window nobody will ever pay stays until the owner releases it
    // (releaseVoucherHold, on the partners page). Only another collection is
    // blocked by it — the holding collection may always use its own code.
    holdIsLive(row, now = Date.now()) {
      const h = row && row.held;
      if (!h || !Array.isArray(h.tokens) || !h.tokens.length) return false;
      const c = this.getCollection(h.collection_id);
      if (!c || !c.order || c.order.paid) return false;
      const sessions = (c.order.pelecard && c.order.pelecard.sessions) || [];
      return h.tokens.some(
        (t) =>
          sessions.some((s) => s && s.token === t.token) ||
          now - Date.parse(t.at) < HOLD_INIT_GRACE_MS
      );
    },

    // Reserve a code for one card window of this collection (`token`, the pay
    // session's own token). Called by pay/init in the SAME synchronous step as
    // its validation — before the await on the card provider — so two checkouts
    // cannot both pass validation and then both open a window. A collection may
    // hold its own code from several windows; another collection only takes it
    // over once every window of the old hold is dead. Returns false when the
    // code is not free for this collection. Saves.
    holdVoucher(code, collectionId, token, now = Date.now()) {
      const v = this.validateVoucher(code, { collectionId, now });
      if (!v.valid) return false;
      const r = this.getVoucherByCode(code);
      const entry = { token, at: new Date(now).toISOString() };
      if (r.held && r.held.collection_id === collectionId && Array.isArray(r.held.tokens)) {
        // Newest MAX_HOLD_TOKENS windows only. A buyer retrying a payment opens a
        // handful; the cap is so a script re-opening windows cannot grow a row
        // without end. The session store keeps at most MAX_SESSIONS per order
        // anyway, so an older token past this would be a weak claim regardless.
        r.held.tokens = [...r.held.tokens, entry].slice(-MAX_HOLD_TOKENS);
      } else {
        r.held = { collection_id: collectionId, tokens: [entry] };
      }
      saveDb();
      return true;
    },

    // Undo ONE window's part of a hold — the one pay/init just took, when the
    // card provider refused to open that window. Every other window of the hold,
    // which may still be settling, keeps it. Returns whether anything changed.
    dropVoucherHold(code, collectionId, token) {
      const r = this.getVoucherByCode(code);
      const h = r && r.held;
      if (!h || h.collection_id !== collectionId || !Array.isArray(h.tokens)) return false;
      const before = h.tokens.length;
      h.tokens = h.tokens.filter((t) => t.token !== token);
      if (h.tokens.length === before) return false;
      if (!h.tokens.length) r.held = null;
      saveDb();
      return true;
    },

    // Admin: let go of a hold whose window will never be paid (the buyer gave up
    // and started a new order elsewhere). The owner's call, because only she can
    // know the window is dead: a settle has no age limit. Returns the row, null
    // for an unknown id, or { error: 'not_held' }.
    releaseVoucherHold(id) {
      const r = this.getVoucherById(id);
      if (!r) return null;
      if (!r.held || r.used_at) return { error: 'not_held' };
      r.held = null;
      saveDb();
      return r;
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
    // needs a window that settles after its hold was released by the owner); if it happens anyway, the second
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

    // Admin: RESTORE a code spent on an order that was cancelled (or deleted) —
    // the buyer refunded, the game never made. The code is unused again and can
    // be handed out or redeemed; the use is kept in `restored` so the history of
    // who spent it, and when, survives. Refused while that order still stands:
    // un-spending a live order's code would let one code buy two games.
    // Returns the row, null for an unknown id, or { error } — 'not_used' |
    // 'order_active'.
    restoreVoucher(id) {
      const r = this.getVoucherById(id);
      if (!r) return null;
      if (!r.used_at) return { error: 'not_used' };
      const c = r.order_id ? this.getCollection(r.order_id) : null;
      if (c && !c.cancelled) return { error: 'order_active' };
      if (!Array.isArray(r.restored)) r.restored = [];
      r.restored.push({ used_at: r.used_at, order_id: r.order_id, restored_at: nowIso() });
      // The order remembers its code went back, so un-cancelling it later cannot
      // quietly leave a live paid order whose code nobody bills (and someone
      // else may by then have redeemed): see reclaimRestoredVoucher.
      if (c && c.order) c.order.voucher_restored = { code: r.code, at: nowIso() };
      r.used_at = null;
      r.order_id = null;
      r.held = null;
      saveDb();
      return r;
    },

    // UN-CANCELLING AN ORDER WHOSE CODE WAS RESTORED. The order becomes a live,
    // paid sale again, so its code must be spent on it again — or the
    // un-cancel refused, because one code may not pay for two games.
    //
    //   null                         nothing to do (no restored code)
    //   { reclaimed: code }          the code was still unused: spent on this
    //                                order again (billed again), saves
    //   { error: 'voucher_reused' }  someone else has spent it since (or it was
    //                                voided): the caller refuses the un-cancel
    reclaimRestoredVoucher(collectionId) {
      const c = this.getCollection(collectionId);
      const mark = c && c.order && c.order.voucher_restored;
      if (!mark) return null;
      const r = this.getVoucherByCode(mark.code);
      if (!r || r.used_at || r.voided_at) return { error: 'voucher_reused', code: mark.code };
      r.used_at = nowIso();
      r.order_id = collectionId;
      r.held = null;
      delete c.order.voucher_restored;
      saveDb();
      return { reclaimed: r.code };
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
