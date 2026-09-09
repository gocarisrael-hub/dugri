// attribution.js — the browser half of first-party ad attribution.
//
// It remembers HOW this visitor arrived (the landing URL and the referrer) and
// replays that memory with every funnel event, so the purchase that happens four
// pages and two days later can still be credited to the ad that caused it. The
// server (server/attribution.js) does all the parsing; this file only carries
// the raw strings, which is what keeps a page from being able to declare its own
// campaign.
//
// Attribution model: LAST NON-DIRECT TOUCH. The stored touch is replaced only
// when the visitor arrives on a URL that carries campaign parameters, so a buyer
// who clicks an ad, leaves, and comes back by typing the address still counts as
// the ad's — but a second ad, clicked later, takes the credit from the first.
// That is the same model Ads Manager uses, which is the point: the two numbers
// have to be comparable to be worth checking against each other.

const VISITOR_KEY = 'dugri_vid';
const TOUCH_KEY = 'dugri_attr';
const SESSION_KEY = 'dugri_visit';

// The parameters that mark a URL as campaign-tagged. Mirrors the server's list;
// this side only needs to know THAT there is a campaign, never which.
const TAGS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'igshid',
  'gclid',
  'ttclid',
];

// Storage is unavailable in some in-app browsers and blocked in others, and an
// ad click very often lands in exactly such a browser. Every access is guarded:
// tracking degrades to "this visit only" rather than throwing on the page.
function read(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function write(store, key, value) {
  try {
    store.setItem(key, value);
  } catch {
    /* private mode — the event still sends, it just won't be linked to later ones */
  }
}

function newId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through to the arithmetic id */
  }
  return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** A stable, meaningless id for this browser. Identifies no person — it exists
 *  only so six page views by one visitor count as one visit. */
export function visitorId() {
  let id = read(localStorage, VISITOR_KEY);
  if (!id) {
    id = newId();
    write(localStorage, VISITOR_KEY, id);
  }
  return id;
}

/** Does this URL carry campaign parameters? Pure — exported for the tests. */
export function isTagged(url) {
  let params;
  try {
    params = new URL(String(url)).searchParams;
  } catch {
    return false;
  }
  return TAGS.some((t) => params.get(t));
}

/**
 * Return the touch to report, updating the stored one first when this page load
 * IS a new campaign arrival. Pure-ish: reads/writes localStorage, nothing else.
 */
export function currentTouch(href, referrer) {
  const stored = read(localStorage, TOUCH_KEY);
  if (isTagged(href)) {
    const touch = { landing: String(href).slice(0, 2000), referrer: String(referrer || '') };
    write(localStorage, TOUCH_KEY, JSON.stringify(touch));
    return touch;
  }
  if (stored) {
    try {
      const t = JSON.parse(stored);
      if (t && typeof t.landing === 'string') return t;
    } catch {
      /* corrupt value — fall through and report this arrival instead */
    }
  }
  // First ever arrival, untagged: the referrer is all the evidence there is, and
  // it is worth keeping (it separates Instagram-profile traffic from direct).
  const touch = { landing: String(href).slice(0, 2000), referrer: String(referrer || '') };
  write(localStorage, TOUCH_KEY, JSON.stringify(touch));
  return touch;
}

/**
 * Send one funnel event to our own server. Fire-and-forget: the response is
 * never read and a failure is swallowed, because nothing on the page may depend
 * on a measurement call. `keepalive` lets the request outlive the page, which is
 * what a click that navigates away needs.
 */
export function sendEvent(kind, extra = {}) {
  if (typeof fetch !== 'function') return Promise.resolve(false);
  const touch = currentTouch(location.href, document.referrer);
  const body = {
    kind,
    landing: touch.landing,
    referrer: touch.referrer,
    visitor: visitorId(),
    ...extra,
  };
  return fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  })
    .then(() => true)
    .catch(() => false);
}

/** One visit per browser session, so a five-page browse is one visit and the
 *  conversion rate on the report means what it says. */
export function trackVisit() {
  if (read(sessionStorage, SESSION_KEY)) return false;
  write(sessionStorage, SESSION_KEY, '1');
  sendEvent('visit');
  return true;
}

/**
 * Fire the visit beacon once the page has finished doing its own work.
 *
 * Measurement never competes with rendering: an ad click lands on a phone over
 * mobile data, and one more request racing the fonts and the first picture is a
 * cost paid by the buyer for our benefit. Waiting for load and then for an idle
 * moment also keeps the beacon out of the way of anything measuring when the
 * page went quiet.
 */
export function scheduleVisit() {
  const fire = () => {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(trackVisit, { timeout: 2000 });
    } else {
      setTimeout(trackVisit, 500);
    }
  };
  if (typeof document === 'undefined') return;
  if (document.readyState === 'complete') fire();
  else window.addEventListener('load', fire, { once: true });
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  scheduleVisit();
}
