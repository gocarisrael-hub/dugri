// Owner email notifications — fires on two events: an order is paid, and the
// owner closes a collection (i.e. the word list is finished and ready to
// produce). Modeled on pelecard.js: DORMANT until configured. With no SMTP env
// vars the sends are no-ops (return false) and the site works with zero email
// setup.
//
// Config (all from env):
//   SMTP_HOST   SMTP server host (e.g. smtp.gmail.com)
//   SMTP_PORT   port (default 465; secure/TLS when 465, STARTTLS otherwise)
//   SMTP_USER   SMTP username (the sending mailbox)
//   SMTP_PASS   SMTP password (a Gmail app-password works with smtp.gmail.com)
//   NOTIFY_TO   where notifications are sent (the owner's inbox)
//   NOTIFY_FROM From address (defaults to SMTP_USER)
//
// Works with Gmail: host smtp.gmail.com, port 465, an app-password as SMTP_PASS.

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const NOTIFY_TO = process.env.NOTIFY_TO || '';
const NOTIFY_FROM = process.env.NOTIFY_FROM || SMTP_USER;

// Railway injects RAILWAY_ENVIRONMENT_NAME per environment (values seen live:
// 'production', 'staging'). Any non-empty value that isn't 'production' (matched
// case-insensitively, so a 'Production' rename never taints real orders) is a
// non-prod (test) environment, so its order emails get a TEST marker and staging
// sends are never mistaken for real orders. Empty/unset (local, tests) is treated
// as prod-like — NO marker — so local behavior is unchanged unless a test opts
// in. Production stays byte-identical to before.
const ENV_NAME = process.env.RAILWAY_ENVIRONMENT_NAME || '';
const IS_NONPROD = ENV_NAME !== '' && ENV_NAME.toLowerCase() !== 'production';

// In a non-prod environment, mark an outgoing order email as a test: a plain
// Hebrew prefix on the subject and a banner line at the top of the text body.
// Returns the message unchanged in production / when unset. Central so every
// send path is covered at once.
function markTestEnv(message) {
  if (!IS_NONPROD) return message;
  const marked = { ...message };
  marked.subject = 'הזמנת בדיקה (' + ENV_NAME + ') — ' + (message.subject || '');
  const banner = 'זו הזמנת בדיקה מסביבת ' + ENV_NAME + ' — לא הזמנה אמיתית.';
  if (message.text != null) {
    marked.text = banner + '\n\n' + message.text;
  }
  return marked;
}

// True only when the essentials are present. Sends are no-ops otherwise.
function isConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && NOTIFY_TO);
}

// Hebrew display name for each order version.
const VERSION_LABELS = {
  pdf: 'דיגיטלי (PDF)',
  pickup: 'איסוף עצמי',
  delivery: 'משלוח עד הבית',
};

function honoreeName(collection) {
  const n = collection && collection.honoree_name ? String(collection.honoree_name).trim() : '';
  return n || 'ללא שם';
}

// Best-effort word count: prefer an explicit count, fall back to a words array.
function wordCount(collection) {
  if (!collection) return null;
  if (Number.isFinite(collection.word_count)) return collection.word_count;
  if (Number.isFinite(collection.count)) return collection.count;
  if (Array.isArray(collection.words)) return collection.words.length;
  return null;
}

// The owner link (collect.html with the collection id + owner token), when we
// can build it. `baseUrl` is the already-normalized public origin (the caller
// owns PUBLIC_BASE_URL normalization); returns null when it or the tokens are
// missing.
function ownerLink(collection, baseUrl) {
  if (!baseUrl || !collection || !collection.id || !collection.owner_token) return null;
  return baseUrl + '/collect.html?c=' + collection.id + '&k=' + collection.owner_token;
}

// The amount line(s) for a paid order email. `options.amountCharged`, when a
// finite number, is what the customer ACTUALLY paid (0 for a fully-free
// 100%-coupon order, the discounted amount for a partial coupon); we show that
// rather than the full package price. Without it we fall back to the order's
// pre-coupon total (used by the non-paid "finished" email). A zero charge reads
// clearly as free with a 100%-coupon note. `label` is the field name (e.g.
// 'סכום' for the owner, '· מחיר' for the buyer).
function amountLines(order, options, label) {
  if (!order) return [];
  const charged = options && Number.isFinite(options.amountCharged) ? options.amountCharged : null;
  const amount = charged != null ? charged : order.total != null ? order.total : null;
  if (amount == null) return [];
  if (amount <= 0) return [label + ': 0 ₪ (קופון 100%)'];
  return [label + ': ' + amount + ' ₪'];
}

// Shared body lines (order details) used by both messages. `options` may carry
// `amountCharged` (the real charged amount) — see amountLines.
function orderLines(collection, baseUrl, options) {
  const lines = [];
  const order = (collection && collection.order) || null;
  if (order) {
    const label = VERSION_LABELS[order.version] || order.version || '-';
    lines.push('גרסה: ' + label);
    lines.push(...amountLines(order, options, 'סכום'));
  }
  const wc = wordCount(collection);
  if (wc != null) lines.push('מספר מילים: ' + wc);
  const link = ownerLink(collection, baseUrl);
  if (link) lines.push('קישור לניהול: ' + link);
  return lines;
}

// Pure builder: the "order paid" email. `baseUrl` is the normalized public
// origin (optional; the owner link is omitted without it). `options` may carry
// `amountCharged` — the amount actually paid (0 for a free 100%-coupon order).
// Returns {subject,text}.
function buildPaidMessage(collection, baseUrl, options) {
  const name = honoreeName(collection);
  const subject = 'דוגרי · התקבל תשלום — ' + name;
  const text = [
    'התקבל תשלום עבור ההזמנה של ' + name + '.',
    '',
    ...orderLines(collection, baseUrl, options),
  ].join('\n');
  return { subject, text };
}

// Pure builder: the BUYER's confirmation email — sent to the customer (not the
// owner) when their order is paid. Warm, on-brand, RTL-friendly. Includes a
// thank-you, the order details (package + price, and design/colour when set) and
// the collect link so they can keep adding their words. `baseUrl` is the
// normalized public origin (optional; the link is omitted without it).
// Returns {subject, text} — same shape as the other builders. `options` may
// carry `amountCharged` — the amount actually paid (0 for a free 100%-coupon
// order, the discounted amount for a partial coupon).
function buildBuyerConfirmation(collection, baseUrl, options) {
  const name = honoreeName(collection);
  const subject = 'דוגרי · ההזמנה שלכם התקבלה — ' + name;
  const lines = [
    'תודה רבה על ההזמנה!',
    'קיבלנו את התשלום עבור המשחק של ' + name + '.',
    '',
    'פרטי ההזמנה:',
  ];
  const order = (collection && collection.order) || null;
  if (order) {
    const label = VERSION_LABELS[order.version] || order.version || '-';
    lines.push('· חבילה: ' + label);
    lines.push(...amountLines(order, options, '· מחיר'));
  }
  if (collection && collection.design) lines.push('· עיצוב: ' + collection.design);
  if (collection && collection.color) lines.push('· צבע: ' + collection.color);
  const link = ownerLink(collection, baseUrl);
  if (link) {
    lines.push('');
    lines.push('נשאר רק שלב אחד: הוסיפו את 100+ המילים על בעל/ת השמחה כאן:');
    lines.push(link);
  }
  lines.push('');
  lines.push('נתראה על הלוח,');
  lines.push('צוות דוגרי');
  return { subject, text: lines.join('\n') };
}

// Pure builder: the "order finished / ready to produce" email.
function buildFinishedMessage(collection, baseUrl) {
  const name = honoreeName(collection);
  const subject = 'דוגרי · הזמנה מוכנה להפקה — ' + name;
  const text = [
    'ההזמנה של ' + name + ' נסגרה ומוכנה להפקה.',
    '',
    ...orderLines(collection, baseUrl),
  ].join('\n');
  return { subject, text };
}

let _transporter = null;
function transporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return _transporter;
}

// Send one message. `to` overrides the recipient (defaults to the owner's
// NOTIFY_TO — e.g. the buyer confirmation is sent to the customer's address).
// Fully wrapped: a failure (or being unconfigured, or an empty recipient) NEVER
// throws into the caller — it logs a warning and returns false.
async function send({ subject, text, html, to }) {
  if (!isConfigured()) return false;
  const recipient = to || NOTIFY_TO;
  if (!recipient) return false;
  try {
    // Non-prod (e.g. staging) sends are stamped as test emails; production and
    // local/unset stay untouched.
    const marked = markTestEnv({ subject, text, html });
    const mail = { from: NOTIFY_FROM, to: recipient, subject: marked.subject, text: marked.text };
    if (marked.html != null) mail.html = marked.html;
    await transporter().sendMail(mail);
    return true;
  } catch (e) {
    console.warn('[notify] send failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the "order paid" notification. `baseUrl` is the normalized public origin
// (optional). `options` may carry `amountCharged` (the amount actually paid).
// Never throws.
async function sendOrderPaid(collection, baseUrl, options) {
  try {
    return await send(buildPaidMessage(collection, baseUrl, options));
  } catch (e) {
    console.warn('[notify] sendOrderPaid failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the BUYER confirmation to the customer's own email. Sent to the
// collection's owner_email (captured at checkout), NOT to NOTIFY_TO. Skips
// gracefully (returns false) when that address is missing/empty, and stays
// dormant like the others when SMTP is unconfigured. `options` may carry
// `amountCharged` (the amount actually paid). Never throws.
async function sendBuyerConfirmation(collection, baseUrl, options) {
  try {
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (!to) return false;
    return await send({ ...buildBuyerConfirmation(collection, baseUrl, options), to });
  } catch (e) {
    console.warn('[notify] sendBuyerConfirmation failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the "order finished" notification. `baseUrl` is the normalized public
// origin (optional). Never throws.
async function sendOrderFinished(collection, baseUrl) {
  try {
    return await send(buildFinishedMessage(collection, baseUrl));
  } catch (e) {
    console.warn('[notify] sendOrderFinished failed:', e && e.message ? e.message : e);
    return false;
  }
}

module.exports = {
  isConfigured,
  buildPaidMessage,
  buildBuyerConfirmation,
  buildFinishedMessage,
  sendOrderPaid,
  sendBuyerConfirmation,
  sendOrderFinished,
};
