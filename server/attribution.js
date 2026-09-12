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

// How often the ledger is swept for events past the age limit. On a timer rather
// than on every event: the sweep reads every stored timestamp, and doing that per
// page view is a cost that grows with the traffic it is measuring.
const PRUNE_INTERVAL_MS = Number(process.env.ATTRIBUTION_PRUNE_MS || 5 * 60 * 1000);

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

// An ad platform's own placeholder, arriving UNSUBSTITUTED. Meta fills
// {{campaign.name}} in as it delivers the ad, but a link pasted into a story, a
// preview, or an ad that was never published can arrive with the braces intact.
// Reported as a campaign, it would be a row named "{{campaign.name}}" sitting
// there looking like a real one — so an unresolved placeholder is treated as
// what it is: no answer. Both the raw and URL-encoded forms.
const MACRO_RE = /^(\{\{.*\}\}|%7b%7b.*%7d%7d)$/i;

// THE FOUNDERS' DOOR. The site answers to more than one address: customers are
// given dugri-israel.co.il (PUBLIC_BASE_URL), while the owner and her partner
// open Railway's own generated hostname on purpose, so that their own browsing
// and their own test orders are separable from real traffic. A visit that landed
// on one of OUR OWN non-public addresses is internal — still recorded, still in
// the live feed, and held out of the rows and tiles into a separate `internal`
// count the page prints.
//
// WHY A NAMED SET OF HOSTS AND NOT "ANY ADDRESS BUT THE PUBLIC ONE". Because
// every purchase in this ledger is a PAID order (see /api/track: an unpaid or
// unprovable one records nothing), so anything this rule calls internal is real
// money held out of the report. "Not PUBLIC_BASE_URL" put every address in the
// world on that side of the line, which made two things possible that must not
// be: a buyer still using the *.up.railway.app link that once sat in the
// Instagram bio would have had their paid order dropped, and a PUBLIC_BASE_URL
// that was stale or mistyped would have silenced the entire report — the
// variable's only previous job was building links. Naming the hosts keeps the
// blast radius at addresses we actually own.
//
// With no PUBLIC_BASE_URL configured (local development, the test server) there
// is no public address to differ from, and nothing is internal at all. That is
// the safe default in both directions: a missing variable must never make real
// traffic disappear from the report.
const GENERATED_HOST_RE = /(^|\.)up\.railway\.app$/;
const GENERATED_HOST_LABEL = '*.up.railway.app';

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return ''; // nothing to judge
  }
}

function publicHost() {
  return hostOf(process.env.PUBLIC_BASE_URL || '');
}

// A comma-separated list of hostnames from the environment, normalised the same
// way a landing URL's host is.
function hostList(raw) {
  return String(raw || '')
    .split(',')
    .map((h) =>
      h
        .trim()
        .replace(/^www\./, '')
        .toLowerCase()
    )
    .filter(Boolean);
}

// Hosts named as ours by hand, for the ones no rule can guess: an old address
// kept alive, a bare IP, a preview domain.
function configuredInternalHosts() {
  return hostList(process.env.ATTRIBUTION_INTERNAL_HOSTS);
}

// Railway's generated hostname always ends in up.railway.app, and once a service
// answers to a custom domain — ours does; RAILWAY_PUBLIC_DOMAIN in production
// reads dugri-israel.co.il — nothing customer-facing points at the generated name
// any more. So it is treated as ours by default, with one exception: on STAGING
// the generated name IS the public address, and there it is the site rather than
// a back door, so the rule switches itself off.
function generatedRuleActive() {
  const pub = publicHost();
  return !!pub && !GENERATED_HOST_RE.test(pub);
}

// The OPT-OUT, and the lever the owner has if the generated-host rule ever owns an
// address her customers are actually using. It is what the *.up.railway.app link
// that once sat in the Instagram bio needs: naming that host here hands its
// traffic and its paid orders straight back to the report, without her having to
// make PUBLIC_BASE_URL a railway name to do it. Checked FIRST — a host named as a
// customer's is a customer's, whatever any other rule would have said.
function configuredCustomerHosts() {
  return hostList(process.env.ATTRIBUTION_CUSTOMER_HOSTS);
}

function isInternalHost(host) {
  const pub = publicHost();
  if (!pub || !host || host === pub) return false;
  if (configuredCustomerHosts().includes(host)) return false;
  if (configuredInternalHosts().includes(host)) return true;
  return generatedRuleActive() && GENERATED_HOST_RE.test(host);
}

/** The addresses counted as ours, for the page to name in its own words. */
function internalHosts() {
  if (!publicHost()) return [];
  const names = configuredInternalHosts().filter((h) => isInternalHost(h));
  if (generatedRuleActive()) names.push(GENERATED_HOST_LABEL);
  return names;
}

function isInternalLanding(landing) {
  return isInternalHost(hostOf(landing));
}

// Since this change EVERY event carries the answer: i === 1 internal, i === 0
// judged at the door and not. Eight bytes an event (`,"i":0`) buys the one thing
// report() can never work out later — which address the visit landed on — and,
// just as important, it fences the guesswork below off from events that were
// judged. A full event is then 118 bytes, still inside the ~120 the cap above is
// reasoned from.
function judged(e) {
  return e.i === 1 || e.i === 0;
}

// What was ALREADY IN THE LEDGER when this shipped carries no mark and no landing
// URL, so those rows can only be guessed at, from two marks:
//
//  1. a SOURCE that is one of our own addresses — an internal page-to-page move,
//     whose referrer parsed to that hostname;
//  2. a VISITOR ID that has been seen at the internal door. A visitor id lives in
//     localStorage, which is per ORIGIN, so an id this rule can reach is an id
//     minted on the internal address itself — the same browsing that produced the
//     rows it is being used to explain. (It cannot reach the same person's
//     browsing of the public domain, which mints a different id there.)
//
// (2) is what actually reaches the row the owner could not explain — "instagram /
// social / link_in_bio, 19 visits" — because the browser REPLAYS its stored touch
// on every later event (site/js/attribution.js), so a founder re-opening the
// Railway address kept sending the campaign source and nothing in the row says
// where it was opened.
//
// BOTH GUESSES STOP AT TRAFFIC. Neither one may ever move a PURCHASE, because a
// purchase is a paid order and a guess is not evidence enough to take real money
// out of the report: a returning buyer who once followed a link off somebody
// else's Railway page would have had the sale reclassified under them, and the
// sweep would have reached the whole of that browser's history the moment this
// deployed. The row this exists for reads "19 visits, 3 checkouts, 0 ORDERS", so
// it collapses exactly as intended and this rule is arithmetically incapable of
// losing a sale. A purchase is internal only when the door said so.
//
// And neither guess is ever applied to an event that was judged at the door: a
// genuine referral from somebody ELSE's Railway-hosted page is a customer, and
// must stay one for good.
function isInternalEvent(e, internalVisitors) {
  if (e.i === 1) return true;
  if (judged(e)) return false;
  if (e.k !== 'visit' && e.k !== 'checkout') return false;
  if (isInternalHost(String(e.s || '').toLowerCase())) return true;
  const who = String(e.v || '');
  return who !== '' && !!internalVisitors && internalVisitors.has(who);
}

// The browsers known to be ours, over the WHOLE ledger rather than the reporting
// window: a browser identified as the owner's three months ago is still hers.
//
// Seeded from TRAFFIC only, never from a purchase, for the same reason the rule
// above stops at traffic: an unjudged purchase is not allowed to nominate the
// browser that made it, or one paid order on an address of ours would pull the
// rest of that browser's history along behind it.
function internalVisitorIds() {
  const out = new Set();
  for (const e of _events) {
    if (!e || typeof e !== 'object') continue;
    const who = String(e.v || '');
    if (!who) continue;
    if (e.i === 1) {
      out.add(who);
    } else if (
      !judged(e) &&
      (e.k === 'visit' || e.k === 'checkout') &&
      isInternalHost(String(e.s || '').toLowerCase())
    ) {
      out.add(who);
    }
  }
  return out;
}

// One field of a touch: trimmed, lowercased, control characters removed, capped.
// Everything here ends up as a row label in the admin table and as a group key,
// so it is normalised once, at the door.
function field(v, max = 80) {
  if (v == null) return '';
  const clean = String(v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .toLowerCase()
    .slice(0, max);
  return MACRO_RE.test(clean) ? '' : clean;
}

// Meta's {{site_source_name}} answers in its own shorthand. Spelling it out
// keeps one platform to one row: an ad running on both feeds would otherwise
// report as 'ig' here and 'instagram' on a hand-tagged link, and the report
// would show the same campaign twice.
// Null-prototype ON PURPOSE. The key is a string the VISITOR chooses — it comes
// straight off ?utm_source= — and a plain object answers for 'constructor' and
// '__proto__' with something that is not a source name at all: a function (which
// JSON.stringify drops, leaving a blank row label) or Object.prototype (a row
// labelled "[object Object]"). Anyone with the address of /api/track could plant
// those rows in the owner's report; an object with no prototype has nothing to
// inherit and answers only for the five names written here.
const SITE_SOURCE = Object.assign(Object.create(null), {
  ig: 'instagram',
  fb: 'facebook',
  an: 'audience_network',
  msg: 'messenger',
  bz: 'business_suite',
});

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

  const utmSource = SITE_SOURCE[get('utm_source')] || get('utm_source');
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
let _pruneTimer = null;
// The order numbers already counted as a sale. Kept beside the ledger so the
// once-per-order guard is a lookup rather than a scan of every event ever
// stored; rebuilt whenever the ledger is replaced or pruned.
let _orders = new Set();
// Bumped on every change to _events. A write captures the version it serialised,
// so a slow write can never land on top of a newer one.
let _version = 0;
let _written = -1;
let _chain = Promise.resolve();

const TMP = FILE + '.tmp';
const FLUSH_TMP = FILE + '.flush.tmp';

function reindex() {
  _orders = new Set();
  for (const e of _events) if (e.k === 'purchase' && e.o) _orders.add(e.o);
}

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

/**
 * The count cap, with ONE exemption: a purchase is never evicted by it.
 *
 * Visits outnumber sales by about a thousand to one, so an oldest-first cap over
 * the whole ledger deletes the ORDERS inside the reporting window long before it
 * deletes the traffic around them: revenue would fall with nothing on the page
 * to say why, and the once-per-order guard would stop holding, so a buyer who
 * reopened a bookmarked confirmation link would be counted as a second sale.
 * Only visits and checkouts are dropped, oldest first.
 *
 * The costs of that exemption, stated plainly. Every purchase kept is one slot
 * of traffic given up, permanently. And once the purchases ALONE fill the cap
 * the ledger stops recording traffic altogether: each new visit is pushed and
 * evicted by the same call, so the report shows orders against no visits and a
 * conversion rate of null. That needs MAX_EVENTS orders inside the age window —
 * twenty thousand at the default, decades of this shop — which is why the
 * exemption is still the right trade: of everything in here the sales are the
 * part worth the bytes.
 *
 * Cost per call: the scan skips the run of purchases at the front of the ledger,
 * and each eviction is an O(n) splice. Normally that is one splice of one
 * element at index 0.
 */
function capEvents() {
  let excess = _events.length - MAX_EVENTS;
  if (excess <= 0) return;
  let i = 0;
  while (excess > 0 && i < _events.length) {
    if (_events[i].k === 'purchase') i += 1;
    else {
      _events.splice(i, 1);
      excess -= 1;
    }
  }
}

// Drop events past the age limit, then past the count limit. This walks the
// whole ledger with a Date.parse per event, so it runs at boot and on a slow
// timer — never per event. An ad burst is exactly the moment the server can
// least afford to re-read twenty thousand timestamps on every page view.
function prune(now = Date.now()) {
  const before = _events.length;
  const cutoff = now - MAX_AGE_MS;
  _events = _events.filter((e) => {
    const t = Date.parse(e.t);
    return Number.isFinite(t) && t >= cutoff;
  });
  capEvents();
  reindex();
  if (_events.length !== before) {
    _version += 1;
    scheduleWrite();
  }
}

// The sweep is armed by record(), so a server with no traffic stops pruning
// after boot, and record() itself no longer applies the age limit at all: an
// event dated outside the window — a caller-supplied `at`, a skewed clock —
// lingers in the live feed and on disk until the next sweep, which on a silent
// server never comes. report() filters by its own window, so the numbers are
// unaffected either way; what is at stake is only how long a stale event takes
// to leave the file.
function schedulePrune() {
  if (_pruneTimer) return;
  _pruneTimer = setTimeout(() => {
    _pruneTimer = null;
    prune();
  }, PRUNE_INTERVAL_MS);
  if (typeof _pruneTimer.unref === 'function') _pruneTimer.unref();
}

/**
 * Write the ledger out. The BYTES go out asynchronously: the file runs to a
 * couple of megabytes at the cap, and fs.writeFileSync of that much, re-armed
 * every second and a half, is a stall the buyer's request waits behind — on an
 * instance that is already fragile under concurrency. Nothing in here is money,
 * so nothing in here is worth blocking a page view for.
 *
 * Writes are serialised through one chain and stamped with the version they
 * carry, so an overtaken write never restores older content.
 *
 * THE PUBLISH STEP IS SYNCHRONOUS, and that is the whole ordering argument.
 * `rename` is a metadata operation measured in microseconds — nothing like the
 * write it follows — and doing it without yielding makes "check the version,
 * then publish" one indivisible step as far as the rest of the process is
 * concerned. With an async rename there is a window between the check and the
 * publish in which the main thread runs, and flush() is synchronous: a shutdown
 * flush landing in that window would publish the newer ledger and then have this
 * older rename dropped on top of it, silently rolling a sale back off the disk.
 * Nothing sequences the two paths on the file itself, so the window is the bug.
 */
function writeNow() {
  _timer = null;
  const version = _version;
  if (version <= _written) return _chain;
  const data = JSON.stringify(_events);
  _chain = _chain.then(async () => {
    if (version <= _written) return; // a newer snapshot already reached the file
    try {
      await fs.promises.writeFile(TMP, data, 'utf8');
      // Re-checked after the await, because the main thread ran while it was
      // out: flush() may have published something newer in the meantime.
      if (version <= _written) {
        await fs.promises.unlink(TMP).catch(() => {});
        return;
      }
      fs.renameSync(TMP, FILE); // no await between the check and the publish
      _written = Math.max(_written, version);
    } catch {
      /* a failed write must never break a page view */
    }
  });
  return _chain;
}

function scheduleWrite() {
  if (_timer) return;
  _timer = setTimeout(writeNow, SAVE_THROTTLE_MS);
  // Never hold the process open for a counting ledger.
  if (typeof _timer.unref === 'function') _timer.unref();
}

/**
 * Write any queued events to disk immediately. Synchronous from end to end on
 * purpose: this is the deterministic seam — the tests, and the SIGTERM of every
 * deploy — where the process may not survive long enough to await anything.
 *
 * Its own tmp file, so it cannot collide with a queued write halfway through
 * one; and being synchronous, it cannot interleave with the chain's publish
 * step, which is synchronous for the same reason. Whichever of the two goes
 * last, the version stamp keeps the newer content: `_written` only ever moves
 * forward, and the chain skips any snapshot that has been overtaken.
 */
function flush() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
  const version = _version;
  if (version <= _written) return _chain;
  try {
    fs.writeFileSync(FLUSH_TMP, JSON.stringify(_events), 'utf8');
    fs.renameSync(FLUSH_TMP, FILE);
    _written = Math.max(_written, version);
  } catch {
    try {
      fs.unlinkSync(FLUSH_TMP);
    } catch {
      /* nothing to clean up */
    }
  }
  return _chain;
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
    if (_orders.has(order)) return null;
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
  // Marked at the door, not at report time: the landing URL is not kept (it can
  // carry an order's owner token — see safeUrl in site/js/attribution.js), so
  // this is the only moment at which the address is still known. Written either
  // way, 1 or 0, so that the answer is on the record and the guesswork that fills
  // in for the rows written before this change can never be applied to it.
  ev.i = isInternalLanding(landing) ? 1 : 0;
  if (order) ev.o = order;
  if (Number.isFinite(value)) ev.val = Math.round(Number(value) * 100) / 100;
  _events.push(ev);
  if (kind === 'purchase') _orders.add(order);
  capEvents(); // cheap and clockless; the age sweep is the timer's job
  _version += 1;
  scheduleWrite();
  schedulePrune();
  return ev;
}

// --- reporting ----------------------------------------------------------------

const rowKey = (e) => [e.s || '', e.m || '', e.c || '', e.ct || ''].join('|');

/**
 * Aggregate the ledger into one row per (source, medium, campaign, content),
 * newest `days` only, best-selling first.
 *
 * `visits` and `checkouts` both count DISTINCT VISITORS rather than events, so a
 * buyer who reloads the shop six times is one visit, and a wizard that puts the
 * step in the URL — so a reload, a back button or a shared ?step=4 link re-enters
 * the checkout step — is still one checkout. Counting the checkouts per event
 * while counting the visits per visitor is what produced rows reading "3 visits,
 * 7 checkouts": a funnel that widens as it descends is not a funnel.
 *
 * The TOTALS tiles are deduplicated across the whole window, not per row. One
 * visitor who arrives once organically and once from an ad is two rows and one
 * browser, and the tile says "visitors".
 */
function report({ days = 30, now = Date.now() } = {}) {
  const cutoff = now - Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000;
  const rows = new Map();
  const totals = { visits: 0, checkouts: 0, orders: 0, revenue: 0, paid_orders: 0 };
  // What our own addresses contributed, counted separately so the page can say
  // how much was set aside rather than leaving her to wonder where four visits
  // went. REVENUE IS IN HERE, and it is the whole reason this object exists: a
  // purchase only reaches the ledger once the order is paid, so an internal
  // purchase is real money, and money that leaves the report without a number
  // beside it is money nobody can tell from a test order.
  const internal = { visits: 0, checkouts: 0, orders: 0, revenue: 0, hosts: internalHosts() };
  const seenInternal = { visit: new Set(), checkout: new Set() };
  const ourBrowsers = internalVisitorIds();
  const seen = new Map(); // row key -> { visit: Set, checkout: Set } of visitor ids
  const seenAll = { visit: new Set(), checkout: new Set() }; // the same, site-wide

  // An event with no visitor id can only ever be itself: its timestamp stands in
  // for an identity, so two such events count twice rather than collapsing into
  // one. That case is rare in practice — and NOT the blocked-storage one. A
  // browser that refuses site data mints a fresh id per event (site/js/
  // attribution.js), so it arrives as a stream of one-page visitors: every page
  // view it makes is a visitor in this tile. The in-app browsers an ad click
  // lands in are exactly those browsers, so "מבקרים" reads a little high, and
  // the way to fix it is a first-party cookie, not a change here.
  const whoOf = (e) => e.v || 't:' + e.t;

  for (const e of _events) {
    const t = Date.parse(e.t);
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (isInternalEvent(e, ourBrowsers)) {
      // Branched on the kind by name, never indexed by it. `e.k` is a string off
      // a JSON file that load() does not validate, and seenInternal[e.k] answers
      // for 'constructor' and 'toString' with something that has no .has — one
      // malformed row would have taken both admin ad endpoints down with a
      // TypeError, on data the customer path beside it survives.
      const who = whoOf(e);
      if (e.k === 'visit' || e.k === 'checkout') {
        const bucket = e.k === 'visit' ? seenInternal.visit : seenInternal.checkout;
        if (!bucket.has(who)) {
          bucket.add(who);
          if (e.k === 'visit') internal.visits += 1;
          else internal.checkouts += 1;
        }
      } else if (e.k === 'purchase') {
        internal.orders += 1;
        if (Number.isFinite(e.val)) internal.revenue += e.val;
      }
      continue;
    }
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
      seen.set(key, { visit: new Set(), checkout: new Set() });
    }
    if (e.k === 'visit' || e.k === 'checkout') {
      const who = whoOf(e);
      const perRow = seen.get(key)[e.k];
      if (!perRow.has(who)) {
        perRow.add(who);
        if (e.k === 'visit') row.visits += 1;
        else row.checkouts += 1;
      }
      if (!seenAll[e.k].has(who)) {
        seenAll[e.k].add(who);
        if (e.k === 'visit') totals.visits += 1;
        else totals.checkouts += 1;
      }
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
  internal.revenue = Math.round(internal.revenue * 100) / 100;
  return { days: Number(days) || 30, rows: out, totals, internal };
}

/**
 * The most recent events, newest first — the "what is happening now" feed.
 *
 * The internal mark is RESOLVED on the way out, not just read off the record. A
 * row written before this shipped carries no mark, and the page badges on the
 * mark alone — so an event the report has set aside as ours would have appeared
 * in the feed looking exactly like a customer arriving, right underneath a note
 * asking her to go and check that very row. Marked on a copy: the ledger keeps
 * what the door actually said.
 */
function recent(limit = 50) {
  const n = Math.min(Math.max(1, Number(limit) || 50), 500);
  const ours = internalVisitorIds();
  return _events
    .slice(-n)
    .reverse()
    .map((e) => (e.i === 1 || !isInternalEvent(e, ours) ? e : { ...e, i: 1 }));
}

/** Test seam: replace the whole ledger. */
function _setEvents(events) {
  _events = Array.isArray(events) ? events : [];
  reindex();
  _version += 1;
}

load();

module.exports = {
  parseTouch,
  isInternalLanding,
  internalHosts,
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
