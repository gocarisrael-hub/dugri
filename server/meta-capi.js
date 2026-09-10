// meta-capi.js — the Meta Conversions API: the sale, reported from our server.
//
// WHY. The browser pixel is the only thing that has ever told Meta a sale
// happened, and the browser is exactly where that message gets lost: an iOS
// buyer who declined tracking, a content blocker, a in-app browser that drops
// third-party scripts, a tab closed before the beacon left. Every one of those
// is a real order that Ads Manager never counts — so the campaign looks worse
// than it is, and Meta optimises delivery towards the wrong people, which costs
// money twice.
//
// The Conversions API is the server's copy of the same event. It leaves our box,
// not the buyer's, so nothing on the buyer's device can suppress it.
//
// DEDUPLICATION is the whole game. Both halves send the SAME event_id (the order
// number), and Meta keeps one. Without that, a sale seen by both would count
// twice and every number downstream — ROAS included — would be inflated.
//
// DORMANT until armed: with no META_CAPI_TOKEN in the environment nothing is
// sent and nothing is attempted. This is the state the site ships in.
const crypto = require('crypto');

// Meta's Graph version. Pinned deliberately: an unpinned version changes the
// payload contract underneath us on Meta's schedule, and a silently rejected
// purchase event is invisible until someone reads the ad account.
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const TIMEOUT_MS = Number(process.env.META_CAPI_TIMEOUT_MS || 6000);

/** Is the API armed? Needs both halves: a pixel to send to and a token to send with. */
function isArmed({ pixelId, token } = {}) {
  return Boolean(pixelId && /^\d{5,20}$/.test(String(pixelId)) && token);
}

// Meta requires every piece of contact information to arrive SHA-256 hashed,
// lowercased and trimmed — it is matched against hashes on their side and the
// plain value is never sent. A phone is reduced to digits with the country code,
// since '052-244-1334' and '+972552441334' must hash to the same person.
function hashed(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  if (!v) return null;
  return crypto.createHash('sha256').update(v).digest('hex');
}

/**
 * A phone number reduced to the bare international digits Meta matches on.
 *
 * This mirrors ilPhoneToWaId() in server/index.js, which is the form the shop
 * already normalises a buyer's number into for WhatsApp — the same four cases,
 * in the same order, because two different answers to "what is this person's
 * number?" is exactly how a hash silently stops matching anything:
 *   • '00972…' is an international dialling prefix, stripped FIRST so it is not
 *     mistaken for a local leading 0 and doubled into '9720972…';
 *   • '+…' is already international and is left alone (a redundant 0 after a
 *     972 country code is dropped);
 *   • a local '05x…' becomes '9725x…';
 *   • a bare national number gets the country code — this shop sells in Israel,
 *     and the same assumption the WhatsApp id makes is the right one here.
 * Returns '' for anything with no digits in it.
 */
function normalisedPhone(value) {
  const raw = String(value || '').trim();
  // A leading '+' (or a '00' prefix) says the number is ALREADY international:
  // whatever country it belongs to, no country code may be added to it.
  let international = raw.startsWith('+');
  let s = raw.replace(/\D/g, '');
  if (!s) return '';
  // '00' is the international dialling prefix. Stripped FIRST — and then the
  // rest is re-examined, because '00972-052-…' still has a redundant local 0
  // sitting behind the country code.
  if (s.startsWith('00')) {
    s = s.slice(2);
    international = true;
  }
  if (s.startsWith('972')) return '972' + s.slice(3).replace(/^0+/, '');
  if (international) return s;
  if (s.startsWith('0')) return '972' + s.replace(/^0+/, '');
  return '972' + s;
}

function hashedPhone(value) {
  const digits = normalisedPhone(value);
  if (!digits) return null;
  return hashed(digits);
}

/**
 * Meta's click id in the form the API expects: `fb.1.<unix ms>.<fbclid>`.
 * Built from the landing URL we already store, so a buyer whose browser dropped
 * the _fbc cookie is still matched to the click that brought them.
 * Returns null when the URL carries no fbclid.
 */
function fbcFrom(landing, at = Date.now()) {
  let fbclid = '';
  try {
    fbclid = new URL(String(landing)).searchParams.get('fbclid') || '';
  } catch {
    return null;
  }
  if (!fbclid) return null;
  return `fb.1.${at}.${fbclid}`;
}

// Meta's own _fbc / _fbp, read from the request the BUYER's browser made — they
// are first-party cookies on our own domain, so the server can pick them up
// without the page having to hand them over. This is what lets the sale be
// reported from the payment callback, where no page exists at all.
// Returns {} for a request that carries neither.
function fbCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== '_fbc' && name !== '_fbp') continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* a cookie that is not valid percent-encoding is used as it stands */
    }
    if (value) out[name.slice(1)] = value.slice(0, 255);
  }
  return out;
}

/**
 * Build the event payload for one purchase. Pure — no I/O, no clock unless one
 * is passed — so the shape can be asserted without touching the network.
 *
 * `contact` (email/phone) is included ONLY when the caller passes it, which the
 * route does only when the owner has switched contact matching on. Everything
 * else here is either the order's own money or the click that produced it.
 *
 * USER_DATA IS NEVER EMPTY. Meta requires at least one customer-information
 * parameter and rejects the whole event (error 100) without one — and the buyer
 * this feature exists for, the one whose pixel never loaded, is precisely the
 * buyer with no _fbc and no _fbp. So `externalId` — our own order id, hashed —
 * always goes: Meta counts an external id as one of the identifiers that satisfy
 * the requirement, and it is the only one of them that describes a sale rather
 * than a person. `client_ip_address` and `client_user_agent` ride along as well;
 * Meta documents client_user_agent as REQUIRED for a website event, and both
 * improve matching.
 */
function purchaseEvent({
  orderNo,
  value,
  currency = 'ILS',
  landing = '',
  sourceUrl = '',
  fbp = '',
  fbc = '',
  ip = '',
  userAgent = '',
  externalId = '',
  contact = {},
  at = Date.now(),
  // When the click was OBSERVED, for a _fbc we have to rebuild ourselves. The
  // purchase instant is the wrong answer — the touch that produced the sale is
  // routinely days old — so the caller passes the earliest moment it can prove
  // it saw this landing URL, and only falls back to `at` with nothing better.
  clickAt = 0,
} = {}) {
  const user_data = {};
  const click = fbc || fbcFrom(landing, clickAt || at);
  if (click) user_data.fbc = click;
  if (fbp) user_data.fbp = String(fbp);
  // Our own id for this sale, hashed like every other identifier so the store's
  // ids never leave in the clear. Always present, which is what guarantees the
  // event carries a match key even when nothing else survived the browser.
  const ext = hashed(externalId || orderNo);
  if (ext) user_data.external_id = [ext];
  if (ip) user_data.client_ip_address = String(ip);
  if (userAgent) user_data.client_user_agent = String(userAgent).slice(0, 500);
  const em = hashed(contact.email);
  if (em) user_data.em = [em];
  const ph = hashedPhone(contact.phone);
  if (ph) user_data.ph = [ph];

  return {
    event_name: 'Purchase',
    // Seconds, not milliseconds — Meta rejects an event whose time is in the
    // future, which a millisecond value always is when read as seconds.
    event_time: Math.floor(at / 1000),
    // THE DEDUPLICATION KEY. The browser pixel sends the same string as its
    // eventID; Meta keeps one of the two. It must be the order number and
    // nothing else — a random id per send would defeat the whole mechanism.
    event_id: String(orderNo),
    action_source: 'website',
    event_source_url: sourceUrl || undefined,
    user_data,
    custom_data: { value: Number(value), currency },
  };
}

/**
 * Send one event to Meta. Resolves { ok, status, error } and NEVER throws or
 * rejects: this runs off the back of a buyer's confirmation page, and a failure
 * to tell Meta about a sale must not become a failure the buyer can see.
 */
async function send({ pixelId, token, testCode, event, fetchImpl = globalThis.fetch } = {}) {
  if (!isArmed({ pixelId, token })) return { ok: false, skipped: true, error: 'not armed' };
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events`;
  const body = { data: [event], access_token: token };
  // Meta's Events Manager "Test events" tab only shows events carrying this
  // code. It is how the owner proves the wiring works before trusting it.
  if (testCode) body.test_event_code = testCode;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      // Meta's own message, kept: "Invalid parameter" and "Unsupported post
      // request" mean completely different fixes, and the status alone says
      // neither.
      const detail = payload && payload.error ? payload.error.message : '';
      return { ok: false, status: res.status, error: detail || 'http ' + res.status };
    }
    return { ok: true, status: res.status, received: payload && payload.events_received };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return { ok: false, error: aborted ? 'timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isArmed,
  hashed,
  normalisedPhone,
  hashedPhone,
  fbcFrom,
  fbCookies,
  purchaseEvent,
  send,
  GRAPH_VERSION,
};
