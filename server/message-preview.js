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
const EMAIL_KINDS = [
  {
    id: 'buyer_confirmation',
    label: 'אישור הזמנה ללקוח/ה',
    audience: 'buyer',
    build: (n, c, base, opts) => n.buildBuyerConfirmation(c, base, opts),
  },
  {
    id: 'buyer_payment_received',
    label: 'קבלה על תשלום ללקוח/ה',
    audience: 'buyer',
    build: (n, c, base, opts) => n.buildBuyerReceipt(c, base, { ...opts, amountCharged: 139 }),
  },
  {
    id: 'words_reminder',
    label: 'תזכורת להוסיף מילים',
    audience: 'buyer',
    build: (n, c, base) => n.buildWordsReminder(c, base),
  },
  {
    id: 'payment_reminder',
    label: 'תזכורת להשלים תשלום',
    audience: 'buyer',
    build: (n, c, base) => n.buildPaymentReminder(c, base),
  },
  {
    id: 'pdf_ready',
    label: 'הקובץ מוכן',
    audience: 'buyer',
    build: (n, c, base) => n.buildPdfReadyMessage(c, base + '/download/sample.pdf', base),
  },
  {
    id: 'owner_order_created',
    label: 'הזמנה חדשה (לבעלת העסק)',
    audience: 'owner',
    build: (n, c, base, opts) => n.buildPaidMessage(c, base, opts),
  },
  {
    id: 'owner_payment_received',
    label: 'התקבל תשלום (לבעלת העסק)',
    audience: 'owner',
    build: (n, c, base, opts) => n.buildPaymentReceipt(c, base, { ...opts, amountCharged: 139 }),
  },
  {
    id: 'owner_custom_order',
    label: 'הזמנה מותאמת (לבעלת העסק)',
    audience: 'owner',
    build: (n, c, base, opts) => n.buildCustomOrderAlert(c, base, opts),
  },
  {
    id: 'owner_finished',
    label: 'הרשימה נסגרה — מוכן להפקה',
    audience: 'owner',
    build: (n, c, base) => n.buildFinishedMessage({ ...c, count: 84 }, base),
  },
  {
    id: 'production_error',
    label: 'שגיאת הפקה',
    audience: 'owner',
    build: (n, c, base) => n.buildProductionError(c, base, ['חסר גופן לתבנית', 'קובץ פלט ריק']),
  },
  {
    id: 'system_alert',
    label: 'התראת מערכת',
    audience: 'owner',
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
function listKinds(deps = {}) {
  const settings = deps.settings || require('./settings');
  const kinds = EMAIL_KINDS.map((k) => ({
    id: k.id,
    channel: 'email',
    label: k.label,
    audience: k.audience,
  }));
  const waSection = (settings.REGISTRY && settings.REGISTRY.wa) || {};
  for (const key of Object.keys(waSection)) {
    if (!key.startsWith('trigger.')) continue;
    const id = key.slice('trigger.'.length);
    kinds.push({ id, channel: 'whatsapp', label: id, audience: 'group' });
  }
  return kinds;
}

// Render ONE message. Returns
//   { id, channel, label, subject, text, html, enabled }
// or null when the id isn't previewable. `html` is null for WhatsApp and for the
// plain-text-only emails (several owner-facing builders return no html) — the UI
// falls back to showing `text`, which is exactly what those mails contain.
//
// `enabled` is meaningful for WhatsApp only: a disabled trigger sends nothing, and
// the preview must SAY so rather than silently rendering text that never goes out.
function render(channel, id, deps = {}) {
  const notify = deps.notify || require('./notify');
  const whatsapp = deps.whatsapp || require('./whatsapp');
  const baseUrl = deps.baseUrl || '';
  const collection = deps.collection || SAMPLE_COLLECTION;
  const productImageUrl = deps.productImageUrl || null;

  // Keyed on (channel, id), NOT id alone: `payment_reminder` exists as BOTH an
  // email and a WhatsApp trigger, and an id-only lookup silently returned the
  // email for the WhatsApp entry — the owner would preview the wrong message and
  // have no way to tell.
  const email = channel === 'email' ? EMAIL_KINDS.find((k) => k.id === id) : null;
  if (email) {
    const built = email.build(notify, collection, baseUrl, { productImageUrl }) || {};
    return {
      id,
      channel: 'email',
      label: email.label,
      audience: email.audience,
      subject: built.subject || '',
      text: built.text || '',
      html: built.html || null,
      enabled: true,
    };
  }

  if (channel !== 'whatsapp') return null;
  const wa = listKinds(deps).find((k) => k.channel === 'whatsapp' && k.id === id);
  if (!wa) return null;
  const settings = deps.settings || require('./settings');
  const values = sampleWaValues(baseUrl);
  const msg = whatsapp.buildTriggerMessage(id, values, { settings }) || {};
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
      const cfg = settings.get('wa', 'trigger.' + id);
      text = settings.interpolate((cfg && cfg.text) || '', values);
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
  };
}

module.exports = { listKinds, render, SAMPLE_COLLECTION, EMAIL_KINDS };
