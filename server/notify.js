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
// can build it. Returns null when PUBLIC_BASE_URL or the tokens are missing.
function ownerLink(collection) {
  const base = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') : null;
  if (!base || !collection || !collection.id || !collection.owner_token) return null;
  return base + '/collect.html?c=' + collection.id + '&k=' + collection.owner_token;
}

// Shared body lines (order details) used by both messages.
function orderLines(collection) {
  const lines = [];
  const order = (collection && collection.order) || null;
  if (order) {
    const label = VERSION_LABELS[order.version] || order.version || '-';
    lines.push('גרסה: ' + label);
    if (order.total != null) lines.push('סכום: ' + order.total + ' ₪');
  }
  const wc = wordCount(collection);
  if (wc != null) lines.push('מספר מילים: ' + wc);
  const link = ownerLink(collection);
  if (link) lines.push('קישור לניהול: ' + link);
  return lines;
}

// Pure builder: the "order paid" email. Returns { subject, text }.
function buildPaidMessage(collection) {
  const name = honoreeName(collection);
  const subject = 'דוגרי · התקבל תשלום — ' + name;
  const text = ['התקבל תשלום עבור ההזמנה של ' + name + '.', '', ...orderLines(collection)].join(
    '\n'
  );
  return { subject, text };
}

// Pure builder: the "order finished / ready to produce" email.
function buildFinishedMessage(collection) {
  const name = honoreeName(collection);
  const subject = 'דוגרי · הזמנה מוכנה להפקה — ' + name;
  const text = ['ההזמנה של ' + name + ' נסגרה ומוכנה להפקה.', '', ...orderLines(collection)].join(
    '\n'
  );
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

// Send one message. Fully wrapped: a failure (or being unconfigured) NEVER
// throws into the caller — it logs a warning and returns false.
async function send({ subject, text }) {
  if (!isConfigured()) return false;
  try {
    await transporter().sendMail({ from: NOTIFY_FROM, to: NOTIFY_TO, subject, text });
    return true;
  } catch (e) {
    console.warn('[notify] send failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the "order paid" notification. Never throws.
async function sendOrderPaid(collection) {
  try {
    return await send(buildPaidMessage(collection));
  } catch (e) {
    console.warn('[notify] sendOrderPaid failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the "order finished" notification. Never throws.
async function sendOrderFinished(collection) {
  try {
    return await send(buildFinishedMessage(collection));
  } catch (e) {
    console.warn('[notify] sendOrderFinished failed:', e && e.message ? e.message : e);
    return false;
  }
}

module.exports = {
  isConfigured,
  buildPaidMessage,
  buildFinishedMessage,
  sendOrderPaid,
  sendOrderFinished,
};
