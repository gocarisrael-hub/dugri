// attribution.js — first-party ad attribution: which campaign produced which order.
//
// WHY THIS EXISTS. The site already carries GA4 and (optionally) the Meta Pixel,
// and both report on the ads — but each reports only what its own tag survived to
// see, and Meta grades its own homework. Neither can be checked against anything.
// This module is the independent record: the landing URL a visitor arrived on is
// parsed HERE, on our server, and joined to OUR paid orders. It is the number the
// owner can trust when Ads Manager claims eleven purchases and the bank shows six.
//
// The store is a JSON file under DATA_DIR (a Railway volume in production), the
// same pattern as playbook.js. Events are small and capped hard — this is a
// counting ledger, not a session recorder. It holds NO personal data: no name, no
// email, no phone, no IP, no user-agent. A visitor is a random id their own
// browser minted and keeps in localStorage; it identifies nobody.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'attribution-events.json');

// Hard caps. The file is read whole at boot and rewritten whole on change, so it
// must never be allowed to grow without bound (the same reasoning that keeps the
// order store small). At ~120 bytes an event, 20k events is a couple of MB and
// roughly a year of this shop's traffic.
const MAX_EVENTS = Number(process.env.ATTRIBUTION_MAX_EVENTS || 20000);
const MAX_AGE_MS = Number(process.env.ATTRIBUTION_MAX_AGE_DAYS || 400) * 24 * 60 * 60 * 1000;

// Writes are THROTTLED. A visit event fires on every session, and the naive
// "save on every change" of the other stores would turn a burst of ad traffic
// into a burst of whole-file writes. Events are queued in memory and flushed at
// most this often; losing the last second of a counting ledger to a restart is
// not a real loss, and flush() makes it deterministic for tests.
const SAVE_THROTTLE_MS = Number(process.env.ATTRIBUTION_SAVE_MS || 1500);

const KINDS = new Set(['visit', 'checkout', 'purchase']);

// --- parsing ------------------------------------------------------------------

// Referrer hosts worth naming. Everything else is reported under its bare
// hostname, which is more useful than lumping it into "other" and costs nothing.
const KNOWN_HOSTS = [
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)facebook\.com$/, 'facebook'],
  [/(^|\.)fb\.(com|me)$/, 'facebook'],
  [/(^|\.)messenger\.com$/, 'facebook'],
  [/(^|\.)google\./, 'google'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)whatsapp\.com$/, 'whatsapp'],
  [/(^|\.)youtube\.com$/, 'youtube'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)t\.co$/, 'twitter'],
];

// Click ids, and the network each one names. A Meta ad that was boosted from the
// app often arrives with NO utm parameters at all — just ?fbclid=… — so treating
// the click id as evidence of a paid click is what keeps those visits out of
// "direct", where they would be invisible.
const CLICK_IDS = [
  ['fbclid', 'meta'],
  ['igshid', 'instagram'],
  ['gclid', 'google'],
  ['ttclid', 'tiktok'],
];

// One field of a touch: trimmed, lowercased, control characters removed, capped.
// Everything here ends up as a row label in the admin table and as a group key,
// so it is normalised once, at the door.
function field(v, max = 80) {
  if (v == null) return '';
  return String(v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .toLowerCase()
    .slice(0, max);
}

function hostLabel(host) {
  const h = field(host, 120).replace(/^www\./, '');
  if (!h) return '';
  for (const [re, name] of KNOWN_HOSTS) if (re.test(h)) return name;
  return h;
}

/**
 * Turn a landing URL (+ the referrer that led to it) into a normalised touch:
 * { source, medium, campaign, content, term }.
 *
 * Precedence, strongest evidence first:
 *  1. utm_* on the landing URL — the owner tagged the link herself, so it wins.
 *  2. a click id (fbclid/gclid/…) — a paid click from that network.
 *  3. the referrer host — organic traffic from a named site.
 *  4. nothing — direct.
 *
 * Pure: no I/O, no clock. `landing` may be any string; a URL that will not parse
 * degrades to the referrer, and then to direct, rather than throwing.
 */
function parseTouch({ landing = '', referrer = '' } = {}) {
  let q = null;
  try {
    q = new URL(String(landing)).searchParams;
  } catch {
    q = null;
  }
  const get = (k) => field(q ? q.get(k) : '');

  const utmSource = get('utm_source');
  const utmMedium = get('utm_medium');
  const touch = {
    source: utmSource,
    medium: utmMedium,
    campaign: get('utm_campaign'),
    content: get('utm_content') || get('utm_ad') || '',
    term: get('utm_term'),
  };

  if (!touch.source) {
    const clicked = q ? CLICK_IDS.find(([param]) => q.get(param)) : null;
    if (clicked) {
      touch.source = clicked[1];
      // A click id says the network but not the buying model. Only Meta's and
      // Google's are exclusively paid-click parameters; igshid rides on ordinary
      // shared links too, so it must not be reported as spend.
      if (!touch.medium) touch.medium = clicked[0] === 'igshid' ? 'social' : 'paid';
    }
  }

  if (!touch.source) {
    let refHost = '';
    try {
      refHost = new URL(String(referrer)).hostname;
    } catch {
      refHost = '';
    }
    const label = hostLabel(refHost);
    if (label) {
      touch.source = label;
      if (!touch.medium) touch.medium = 'referral';
    }
  }

  if (!touch.source) touch.source = 'direct';
  if (!touch.medium) touch.medium = 'none';
  return touch;
}

// A touch is "paid" when the medium says so. Used only for the report's summary
// line; the rows always show the medium itself.
function isPaid(touch) {
  return /^(paid|cpc|ppc|cpm|ads?)/.test(touch.medium || '');
}

// --- store --------------------------------------------------------------------

let _events = [];
let _timer = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    _events = Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object') : [];
  } catch {
    // No file yet, or a corrupt one. An empty ledger is the correct start state:
    // this store is never the source of truth for money, so it must not be able
    // to take the server down with it.
    _events = [];
  }
  prune();
}

// Drop events past the age limit, then past the count limit (oldest first).
function prune(now = Date.now()) {
  const cutoff = now - MAX_AGE_MS;
  _events = _events.filter((e) => {
    const t = Date.parse(e.t);
    return Number.isFinite(t) && t >= cutoff;
  });
  if (_events.length > MAX_EVENTS) _events = _events.slice(_events.length - MAX_EVENTS);
}

function writeNow() {
  _timer = null;
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_events), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {
    /* a failed write must never break a page view */
  }
}

function scheduleWrite() {
  if (_timer) return;
  _timer = setTimeout(writeNow, SAVE_THROTTLE_MS);
  // Never hold the process open for a counting ledger.
  if (typeof _timer.unref === 'function') _timer.unref();
}

/** Write any queued events to disk immediately. */
function flush() {
  if (_timer) clearTimeout(_timer);
  writeNow();
}

/**
 * Record one event. Returns the stored event, or null when it was refused or
 * deduplicated (an already-counted purchase). Never throws.
 *
 * `landing`/`referrer` are the RAW strings the browser reported; the touch is
 * derived here so a client cannot declare its own campaign. `value` is passed by
 * the caller from the order store, never by the browser.
 */
function record({ kind, landing, referrer, visitor, order_no, value, at } = {}) {
  if (!KINDS.has(kind)) return null;
  const touch = parseTouch({ landing, referrer });
  const order = field(order_no, 40);
  // A purchase is counted ONCE per order, whatever the page does — a refresh, a
  // bookmarked confirmation link, two devices. The client guards this too; this
  // is the guard that actually holds.
  if (kind === 'purchase') {
    if (!order) return null;
    if (_events.some((e) => e.k === 'purchase' && e.o === order)) return null;
  }
  const ev = {
    t: at || new Date().toISOString(),
    k: kind,
    v: field(visitor, 40),
    s: touch.source,
    m: touch.medium,
    c: touch.campaign,
    ct: touch.content,
    tm: touch.term,
  };
  if (order) ev.o = order;
  if (Number.isFinite(value)) ev.val = Math.round(Number(value) * 100) / 100;
  _events.push(ev);
  prune();
  scheduleWrite();
  return ev;
}

// --- reporting ----------------------------------------------------------------

const rowKey = (e) => [e.s || '', e.m || '', e.c || '', e.ct || ''].join('|');

/**
 * Aggregate the ledger into one row per (source, medium, campaign, content),
 * newest `days` only, best-selling first.
 *
 * `visits` counts DISTINCT visitors rather than events, so a buyer who reloads
 * the shop six times is one visit and the conversion rate stays honest.
 */
function report({ days = 30, now = Date.now() } = {}) {
  const cutoff = now - Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000;
  const rows = new Map();
  const totals = { visits: 0, checkouts: 0, orders: 0, revenue: 0, paid_orders: 0 };
  const seen = new Map(); // row key -> Set of visitor ids

  for (const e of _events) {
    const t = Date.parse(e.t);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const key = rowKey(e);
    let row = rows.get(key);
    if (!row) {
      row = {
        source: e.s || '',
        medium: e.m || '',
        campaign: e.c || '',
        content: e.ct || '',
        visits: 0,
        checkouts: 0,
        orders: 0,
        revenue: 0,
      };
      rows.set(key, row);
      seen.set(key, new Set());
    }
    if (e.k === 'visit') {
      const who = e.v || 't:' + e.t;
      if (!seen.get(key).has(who)) {
        seen.get(key).add(who);
        row.visits += 1;
        totals.visits += 1;
      }
    } else if (e.k === 'checkout') {
      row.checkouts += 1;
      totals.checkouts += 1;
    } else if (e.k === 'purchase') {
      row.orders += 1;
      totals.orders += 1;
      const v = Number.isFinite(e.val) ? e.val : 0;
      row.revenue += v;
      totals.revenue += v;
      if (isPaid({ medium: e.m })) totals.paid_orders += 1;
    }
  }

  const out = [...rows.values()].map((r) => ({
    ...r,
    revenue: Math.round(r.revenue * 100) / 100,
    // Visits-to-orders, as a percentage. Null (not zero) when there were no
    // visits to divide by: "no data" and "nobody bought" are different answers
    // and the table must not print the second when it means the first.
    conversion: r.visits ? Math.round((r.orders / r.visits) * 1000) / 10 : null,
  }));
  // Money first, then traffic — the owner opens this page to see what paid.
  out.sort((a, b) => b.revenue - a.revenue || b.orders - a.orders || b.visits - a.visits);
  totals.revenue = Math.round(totals.revenue * 100) / 100;
  return { days: Number(days) || 30, rows: out, totals };
}

/** The most recent events, newest first — the "what is happening now" feed. */
function recent(limit = 50) {
  const n = Math.min(Math.max(1, Number(limit) || 50), 500);
  return _events.slice(-n).reverse();
}

/** Test seam: replace the whole ledger. */
function _setEvents(events) {
  _events = Array.isArray(events) ? events : [];
}

load();

module.exports = {
  parseTouch,
  isPaid,
  record,
  report,
  recent,
  flush,
  load,
  _setEvents,
  FILE,
  MAX_EVENTS,
};
