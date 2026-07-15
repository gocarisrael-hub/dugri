// Owner email notifications — fires on two events: an order is paid, and the
// owner closes a collection (i.e. the word list is finished and ready to
// produce). Modeled on pelecard.js: DORMANT until configured. With no Resend env
// vars the sends are no-ops (return false) and the site works with zero email
// setup.
//
// Transport: the Resend HTTPS API (POST https://api.resend.com/emails). We use
// HTTPS on purpose — Railway blocks outbound SMTP (ports 25/465/587 to
// smtp.gmail.com time out from inside the container), so nodemailer→Gmail could
// never connect. Resend sends over port 443, which works. Uses the global fetch
// (Node 20), so there is no mail dependency to install.
//
// Config (all from env):
//   RESEND_API_KEY  Resend API key — the Bearer token for the API call.
//   NOTIFY_TO       where notifications are sent (the owner's inbox).
//   NOTIFY_FROM     From address — must be a Resend-VERIFIED sender/domain,
//                   e.g. "Dugri <orders@yourdomain>". For quick testing Resend
//                   allows "onboarding@resend.dev" (delivers only to your own
//                   account email).
//   REPLY_TO        Optional. The address replies are routed to (Reply-To
//                   header); defaults to NOTIFY_TO when unset. Need NOT be a
//                   verified domain, so From can stay on the branded verified
//                   domain while replies land in the business inbox (e.g. a
//                   Gmail).

// Owner-editable message templates + labels live in settings.js (a DATA_DIR
// store overlaying the registry defaults). notify -> settings only; settings
// must never require notify (would be a require cycle). With no override every
// template resolves to the default, which is byte-identical to the strings that
// used to be inline here — so email output is unchanged until the owner edits it.
const settings = require('./settings');
const { interpolate } = settings;

const RESEND_API_URL = 'https://api.resend.com/emails';
// Abort a stalled Resend request instead of hanging the (fire-and-forget) send
// forever — on timeout the fetch rejects and the send logs + returns false.
const SEND_TIMEOUT_MS = 10000;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_TO = process.env.NOTIFY_TO || '';
const NOTIFY_FROM = process.env.NOTIFY_FROM || '';
// Reply-To: replies to any outgoing email are routed here. Defaults to NOTIFY_TO
// (the business inbox that receives owner alerts) so a customer replying to their
// confirmation reaches us, even though From stays on the branded verified domain.
// Need not be a verified domain; set REPLY_TO to override (e.g. a Gmail).
const REPLY_TO = process.env.REPLY_TO || NOTIFY_TO;

// Warn (once) at startup if the owner set SOME but not all of the three Resend
// vars — a likely misconfiguration (e.g. they set the key + recipient and forgot
// NOTIFY_FROM) that would otherwise silently disable ALL email with no clue why.
// None set = dormant by design (stay silent); all set = configured (no warning).
let _partialConfigWarned = false;
function warnIfPartiallyConfigured() {
  if (_partialConfigWarned) return;
  const vars = { RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM };
  const present = Object.values(vars).filter(Boolean).length;
  if (present === 0 || present === 3) return;
  _partialConfigWarned = true;
  const missing = Object.keys(vars).filter((k) => !vars[k]);
  console.warn(
    '[notify] email partially configured — sends disabled. Missing: ' + missing.join(', ')
  );
}
warnIfPartiallyConfigured();

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
  return Boolean(RESEND_API_KEY && NOTIFY_TO && NOTIFY_FROM);
}

// --- Branded HTML email --------------------------------------------------
// Customer-facing emails ship a branded HTML body (logo, brand-pink accents, a
// CTA button, RTL) with the existing plain text kept as the fallback. Layout is
// table-based + inline CSS on purpose: that is the only styling most email
// clients (Gmail, Outlook, Apple Mail) render reliably.

// Brand palette — from site/js/designs.js MAIN_COLORS (magenta + pink).
const BRAND_PINK = '#ED2A9C';
const BRAND_PINK_LIGHT = '#FF4FA3';
const INK = '#1e1e2e';
const MUTED = '#6b6b7b';

// Served path of the email logo. The file is committed to site/assets/ so the
// static site serves it at `${baseUrl}${LOGO_PATH}` — email clients cannot embed
// a local file, they need a public https src. Source asset:
// resources/dugri-logo-email.png (copied to site/assets/dugri-logo-email.png).
const LOGO_PATH = '/assets/dugri-logo-email.png';

// Minimal HTML-escaping for text interpolated into the HTML body (honoree
// names, problem strings, URLs). Keeps a stray & or < from breaking the markup.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Shared branded HTML shell. `bodyLines` are plain strings rendered as centered
// paragraphs (an empty string becomes vertical spacing). `cta` is an optional
// { label, url } rendered as a rounded brand-pink button. `baseUrl` (the
// normalized public origin) is where the hosted logo is loaded from; without it
// the header falls back to the brand wordmark so the email still renders.
// Returns a full, email-client-safe HTML document (RTL, inline CSS, tables).
function renderEmailHtml({ title, bodyLines, cta, baseUrl } = {}) {
  const logo = baseUrl
    ? `<img src="${escapeHtml(baseUrl + LOGO_PATH)}" width="120" alt="דוגרי" style="display:block;border:0;outline:none;text-decoration:none;height:auto;margin:0 auto;" />`
    : `<div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:1px;">דוגרי</div>`;

  const heading = title
    ? `<tr><td style="padding:0 32px 8px;text-align:center;font-size:22px;font-weight:800;color:${INK};">${escapeHtml(
        title
      )}</td></tr>`
    : '';

  const paragraphs = (Array.isArray(bodyLines) ? bodyLines : [])
    .map((line) => {
      if (line === '' || line == null) {
        return '<tr><td style="height:12px;line-height:12px;font-size:12px;">&nbsp;</td></tr>';
      }
      return `<tr><td style="padding:2px 32px;text-align:center;font-size:16px;line-height:1.6;color:${INK};">${escapeHtml(
        line
      )}</td></tr>`;
    })
    .join('');

  const button =
    cta && cta.url
      ? `<tr><td style="padding:24px 32px 8px;text-align:center;">
            <a href="${escapeHtml(
              cta.url
            )}" style="display:inline-block;background:${BRAND_PINK};background-image:linear-gradient(135deg,${BRAND_PINK_LIGHT},${BRAND_PINK});color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 32px;border-radius:9999px;">${escapeHtml(
              cta.label || 'המשך'
            )}</a>
          </td></tr>`
      : '';

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title || 'דוגרי')}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" dir="rtl" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;font-family:'Heebo',Arial,Helvetica,sans-serif;">
            <tr>
              <td style="background:linear-gradient(135deg,${BRAND_PINK_LIGHT},${BRAND_PINK});padding:28px 32px;text-align:center;">
                ${logo}
              </td>
            </tr>
            <tr><td style="height:20px;line-height:20px;font-size:20px;">&nbsp;</td></tr>
            ${heading}
            ${paragraphs}
            ${button}
            <tr><td style="height:16px;line-height:16px;font-size:16px;">&nbsp;</td></tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid #eee;text-align:center;font-size:13px;line-height:1.6;color:${MUTED};">
                נתראה על הלוח,<br />צוות דוגרי
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Owner-editable string groups (registry-backed; default to the current
// strings). Read fresh each build so an override takes effect without a restart.
function emailTpl(name) {
  return settings.get('email', name);
}
function versionLabels() {
  return settings.get('email', 'version_labels');
}
function fieldLabels() {
  return settings.get('email', 'field_labels');
}
function ctaLabels() {
  return settings.get('email', 'cta_labels');
}
function footer() {
  return settings.get('email', 'footer');
}

// Hebrew display name for one order version — the mapped label, else the raw
// version string, else '-' (matches the previous VERSION_LABELS[v] || v || '-').
function versionLabelFor(version) {
  const map = versionLabels();
  if (version && Object.prototype.hasOwnProperty.call(map, version) && map[version]) {
    return map[version];
  }
  return version || '-';
}

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
  const f = fieldLabels();
  if (amount <= 0) return [label + ': 0 ' + f.currency + ' (' + f.freeCoupon + ')'];
  return [label + ': ' + amount + ' ' + f.currency];
}

// Shared body lines (order details) used by both messages. `options` may carry
// `amountCharged` (the real charged amount) — see amountLines.
function orderLines(collection, baseUrl, options) {
  const lines = [];
  const f = fieldLabels();
  const order = (collection && collection.order) || null;
  if (order) {
    const label = versionLabelFor(order.version);
    lines.push(f.version + ': ' + label);
    lines.push(...amountLines(order, options, f.amount));
  }
  const wc = wordCount(collection);
  if (wc != null) lines.push(f.wordCount + ': ' + wc);
  const link = ownerLink(collection, baseUrl);
  if (link) lines.push(f.ownerLink + ': ' + link);
  return lines;
}

// Pure builder: the "order paid" email. `baseUrl` is the normalized public
// origin (optional; the owner link is omitted without it). `options` may carry
// `amountCharged` — the amount actually paid (0 for a free 100%-coupon order).
// Returns {subject,text}.
function buildPaidMessage(collection, baseUrl, options) {
  const name = honoreeName(collection);
  const tpl = emailTpl('order_paid');
  const values = { honoree: name };
  const subject = interpolate(tpl.subject, values);
  const text = [
    ...interpolate(tpl.body, values).split('\n'),
    '',
    ...orderLines(collection, baseUrl, options),
  ].join('\n');
  return { subject, text };
}

// Pure builder: the Dugri-only "CUSTOM order — needs hand-design" alert. Fired
// (in ADDITION to the normal paid emails) when a paid order is a bespoke custom
// order (order.version === 'custom'). A distinct subject/line so it stands out
// in the owner's inbox as work that needs a hand-designed game. `baseUrl` is the
// normalized public origin (optional; the owner link is omitted without it).
// Returns {subject, text} — same shape as the other builders.
function buildCustomOrderAlert(collection, baseUrl, options) {
  const name = honoreeName(collection);
  const tpl = emailTpl('custom_order_alert');
  const values = { honoree: name };
  const subject = interpolate(tpl.subject, values);
  const text = [
    ...interpolate(tpl.body, values).split('\n'),
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
  const tpl = emailTpl('buyer_confirmation');
  const f = fieldLabels();
  const cta = ctaLabels();
  const ft = footer();
  const values = { honoree: name };
  const subject = interpolate(tpl.subject, values);
  const lines = interpolate(tpl.body, values).split('\n');
  const order = (collection && collection.order) || null;
  if (order) {
    const label = versionLabelFor(order.version);
    lines.push(f.buyerPackage + ': ' + label);
    lines.push(...amountLines(order, options, f.buyerPrice));
  }
  if (collection && collection.design) lines.push(f.buyerDesign + ': ' + collection.design);
  if (collection && collection.color) lines.push(f.buyerColor + ': ' + collection.color);
  const link = ownerLink(collection, baseUrl);
  // Branded HTML mirrors the plain-text body but drops the raw URL line — the
  // link becomes the CTA button. Everything above the link is reused as-is.
  const htmlLines = lines.slice();
  if (link) {
    lines.push('');
    lines.push('נשאר רק שלב אחד: הוסיפו את 100+ המילים על בעל/ת השמחה כאן:');
    lines.push(link);
    htmlLines.push('');
    htmlLines.push('נשאר רק שלב אחד: הוסיפו את 100+ המילים על בעל/ת השמחה.');
  }
  lines.push('');
  lines.push(ft.line1);
  lines.push(ft.line2);
  const html = renderEmailHtml({
    title: 'ההזמנה שלכם התקבלה — ' + name,
    bodyLines: htmlLines,
    cta: link ? { label: cta.addWords, url: link } : null,
    baseUrl,
  });
  return { subject, text: lines.join('\n'), html };
}

// Pure builder: the "your game PDF is ready" email. `link` is the download URL
// for the generated print-ready PDF (the admin-gated GET route). `baseUrl` (the
// normalized public origin, optional) is used only to host the branded logo.
// Returns {subject, text, html}. The same body is sent to the client and to Dugri.
function buildPdfReadyMessage(collection, link, baseUrl) {
  const name = honoreeName(collection);
  const tpl = emailTpl('pdf_ready');
  const cta = ctaLabels();
  const ft = footer();
  const values = { honoree: name, downloadLink: link || '' };
  const subject = interpolate(tpl.subject, values);
  const bodyLines = interpolate(tpl.body, values).split('\n');
  const lines = [...bodyLines, ''];
  if (link) {
    lines.push('להורדת ה-PDF:');
    lines.push(link);
    lines.push('');
  }
  lines.push(ft.line1);
  lines.push(ft.line2);
  const html = renderEmailHtml({
    title: 'הקובץ שלכם מוכן — ' + name,
    bodyLines,
    cta: link ? { label: cta.downloadFile, url: link } : null,
    baseUrl,
  });
  return { subject, text: lines.join('\n'), html };
}

// Pure builder: the "order finished / ready to produce" email.
function buildFinishedMessage(collection, baseUrl) {
  const name = honoreeName(collection);
  const tpl = emailTpl('order_finished');
  const values = { honoree: name };
  const subject = interpolate(tpl.subject, values);
  const text = [
    ...interpolate(tpl.body, values).split('\n'),
    '',
    ...orderLines(collection, baseUrl),
  ].join('\n');
  return { subject, text };
}

// Pure builder: the "production blocked — needs fixing" email. `problems` is the
// list of Hebrew problem strings from validateOrderForProduction; the body lists
// each one so the client (and Dugri) know exactly what to correct before we can
// generate. The owner link (when available) lets them update the order.
// Returns {subject, text} — same shape as the other builders.
function buildProductionError(collection, baseUrl, problems) {
  const name = honoreeName(collection);
  const tpl = emailTpl('production_error');
  const cta = ctaLabels();
  const ft = footer();
  const values = { honoree: name };
  const subject = interpolate(tpl.subject, values);
  const bodyLines = interpolate(tpl.body, values).split('\n');
  const items = (Array.isArray(problems) ? problems : []).map((p) => '· ' + p);
  const lines = [...bodyLines, '', ...items];
  const link = ownerLink(collection, baseUrl);
  // HTML mirrors the same intro + problem list; the owner link becomes the CTA.
  const htmlLines = [...bodyLines, '', ...items];
  if (link) {
    lines.push('');
    lines.push('לעדכון ההזמנה:');
    lines.push(link);
  }
  lines.push('');
  lines.push(ft.line2);
  const html = renderEmailHtml({
    title: 'צריך תיקון לפני הפקה — ' + name,
    bodyLines: htmlLines,
    cta: link ? { label: cta.updateOrder, url: link } : null,
    baseUrl,
  });
  return { subject, text: lines.join('\n'), html };
}

// Pure builder: the customer nudge — "you paid but haven't added your words
// yet". Since production can't start until the word list arrives, this reminds
// the buyer to open the collect link and fill it in. `baseUrl` (the normalized
// public origin, optional) builds both the collect CTA and the hosted logo.
// Returns {subject, text, html} — the plain text is the fallback.
function buildWordsReminder(collection, baseUrl) {
  const name = honoreeName(collection);
  const tpl = emailTpl('words_reminder');
  const cta = ctaLabels();
  const ft = footer();
  const values = { honoree: name };
  const subject = interpolate(tpl.subject, values);
  const bodyLines = interpolate(tpl.body, values).split('\n');
  const lines = bodyLines.slice();
  const link = ownerLink(collection, baseUrl);
  if (link) {
    lines.push('');
    lines.push('להוספת המילים:');
    lines.push(link);
  }
  lines.push('');
  lines.push(ft.line1);
  lines.push(ft.line2);
  const html = renderEmailHtml({
    title: 'עוד לא הוספתם מילים — ' + name,
    bodyLines,
    cta: link ? { label: cta.addWords, url: link } : null,
    baseUrl,
  });
  return { subject, text: lines.join('\n'), html };
}

// Send one message via the Resend HTTPS API. `to` overrides the recipient
// (defaults to the owner's NOTIFY_TO — e.g. the buyer confirmation is sent to
// the customer's address). Fully wrapped: a failure (a non-2xx response, a
// thrown/network error, being unconfigured, or an empty recipient) NEVER throws
// into the caller — it logs a warning and returns false.
async function send({ subject, text, html, to }) {
  if (!isConfigured()) return false;
  const recipient = to || NOTIFY_TO;
  if (!recipient) return false;
  // Abort the request if Resend stalls, so a fire-and-forget send can never hang
  // forever. The timer is always cleared in finally so it can't leak.
  const controller = new AbortController();
  let timer;
  try {
    // Non-prod (e.g. staging) sends are stamped as test emails; production and
    // local/unset stay untouched.
    const marked = markTestEnv({ subject, text, html });
    const body = {
      from: NOTIFY_FROM,
      to: [recipient],
      subject: marked.subject,
      text: marked.text,
    };
    if (marked.html != null) body.html = marked.html;
    // Route replies to the business inbox (Reply-To). Only sent when non-empty so
    // an unset/blank REPLY_TO never adds an empty header to the Resend payload.
    if (REPLY_TO) body.reply_to = REPLY_TO;
    timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn('[notify] send failed:', 'HTTP ' + res.status + (detail ? ' ' + detail : ''));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[notify] send failed:', e && e.message ? e.message : e);
    return false;
  } finally {
    clearTimeout(timer);
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

// Fire the Dugri-only "custom order needs hand-design" alert (to NOTIFY_TO).
// Called alongside sendOrderPaid for a paid bespoke order. `baseUrl` is the
// normalized public origin (optional). Never throws.
async function sendCustomOrderAlert(collection, baseUrl, options) {
  try {
    return await send(buildCustomOrderAlert(collection, baseUrl, options));
  } catch (e) {
    console.warn('[notify] sendCustomOrderAlert failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the BUYER confirmation to the customer's own email. Sent to the
// collection's owner_email (captured at checkout), NOT to NOTIFY_TO. Skips
// gracefully (returns false) when that address is missing/empty, and stays
// dormant like the others when Resend is unconfigured. `options` may carry
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

// Fire the customer "you haven't added words yet" reminder. Sent to the
// collection's owner_email (the buyer), NOT to NOTIFY_TO. Skips gracefully
// (returns false) when that address is missing/empty, and stays dormant like the
// others when Resend is unconfigured. `baseUrl` is the normalized public origin
// (optional). Never throws.
async function sendWordsReminder(collection, baseUrl) {
  try {
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (!to) return false;
    return await send({ ...buildWordsReminder(collection, baseUrl), to });
  } catch (e) {
    console.warn('[notify] sendWordsReminder failed:', e && e.message ? e.message : e);
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

// Fire the "PDF ready" notification. `links` is either a single string (legacy:
// the same link to everyone) or a { admin, customer } pair. Dugri (NOTIFY_TO)
// gets the admin link; the CUSTOMER (owner_email) gets the customer link — which
// carries a capability token, NEVER the admin key. Each recipient gets a message
// built with only their own link, so the admin secret can't leak in the customer
// email. Fully wrapped — never throws. Returns true when at least one send
// succeeded.
async function sendPdfReady(collection, baseUrl, links) {
  try {
    const adminLink = typeof links === 'string' ? links : (links && links.admin) || null;
    const customerLink = typeof links === 'string' ? links : (links && links.customer) || null;
    const ownerMsg = buildPdfReadyMessage(collection, adminLink, baseUrl);
    const owner = await send(ownerMsg); // -> NOTIFY_TO (Dugri)
    let client = false;
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (to && to.toLowerCase() !== String(NOTIFY_TO).toLowerCase()) {
      const clientMsg = buildPdfReadyMessage(collection, customerLink, baseUrl);
      client = await send({ ...clientMsg, to });
    }
    return owner || client;
  } catch (e) {
    console.warn('[notify] sendPdfReady failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the "production blocked — needs fixing" notification. Sends the same
// message to Dugri (NOTIFY_TO) AND, when present, the client (owner_email) —
// same fan-out and de-dupe as sendPdfReady. Fully wrapped — never throws.
// Returns true when at least one send succeeded.
async function sendProductionError(collection, baseUrl, problems) {
  try {
    const msg = buildProductionError(collection, baseUrl, problems);
    const owner = await send(msg); // -> NOTIFY_TO (Dugri)
    let client = false;
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (to && to.toLowerCase() !== String(NOTIFY_TO).toLowerCase()) {
      client = await send({ ...msg, to });
    }
    return owner || client;
  } catch (e) {
    console.warn('[notify] sendProductionError failed:', e && e.message ? e.message : e);
    return false;
  }
}

module.exports = {
  isConfigured,
  renderEmailHtml,
  buildPaidMessage,
  buildCustomOrderAlert,
  buildBuyerConfirmation,
  buildFinishedMessage,
  buildPdfReadyMessage,
  buildProductionError,
  buildWordsReminder,
  sendOrderPaid,
  sendCustomOrderAlert,
  sendBuyerConfirmation,
  sendOrderFinished,
  sendPdfReady,
  sendProductionError,
  sendWordsReminder,
};
