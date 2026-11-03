// Agent A (Commerce): the "add delivery" payment link, for an order already
// closed for production.
//
// THE CASE. A pickup customer whose collection is closed (the deck is in
// production) asks to have it sent instead. The buyer's own "add delivery" card
// on collect.html is deliberately gone by then (db.shippingUpgrade refuses with
// 'closed'), so the owner makes the offer herself: she creates a link from the
// orders table, at a price she can change, and sends it by hand. The customer
// pays on a public page found by the link's own token — never the ?k= managing
// link, which every friend of the buyer also holds.
//
// IT IS THE SAME PURCHASE AS THE BUYER'S OWN UPGRADE, recorded in the same place:
// `order.shipping`, with its own pay sessions, settled by the SAME branch of
// settleVerifiedPayment (kind 'shipping') and converged onto a delivery order by
// the SAME db.markShippingPaid. The only additions are `order.shipping.link`
// (who made the offer, the token, the amount she set) and the phone the customer
// gives for the courier. So the Tranzila sweep, the PeleCard callback, the
// one-charge-one-purchase guard (isTransactionUsed), the receipts table in the
// admin (js/payment-refs.js) and the revenue ledgers need no new reading: an
// order converted by a link IS an order whose delivery was bought afterwards.
//
// ONE LIVE LINK PER ORDER. Creating a new one replaces the record, so the old
// token stops resolving at once. The in-flight pay sessions are carried over (as
// startShippingUpgrade does): a charge already made in an old window still finds
// its session and is verified against that window's own amount, rather than
// becoming money taken with nothing to match it.
//
// Nothing is required at the top level, like server/stores/commerce.js: the
// tests reload db.js by purging require.cache, and a cached copy of this file
// must never hold on to a previous load's store.

// A typo guard on the owner's own number, not a price rule: no delivery we sell
// costs anywhere near this, and a stray extra zero should be refused, not sent.
const LINK_MAX_AMOUNT = 1000;

// The shape every token we mint has (base64url of 18 random bytes = 24 chars).
// Anything else is refused before the store is scanned.
const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

// An Israeli phone as people type it, to its local form ("0521234567"), or ''.
// Spaces, dashes, dots and brackets are ignored; +972 / 972 / 00972 become 0.
// The same shapes site/js/configurator.js normalizeIlPhone accepts, which is
// what the customer's page validates with before it ever sends.
function normalizePhone(v) {
  let s = String(v == null ? '' : v).replace(/[\s().\-/[\]]/g, '');
  s = s.replace(/^(?:\+|00)/, '');
  if (s.startsWith('972')) s = '0' + s.slice(3).replace(/^0+/, '');
  else if (/^5\d{8}$/.test(s)) s = '0' + s;
  return /^0\d{8,9}$/.test(s) ? s : '';
}

function deliveryLinkBlock({
  _db,
  saveDb,
  nowIso,
  crypto,
  effectiveStatus,
  sanitizeAddress,
  deliveryFee,
  boxesFor,
}) {
  // The link as the admin and the customer page see it. The token is included
  // for the admin only (the route decides); the record itself never leaves.
  function summary(sh) {
    if (!sh || !sh.link) return null;
    return {
      token: sh.link.token,
      amount: sh.link.amount,
      created_at: sh.link.created_at,
      cancelled_at: sh.link.cancelled_at || null,
      paid: !!sh.paid,
      paid_at: sh.paid_at || null,
      charged_total: sh.charged_total != null ? sh.charged_total : null,
      hfd_auto: sh.link.hfd_auto || null,
    };
  }

  // Mark every unresolved window on a shipping record abandoned, the way
  // db.abandonPaySessions does for an order's own: `resolved` means only "no
  // longer in flight", and a session is still found by its token.
  function abandonSessions(holder) {
    if (!holder || !Array.isArray(holder.sessions)) return;
    for (const s of holder.sessions) {
      if (s && !s.resolved) {
        s.resolved = true;
        s.abandoned_at = nowIso();
      }
    }
  }

  return {
    // Which link a window was opened for, stamped on its session at pay time,
    // so a charge that settles later can be told apart from one made on a link
    // the owner has since replaced.
    tagDeliveryLinkSession(id, paramToken, linkToken) {
      const c = this.getCollection(id);
      const sh = c && c.order && c.order.shipping;
      const list =
        sh && sh.pelecard && Array.isArray(sh.pelecard.sessions) ? sh.pelecard.sessions : [];
      const s = list.find((x) => x.token === paramToken);
      if (!s) return false;
      s.link_token = linkToken;
      saveDb();
      return true;
    },

    // Should a paid link book the courier by itself? Only when the money came
    // through the link that is LIVE: not one she cancelled, not one she replaced
    // with another, and not on a collection she cancelled. In every other case
    // the charge still settles (the money was taken), but the decision to send a
    // van is hers again. Returns null to book, or the reason not to. Read BEFORE
    // markShippingPaid.
    deliveryLinkAutoBook(c, session) {
      const link = c && c.order && c.order.shipping && c.order.shipping.link;
      if (!link) return 'no link';
      if (c.cancelled) return 'collection cancelled';
      if (link.cancelled_at) return 'link cancelled';
      if (!session || session.link_token !== link.token) return 'link replaced';
      return null;
    },

    // Can the owner make this offer, and what does it cost by default? ONE place,
    // so the admin dialog, the create route and the customer's charge cannot
    // disagree. Null for an unknown collection.
    //
    // Eligible: a PAID order for a printed deck, closed for production (closed or
    // expired; a cancelled one is not being made), not already a delivery order.
    // While the collection is still OPEN the buyer has her own card for this on
    // collect.html, so the owner's link is not offered then.
    deliveryLinkState(id) {
      const c = this.getCollection(id);
      if (!c) return null;
      const order = c.order || null;
      const sh = (order && order.shipping) || null;
      const boxes = order ? boxesFor(order.quantity || 1, order.one_box) : 1;
      // The default the dialog fills in: what checkout would charge for these
      // boxes today (settings pricing). Hers to change.
      const defaultFee = Math.max(0, Number(deliveryFee()) || 0) * boxes;
      const status = effectiveStatus(c);
      let reason = null;
      if (!order || !order.paid) reason = 'no paid order';
      else if (status === 'cancelled') reason = 'cancelled';
      else if (sh && sh.paid) reason = 'paid';
      else if (order.version === 'delivery') reason = 'already delivery';
      else if (order.version === 'pdf') reason = 'digital';
      // A bespoke order is priced and delivered by arrangement, and
      // markShippingPaid would overwrite its 'custom' version with 'delivery'.
      else if (order.version === 'custom') reason = 'custom';
      else if (status === 'open') reason = 'open';
      return {
        eligible: !reason,
        reason,
        default_fee: defaultFee,
        boxes,
        max_amount: LINK_MAX_AMOUNT,
        link: summary(sh),
      };
    },

    // Create (or REPLACE) the order's link at the amount the owner set. Returns
    // the link summary, or { error }.
    createDeliveryLink(id, { amount } = {}) {
      const c = this.getCollection(id);
      if (!c) return { error: 'not found' };
      const state = this.deliveryLinkState(id);
      if (!state.eligible) return { error: state.reason };
      const n = Number(amount);
      if (!Number.isInteger(n) || n < 1 || n > LINK_MAX_AMOUNT) return { error: 'invalid amount' };
      const prevSh = c.order.shipping && !c.order.shipping.paid ? c.order.shipping : null;
      const prev = prevSh ? prevSh.pelecard : null;
      // The windows opened for the record being replaced are no longer in flight
      // as far as we are concerned. A provider window cannot be closed from here,
      // so a charge made in one still SETTLES (it is found by its token and
      // verified against its own amount) — but it no longer books a courier on
      // its own (see the settle path, deliveryLinkAutoBook).
      abandonSessions(prev);
      c.order.shipping = {
        // `fee` is what the charge is made and verified for (shipping/init's own
        // field), so the amount she set IS the fee: shippingPriceKey, the
        // Tranzila match and markShippingPaid's convergence all read it.
        fee: n,
        // Kept across a replace: a charge still landing from the old window
        // converges the order with the address its customer gave there (the
        // next payment on the new link overwrites it anyway).
        address: (prevSh && prevSh.address) || null,
        requested_at: null,
        paid: false,
        paid_at: null,
        pelecard: prev || null,
        link: {
          token: crypto.randomBytes(18).toString('base64url'),
          amount: n,
          created_at: nowIso(),
          cancelled_at: null,
        },
      };
      saveDb();
      return summary(c.order.shipping);
    },

    // Stand an unpaid link down. The record stays (marked cancelled), so the
    // admin can still say a link existed. Returns the summary, or { error }.
    cancelDeliveryLink(id) {
      const c = this.getCollection(id);
      if (!c) return { error: 'not found' };
      const sh = c.order && c.order.shipping;
      if (!sh || !sh.link) return { error: 'no link' };
      if (sh.paid) return { error: 'paid' };
      if (!sh.link.cancelled_at) {
        sh.link.cancelled_at = nowIso();
        abandonSessions(sh.pelecard);
        saveDb();
      }
      return summary(sh);
    },

    // The collection a public token belongs to, or null. A cancelled or replaced
    // link resolves to nothing; a PAID one still resolves, so the page can show
    // the confirmation on a second visit.
    findDeliveryLink(token) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      const c = _db.collections.find((x) => {
        const l = x.order && x.order.shipping && x.order.shipping.link;
        return !!(l && l.token === token);
      });
      if (!c) return null;
      const sh = c.order.shipping;
      if (sh.link.cancelled_at && !sh.paid) return null;
      return { collection: c, shipping: sh };
    },

    // What the customer's page may show. Deliberately small: the order number,
    // whom the game is for, the amount, and — once paid — where it is going.
    // No email, no owner phone, no tokens.
    deliveryLinkPublic(token) {
      const m = this.findDeliveryLink(token);
      if (!m) return null;
      const c = m.collection;
      const sh = m.shipping;
      const status = effectiveStatus(c);
      return {
        order_ref: c.order_no || c.id,
        honoree: (c.custom_title || c.honoree_name || '').trim(),
        amount: sh.fee,
        boxes: boxesFor(c.order.quantity || 1, c.order.one_box),
        paid: !!sh.paid,
        paid_at: sh.paid_at || null,
        // Still payable: not paid, and the order is still one the link was made
        // for (it may have been cancelled, or made a delivery order by hand).
        payable:
          !sh.paid &&
          status !== 'cancelled' &&
          c.order.version !== 'delivery' &&
          c.order.version !== 'pdf' &&
          c.order.version !== 'custom',
        address: sh.paid ? sh.address : null,
      };
    },

    // The customer pressed pay: stage the address + phone on the link's record,
    // re-checking everything (the link may have been cancelled, replaced or paid
    // since the page rendered). Returns { collection, shipping } or { error }.
    startDeliveryLinkPayment(token, { address, phone } = {}) {
      const m = this.findDeliveryLink(token);
      if (!m) return { error: 'not found' };
      const c = m.collection;
      const sh = m.shipping;
      if (sh.paid) return { error: 'already paid' };
      const pub = this.deliveryLinkPublic(token);
      if (!pub.payable) return { error: 'unavailable' };
      const addr = sanitizeAddress(address);
      if (!addr) return { error: 'address required' };
      const tel = normalizePhone(typeof phone === 'string' ? phone : '');
      // A mobile, as the wizard asks for one (configurator.isValidIlMobile): the
      // courier texts this number on the day.
      if (!tel || !/^05\d{8}$/.test(tel)) return { error: 'phone required' };
      // The phone rides INSIDE the address: it is the courier's contact for this
      // parcel (server/hfd.js prefers it over the buyer's own), and it travels
      // onto order.address with the rest when the charge lands.
      sh.address = { ...addr, phone: tel };
      sh.requested_at = nowIso();
      saveDb();
      return { collection: c, shipping: sh };
    },

    // The outcome of the automatic courier booking after a link was paid, kept
    // on the link so the admin can read it next to the order.
    recordDeliveryLinkHfd(id, outcome) {
      const c = this.getCollection(id);
      const sh = c && c.order && c.order.shipping;
      if (!sh || !sh.link) return false;
      sh.link.hfd_auto = { at: nowIso(), ...outcome };
      saveDb();
      return true;
    },
  };
}

module.exports = { deliveryLinkBlock, normalizePhone, LINK_MAX_AMOUNT };
