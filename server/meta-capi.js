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

function hashedPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  // An Israeli local number ('052…') is the same person as '97252…'; Meta
  // matches on the international form, so a local one is converted rather than
  // sent as a number that can never match.
  if (digits.startsWith('0')) digits = '972' + digits.slice(1);
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

/**
 * Build the event payload for one purchase. Pure — no I/O, no clock unless one
 * is passed — so the shape can be asserted without touching the network.
 *
 * `contact` (email/phone) is included ONLY when the caller passes it, which the
 * route does only when the owner has switched contact matching on. Everything
 * else here is either the order's own money or the click that produced it.
 */
function purchaseEvent({
  orderNo,
  value,
  currency = 'ILS',
  landing = '',
  sourceUrl = '',
  fbp = '',
  fbc = '',
  contact = {},
  at = Date.now(),
} = {}) {
  const user_data = {};
  const click = fbc || fbcFrom(landing, at);
  if (click) user_data.fbc = click;
  if (fbp) user_data.fbp = String(fbp);
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
  hashedPhone,
  fbcFrom,
  purchaseEvent,
  send,
  GRAPH_VERSION,
};
