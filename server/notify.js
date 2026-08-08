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
// { label, url } — or an ARRAY of them — rendered as rounded buttons (the first
// filled, the rest outlined; see `buttons` below). `baseUrl` (the
// normalized public origin) is where the hosted logo is loaded from; without it
// the header falls back to the brand wordmark so the email still renders. `image`
// is an optional absolute URL for a hero product photo shown under the heading
// (with `imageAlt` as its alt text — so a client that can't render the format,
// e.g. WebP in Outlook desktop, still shows the design name). Returns a full,
// email-client-safe HTML document (RTL, inline CSS, tables).
function renderEmailHtml({ title, bodyLines, cta, baseUrl, image, imageAlt } = {}) {
  const logo = baseUrl
    ? `<img src="${escapeHtml(baseUrl + LOGO_PATH)}" width="120" alt="דוגרי" style="display:block;border:0;outline:none;text-decoration:none;height:auto;margin:0 auto;" />`
    : `<div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:1px;">דוגרי</div>`;

  const heading = title
    ? `<tr><td style="padding:0 32px 8px;text-align:center;font-size:22px;font-weight:800;color:${INK};">${escapeHtml(
        title
      )}</td></tr>`
    : '';

  // Optional hero product photo, centered and rounded. Alt text carries the
  // design name so a client that can't decode the image still conveys it.
  const hero = image
    ? `<tr><td style="padding:16px 32px 4px;text-align:center;"><img src="${escapeHtml(
        image
      )}" alt="${escapeHtml(
        imageAlt || 'דוגרי'
      )}" width="320" style="display:block;max-width:100%;height:auto;border:0;border-radius:12px;margin:0 auto;" /></td></tr>`
    : '';

  // Small logo icon above the sign-off (the branded "signature"). Rendered only
  // when we have a public origin to host it from.
  const footerLogo = baseUrl
    ? `<img src="${escapeHtml(
        baseUrl + LOGO_PATH
      )}" width="72" alt="דוגרי" style="display:block;border:0;outline:none;text-decoration:none;height:auto;margin:0 auto 10px;" />`
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

  // One or more CTAs. `cta` takes a single { label, url } OR an array of them —
  // the "file ready" email ships two (the card deck and the separate board file).
  // The first is the filled brand-pink pill; any further ones render as outlined
  // pills below it, so a one-CTA email is byte-identical to what it was before.
  const buttons = (Array.isArray(cta) ? cta : [cta])
    .filter((c) => c && c.url)
    .map((c, i) =>
      i === 0
        ? `<tr><td style="padding:24px 32px 8px;text-align:center;">
            <a href="${escapeHtml(
              c.url
            )}" style="display:inline-block;background:${BRAND_PINK};background-image:linear-gradient(135deg,${BRAND_PINK_LIGHT},${BRAND_PINK});color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 32px;border-radius:9999px;">${escapeHtml(
              c.label || 'המשך'
            )}</a>
          </td></tr>`
        : `<tr><td style="padding:8px 32px 0;text-align:center;">
            <a href="${escapeHtml(
              c.url
            )}" style="display:inline-block;background:#ffffff;border:2px solid ${BRAND_PINK};color:${BRAND_PINK};text-decoration:none;font-size:16px;font-weight:700;padding:12px 30px;border-radius:9999px;">${escapeHtml(
              c.label || 'המשך'
            )}</a>
          </td></tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title || 'דוגרי')}</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Assistant:wght@300;400;600;700&display=swap');
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" dir="rtl" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;font-family:'Assistant','Heebo',Arial,Helvetica,sans-serif;">
            <tr>
              <td style="background:linear-gradient(135deg,${BRAND_PINK_LIGHT},${BRAND_PINK});padding:28px 32px;text-align:center;">
                ${logo}
              </td>
            </tr>
            <tr><td style="height:20px;line-height:20px;font-size:20px;">&nbsp;</td></tr>
            ${heading}
            ${hero}
            ${paragraphs}
            ${buttons}
            <tr><td style="height:16px;line-height:16px;font-size:16px;">&nbsp;</td></tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid #eee;text-align:center;font-size:13px;line-height:1.6;color:${MUTED};">
                ${footerLogo}נתראה על הלוח,<br />צוות דוגרי
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Which settings store the builders read templates/labels from. Normally THE
// store; swapped only for the duration of a withSettings() call (see below).
let _store = settings;

// Render the mails against an ALTERNATIVE settings store for the duration of one
// SYNCHRONOUS call, then restore the real one. The admin message preview uses it
// to render an UNSAVED draft — the owner sees the mail as they type it — without
// writing that draft to the real store, which would make every keystroke a live
// change to what customers receive.
//
// Synchronous only, deliberately: the builders are pure and sync, and the swap is
// undone in `finally`. Wrapping an async fn would restore the store at the first
// await and leak the override into whatever ran in between. `store` must expose
// settings' read surface (get/interpolate); a falsy one is a no-op.
function withSettings(store, fn) {
  const prev = _store;
  _store = store || settings;
  try {
    return fn();
  } finally {
    _store = prev;
  }
}

// Owner-editable string groups (registry-backed; default to the current
// strings). Read fresh each build so an override takes effect without a restart.
function emailTpl(name) {
  return _store.get('email', name);
}
function versionLabels() {
  return _store.get('email', 'version_labels');
}
function fieldLabels() {
  return _store.get('email', 'field_labels');
}
function ctaLabels() {
  return _store.get('email', 'cta_labels');
}
function footer() {
  return _store.get('email', 'footer');
}
function deliveryInfo() {
  return _store.get('email', 'delivery_info');
}
function pickupInfo() {
  return _store.get('email', 'pickup_info');
}
function nextStep() {
  return _store.get('email', 'next_step');
}

// Format a stored delivery address object ({ street, city, postal, apartment,
// floor }) into a single readable Hebrew line, or '' when absent. Only the parts
// that are present are included, in a natural order.
function formatAddress(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const seg = [];
  if (addr.street) seg.push(String(addr.street).trim());
  if (addr.apartment) seg.push('דירה ' + String(addr.apartment).trim());
  if (addr.floor) seg.push('קומה ' + String(addr.floor).trim());
  if (addr.city) seg.push(String(addr.city).trim());
  if (addr.postal) seg.push(String(addr.postal).trim());
  return seg.filter(Boolean).join(', ');
}

// The buyer-facing fulfilment block for an order: a delivery block (approx time +
// shipping address) for a `delivery` order, or a self-pickup block (we'll email
// when ready + approx prep time + pickup address) for a `pickup` order. Returns
// [] for pdf/custom or a missing order. Every string is owner-editable via
// settings (delivery_info / pickup_info); the address comes from the order.
function fulfilmentLines(order) {
  if (!order) return [];
  const lines = [];
  if (order.version === 'delivery') {
    const d = deliveryInfo();
    if (d.eta) lines.push(d.eta);
    const addr = formatAddress(order.address);
    if (addr) lines.push((d.address_label ? d.address_label + ': ' : '') + addr);
  } else if (order.version === 'pickup') {
    const p = pickupInfo();
    if (p.ready) lines.push(p.ready);
    if (p.eta) lines.push(p.eta);
    if (p.address) lines.push((p.address_label ? p.address_label + ': ' : '') + p.address);
  }
  return lines;
}

// The fulfilment block as it appears in a BUYER email: the lines above, preceded
// by a blank separator, or [] when there is nothing to say. Kept as its own
// helper so the confirmation and the receipt can never format it differently.
function fulfilmentBlock(collection) {
  const fulfil = fulfilmentLines((collection && collection.order) || null);
  return fulfil.length ? ['', ...fulfil] : [];
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

// The order reference a human quotes back at us: the short order number
// ("DG-1042") when the collection carries one, else the raw collection id. Older
// collections predate order numbers and a receipt still needs SOME reference, so
// the id remains the fallback rather than printing an empty line.
function orderRef(collection) {
  if (!collection) return '';
  return String(collection.order_no || collection.id || '');
}

// The order-reference stamp for a BUYER email: a blank separator and one
// "מספר הזמנה: DG-1042" line, or [] when there is nothing to stamp.
//
// GATED ON PAYMENT, and that gate is the whole point. Every collection is
// stamped with an order number the moment it is created — including one from
// somebody who only ever started a free word list and never ordered anything.
// Quoting a number at that person is worse than saying nothing: it tells them
// they have an order they do not have. So the payment receipt is the FIRST mail
// that carries a reference, and everything before it (the confirmation, the
// free-quota notice, the words and payment reminders) carries none.
//
// After payment it is exactly what a customer quotes when they write in, so it
// rides on every later mail. Returned as body lines rather than appended to the
// plain text, so the number appears in the branded HTML too.
function orderRefLine(collection) {
  if (!orderPaid(collection)) return [];
  const ref = orderRef(collection);
  if (!ref) return [];
  return ['', fieldLabels().orderId + ': ' + ref];
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

// The same link with `pay=1`, which makes the collect page OPEN its checkout on
// arrival instead of landing on the word list with the pay panel folded shut.
// Used by the buyer emails whose next step is payment: a "complete your payment"
// button has to land ON the payment, not near it. Null whenever ownerLink is.
function payLink(collection, baseUrl) {
  const link = ownerLink(collection, baseUrl);
  return link ? link + '&pay=1' : null;
}

// Is this collection's order already paid? Drives which closing line + CTA a
// buyer email gets. Treated as UNPAID when there is no order yet — the order
// confirmation fires when a collection is created, often before any version is
// chosen, and payment is exactly what is missing at that point.
function orderPaid(collection) {
  return !!(collection && collection.order && collection.order.paid);
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

// The copies breakdown for an order-detail block: how many decks, the per-copy
// price, and the one-time shipping fee. Returns [] for an ordinary single-copy
// order (and for orders placed before copies existed, which carry no quantity) so
// nothing changes on the receipts that dominate.
function copyLines(order) {
  const qty = order && Number.isInteger(order.quantity) ? order.quantity : 1;
  if (qty <= 1) return [];
  const f = fieldLabels();
  const out = [f.copies + ': ' + qty];
  if (Number.isInteger(order.unit_price)) {
    out.push(f.unitPrice + ': ' + order.unit_price + ' ' + f.currency);
  }
  if (Number.isInteger(order.delivery_fee) && order.delivery_fee > 0) {
    out.push(f.shipping + ': ' + order.delivery_fee + ' ' + f.currency);
  }
  return out;
}

// Shared body lines (order details) used by both messages. `options` may carry
// `amountCharged` (the real charged amount) — see amountLines.
function orderLines(collection, baseUrl, options) {
  const lines = [];
  const f = fieldLabels();
  const order = (collection && collection.order) || null;
  const ref = orderRef(collection);
  if (ref) lines.push(f.orderId + ': ' + ref);
  if (order) {
    const label = versionLabelFor(order.version);
    lines.push(f.version + ': ' + label);
    // Copies + the arithmetic behind the total. Shown ONLY for a multi-copy order:
    // "מספר עותקים: 1" on every single-deck receipt would be noise. The print
    // instruction depends on this line, so it must never be silently dropped.
    lines.push(...copyLines(order));
    lines.push(...amountLines(order, options, f.amount));
    // A delivery order carries a shipping address — surface it so the owner can
    // fulfil without opening the panel.
    if (order.version === 'delivery') {
      const addr = formatAddress(order.address);
      if (addr) lines.push('כתובת למשלוח: ' + addr);
    }
  }
  const wc = wordCount(collection);
  if (wc != null) lines.push(f.wordCount + ': ' + wc);
  // Her own note, when she left one. It goes near the bottom on purpose: it is
  // the one line here she WROTE rather than chose, so it reads last and reads
  // whole — the newlines are kept, because a note is often a short list.
  const note = collection && collection.comment ? String(collection.comment).trim() : '';
  if (note) lines.push(f.comment + ': ' + note);
  const link = ownerLink(collection, baseUrl);
  if (link) lines.push(f.ownerLink + ': ' + link);
  // One-click link to the admin orders panel (built by the caller with the admin
  // key; the mail module never sees the secret). Present only when passed.
  const adminLink = options && options.adminLink ? String(options.adminLink) : '';
  if (adminLink) lines.push(f.adminOrder + ': ' + adminLink);
  return lines;
}

// Interpolation values for the owner emails. Beyond {honoree}, exposes the
// {orderId}, {link} (collect/management link) and {adminLink} (admin orders
// panel) tokens the owner can drop anywhere in the subject/body. Missing values
// resolve to '' (not null) so an unavailable token vanishes rather than rendering
// literally as "{adminLink}".
function ownerTokenValues(collection, baseUrl, options, name) {
  return {
    honoree: name,
    orderId: orderRef(collection),
    link: ownerLink(collection, baseUrl) || '',
    adminLink: options && options.adminLink ? String(options.adminLink) : '',
  };
}

// Pure builder: the "order paid" email. `baseUrl` is the normalized public
// origin (optional; the owner link is omitted without it). `options` may carry
// `amountCharged` — the amount actually paid (0 for a free 100%-coupon order).
// Returns {subject,text}.
function buildPaidMessage(collection, baseUrl, options) {
  const name = honoreeName(collection);
  const tpl = emailTpl('order_paid');
  const values = ownerTokenValues(collection, baseUrl, options, name);
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
  const values = ownerTokenValues(collection, baseUrl, options, name);
  const subject = interpolate(tpl.subject, values);
  const text = [
    ...interpolate(tpl.body, values).split('\n'),
    '',
    ...orderLines(collection, baseUrl, options),
  ].join('\n');
  return { subject, text };
}

// Pure builder: the BUYER's confirmation email — sent to the customer (not the
// owner) when their order is created. Warm, on-brand, RTL-friendly: a thank-you,
// a PHOTO of the template they chose, how they will receive it, and the CTA.
//
// It deliberately carries NO itemised order details (order id, package, price,
// design, colour). What they bought is SHOWN rather than listed — the picture is
// the point, and a price/spec table under it reads like an invoice, not a
// confirmation. The owner's own copy (buildPaidMessage -> orderLines) still has
// the full breakdown including the shipping address, so nothing operational is
// lost. `baseUrl` is the normalized public origin (optional; the link is omitted
// without it). `options.productImageUrl` is the template photo, resolved by the
// caller. Returns {subject, text, html}.
function buildBuyerConfirmation(collection, baseUrl, options) {
  const name = honoreeName(collection);
  const tpl = emailTpl('buyer_confirmation');
  const cta = ctaLabels();
  const ft = footer();
  const step = nextStep();
  // This mail fires at ORDER CREATION, so the buyer's next step is PAYING: the
  // closing line and the button both point at the checkout, and the link carries
  // pay=1 so the collect page opens it rather than making them find it. The
  // add-words pair is kept for the one case where that would be wrong — an order
  // already paid when the mail goes out (a 100% coupon).
  const paid = orderPaid(collection);
  const link = paid ? ownerLink(collection, baseUrl) : payLink(collection, baseUrl);
  const closing = paid ? step.words : step.pay;
  const ctaLabel = paid ? cta.addWords : cta.pay;
  // {link} is available to the owner inside the template body; '' when absent so
  // it vanishes rather than rendering literally.
  const values = { honoree: name, link: link || '' };
  const subject = interpolate(tpl.subject, values);
  const lines = interpolate(tpl.body, values).split('\n');
  // The ONLY block kept from the old order-details section: how they receive the
  // game. That is not an order detail but the buyer's instructions — it is the
  // only place they are told where and when to collect it.
  lines.push(...fulfilmentBlock(collection));
  // Branded HTML mirrors the plain-text body but drops the raw URL line — the
  // link becomes the CTA button. Everything above the link is reused as-is.
  const htmlLines = lines.slice();
  if (link) {
    lines.push('');
    lines.push(closing);
    lines.push(link);
    htmlLines.push('');
    htmlLines.push(closing);
  }
  lines.push('');
  lines.push(ft.line1);
  lines.push(ft.line2);
  const html = renderEmailHtml({
    title: 'ההזמנה שלכם התקבלה — ' + name,
    bodyLines: htmlLines,
    cta: link ? { label: ctaLabel, url: link } : null,
    baseUrl,
    // The template product photo (owner override or catalog thumbnail), resolved
    // by the caller and passed through options; alt text is the chosen design.
    image: options && options.productImageUrl ? String(options.productImageUrl) : null,
    imageAlt: collection && collection.design ? String(collection.design) : name,
  });
  return { subject, text: lines.join('\n'), html };
}

// Pure builder: the OWNER's "payment received" receipt — fired at the real
// unpaid->paid transition (card callback, free 100%-coupon order, or a manual
// admin mark-paid), NOT at order creation (that's buildPaidMessage, whose legacy
// name predates this split). `options` carries `amountCharged` — what the
// customer ACTUALLY paid after any coupon; without it the order's pre-coupon
// total is shown. `baseUrl` is the normalized public origin (optional).
// Returns {subject, text}.
function buildPaymentReceipt(collection, baseUrl, options) {
  const name = honoreeName(collection);
  const tpl = emailTpl('payment_received');
  const values = ownerTokenValues(collection, baseUrl, options, name);
  const subject = interpolate(tpl.subject, values);
  const text = [
    ...interpolate(tpl.body, values).split('\n'),
    '',
    ...orderLines(collection, baseUrl, options),
  ].join('\n');
  return { subject, text };
}

// Pure builder: the BUYER's payment receipt — sent to the customer at the real
// unpaid->paid transition. Same branded shell as the order confirmation (logo,
// hero product photo, add-words CTA button) so the two read as one series, and
// like the confirmation it shows the template rather than itemising the order
// (see buildBuyerConfirmation for why). `options` may carry `productImageUrl`
// (resolved by the caller). Returns {subject, text, html}.
function buildBuyerReceipt(collection, baseUrl, options) {
  const name = honoreeName(collection);
  const tpl = emailTpl('buyer_payment_received');
  const cta = ctaLabels();
  const ft = footer();
  const link = ownerLink(collection, baseUrl);
  // {link} is available to the owner inside the template body; '' when absent so
  // it vanishes rather than rendering literally.
  const values = { honoree: name, link: link || '' };
  const subject = interpolate(tpl.subject, values);
  const lines = interpolate(tpl.body, values).split('\n');
  lines.push(...fulfilmentBlock(collection));
  lines.push(...orderRefLine(collection));
  // Branded HTML mirrors the plain-text body but drops the raw URL line — the
  // link becomes the CTA button. Everything above the link is reused as-is.
  const htmlLines = lines.slice();
  if (link) {
    lines.push('');
    // Payment is done by the time this receipt goes out, so the next step here
    // really is the word list (owner-editable, shared with the confirmation).
    lines.push(nextStep().words);
    lines.push(link);
    htmlLines.push('');
    htmlLines.push(nextStep().words);
  }
  lines.push('');
  lines.push(ft.line1);
  lines.push(ft.line2);
  const html = renderEmailHtml({
    title: 'התשלום התקבל — ' + name,
    bodyLines: htmlLines,
    cta: link ? { label: cta.addWords, url: link } : null,
    baseUrl,
    // The template product photo (owner override or catalog thumbnail), resolved
    // by the caller and passed through options; alt text is the chosen design.
    image: options && options.productImageUrl ? String(options.productImageUrl) : null,
    imageAlt: collection && collection.design ? String(collection.design) : name,
  });
  return { subject, text: lines.join('\n'), html };
}

// Pure builder: the BUYER's "we've got your list, production has started" email —
// fired the moment they close word collection with "סיום — התחילו להפיק".
//
// It carries NO link and no CTA on purpose: the collection is closed, there is
// nothing left for them to do, and the next thing they need is us telling them
// the game is ready. This is the mail that replaced pdf_ready ("download your
// file"), which stopped making sense once the product shipped as a printed game
// rather than a PDF.
//
// `wordCount` comes off the collection (the close routes stamp it), and is worth
// echoing back: it is the one number that tells them their whole list arrived.
// `baseUrl` is used only to host the branded logo. Returns {subject, text, html}.
function buildProductionStarted(collection, baseUrl) {
  const name = honoreeName(collection);
  const tpl = emailTpl('buyer_production_started');
  const ft = footer();
  const count = wordCount(collection);
  const values = { honoree: name, wordCount: count == null ? '' : count };
  const subject = interpolate(tpl.subject, values);
  const bodyLines = interpolate(tpl.body, values).split('\n');
  // The order reference, on every buyer mail from the payment receipt onward.
  bodyLines.push(...orderRefLine(collection));
  const lines = [...bodyLines, '', ft.line1, ft.line2];
  const html = renderEmailHtml({
    title: 'מתחילים להכין את המשחק — ' + name,
    bodyLines,
    cta: null,
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

// The fulfilment half of the "your order is ready" mail: what happens NOW, which
// is a genuinely different promise per version rather than a wording tweak —
// self-pickup is "come and get it", delivery is "it's on its way". Both wordings
// are owner-editable (settings email.order_ready_info); only the plumbing is
// here. Returns [] for a version with no promise to make (pdf/custom), so the
// mail is still sendable for them, just without a fulfilment paragraph.
//
// The pickup ADDRESS is read from pickup_info, which already holds it and is
// already editable — the ready mail must never carry a second copy that can
// drift out of step with the one on the confirmation.
function orderReadyFulfilment(order) {
  const info = _store.get('email', 'order_ready_info') || {};
  const version = order && order.version;
  if (version === 'pickup') {
    const p = pickupInfo();
    const out = info.pickup ? [info.pickup] : [];
    if (p.address) out.push((p.address_label ? p.address_label + ': ' : '') + p.address);
    return out;
  }
  if (version === 'delivery') {
    const out = info.delivery ? [info.delivery] : [];
    const addr = formatAddress(order.address);
    const d = deliveryInfo();
    if (addr) out.push((d.address_label ? d.address_label + ': ' : '') + addr);
    return out;
  }
  return [];
}

// How many copies are ready, when that is worth saying. Omitted entirely for an
// ordinary single-copy order (and for orders placed before copies existed) —
// "1 עותקים מוכנים" would be noise; "5 עותקים מוכנים" matters a lot to someone
// about to carry a box home. Owner-editable, interpolated with {count}.
function orderReadyCopies(order) {
  const qty = order && Number.isInteger(order.quantity) ? order.quantity : 1;
  if (qty <= 1) return [];
  const info = _store.get('email', 'order_ready_info') || {};
  const text = interpolate(info.copies || '', { count: qty });
  return text ? [text] : [];
}

// Pure builder: the BUYER's "your game is ready" email — fired by the owner
// marking the order ready on the admin orders page. The last mail in the flow:
// buyer_production_started said "we've started", this one says "it's done, here
// is how you get it".
//
// Shape: the owner-editable greeting, then the per-version fulfilment promise
// (+ address), then the copies line when there is more than one, then the order
// reference, then an ordinary CTA to their collection page. `baseUrl` is the
// normalized public origin. Returns {subject, text, html}.
function buildOrderReady(collection, baseUrl) {
  const name = honoreeName(collection);
  const tpl = emailTpl('order_ready');
  const cta = ctaLabels();
  const ft = footer();
  const order = (collection && collection.order) || null;
  const link = ownerLink(collection, baseUrl);
  const values = { honoree: name, link: link || '' };
  const subject = interpolate(tpl.subject, values);
  const bodyLines = interpolate(tpl.body, values).split('\n');
  const fulfil = orderReadyFulfilment(order);
  if (fulfil.length) bodyLines.push('', ...fulfil);
  const copies = orderReadyCopies(order);
  if (copies.length) bodyLines.push('', ...copies);
  bodyLines.push(...orderRefLine(collection));
  // Branded HTML mirrors the body but drops the raw URL line — the link becomes
  // the CTA button, exactly as in the other buyer mails.
  const lines = bodyLines.slice();
  if (link) {
    lines.push('');
    lines.push(link);
  }
  lines.push('');
  lines.push(ft.line1);
  lines.push(ft.line2);
  const html = renderEmailHtml({
    title: 'המשחק מוכן — ' + name,
    bodyLines,
    cta: link ? { label: cta.viewOrder, url: link } : null,
    baseUrl,
  });
  return { subject, text: lines.join('\n'), html };
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
  const ref = orderRefLine(collection);
  const lines = [...bodyLines, '', ...items, ...ref];
  const link = ownerLink(collection, baseUrl);
  // HTML mirrors the same intro + problem list; the owner link becomes the CTA.
  const htmlLines = [...bodyLines, '', ...items, ...ref];
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
  // The order reference, on every buyer mail from the payment receipt onward.
  bodyLines.push(...orderRefLine(collection));
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

// Pure builder: the "your order is still waiting for payment" reminder — sent to
// the buyer when an order has sat unpaid past the configured delay. The CTA links
// to the buyer's own pay page (the collect page with their owner token, which
// carries the pay panel). `baseUrl` (optional) builds the link + hosted logo.
// Returns {subject, text, html}.
function buildPaymentReminder(collection, baseUrl) {
  const name = honoreeName(collection);
  const tpl = emailTpl('payment_reminder');
  const cta = ctaLabels();
  const ft = footer();
  const values = { honoree: name };
  const subject = interpolate(tpl.subject, values);
  const bodyLines = interpolate(tpl.body, values).split('\n');
  // The order reference, on every buyer mail from the payment receipt onward.
  bodyLines.push(...orderRefLine(collection));
  const lines = bodyLines.slice();
  const link = ownerLink(collection, baseUrl);
  if (link) {
    lines.push('');
    lines.push('להשלמת התשלום:');
    lines.push(link);
  }
  lines.push('');
  lines.push(ft.line1);
  lines.push(ft.line2);
  const html = renderEmailHtml({
    title: 'ההזמנה שלך ממתינה לתשלום — ' + name,
    bodyLines,
    cta: link ? { label: cta.pay, url: link } : null,
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

// Pure builder: a generic owner "system alert" (Hebrew). Used for operational
// escalations that need a human — e.g. a paid WhatsApp order whose buyer could
// neither be added to their word-collection group nor DM'd an invite, so the
// owner must step in manually. `subject` is a short Hebrew summary; `lines` is a
// string or an array of Hebrew body lines. Returns {subject, text} — the same
// shape as the other builders. Never throws.
function buildSystemAlert(subject, lines) {
  const subj = 'דוגרי · ' + String(subject == null || subject === '' ? 'התראת מערכת' : subject);
  const body = (Array.isArray(lines) ? lines : [lines])
    .map((l) => String(l == null ? '' : l))
    .join('\n');
  return { subject: subj, text: body };
}

// --- the send wrappers --------------------------------------------------------
// Each one below opens with `if (!settings.emailEnabled('<key>')) return false;`
// — the owner's per-message switch, edited on the admin texts page next to that
// message's own subject and body (the email counterpart to a WhatsApp trigger's
// `enabled`). It gates ONE message: turning off, say, the words reminder leaves
// every receipt sending. A skipped send returns false, exactly like being
// unconfigured or having no recipient, so no caller has to learn a new result.
//
// Two sends here are deliberately NOT gated. sendSystemAlert is an operational
// escalation to the owner (e.g. a paid order whose buyer could not be reached at
// all) — not a message the owner composes, and switching it off would silence
// the very alert that says something needs a human. sendReminderEmail renders
// the owner-managed reminder LIST, where each reminder already carries its own
// `enabled` (server/reminders.js); a second switch over the same thing would
// only be a second place to look when a reminder doesn't arrive.

// Fire a generic owner system alert to NOTIFY_TO. Dormant (returns false) when
// Resend is unconfigured, like every other send. Fully wrapped — never throws.
async function sendSystemAlert(subject, lines) {
  try {
    return await send(buildSystemAlert(subject, lines));
  } catch (e) {
    console.warn('[notify] sendSystemAlert failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the "order paid" notification. `baseUrl` is the normalized public origin
// (optional). `options` may carry `amountCharged` (the amount actually paid).
// Never throws.
async function sendOrderPaid(collection, baseUrl, options) {
  try {
    if (!settings.emailEnabled('order_paid')) return false;
    return await send(buildPaidMessage(collection, baseUrl, options));
  } catch (e) {
    console.warn('[notify] sendOrderPaid failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the OWNER's payment receipt to NOTIFY_TO, at the real unpaid->paid
// transition. `options` carries `amountCharged` (what was actually charged).
// Never throws.
async function sendPaymentReceipt(collection, baseUrl, options) {
  try {
    if (!settings.emailEnabled('payment_received')) return false;
    return await send(buildPaymentReceipt(collection, baseUrl, options));
  } catch (e) {
    console.warn('[notify] sendPaymentReceipt failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the BUYER's payment receipt to the customer's own email (the collection's
// owner_email captured at checkout), NOT to NOTIFY_TO. Skips gracefully (returns
// false) when that address is missing/empty, and stays dormant like the others
// when Resend is unconfigured. Never throws.
async function sendBuyerReceipt(collection, baseUrl, options) {
  try {
    if (!settings.emailEnabled('buyer_payment_received')) return false;
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (!to) return false;
    return await send({ ...buildBuyerReceipt(collection, baseUrl, options), to });
  } catch (e) {
    console.warn('[notify] sendBuyerReceipt failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the Dugri-only "custom order needs hand-design" alert (to NOTIFY_TO).
// Called alongside sendOrderPaid for a paid bespoke order. `baseUrl` is the
// normalized public origin (optional). Never throws.
async function sendCustomOrderAlert(collection, baseUrl, options) {
  try {
    if (!settings.emailEnabled('custom_order_alert')) return false;
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
    if (!settings.emailEnabled('buyer_confirmation')) return false;
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
    if (!settings.emailEnabled('words_reminder')) return false;
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (!to) return false;
    return await send({ ...buildWordsReminder(collection, baseUrl), to });
  } catch (e) {
    console.warn('[notify] sendWordsReminder failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the "complete your payment" reminder to the buyer (owner_email). Skips
// gracefully when that address is missing, and stays dormant when Resend is
// unconfigured. `baseUrl` is the normalized public origin (optional). Never throws.
async function sendPaymentReminder(collection, baseUrl) {
  try {
    if (!settings.emailEnabled('payment_reminder')) return false;
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (!to) return false;
    return await send({ ...buildPaymentReminder(collection, baseUrl), to });
  } catch (e) {
    console.warn('[notify] sendPaymentReminder failed:', e && e.message ? e.message : e);
    return false;
  }
}

// The "you've filled the free word quota" email — sent ONCE, the moment the
// collection reaches pricing.free_word_limit. Carries the pay CTA on the owner
// link (the same link the pay panel lives on). `limit` is the quota reached.
function buildFreeLimitReached(collection, baseUrl, limit) {
  const name = honoreeName(collection);
  const tpl = emailTpl('free_limit_reached');
  const cta = ctaLabels();
  const ft = footer();
  const values = { honoree: name, limit };
  const subject = interpolate(tpl.subject, values);
  const bodyLines = interpolate(tpl.body, values).split('\n');
  const lines = bodyLines.slice();
  const link = ownerLink(collection, baseUrl);
  if (link) {
    lines.push('');
    lines.push('להשלמת התשלום ולהמשך האיסוף:');
    lines.push(link);
  }
  lines.push('');
  lines.push(ft.line1);
  lines.push(ft.line2);
  const html = renderEmailHtml({
    title: limit + ' מילים בפנים — ' + name,
    bodyLines,
    cta: link ? { label: cta.pay, url: link } : null,
    baseUrl,
  });
  return { subject, text: lines.join('\n'), html };
}

// Fire the one-time "free quota reached" email to the BUYER. Never throws; the
// once-only guard lives in db.markFreeLimitNotified, not here.
async function sendFreeLimitReached(collection, baseUrl, limit) {
  try {
    if (!settings.emailEnabled('free_limit_reached')) return false;
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (!to) return false;
    return await send({ ...buildFreeLimitReached(collection, baseUrl, limit), to });
  } catch (e) {
    console.warn('[notify] sendFreeLimitReached failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the "order finished" notification. `baseUrl` is the normalized public
// origin (optional). Never throws.
async function sendOrderFinished(collection, baseUrl) {
  try {
    if (!settings.emailEnabled('order_finished')) return false;
    return await send(buildFinishedMessage(collection, baseUrl));
  } catch (e) {
    console.warn('[notify] sendOrderFinished failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the BUYER's "production has started" mail — the customer-facing half of
// closing a collection (the owner's half is sendOrderFinished, above; both fire
// from the same close transition). Goes to the buyer's own address only, and is a
// no-op when they gave none. Fully wrapped — never throws.
async function sendProductionStarted(collection, baseUrl) {
  try {
    if (!settings.emailEnabled('buyer_production_started')) return false;
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (!to) return false;
    return await send({ ...buildProductionStarted(collection, baseUrl), to });
  } catch (e) {
    console.warn('[notify] sendProductionStarted failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the BUYER's "your order is ready" mail. Called by the admin orders page
// when the owner marks an order ready; this module owns the message, not the
// trigger. Goes to the buyer's own address only. Returns false — never throws —
// when there is no buyer address, the template is switched off, or Resend is
// unconfigured, matching every other sender here.
//
// DELIBERATELY NOT IDEMPOTENT. The owner can un-mark an order and mark it ready
// again, and that DOES re-send: the second press is a real signal (a re-print, a
// corrected pickup date, a customer who says they never got it), and a silent
// no-op would leave the owner pressing a button that does nothing with no way to
// tell. Anything that should fire only once has to be guarded at the call site,
// not here.
async function sendOrderReady(collection, baseUrl) {
  try {
    if (!settings.emailEnabled('order_ready')) return false;
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (!to) return false;
    return await send({ ...buildOrderReady(collection, baseUrl), to });
  } catch (e) {
    console.warn('[notify] sendOrderReady failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Fire the "production blocked — needs fixing" notification. Sends the same
// message to Dugri (NOTIFY_TO) AND, when present, the client (owner_email),
// de-duped so one address never gets it twice. Fully wrapped — never throws.
// Returns true when at least one send succeeded.
async function sendProductionError(collection, baseUrl, problems) {
  try {
    if (!settings.emailEnabled('production_error')) return false;
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

// Send ONE owner-list reminder over email. `rawText` is the reminder's own body
// (from server/reminders.js), which may contain {honoree} and {link}. We
// interpolate {honoree}, strip the {link} token from the body, and render the
// collect link as a proper CTA button instead — so the email reads cleanly rather
// than showing a raw URL mid-sentence. Sent to the buyer (owner_email). Fail-soft:
// returns false (never throws) when email is off / no recipient / send fails.
// Pure builder: ONE reminder from the owner-managed reminder list
// (settings reminders.list, scheduled by server/reminders.js). Unlike the other
// templates the text is not a registry key — it is whatever the owner typed on
// that reminder — so `rawText` is passed in. {honoree} is interpolated; a {link}
// token is STRIPPED rather than substituted, because the link is rendered as the
// CTA button / a trailing line, and leaving it inline would print the URL twice.
// Extracted from the sender so the admin preview can render this message through
// exactly the same code the send path uses. Returns {subject, text, html}.
function buildReminderEmail(collection, rawText, baseUrl) {
  const name = honoreeName(collection);
  const link = ownerLink(collection, baseUrl);
  let body = interpolate(String(rawText || ''), { honoree: name });
  body = body
    .replace(/\{link\}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const bodyLines = body ? body.split('\n') : [];
  // The order reference, on every buyer mail from the payment receipt onward.
  bodyLines.push(...orderRefLine(collection));
  const ft = footer();
  const lines = bodyLines.slice();
  if (link) {
    lines.push('');
    lines.push('להוספת המילים:');
    lines.push(link);
  }
  lines.push('');
  lines.push(ft.line1);
  lines.push(ft.line2);
  const html = renderEmailHtml({
    title: 'תזכורת · ' + name,
    bodyLines,
    cta: link ? { label: ctaLabels().addWords, url: link } : null,
    baseUrl,
  });
  return { subject: 'דוגרי · תזכורת על ' + name, text: lines.join('\n'), html };
}

async function sendReminderEmail(collection, rawText, baseUrl) {
  try {
    const to = collection && collection.owner_email ? String(collection.owner_email).trim() : '';
    if (!to) return false;
    return await send({ ...buildReminderEmail(collection, rawText, baseUrl), to });
  } catch (e) {
    console.warn('[notify] sendReminderEmail failed:', e && e.message ? e.message : e);
    return false;
  }
}

module.exports = {
  isConfigured,
  withSettings,
  renderEmailHtml,
  buildPaidMessage,
  buildCustomOrderAlert,
  buildBuyerConfirmation,
  buildPaymentReceipt,
  buildBuyerReceipt,
  buildFinishedMessage,
  buildProductionStarted,
  buildOrderReady,
  buildProductionError,
  buildWordsReminder,
  buildPaymentReminder,
  buildFreeLimitReached,
  buildReminderEmail,
  buildSystemAlert,
  sendSystemAlert,
  sendOrderPaid,
  sendCustomOrderAlert,
  sendBuyerConfirmation,
  sendPaymentReceipt,
  sendBuyerReceipt,
  sendOrderFinished,
  sendProductionStarted,
  sendOrderReady,
  sendProductionError,
  sendWordsReminder,
  sendPaymentReminder,
  sendFreeLimitReached,
  sendReminderEmail,
};
