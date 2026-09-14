// Agent D (Platform & Comms): the reminder + notification state kept on a
// collection, moved out of server/db.js (slice 1 of splitting the monolith; see
// docs/agent-partition.md). A VERBATIM move of that block of the `db` object.
//
// db.js spreads the returned methods back into `db` at the same position, so every
// caller keeps calling db.markReminded(...) etc. unchanged, `this` is still `db`,
// and there is still ONE in-memory store written by ONE saveDb. Nothing is required
// at the top level, for the same reason as server/routes/platform.js: the tests
// purge require.cache to reload db.js, and a cached copy of this file must never
// hold on to a previous load's store.

module.exports = function platformStore({
  _db,
  saveDb,
  nowIso,
  reminders,
  effectiveStatus,
  REMINDER_AFTER_MS,
}) {
  return {
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
        // Nothing to ask for once the words are in, the deck is at the printer or
        // the order is ready — see reminders.wordRemindersStopped. `status` is the
        // STORED one here (this is the raw store), so effectiveStatus is applied
        // first: an expired list reads as open until it is derived.
        if (reminders.wordRemindersStopped({ ...c, status: effectiveStatus(c) })) return false;
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

    // How many AUTOMATED reminder emails this buyer has already had — the words
    // nudge, the payment milestones and the owner's reminder list, counted together
    // because the buyer does not experience them as three systems. It is the number
    // the ceiling in settings (reminders.max_emails) is spent against; transactional
    // mail (the confirmation, the receipt, "your order is ready") is NOT counted,
    // since each of those is the consequence of a thing that actually happened.
    reminderEmailsSent(c) {
      if (!c) return 0;
      return Number.isInteger(c.reminder_emails_sent) ? c.reminder_emails_sent : 0;
    },

    // Spend one of that budget. Called on every reminder email ATTEMPT (the same
    // record-on-attempt posture the reminder state itself uses: a send that looks
    // failed must not become a free retry).
    markReminderEmailSent(id) {
      const c = this.getCollection(id);
      if (!c) return false;
      c.reminder_emails_sent = this.reminderEmailsSent(c) + 1;
      saveDb();
      return true;
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
        if (!c) return false;
        // A ready order has been handed over; chasing it for money is the owner's
        // call to make by hand, not an automated nudge — see
        // reminders.paymentRemindersStopped.
        if (reminders.paymentRemindersStopped(c)) return false;
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
  };
};
