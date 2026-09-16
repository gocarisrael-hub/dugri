// Agent D (Platform & Comms): the notification hooks, the WhatsApp bot machinery
// and the reminder schedulers, moved out of server/index.js.
//
// Slice 1b of splitting the monolith (see docs/agent-partition.md, "Splitting the
// monolith"). Everything below is a VERBATIM move; only the glue is new.
//
// A factory rather than route registrars, because none of this is routes: it is
// the machinery the routes and the payment path call. index.js builds it once, at
// the spot the first moved block occupied, and calls the returned functions
// exactly as it called the inline ones. Whatever index.js, the domain route
// modules or the tests still need comes back in the returned object.
//
// It requires NOTHING at the top level and holds no module-level state — the node
// built-ins included, which are passed in like every other dependency. The unit
// tests reload the app by purging require.cache for a fixed list of server modules
// (db, settings, wa-state, whatsapp, notify, index) that does NOT include this
// file, so a cached copy is handed to each freshly loaded app: it must carry
// nothing from the previous load.
//
// __dirname is still server/, so the paths inside resolveProductImagePath are
// unchanged by the move.

module.exports = function platformHooks({
  path,
  fs,
  pathToFileURL,
  db,
  notify,
  whatsapp,
  waState,
  settings,
  reminders,
  designImages,
  paymentBaseUrl,
  ADMIN_KEY,
}) {
  // Fire the owner + buyer "order paid" emails for a collection that just
  // transitioned to paid. Shared by BOTH paid transitions — the PeleCard callback
  // and the free (100%-coupon) path — so they send identical, consistent
  // notifications. `amountCharged` is what the customer ACTUALLY paid (0 for a
  // fully-free order, the discounted amount for a partial coupon); the emails show
  // that rather than the pre-coupon package price. Fire-and-forget: the payment
  // must succeed even if a send fails. Called via onOrderPaid, which guards it with
  // notify.isConfigured() so the word-count work is skipped when email is dormant.
  // Resolve the template/product photo URL for a paid collection's chosen design,
  // for the buyer confirmation email. Prefers the owner's uploaded photo
  // (design-images 'store', else 'front' override), else the shipped static
  // store.webp — matched to the design by the order's stable `theme` key (or the
  // Hebrew design name as a fallback). Returns an absolute URL under `base`, or null
  // when nothing resolves. Fail-soft: any error -> null (the email just omits the
  // image). The design catalog is the ESM site/js/designs.js, dynamically imported
  // (and Node-cached) exactly as /api/admin/designs does.
  // The SITE-RELATIVE path ("/assets/designs/<id>/store.webp" or an owner-uploaded
  // "/content-uploads/<hash>.webp") of the product photo for a collection's chosen
  // design, or null when nothing resolves. Split out from resolveProductImageUrl so
  // the browser (payment confirmation page) can use a relative path while the email
  // builders — which need a fully-qualified src — prepend the public origin.
  async function resolveProductImagePath(collection) {
    if (!collection) return null;
    try {
      const mod = await import(
        pathToFileURL(path.join(__dirname, '..', 'site', 'js', 'designs.js'))
      );
      const catalog = mod.DESIGNS || [];
      const theme = collection.theme || null;
      const designName = collection.design || null;
      const d = catalog.find(
        (x) => (theme && x.theme === theme) || (designName && x.name === designName)
      );
      if (!d) return null;
      // Owner override (a validated /content-uploads/<hash> path) wins over the
      // shipped static photo.
      const override = designImages.get(d.id, 'store') || designImages.get(d.id, 'front');
      if (override) return override;
      // Static fallback — only when the file actually exists on disk, so the email
      // never embeds a broken <img> (it would then just show the alt text).
      const rel = 'assets/designs/' + d.id + '/store.webp';
      if (!fs.existsSync(path.join(__dirname, '..', 'site', rel))) return null;
      return '/' + rel;
    } catch {
      return null;
    }
  }

  // The same photo as an ABSOLUTE url for the email builders (an <img> in an inbox
  // can't resolve a site-relative src). Null without a public origin to build on.
  async function resolveProductImageUrl(collection, base) {
    if (!base) return null;
    const rel = await resolveProductImagePath(collection);
    return rel ? base + rel : null;
  }

  // Send the owner + buyer "order received" emails. Fired at ORDER CREATION, so
  // there is no charged amount yet — the emails show the order's package price
  // (order.total), and the free/coupon charge display is a payment concern that no
  // longer appears here. `base` is the normalized public origin.
  async function sendOrderNotifications(collectionId, base) {
    const c = db.getCollection(collectionId);
    if (!c) return;
    const enriched = { ...c, count: db.listWords(collectionId).length };
    // One-click admin orders panel link for the OWNER emails (goes to NOTIFY_TO
    // only). Includes the admin key by design — the owner chose convenience, and
    // the mail never reaches the buyer. The secret is built HERE and passed in;
    // server/notify.js never sees ADMIN_KEY.
    const adminLink =
      base && ADMIN_KEY ? base + '/admin.html?key=' + encodeURIComponent(ADMIN_KEY) : null;
    const ownerOptions = { adminLink };
    // Fire the OWNER emails IMMEDIATELY (synchronously) — they carry no product
    // image, so they must NOT wait on the async image resolution below.
    notify.sendOrderPaid(enriched, base, ownerOptions).catch(() => {});
    // A bespoke "custom" order (no template) needs hand-design — fire an EXTRA
    // Dugri-only alert so it stands out from the normal order emails.
    if (c.order && c.order.version === 'custom') {
      notify.sendCustomOrderAlert(enriched, base, ownerOptions).catch(() => {});
    }
    // The BUYER confirmation embeds the template product photo, which needs an async
    // catalog lookup — resolve it, then send. Skips gracefully if no buyer email.
    const productImageUrl = await resolveProductImageUrl(c, base);
    notify.sendBuyerConfirmation(enriched, base, { adminLink, productImageUrl }).catch(() => {});
  }

  // Everything that must happen when an order is first CREATED — the owner captures
  // the order and starts collecting words immediately, BEFORE/without a completed
  // card payment. Idempotent via db.markOrderNotified: only the first order creation
  // per collection notifies, so re-setting the version or re-opening the pay modal
  // never re-sends or re-opens a group. The two effects are INDEPENDENTLY gated
  // (email on notify.isConfigured(), the WhatsApp group on whatsapp.isConfigured())
  // and fully fire-and-forget, so neither can block or break the order/payment flow.
  // Fire the one-time "new order" side effects for a collection: the owner + buyer
  // emails and the WhatsApp word-collection group. Fires the moment a customer
  // STARTS — a collection is created (honoree + contact + design) — so word
  // collection begins immediately, before/without payment (most starts never reach
  // the pay step). Idempotent per collection via db.markOrderNotified, so the later
  // order/pay step is a no-op. Works with or without an order yet: order details
  // (version/price) are simply omitted from the email until the buyer picks one.
  // Both effects are independently gated (email on notify.isConfigured(), the group
  // on whatsapp.isConfigured()) and fully fire-and-forget.
  function fireStartNotifications(collectionId, base) {
    const c = db.getCollection(collectionId);
    if (!c) return;
    if (!db.markOrderNotified(collectionId)) return; // already notified — no-op
    if (notify.isConfigured()) sendOrderNotifications(collectionId, base).catch(() => {});
    if (whatsapp.isConfigured()) {
      openWhatsappGroup(c, base).catch((e) => {
        console.warn('[whatsapp] group open failed:', e && e.message ? e.message : e);
      });
    }
  }

  // Fired at the order-creation points (pay/init, POST /order, admin custom). Now a
  // thin wrapper over fireStartNotifications — the collection was almost always
  // already notified at creation, so this is usually a no-op; it stays as a safety
  // net for an order placed on a collection created before this behavior (or via a
  // path that skipped the start notification).
  function onOrderCreated(collectionId, base) {
    fireStartNotifications(collectionId, base);
  }

  // Send the owner + buyer PAYMENT receipts for a collection that just went paid.
  // The counterpart to sendOrderNotifications (which fires at order CREATION): this
  // one is about the money actually landing, so it shows `amountCharged` — what was
  // charged AFTER any coupon — rather than the package's list price. The buyer's
  // copy carries the product photo and the add-words CTA, so it needs the same async
  // catalog lookup the confirmation does; the owner's copy is fired first and does
  // not wait on it. `base` is the normalized public origin.
  async function sendPaidNotifications(collectionId, base, amountCharged) {
    const c = db.getCollection(collectionId);
    if (!c) return;
    const enriched = { ...c, count: db.listWords(collectionId).length };
    // One-click admin orders panel link — OWNER copy only. Built here (never inside
    // server/notify.js) so the mail module never sees ADMIN_KEY, and never passed to
    // the buyer's copy.
    const adminLink =
      base && ADMIN_KEY ? base + '/admin.html?key=' + encodeURIComponent(ADMIN_KEY) : null;
    // Both callers pass a real charge, but a non-finite value is tolerated: it's
    // omitted so the emails fall back to the order's own total rather than
    // rendering a broken amount.
    const charged = Number.isFinite(amountCharged) ? { amountCharged } : {};
    notify.sendPaymentReceipt(enriched, base, { adminLink, ...charged }).catch(() => {});
    const productImageUrl = await resolveProductImageUrl(c, base);
    notify.sendBuyerReceipt(enriched, base, { productImageUrl, ...charged }).catch(() => {});
  }

  // Everything that must happen when a payment actually COMPLETES. Called from BOTH
  // unpaid->paid transitions — the verified PeleCard callback and the free
  // (100%-coupon) path — each of which guards the transition, so this never fires
  // twice for one order. There is no third caller by design: nothing marks an order
  // paid by hand, so a receipt always follows real money. Order creation has its own
  // notifications (onOrderCreated); this is purely the receipt pair. Gated on
  // notify.isConfigured() so the word-count/image work is skipped when email is
  // dormant, and fire-and-forget: a failed send must never fail the payment.
  function onOrderPaid(collectionId, base, amountCharged) {
    if (!notify.isConfigured()) return;
    sendPaidNotifications(collectionId, base, amountCharged).catch(() => {});
  }

  // A PAID order just became a DELIVERY order, because the buyer bought shipping
  // after the fact. The owner now has a parcel to send that she did not have this
  // morning, and an address she has never seen.
  //
  // Deliberately a SYSTEM ALERT and not a new customer-facing email template. The
  // buyer needs no letter: she paid on screen, saw it succeed, and the collection
  // page tells her the game is being shipped. The person who has to DO something is
  // the owner — and an alert reaches her through the operational channel that is
  // already there, rather than adding a template, a settings key and an on/off
  // toggle to a mail catalog that is not this change's to grow.
  //
  // Fire-and-forget, like every other notification on the payment path: a failed
  // send must never turn a successful charge into a failed callback.
  function onShippingAdded(collectionId, base, amountCharged) {
    const c = db.getCollection(collectionId);
    if (!c || !c.order) return;
    const addr = notify.formatAddress(c.order.address);
    const lines = [
      'הזמנה: ' + db.orderRef(c),
      'בעל/ת השמחה: ' + (c.honoree_name || '—'),
      'הלקוח/ה הוסיפ/ה משלוח עד הבית אחרי התשלום, ושילמ/ה ' +
        (Number.isFinite(amountCharged) ? amountCharged : c.order.delivery_fee) +
        ' ₪ נוספים.',
      addr ? 'כתובת למשלוח: ' + addr : 'כתובת למשלוח: —',
      base && ADMIN_KEY
        ? 'לוח ההזמנות: ' + base + '/admin.html?key=' + encodeURIComponent(ADMIN_KEY)
        : '',
    ].filter(Boolean);
    notify.sendSystemAlert('נוסף משלוח להזמנה קיימת', lines).catch(() => {});
  }

  // =========================================================================
  // WhatsApp bot (Phase B) — inbound webhook, paid-order group creation, and the
  // nudge scheduler. EVERYTHING below is gated on whatsapp.isConfigured(): with the
  // WHAPI_* / WHATSAPP_ENABLED env unset the module is inert (no fetch, no state),
  // so merging this changes nothing in production until the owner arms the bot.
  // Every outgoing message text comes from the owner-editable trigger catalog in
  // settings.js (via whatsapp.buildTriggerMessage) — a disabled trigger is silent.
  // =========================================================================

  // The buyer's in-group "finish the list" command. Editable via env; a distinct
  // short phrase so ordinary group chatter never closes a list by accident. Matched
  // case-insensitively against the trimmed message text.
  const WA_CLOSE_COMMAND = (process.env.WHAPI_CLOSE_COMMAND || 'סיום').trim();
  // The bot's OWN WhatsApp id (optional). Recorded as an initial member at group
  // creation so the bot never greets itself as a joining friend.
  const WHAPI_BOT_WA = process.env.WHAPI_BOT_WA || '';
  // The owner's OWN WhatsApp number (optional). Used as the escalation channel that
  // survives an email-dormant deployment: when an operational alert can't be emailed
  // (Resend unconfigured), it's DM'd to this number instead. A phone or a wa id.
  const WHAPI_OWNER_WA = process.env.WHAPI_OWNER_WA || '';

  // Reduce a WhatsApp id / phone to its bare international digits for comparison
  // ("972521234567@s.whatsapp.net" -> "972521234567"). Strips the "@…" chat-suffix,
  // the ":<device>" multi-device JID suffix ("972…:12@s.whatsapp.net"), and every
  // non-digit, so ids captured in different shapes still compare equal. Without the
  // ":device" strip a multi-device sender's id would carry the device number as
  // extra trailing digits and never match the buyer/initial-member ids.
  function waIdDigits(x) {
    return String(x == null ? '' : x)
      .split('@')[0]
      .split(':')[0]
      .replace(/[^\d]/g, '');
  }

  // Convert an Israeli mobile number to a WhatsApp id (bare international digits,
  // e.g. "052-123-4567" / "+972 52 123 4567" / "00972521234567" -> "972521234567").
  // Returns '' when it can't produce a plausible IL mobile, so the caller simply
  // skips the bot for that order. Normalizes robustly to the 972 international form:
  //   • strip a leading "00" international dialing prefix (00972… -> 972…) so it is
  //     NOT mistaken for a local "0" and double-prefixed into "972972…";
  //   • an already-972-prefixed number is kept (dropping a redundant local 0 after
  //     the code);
  //   • a local "0XXXXXXXXX" becomes "972XXXXXXXXX";
  //   • a bare national number gets the 972 country code.
  // The result must be a plausible IL MOBILE — 972 + a 9-digit national part that
  // starts with 5 — otherwise it's rejected (soft-fail) rather than returned as a
  // malformed / doubled-code id.
  function ilPhoneToWaId(phone) {
    let s = waIdDigits(phone);
    if (!s) return '';
    if (s.startsWith('00')) s = s.slice(2); // drop the 00 international prefix first
    if (s.startsWith('972')) s = '972' + s.slice(3).replace(/^0+/, '');
    else if (s.startsWith('0')) s = '972' + s.replace(/^0+/, '');
    else s = '972' + s;
    // Plausible IL mobile only: 972 + "5" + 8 more digits (12 total). Anything else
    // (landline, junk, a doubled code) soft-fails to '' so we never emit a bad id.
    if (!/^9725\d{8}$/.test(s)) return '';
    return s;
  }

  // The interpolation values shared by every group-scoped trigger: the honoree's
  // name and the collect link. That link is the MANAGING one now — the owner token
  // and all — because the product has stopped keeping two: the buyer pastes the
  // same URL into the group herself the moment she shares it, so a bot posting a
  // token-free variant only meant the group held two links with different powers
  // and no way to tell them apart. What it costs (anyone in the group can delete a
  // word or close the collection) is the owner's decision; see friendsUrl() in
  // site/collect.html. `base` is the normalized public origin.
  function waGroupValues(collection, base) {
    const honoree = (collection && collection.honoree_name) || 'בעל/ת השמחה';
    const link =
      base && collection && collection.id && collection.owner_token
        ? base + '/collect.html?c=' + collection.id + '&k=' + collection.owner_token
        : '';
    return { honoree, link };
  }

  // Send ONE trigger's message to a chat, if that trigger is enabled. Text comes
  // from the owner-editable catalog via whatsapp.buildTriggerMessage (a disabled or
  // unknown trigger yields no text and sends nothing). Fail-soft: a Whapi send
  // failure never throws. Returns { ok, messageId } — ok is true only when a message
  // was actually sent; messageId (when present) lets the caller pin it.
  async function sendWaTrigger(to, triggerId, values) {
    const msg = whatsapp.buildTriggerMessage(triggerId, values);
    if (!msg || !msg.enabled || !msg.text) return { ok: false, messageId: null };
    const r = await whatsapp.sendMessage(to, msg.text);
    return { ok: !!(r && r.ok), messageId: (r && r.messageId) || null };
  }

  // Did the buyer actually land in the freshly-created group? WhatsApp may silently
  // refuse to add a number for privacy. Whapi's real POST /groups success response
  // is typically { group_id, invite_code } with NO participants array, so absence of
  // participant info must NOT be read as failure — doing so would DM/escalate on
  // EVERY order. The rule: the buyer is ADDED whenever the group was created,
  // UNLESS the response EXPLICITLY lists the buyer in a failed / not-added set. Only
  // a POSITIVE failure signal returns false (→ invite DM + escalation); a response
  // silent about participants means "assume added" (don't spam). The failed-field
  // key variants (failed_participants / not_added / failed) cover Whapi's documented
  // shapes.
  function participantIds(list) {
    return (Array.isArray(list) ? list : [])
      .map((p) => (typeof p === 'string' ? p : (p && (p.id || p.wa_id)) || ''))
      .map(waIdDigits)
      .filter(Boolean);
  }
  function buyerLandedInGroup(created, buyerWa) {
    const data = (created && created.data) || {};
    const want = waIdDigits(buyerWa);
    if (!want) return true; // no buyer id to check — group exists, don't spam
    // A POSITIVE failure signal (buyer explicitly in a failed/not-added set) is the
    // ONLY thing that means "not added". Anything else = assume added.
    const failed = participantIds(data.failed_participants || data.not_added || data.failed);
    return !failed.includes(want);
  }

  // The owner's own WhatsApp id for escalations, derived from WHAPI_OWNER_WA (a
  // phone or a raw wa id). '' when unset.
  function ownerWaId() {
    if (!WHAPI_OWNER_WA) return '';
    return ilPhoneToWaId(WHAPI_OWNER_WA) || waIdDigits(WHAPI_OWNER_WA);
  }

  // Escalate an operational alert to the OWNER over WhatsApp — a DM to the owner's
  // own number. This is the escalation channel that survives an email-dormant
  // deployment: the owner has WhatsApp even when Resend is unconfigured, so a paid
  // order whose buyer couldn't be added still reaches a human. Fail-soft: NEVER
  // throws. When no owner WA number is configured we can't DM, so we emit a
  // prominent server-side ERROR log instead, so the lost escalation is at least
  // diagnosable rather than silent. Returns true only when the DM actually sent.
  async function alertOwnerViaWhatsApp(subject, lines) {
    const text = [String(subject == null ? '' : subject)]
      .concat(Array.isArray(lines) ? lines : [lines])
      .map((l) => String(l == null ? '' : l))
      .join('\n');
    try {
      const to = ownerWaId();
      if (!to) {
        console.error(
          '[whatsapp] OWNER ESCALATION NOT DELIVERED — no WHAPI_OWNER_WA configured ' +
            'and email is unavailable. Set WHAPI_OWNER_WA to receive these. Alert: ' +
            text.replace(/\n/g, ' | ')
        );
        return false;
      }
      // exempt: the owner's own number is not a stranger reachout, and this is
      // exactly the message that must still get out when the breaker has tripped —
      // gating it would silence the alert that explains the gate.
      const r = await whatsapp.sendMessage(to, text, { exempt: true });
      if (!r || !r.ok) {
        console.error(
          '[whatsapp] OWNER ESCALATION DM FAILED — intervene manually. Alert: ' +
            text.replace(/\n/g, ' | ')
        );
        return false;
      }
      return true;
    } catch (e) {
      console.error('[whatsapp] alertOwnerViaWhatsApp threw:', e && e.message ? e.message : e);
      return false;
    }
  }

  // Paid-order hook: open a WhatsApp word-collection group for the buyer. Idempotent
  // (never opens a second group for a collection — even under two concurrent paid
  // events, thanks to the synchronous wa-state reservation below) and fully
  // fail-soft. Steps:
  //   1. reserve the collection synchronously (before any await) so a concurrent
  //      second call backs off — closing the check-then-create TOCTOU;
  //   2. derive the buyer's WhatsApp id from the collection's owner_phone;
  //   3. createGroup(subject, [buyer]); on success link the group ↔ collection with
  //      the buyer + bot recorded as initial members (so they're never greeted as
  //      joining friends), and announce with the `group_opened` trigger;
  //   4. fetch + persist the group's join link. In the default invite_link mode
  //      that link IS the delivery: it appears as a WhatsApp button on the buyer's
  //      own order page, which they tap to join. NOTHING is sent to the buyer here
  //      — no DM, no email — so the bot contacts nobody and there is no reachout to
  //      be restricted for. In auto_add mode the link is the privacy-block fallback.
  //   5. escalate to the owner — by email (notify.sendSystemAlert), falling back to
  //      a WhatsApp DM to the owner's own number — only when the buyer has been left
  //      with no way in at all.
  async function openWhatsappGroup(collection, base) {
    if (!collection || !collection.id) return;
    if (waState.groupForCollection(collection.id)) return; // already have a group — no-op
    // Reserve the intent to create BEFORE the first await. Two concurrent paid
    // events for one collection would otherwise both pass the check above and both
    // createGroup; the loser here backs off, so exactly one group is ever created.
    if (!waState.reserveCollection(collection.id)) return;
    try {
      const mode = whatsapp.groupMode();
      const buyerWa = ilPhoneToWaId(collection.owner_phone);
      // auto_add needs a usable buyer number to add. invite_link does NOT — the
      // buyer taps the join link on their own order page, so a collection with an
      // unusable phone still gets its group.
      if (mode === 'auto_add' && !buyerWa) return;
      const honoree = collection.honoree_name || '';
      const subject = 'דוגרי · מילים על ' + (honoree || 'בעל/ת השמחה');

      // The whole point of invite_link mode: an EMPTY group contacts nobody, so
      // WhatsApp has no reachout to restrict. Only auto_add puts a number in the
      // create call, and whatsapp.createGroup gates exactly that on the breaker.
      const participants = mode === 'auto_add' && buyerWa ? [buyerWa] : [];
      const created = await whatsapp.createGroup(subject, participants);
      if (created && created.blocked) {
        // The reachout breaker (or the daily cap) held this back. That is the guard
        // working as designed, but it is NOT silent: orders keep arriving while no
        // groups open, so the owner has to hear about it.
        console.error(
          '[whatsapp] group creation BLOCKED by the reachout guard for collection ' +
            collection.id +
            ' (' +
            created.reason +
            '). Switch wa.group_mode to invite_link, or clear the breaker in admin ' +
            'once the number is confirmed healthy.'
        );
        const alertSubject = 'וואטסאפ — פתיחת קבוצות נחסמה';
        const alertLines = [
          created.reason === 'tripped'
            ? 'זוהתה הגבלה של וואטסאפ על המספר, ולכן הפסקנו לפתוח קבוצות חדשות כדי לא להחמיר.'
            : 'הגענו למכסה היומית של פתיחת קבוצות, ולכן ההזמנה הזו לא קיבלה קבוצה.',
          'מספר הזמנה: ' + collection.id,
          'אפשר לעבור למצב "קישור הצטרפות" בעמוד הניהול — הוא לא פונה לאף אחד ולכן לא נחסם.',
        ];
        if (!(await notify.sendSystemAlert(alertSubject, alertLines))) {
          await alertOwnerViaWhatsApp(alertSubject, alertLines);
        }
        return;
      }
      if (!created || !created.ok || !created.groupId) {
        // A `skipped` result is the intentional dormant path (bot off by design) —
        // stay silent. But a REAL failure (dropped Whapi channel, HTTP error, or a
        // 200 with no group id) otherwise fails here silently and the owner just sees
        // "orders but no groups", so log WHY: reason + collection id only — never the
        // buyer's phone or the honoree name.
        if (created && !created.skipped) {
          const why = created.error || 'http ' + (created.status || '?') + ' / no groupId';
          // Append Whapi's own error text. "whapi http 429" alone doesn't say WHY,
          // and the difference is everything: a 429 whose details read
          // "account_reachout_restricted" means WhatsApp has restricted the bot
          // NUMBER from contacting people (appeal in WhatsApp Business — no env or
          // code change helps), while a plain rate limit just means wait. Whapi
          // nests it as { error: { code, message, details } }, and `details` is the
          // machine-readable part worth logging; `message` is the generic
          // "too many requests". Only these fields, never the whole payload — a
          // group response can echo participant phone numbers.
          const d = created.data || {};
          const err = d && typeof d.error === 'object' && d.error ? d.error : null;
          const detail = err ? err.details || err.message || '' : d.message || d.error || '';
          const detailText = detail
            ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
            : '';
          console.warn(
            '[whatsapp] createGroup failed for collection ' +
              collection.id +
              ': ' +
              why +
              detailText
          );
        }
        return;
      }
      const groupId = created.groupId;

      const botId = WHAPI_BOT_WA ? waIdDigits(WHAPI_BOT_WA) : '';
      const initialMembers = botId ? [buyerWa, botId] : [buyerWa];
      waState.linkGroup(groupId, collection.id, buyerWa, initialMembers);

      // Announce the group is open (to the group), then PIN it so anyone who joins
      // the group later still sees the welcome + words link at the top (WhatsApp
      // doesn't reliably webhook member-joins, so we can't greet each joiner). The
      // pin is fail-soft — a pin failure never affects the group flow.
      const opened = await sendWaTrigger(groupId, 'group_opened', waGroupValues(collection, base));
      if (opened.ok && opened.messageId) {
        await whatsapp.pinMessage(opened.messageId).catch(() => {});
      }

      // Always fetch and PERSIST the join link, in both modes. In invite_link mode
      // it is the only way the buyer reaches the group; in auto_add it is the
      // privacy-block fallback. Storing it means a later Whapi outage can't blank a
      // link we already hold.
      const invite = await whatsapp.getInviteLink(groupId);
      const inviteLink = invite && invite.ok ? invite.inviteLink : null;
      if (inviteLink) waState.setInviteLink(groupId, inviteLink);

      if (mode === 'invite_link') {
        // The safe path, and the reason this mode is the default: nothing is sent
        // to the buyer at all. The stored link surfaces as a WhatsApp button on
        // their own order page (publicView.wa_invite_link) and they tap it to join.
        // The bot has now contacted precisely nobody, so there is no reachout for
        // WhatsApp to restrict. The only failure worth a human is having no link.
        if (!inviteLink) {
          const alertSubject = 'קבוצת וואטסאפ — לא הופק קישור הצטרפות';
          const alertLines = [
            'נפתחה קבוצה לאיסוף מילים אבל לא הצלחנו להפיק קישור הצטרפות, ולכן הלקוח/ה לא קיבל/ה דרך להיכנס.',
            'שם בעל/ת השמחה: ' + (honoree || '—'),
            'מזהה קבוצה: ' + groupId,
          ];
          if (!(await notify.sendSystemAlert(alertSubject, alertLines))) {
            await alertOwnerViaWhatsApp(alertSubject, alertLines);
          }
        }
        return;
      }

      // Privacy-block fallback (auto_add only): the buyer couldn't be added by
      // number. The invite DM below is itself a reachout, so it goes through the
      // same breaker + cap inside whatsapp.sendMessage.
      if (!buyerLandedInGroup(created, buyerWa)) {
        let dmSent = false;
        if (inviteLink) {
          dmSent = (await sendWaTrigger(buyerWa, 'group_opened', { honoree, link: inviteLink })).ok;
          if (dmSent) waState.setInviteDmSent(groupId);
        }
        // The buyer still has the join button on their own order page, so this is
        // not "no way in" — but nobody told them, so it needs a human.
        if (!dmSent) {
          const alertSubject = 'קבוצת וואטסאפ — צריך צירוף ידני';
          const alertLines = [
            'נפתחה קבוצה לאיסוף מילים אבל לא הצלחנו לצרף את הלקוח/ה אוטומטית.',
            'שם בעל/ת השמחה: ' + (honoree || '—'),
            'טלפון הלקוח/ה: ' + (collection.owner_phone || '—'),
            'מזהה קבוצה: ' + groupId,
            inviteLink ? 'קישור הצטרפות: ' + inviteLink : 'לא הצלחנו להפיק קישור הצטרפות.',
          ];
          // Email escalation is a no-op (returns false) when Resend is dormant. The
          // owner still has WhatsApp, so fall back to a DM to the owner's own number
          // — otherwise an armed-bot + email-off deployment loses this "intervene
          // manually" alert entirely.
          const emailed = await notify.sendSystemAlert(alertSubject, alertLines);
          if (!emailed) await alertOwnerViaWhatsApp(alertSubject, alertLines);
        }
      }
    } finally {
      // Release the reservation whether we succeeded or bailed. On success the group
      // is now in by_collection (so a later call is a no-op via the top guard); on
      // failure the release lets a subsequent paid event retry.
      waState.releaseCollection(collection.id);
    }
  }

  // Handle ONE normalized webhook event (from whatsapp.parseWebhook). Fail-soft is
  // the CALLER's job (each event is wrapped) — this focuses on the logic.
  async function handleWaEvent(ev, base) {
    if (!ev) return;
    // De-dupe redelivered events. Whapi is at-least-once and can redeliver a whole
    // batch (a network blip, a slow 200), which would otherwise re-greet a joining
    // friend and re-ack the same words. Skip an event whose id we've already
    // processed for this group. We RECORD the id only AFTER handling it (per branch),
    // batched with that branch's own state write where possible (the hot word path
    // persists activity + the id in ONE write). Unmapped groups aren't in state, so
    // this is a no-op for them (they return early below anyway); events with no id
    // (older test payloads) are never deduped.
    if (ev.id && waState.wasEventProcessed(ev.groupId, ev.id)) return;
    if (ev.kind === 'participants_added') {
      const entry = waState.collectionForGroup(ev.groupId);
      if (!entry) return; // group the bot doesn't own — never greet into a foreign chat
      const collection = entry.collection_id ? db.getCollection(entry.collection_id) : null;
      if (!collection) return;
      // A friend who joins after the list is closed/expired must NOT be invited to
      // add words — consistent with the message path, which checks status first.
      if (db.effectiveStatus(collection) !== 'open') return;
      const gv = waGroupValues(collection, base);
      // Compare on bare digits: initial_members are stored as digits ("9725…") but
      // Whapi sends participant ids as JIDs ("9725…@s.whatsapp.net"). Without
      // normalizing BOTH sides the buyer + bot would be mis-greeted as new friends.
      const initial = new Set((entry.initial_members || []).map(waIdDigits));
      for (const m of ev.added || []) {
        if (initial.has(waIdDigits(m && m.id))) continue; // skip the buyer + bot
        await sendWaTrigger(ev.groupId, 'member_joined', {
          name: (m && m.name) || '',
          honoree: gv.honoree,
          link: gv.link,
        });
      }
      if (ev.id) waState.markEventProcessed(ev.groupId, ev.id);
      return;
    }
    if (ev.kind === 'message') {
      const entry = waState.collectionForGroup(ev.groupId);
      if (!entry) return; // unmapped group — ignore
      const cid = entry.collection_id;
      const collection = cid ? db.getCollection(cid) : null;
      if (!collection) return;
      const gv = waGroupValues(collection, base);
      const isBuyer =
        entry.owner_wa && ev.from && waIdDigits(entry.owner_wa) === waIdDigits(ev.from);
      const text = String(ev.text || '').trim();

      // Buyer's "finish the list" command: close the collection + announce.
      if (isBuyer && text.toLowerCase() === WA_CLOSE_COMMAND.toLowerCase()) {
        const closed = db.closeCollection(cid, collection.owner_token);
        waState.markClosed(ev.groupId);
        if (closed && closed.changed) {
          await sendWaTrigger(ev.groupId, 'list_closed', {
            honoree: gv.honoree,
            wordCount: db.countWords(cid),
          });
          // This IS the primary completion path: the list is done and ready to
          // produce. Fire the SAME pair the web /close route does — the owner's
          // "ready to produce" (otherwise no PDF is ever made and the customer waits
          // forever) and the buyer's "we've got your words, we've started". Only on
          // the real open->closed transition, gated on email being configured,
          // fire-and-forget so a send failure never escapes the webhook.
          if (notify.isConfigured()) {
            const fresh = db.getCollection(cid);
            if (fresh) {
              const enriched = { ...fresh, count: db.countWords(cid) };
              notify.sendOrderFinished(enriched, base).catch(() => {});
              notify.sendProductionStarted(enriched, base).catch(() => {});
            }
          }
        }
        if (ev.id) waState.markEventProcessed(ev.groupId, ev.id);
        return;
      }

      // Collection already closed: post the "list closed" note ONCE (state-deduped
      // via the group's `closed` flag) and stop — no words are collected.
      if (db.effectiveStatus(collection) !== 'open') {
        if (!entry.closed) {
          waState.markClosed(ev.groupId);
          await sendWaTrigger(ev.groupId, 'list_closed', {
            honoree: gv.honoree,
            wordCount: db.countWords(cid),
          });
        }
        if (ev.id) waState.markEventProcessed(ev.groupId, ev.id);
        return;
      }

      // Normal traffic: harvest words from the message, stamp activity, and fire the
      // (default-disabled, so usually silent) `word_added` ack. The activity stamp
      // and the dedupe-id record are batched into a SINGLE persist.
      const words = whatsapp.splitWords(ev.text);
      if (words.length) {
        db.addWords(cid, words, ev.fromName);
        // Words arriving from the group count against the free quota exactly like
        // words typed on the page (db.addWords enforces it), so filling it here
        // must fire the same one-time "pay to keep adding" email to the buyer.
        const fl = db.freeLimit(cid);
        if (fl && fl.locked && db.markFreeLimitNotified(cid)) {
          notify
            .sendFreeLimitReached(db.getCollection(cid), paymentBaseUrl(), fl.limit)
            .catch(() => {});
        }
        waState.touchActivityWithEvent(ev.groupId, ev.id);
        await sendWaTrigger(ev.groupId, 'word_added', {
          honoree: gv.honoree,
          count: db.countWords(cid),
          link: gv.link,
        });
      } else if (ev.id) {
        waState.markEventProcessed(ev.groupId, ev.id);
      }
      return;
    }
  }

  // One reminder-scan pass over every OPEN collection, driving the owner-managed
  // reminder list (server/reminders.js). Reminders are anchored to the COLLECTION,
  // so this delivers over BOTH channels: email (to the buyer) and WhatsApp (to the
  // collection's group, when one exists) — email works even with the bot disarmed.
  // Exposed (app.runReminderListScan) so a test can run one pass with an injected
  // `now`. Runs whenever email OR the bot is available; each reminder's own channels
  // + the engine's window / every_days / max_total / idle gates decide what actually
  // sends. Each due reminder is RECORDED BEFORE the send result (mark-on-attempt),
  // so a failed-looking send can never re-fire it — the fix for the hourly spam
  // loop. Fail-soft per collection; never throws.
  // How many more AUTOMATED reminder emails this buyer may receive for this order.
  // One budget across all three schedulers (the words nudge, the payment milestones
  // and the owner's reminder list), because a buyer does not experience them as
  // three systems — she experiences an inbox. Owner-settable; see
  // settings.reminders.max_emails for why per-reminder caps are not enough.
  // A missing/broken setting falls back to the shipped default rather than to
  // "unlimited": a ceiling that fails open is not a ceiling.
  //
  // Takes an ID and re-reads the collection, deliberately: every scan iterates over
  // listAllCollections(), which hands out COPIES, so a budget computed from the loop
  // variable would still show the count as it was when the pass started. With five
  // reminders due in one pass that is five emails against a ceiling of three — which
  // is exactly what the first version of this did.
  function reminderEmailBudget(id) {
    let cap = 8;
    try {
      const v = settings.get('reminders', 'max_emails');
      if (Number.isInteger(v) && v >= 0) cap = v;
    } catch {
      /* keep the default */
    }
    return Math.max(0, cap - db.reminderEmailsSent(db.getCollection(id)));
  }

  async function runReminderListScan(now = Date.now()) {
    const emailOn = notify.isConfigured();
    const waOn = whatsapp.isConfigured();
    if (!emailOn && !waOn) return 0;
    let list = [];
    try {
      list = settings.get('reminders', 'list');
    } catch {
      return 0;
    }
    if (!Array.isArray(list) || !list.some((r) => r && r.enabled)) return 0;
    const base = paymentBaseUrl();
    let sent = 0;
    let collections = [];
    try {
      collections = db.listAllCollections();
    } catch {
      return 0;
    }
    for (const c of collections) {
      try {
        // Words in, at the printer, ready, or cancelled — nothing left to ask for.
        // (This replaces a plain `status !== 'open'` check, which kept chasing an
        // order that was already produced whenever the owner reopened the list.)
        if (reminders.wordRemindersStopped(c)) continue;
        const due = reminders.remindersDue({
          reminders: list,
          nowMs: now,
          sentState: db.reminderState(c.id),
          lastActivityMs: db.lastActivityMs(c.id),
        });
        if (!due.length) continue;
        const groupId = waState.groupForCollection(c.id); // null when no group
        const values = waGroupValues(c, base);
        for (const d of due) {
          // Record on attempt — an ambient reminder fires at most once per its
          // window; never retry on a failed-looking send (that spammed the group).
          db.markReminderSent(c.id, d.id, now);
          let delivered = false;
          // Could WhatsApp carry this reminder AT ALL? Distinct from "did the send
          // succeed" — see the fallback below, which turns on this distinction.
          const waPossible = !!(d.channels.whatsapp && groupId && waOn);
          if (waPossible) {
            const text = settings.interpolate(d.text, values);
            const r = await whatsapp.sendMessage(groupId, text);
            if (r && r.ok) delivered = true;
          }
          // Email runs when the reminder asks for it, OR as a FALLBACK when it asked
          // for WhatsApp only and WhatsApp could not be attempted at all — the bot is
          // off/disconnected, or this collection has no group. Without the fallback a
          // WhatsApp-only reminder (the shipped default for `morning`, see
          // reminders.js DEFAULT_REMINDERS) is marked sent by the record-on-attempt
          // above, delivers nothing, and never retries: the customer silently stops
          // being chased while the admin state claims the reminder went out. Learned
          // when the bot's WhatsApp number was banned and every group went dark.
          //
          // The condition is deliberately `!waPossible`, NOT "the send failed". A
          // restricted account can DELIVER and still return not-ok (see the
          // records-on-attempt regression in reminder-scan.test.js), so falling back
          // on a failed send would double-message the customer. Only the case where
          // nothing was even attempted is unambiguous.
          //
          // Gated on owner_email so a phone-only buyer doesn't count as "delivered".
          // The reminder text is reused as-is — it is channel-neutral.
          // …and never past the ceiling. WhatsApp above is unaffected: it is a group
          // the buyer chose to be in, guarded separately (server/wa-guard.js), and
          // capping it here would silently stop the channel this reminder was
          // actually written for.
          const wantsEmail = d.channels.email || (d.channels.whatsapp && !waPossible);
          if (wantsEmail && emailOn && c.owner_email) {
            if (reminderEmailBudget(c.id) > 0) {
              db.markReminderEmailSent(c.id);
              if (await notify.sendReminderEmail(c, d.text, base)) delivered = true;
            } else {
              console.warn('[reminders] email ceiling reached for collection ' + c.id);
            }
          }
          if (delivered) sent += 1;
          else {
            console.warn(
              '[reminders] ' +
                d.id +
                ' not delivered for collection ' +
                c.id +
                ' (already recorded)'
            );
          }
        }
      } catch (e) {
        console.warn('[reminders] scan failed for a collection:', e && e.message ? e.message : e);
      }
    }
    return sent;
  }

  // --- Words-reminder scheduler ---------------------------------------------
  // A collection that's been sitting for 3+ days with no words gets ONE nudge email
  // asking the buyer to add their word list (production can't start until it
  // arrives). One pass = find the due collections (db.collectionsDueForReminder),
  // email each via notify.sendWordsReminder, then mark it reminded so it's never
  // emailed again. Exposed as a callable so a test can run a single pass without
  // waiting on the interval. Fully wrapped and no-ops when email is unconfigured;
  // it never throws into the caller.
  const REMINDER_SCAN_INTERVAL_MS = Number(process.env.REMINDER_SCAN_INTERVAL_MS || 60 * 60 * 1000);
  // The WhatsApp nudge scan runs on the same hourly cadence (the daily triggers
  // catch up the same day once past their hour; quiet reminders are spaced by
  // idle_hours), and stays dormant unless the bot is armed.
  const WA_NUDGE_SCAN_INTERVAL_MS = Number(process.env.WA_NUDGE_SCAN_INTERVAL_MS || 60 * 60 * 1000);

  async function runReminderScan(now = Date.now()) {
    if (!notify.isConfigured()) return 0;
    const base = paymentBaseUrl();
    let sent = 0;
    try {
      const due = db.collectionsDueForReminder(now);
      for (const c of due) {
        try {
          // The shared ceiling. Skipped WITHOUT marking, so raising the cap later
          // still lets the one nudge this collection is owed go out.
          if (reminderEmailBudget(c.id) <= 0) {
            console.warn('[reminder] email ceiling reached for collection ' + c.id);
            continue;
          }
          db.markReminderEmailSent(c.id);
          // word_count is 0 for every due collection (the query requires it); pass
          // it so the reminder's body renders a correct count.
          await notify.sendWordsReminder({ ...c, word_count: 0 }, base);
          // Mark reminded regardless of the send result — one nudge per collection.
          // sendWordsReminder already swallows its own failures (returns false), so
          // a transient miss won't loop the same customer forever.
          db.markReminded(c.id);
          sent += 1;
        } catch (e) {
          console.warn('[reminder] send failed:', e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      console.warn('[reminder] scan failed:', e && e.message ? e.message : e);
    }
    return sent;
  }

  // --- Payment-reminder scheduler -------------------------------------------
  // The current hour (0..23) in Israel time — for the payment reminder's daytime
  // window gate, so a nudge never fires in the middle of the night.
  function jerusalemHour(now) {
    const s = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jerusalem',
      hour: '2-digit',
      hour12: false,
    }).format(new Date(now));
    const h = Number(s);
    return h === 24 ? 0 : h;
  }

  // One pass of the payment reminder: a DM + email to the buyer when their order has
  // sat unpaid past the owner-configured delay. The payment_reminder WhatsApp
  // trigger is the MASTER switch (enabled) + schedule (timing.delay_hours + window)
  // for BOTH channels. When enabled and inside the window, each due collection gets
  // the email (if Resend is configured) and a WhatsApp DM to the buyer (if the bot
  // is armed), then is marked reminded so it's never nudged twice. Exposed as a
  // callable so a test can run one pass without the interval. Fully wrapped; never
  // throws into the caller.
  async function runPaymentReminderScan(now = Date.now()) {
    const emailOn = notify.isConfigured();
    const waOn = whatsapp.isConfigured();
    if (!emailOn && !waOn) return 0;
    let trig;
    try {
      trig = settings.get('wa', 'trigger.payment_reminder');
    } catch {
      return 0;
    }
    if (!trig || !trig.enabled) return 0; // master switch off
    const timing = trig.timing || {};
    // Milestones (hours after an unpaid order) at which to nudge — remind at each,
    // once, until paid. Fall back to a single 24h reminder for a malformed value.
    const delays = Array.isArray(timing.delays) && timing.delays.length ? timing.delays : [24];
    const window =
      Array.isArray(timing.window) && timing.window.length === 2 ? timing.window : null;
    if (window) {
      const h = jerusalemHour(now);
      if (!(h >= window[0] && h < window[1])) return 0; // outside the daytime window
    }
    const base = paymentBaseUrl();
    let sent = 0;
    try {
      const due = db.collectionsDueForPaymentReminder(now, delays);
      for (const c of due) {
        try {
          // The email half, under the shared ceiling. The WhatsApp DM below is not
          // counted against it — it is a different medium with its own guard — but
          // when neither channel can go, the milestone is left UNSPENT rather than
          // marked, so nothing is silently skipped.
          const emailAllowed = emailOn && c.owner_email && reminderEmailBudget(c.id) > 0;
          const waAllowed = waOn && c.owner_phone && whatsapp.groupMode() === 'auto_add';
          if (!emailAllowed && !waAllowed) {
            console.warn('[payment-reminder] nothing to send for collection ' + c.id);
            continue;
          }
          if (emailAllowed) {
            db.markReminderEmailSent(c.id);
            await notify.sendPaymentReminder(c, base);
          }
          // The WhatsApp half is a COLD DM to a buyer who never messaged the bot —
          // a reachout, and one of the actions that got the previous number banned.
          // It is therefore skipped entirely in invite_link mode (the safe default),
          // and in auto_add mode it still passes through the breaker + daily cap
          // inside whatsapp.sendMessage. The email above goes either way, so the
          // buyer is still reminded.
          if (waAllowed) {
            const buyerWa = ilPhoneToWaId(c.owner_phone);
            if (buyerWa) {
              // The buyer's OWN pay link (their owner token) — safe in a 1:1 DM.
              const link =
                base && c.id && c.owner_token
                  ? base + '/collect.html?c=' + c.id + '&k=' + c.owner_token
                  : '';
              await sendWaTrigger(buyerWa, 'payment_reminder', {
                honoree: c.honoree_name || 'בעל/ת השמחה',
                link,
              });
            }
          }
          // Advance the stage counter regardless of send result — this milestone
          // fires once; the next scan sends the next milestone when it comes due.
          db.markPaymentReminderSent(c.id);
          sent += 1;
        } catch (e) {
          console.warn('[payment-reminder] send failed:', e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      console.warn('[payment-reminder] scan failed:', e && e.message ? e.message : e);
    }
    return sent;
  }

  // index.js still calls most of these; the route modules are handed some of them
  // as deps, and the tests reach the rest through the app export.
  return {
    resolveProductImagePath,
    resolveProductImageUrl,
    sendOrderNotifications,
    fireStartNotifications,
    onOrderCreated,
    sendPaidNotifications,
    onOrderPaid,
    onShippingAdded,
    waIdDigits,
    ilPhoneToWaId,
    waGroupValues,
    sendWaTrigger,
    participantIds,
    buyerLandedInGroup,
    ownerWaId,
    alertOwnerViaWhatsApp,
    openWhatsappGroup,
    handleWaEvent,
    reminderEmailBudget,
    runReminderListScan,
    runReminderScan,
    jerusalemHour,
    runPaymentReminderScan,
    REMINDER_SCAN_INTERVAL_MS,
    WA_NUDGE_SCAN_INTERVAL_MS,
  };
};
