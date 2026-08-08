// message-preview.js — render ANY customer-facing message (email or WhatsApp)
// exactly as it would be sent, for the admin panel.
//
// The owner can edit every email and WhatsApp text in הודעות וטקסטים, but until
// now had no way to SEE the result short of triggering a real order. That made
// the branded HTML mails — logo, hero product photo, CTA button — effectively
// unreviewable, and a broken override only surfaced on a real customer.
//
// Design: this module OWNS no rendering. It calls the same pure builders that the
// real send path calls (notify.build*, whatsapp.buildTriggerMessage), so a preview
// can never drift from what is actually sent — the moment they diverge, the
// preview is a lie and worse than nothing. All this adds is a realistic sample
// order to render them against, and a catalog of what can be previewed.
//
// Pure + injectable: every dependency arrives via `deps` so tests need no DATA_DIR
// and no network.

// A realistic sample order. Deliberately NOT a real collection: a preview must
// work on a fresh install with zero orders, and must never leak a real customer's
// name/phone/email into a screenshot the owner might share. Values are obviously
// fictional but well-formed, so every interpolated token renders something.
const SAMPLE_COLLECTION = Object.freeze({
  id: 'preview-sample-0000',
  owner_token: 'preview-token-0000',
  honoree_name: 'שירה',
  owner_email: 'demo@example.com',
  owner_phone: '0521234567',
  design: 'רווקות אשכוליות',
  color: 'ורוד',
  theme: 'grapefruit',
  status: 'open',
  created_at: '2026-07-01T09:00:00.000Z',
  extra_fields: {},
  order: Object.freeze({
    version: 'premium',
    paid: true,
    total: 139,
    order_id: 'DG-1042',
    fulfilment: 'delivery',
    address: Object.freeze({
      city: 'תל אביב',
      street: 'דיזנגוף',
      house: '12',
      apartment: '4',
      zip: '6433222',
    }),
  }),
});

// Sample interpolation values for the WhatsApp trigger catalog. The trigger texts
// use {honoree}/{link}/{name}/{count}/{wordCount}, so supply them all — an unknown
// token would otherwise render literally and look like a bug in the preview.
function sampleWaValues(baseUrl) {
  const link = (baseUrl || '') + '/collect.html?c=' + SAMPLE_COLLECTION.id;
  return {
    honoree: SAMPLE_COLLECTION.honoree_name,
    link,
    name: 'דנה',
    count: 84,
    wordCount: 84,
  };
}

// The email catalog. Each entry maps a stable id to one notify builder and the
// arguments it takes — the builders do NOT share a signature, so the differences
// are spelled out here rather than papered over with a lowest-common-denominator
// wrapper that would drift from the real call sites.
// `settingsKey` is the settings.REGISTRY key under section 'email' whose
// { enabled, subject, body } this message is built from — what the admin UI edits
// when the owner types in the preview. It is NOT derivable from `id`: several
// preview ids read deliberately for a human (owner_order_created) while the
// stored key keeps its historical name (order_paid), so the mapping is spelled
// out. `null` marks a message with no editable template — system_alert composes
// its text in code — and the UI shows it read-only rather than offering an editor
// that would silently save nothing.
const EMAIL_KINDS = [
  {
    id: 'buyer_confirmation',
    label: 'אישור הזמנה ללקוח/ה',
    audience: 'buyer',
    settingsKey: 'buyer_confirmation',
    build: (n, c, base, opts) => n.buildBuyerConfirmation(c, base, opts),
  },
  {
    id: 'buyer_payment_received',
    label: 'קבלה על תשלום ללקוח/ה',
    audience: 'buyer',
    settingsKey: 'buyer_payment_received',
    build: (n, c, base, opts) => n.buildBuyerReceipt(c, base, { ...opts, amountCharged: 139 }),
  },
  {
    id: 'words_reminder',
    label: 'תזכורת להוסיף מילים',
    audience: 'buyer',
    settingsKey: 'words_reminder',
    build: (n, c, base) => n.buildWordsReminder(c, base),
  },
  {
    id: 'payment_reminder',
    label: 'תזכורת להשלים תשלום',
    audience: 'buyer',
    settingsKey: 'payment_reminder',
    build: (n, c, base) => n.buildPaymentReminder(c, base),
  },
  {
    // The "you've used your free words" mail, sent once when a collection hits
    // pricing.free_word_limit. `limit` is normally the live setting; the preview
    // renders the shipped default so it works before the owner has set one.
    id: 'free_limit_reached',
    label: 'נגמרו המילים החינמיות',
    audience: 'buyer',
    settingsKey: 'free_limit_reached',
    build: (n, c, base, opts) => n.buildFreeLimitReached(c, base, opts.freeWordLimit),
  },
  {
    // One entry from the owner-managed reminder list (settings reminders.list).
    // Its text is NOT a registry template — it is per-reminder — so there is no
    // settingsKey to edit here: the list is edited on the הודעות וטקסטים page and
    // this preview shows how any one of those texts will actually look. The first
    // ENABLED reminder is rendered, falling back to the seed default's wording so
    // the preview is never blank.
    id: 'reminder_list',
    label: 'תזכורת מרשימת התזכורות',
    audience: 'buyer',
    settingsKey: null,
    build: (n, c, base, opts) => n.buildReminderEmail(c, opts.reminderText, base),
  },
  {
    // Fired when the buyer closes word collection ("סיום — התחילו להפיק").
    // Replaced the old pdf_ready ("your file is ready") mail — see the registry
    // entry for why. The sample collection carries a word count, so {wordCount}
    // renders a real number here.
    id: 'buyer_production_started',
    label: 'סגרנו את האיסוף — מתחילים להפיק',
    audience: 'buyer',
    settingsKey: 'buyer_production_started',
    build: (n, c, base) => n.buildProductionStarted({ ...c, count: 84 }, base),
  },
  // "Your game is ready" — previewed TWICE, because its whole point is that it
  // makes a different promise per fulfilment and the owner needs to read both.
  // Both entries edit the same template (email.order_ready); what differs is the
  // sample order they render against. The multi-copy line rides on the pickup
  // sample, where it matters most — someone collecting a box of five.
  {
    id: 'order_ready_pickup',
    label: 'המשחק מוכן — איסוף עצמי',
    audience: 'buyer',
    settingsKey: 'order_ready',
    build: (n, c, base) =>
      n.buildOrderReady(
        { ...c, order: { ...(c.order || {}), version: 'pickup', quantity: 5 } },
        base
      ),
  },
  {
    id: 'order_ready_delivery',
    label: 'המשחק מוכן — משלוח',
    audience: 'buyer',
    settingsKey: 'order_ready',
    build: (n, c, base) =>
      n.buildOrderReady({ ...c, order: { ...(c.order || {}), version: 'delivery' } }, base),
  },
  {
    id: 'owner_order_created',
    label: 'הזמנה חדשה (לבעלת העסק)',
    audience: 'owner',
    settingsKey: 'order_paid',
    build: (n, c, base, opts) => n.buildPaidMessage(c, base, opts),
  },
  {
    id: 'owner_payment_received',
    label: 'התקבל תשלום (לבעלת העסק)',
    audience: 'owner',
    settingsKey: 'payment_received',
    build: (n, c, base, opts) => n.buildPaymentReceipt(c, base, { ...opts, amountCharged: 139 }),
  },
  {
    id: 'owner_custom_order',
    label: 'הזמנה מותאמת (לבעלת העסק)',
    audience: 'owner',
    settingsKey: 'custom_order_alert',
    build: (n, c, base, opts) => n.buildCustomOrderAlert(c, base, opts),
  },
  {
    id: 'owner_finished',
    label: 'הרשימה נסגרה — מוכן להפקה',
    audience: 'owner',
    settingsKey: 'order_finished',
    build: (n, c, base) => n.buildFinishedMessage({ ...c, count: 84 }, base),
  },
  {
    id: 'production_error',
    label: 'שגיאת הפקה',
    audience: 'owner',
    settingsKey: 'production_error',
    build: (n, c, base) => n.buildProductionError(c, base, ['חסר גופן לתבנית', 'קובץ פלט ריק']),
  },
  {
    id: 'system_alert',
    label: 'התראת מערכת',
    audience: 'owner',
    // Composed in code (notify.buildSystemAlert), with no settings template — the
    // owner cannot edit this one.
    settingsKey: null,
    build: (n) =>
      n.buildSystemAlert('קבוצת וואטסאפ — צריך צירוף ידני', [
        'נפתחה קבוצה אבל לא הצלחנו לצרף את הלקוח/ה.',
        'מזהה קבוצה: 120363000000000000@g.us',
      ]),
  },
];

// Every previewable message, email + WhatsApp, as a flat list for the admin UI.
// WhatsApp entries are derived from the settings REGISTRY rather than hardcoded,
// so a trigger added to the catalog becomes previewable with no change here.
// Each entry carries `settings` — { section, key } identifying the stored
// template behind it, or null when there is none — so the admin UI can open an
// editor for it (and save through the ordinary settings API) without duplicating
// this id -> key mapping in the browser, where it would drift.
function listKinds(deps = {}) {
  const settings = deps.settings || require('./settings');
  const kinds = EMAIL_KINDS.map((k) => ({
    id: k.id,
    channel: 'email',
    label: k.label,
    audience: k.audience,
    settings: k.settingsKey ? { section: 'email', key: k.settingsKey } : null,
  }));
  const waSection = (settings.REGISTRY && settings.REGISTRY.wa) || {};
  for (const key of Object.keys(waSection)) {
    if (!key.startsWith('trigger.')) continue;
    const id = key.slice('trigger.'.length);
    kinds.push({
      id,
      channel: 'whatsapp',
      label: id,
      audience: 'group',
      settings: { section: 'wa', key },
    });
  }
  return kinds;
}

// A read-only view of the settings store with ONE key replaced by an unsaved
// draft, so the preview can render what the owner is typing without the store
// (and therefore what real customers receive) changing. Everything else reads
// through untouched, including get()'s throw on an unknown key.
//
// The draft is merged OVER the effective value rather than replacing it: the
// editor sends only the fields it owns (subject/body/text/enabled), and a bare
// replace would drop the siblings the builders need — a trigger's `timing`, or
// any field a future editor doesn't render.
function draftStore(base, draft) {
  if (!draft || typeof draft.section !== 'string' || typeof draft.key !== 'string') return base;
  const value = draft.value;
  if (value === undefined || value === null) return base;
  return {
    get(section, key) {
      const eff = base.get(section, key);
      if (section !== draft.section || key !== draft.key) return eff;
      const bothObjects =
        eff && typeof eff === 'object' && !Array.isArray(eff) && !Array.isArray(value);
      return bothObjects && typeof value === 'object' ? { ...eff, ...value } : value;
    },
    interpolate: (...args) => base.interpolate(...args),
    REGISTRY: base.REGISTRY,
  };
}

// Is this email template's own on/off switch on? Read through the (possibly
// drafted) store so toggling the switch in the preview editor is visible BEFORE
// saving. Mirrors settings.emailEnabled: only an explicit false is off, and a
// read failure answers "on" rather than claiming a live message is disabled.
function emailEnabledIn(store, key) {
  if (!key) return true;
  try {
    const tpl = store.get('email', key);
    return !(tpl && typeof tpl === 'object' && tpl.enabled === false);
  } catch {
    return true;
  }
}

// The live free-word quota, for the "you've used your free words" mail — its
// {limit} token and its title both carry the number, so a preview showing the
// wrong one would misrepresent the message. Falls back to the shipped default
// rather than throwing, so the preview still renders on a broken/absent store.
function freeWordLimitIn(store) {
  try {
    const v = store.get('pricing', 'free_word_limit');
    if (Number.isInteger(v) && v > 0) return v;
  } catch {
    /* fall through */
  }
  return 20;
}

// The text of the first ENABLED entry in the owner's reminder list, which is what
// a real reminder send would use. Falls back to the first entry whatever its
// state, then to the seed default's wording, so the preview is never blank just
// because every reminder happens to be switched off.
function reminderTextIn(store) {
  let list = null;
  try {
    list = store.get('reminders', 'list');
  } catch {
    list = null;
  }
  if (Array.isArray(list) && list.length) {
    const pick = list.find((r) => r && r.enabled && r.text) || list.find((r) => r && r.text);
    if (pick) return String(pick.text);
  }
  return 'בוקר טוב! יש עוד זמן להוסיף מילים על {honoree}:\n{link}';
}

// Render ONE message. Returns
//   { id, channel, label, subject, text, html, enabled, settings }
// or null when the id isn't previewable. `html` is null for WhatsApp and for the
// plain-text-only emails (several owner-facing builders return no html) — the UI
// falls back to showing `text`, which is exactly what those mails contain.
//
// `enabled` is the message's own on/off switch (a WhatsApp trigger's, or an email
// template's): the preview must SAY when what it is showing does not actually go
// out, rather than silently rendering text nobody receives.
//
// `deps.draft` — { section, key, value } — renders an UNSAVED edit: the owner
// types in the preview editor and sees the result before committing it. The draft
// is applied through a throwaway overlay (draftStore), so nothing is written and
// a concurrent real send is unaffected.
function render(channel, id, deps = {}) {
  const notify = deps.notify || require('./notify');
  const whatsapp = deps.whatsapp || require('./whatsapp');
  const baseUrl = deps.baseUrl || '';
  const collection = deps.collection || SAMPLE_COLLECTION;
  const productImageUrl = deps.productImageUrl || null;
  const settings = deps.settings || require('./settings');
  const store = draftStore(settings, deps.draft);

  // Keyed on (channel, id), NOT id alone: `payment_reminder` exists as BOTH an
  // email and a WhatsApp trigger, and an id-only lookup silently returned the
  // email for the WhatsApp entry — the owner would preview the wrong message and
  // have no way to tell.
  const email = channel === 'email' ? EMAIL_KINDS.find((k) => k.id === id) : null;
  if (email) {
    const opts = {
      productImageUrl,
      freeWordLimit: freeWordLimitIn(store),
      reminderText: reminderTextIn(store),
    };
    const build = () => email.build(notify, collection, baseUrl, opts) || {};
    // notify.withSettings swaps the store the builders read for the duration of
    // this (synchronous) build. Guarded so an injected test double without it
    // still renders — against the real store, which is what it had before.
    const built =
      store !== settings && typeof notify.withSettings === 'function'
        ? notify.withSettings(store, build)
        : build();
    return {
      id,
      channel: 'email',
      label: email.label,
      audience: email.audience,
      subject: built.subject || '',
      text: built.text || '',
      html: built.html || null,
      enabled: emailEnabledIn(store, email.settingsKey),
      settings: email.settingsKey ? { section: 'email', key: email.settingsKey } : null,
    };
  }

  if (channel !== 'whatsapp') return null;
  const wa = listKinds(deps).find((k) => k.channel === 'whatsapp' && k.id === id);
  if (!wa) return null;
  const values = sampleWaValues(baseUrl);
  const msg = whatsapp.buildTriggerMessage(id, values, { settings: store }) || {};
  // buildTriggerMessage returns text:null for a DISABLED trigger — correct for the
  // send path (nothing goes out), wrong for a preview: several triggers ship
  // disabled (word_added), and a blank panel is exactly the wrong answer when the
  // owner is reading the text to decide whether to turn it on. So fall back to
  // interpolating the stored template ourselves, and let `enabled:false` carry the
  // "this does not send" warning in the UI. The enabled flag still comes from the
  // real builder, so the preview can't claim a disabled trigger is live.
  let text = msg.text || '';
  if (!text) {
    try {
      const cfg = store.get('wa', 'trigger.' + id);
      text = store.interpolate((cfg && cfg.text) || '', values);
    } catch {
      text = '';
    }
  }
  return {
    id,
    channel: 'whatsapp',
    label: id,
    audience: 'group',
    subject: '',
    text,
    html: null,
    enabled: !!msg.enabled,
    settings: { section: 'wa', key: 'trigger.' + id },
  };
}

module.exports = { listKinds, render, draftStore, SAMPLE_COLLECTION, EMAIL_KINDS };
