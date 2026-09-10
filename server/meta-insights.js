// meta-insights.js — what Meta knows about the ads, pulled with the same token.
//
// WHY THIS EXISTS RATHER THAN MORE TAGGING. Naming a campaign in our own report
// requires the ad's destination URL to carry utm parameters, and Meta offers no
// way to set those once: there is no account-level default, and `url_tags` can
// be set when a creative is CREATED but is not an updatable field, so existing
// ads cannot be stamped from here either (the usual workaround replaces the
// creative, which discards the ad's likes and comments). Per-ad tagging is
// therefore per-ad work, for ever — which means in practice it does not happen,
// and a report that depends on it stays empty.
//
// So this module asks Meta instead. The Ads Insights API returns spend, clicks
// and reported purchases per ad, for the same token the Conversions API uses.
// Nothing has to be tagged, nothing has to be maintained.
//
// The division of labour that results is the useful part:
//   - SPEND and per-ad delivery come from Meta. Only Meta knows them.
//   - ORDERS and REVENUE come from our own order store. Only we know them.
//   - Meta's own purchase count sits next to ours, and the gap between the two
//     is a number worth seeing rather than a discrepancy to hide.
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const TIMEOUT_MS = Number(process.env.META_INSIGHTS_TIMEOUT_MS || 15000);
// Meta rate-limits per ad account, and the owner refreshing the page must not
// spend that budget. The report is a day-scale question; a few minutes of
// staleness costs nothing.
const CACHE_TTL_MS = Number(process.env.META_INSIGHTS_CACHE_MS || 5 * 60 * 1000);
// Cursor paging. Meta returns at most `limit` rows per page and a `paging.next`
// when there are more; an account with more ads than one page would otherwise
// lose rows silently AND under-report the spend they add up to — an error in the
// direction that flatters the ads. The page cap is a stop, not a budget: 20 x 200
// is four thousand ads, far past any account this report is for.
const PAGE_SIZE = Number(process.env.META_INSIGHTS_PAGE_SIZE || 200);
const MAX_PAGES = Number(process.env.META_INSIGHTS_MAX_PAGES || 20);
const DAY_MS = 24 * 60 * 60 * 1000;

// The purchase action, as Meta names it across surfaces. Which one appears
// depends on how the pixel and the Conversions API report; taking the first
// present, in this order, avoids counting the same sale under two aliases.
const PURCHASE_ACTIONS = [
  'offsite_conversion.fb_pixel_purchase',
  'omni_purchase',
  'purchase',
  'onsite_web_purchase',
];

function isArmed(token) {
  return Boolean(token);
}

// One GET against the Graph API. Returns { ok, data } or { ok:false, error } and
// never throws: this is a report, and a report that cannot load must say so, not
// take a page down.
async function graph(pathAndQuery, { token, fetchImpl = globalThis.fetch } = {}) {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${pathAndQuery}` +
    (pathAndQuery.includes('?') ? '&' : '?') +
    'access_token=' +
    encodeURIComponent(token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok || (payload && payload.error)) {
      const err = payload && payload.error;
      // Meta's own message is kept whole. "(#200) Requires ads_read permission"
      // tells the owner exactly which token to make; "http 400" tells her
      // nothing and sends her to us.
      return { ok: false, status: res.status, error: (err && err.message) || 'http ' + res.status };
    }
    return { ok: true, data: payload };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return { ok: false, error: aborted ? 'timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// The cursor for the NEXT page, or '' when this was the last one.
//
// Meta's own instruction is to stop when the `next` link disappears rather than
// when a page comes back empty, because "it is possible that a page may be empty
// but contain a next paging link"
// (https://developers.facebook.com/docs/graph-api/results).
function nextCursor(payload) {
  const p = (payload && payload.paging) || null;
  if (!p || !p.next) return '';
  if (p.cursors && p.cursors.after) return String(p.cursors.after);
  // A `next` with no cursors object: take the `after` parameter out of the URL
  // Meta handed us rather than following the URL itself, which already carries a
  // copy of the access token.
  try {
    return new URL(String(p.next)).searchParams.get('after') || '';
  } catch {
    return '';
  }
}

/**
 * A whole Graph list, followed to the end of its cursor.
 *
 * Returns { ok, data: [...all rows], truncated } — `truncated` true when the walk
 * stopped before Meta ran out of rows. Every early stop here UNDER-counts the
 * list, never over-counts it.
 *
 * WHICH MAKES ANY RATIO AGAINST IT A CEILING, and a caller reporting one has to
 * say so. Under-counted spend is a floor for spend and a ceiling for revenue over
 * spend: three pages of ads at ₪1,000 each, stopped after the first, prints ₪1,000
 * of spend against revenue that Meta's paging never touched, so a true 0.67 shows
 * as 2.00. "The numbers above are a floor" is therefore the wrong label for the
 * one number the owner actually reads.
 */
async function graphList(pathAndQuery, { token, fetchImpl, maxPages = MAX_PAGES } = {}) {
  const rows = [];
  let after = '';
  // Every cursor already walked. A list that loops back on itself would
  // otherwise be concatenated over and over until the page cap — turning one
  // page of spend into twenty pages of it, which INFLATES the total and inverts
  // the "these numbers are a floor" the truncation flag makes the page say.
  const walked = new Set();
  const cap = Math.max(1, Number(maxPages) || 1);
  for (let page = 0; page < cap; page++) {
    const r = await graph(pathAndQuery + (after ? '&after=' + encodeURIComponent(after) : ''), {
      token,
      fetchImpl,
    });
    if (!r.ok) return r;
    const payload = r.data || {};
    const hasNext = Boolean(payload.paging && payload.paging.next);
    const next = hasNext ? nextCursor(payload) : '';
    // Meta handing back the SAME cursor it was just given means it did not
    // advance: `after` means "everything past this item", so a well-behaved page
    // can never end on the cursor that opened it. This page is therefore the
    // previous one again — DISCARD its rows rather than adding a second copy of
    // the same spend, and stop.
    if (after && next && next === after) return { ok: true, data: rows, truncated: true };
    if (Array.isArray(payload.data)) rows.push(...payload.data);
    if (!hasNext) return { ok: true, data: rows, truncated: false };
    // A next link we cannot turn into a cursor: stop, and SAY the list is short
    // rather than presenting a partial total as a complete one.
    if (!next) return { ok: true, data: rows, truncated: true };
    // A longer loop (C1 -> C2 -> C1). The rows already collected are real, so
    // they are kept; going round again would only duplicate them.
    if (walked.has(next)) return { ok: true, data: rows, truncated: true };
    walked.add(next);
    after = next;
  }
  return { ok: true, data: rows, truncated: true };
}

// The window Meta will answer for, in Meta's own terms.
//
// TIMEZONE. `time_range` is whole CALENDAR DAYS interpreted in the AD ACCOUNT's
// timezone — not UTC, and not the server's. Taking the date off a UTC clock is
// therefore wrong by up to a day at the edges: for an owner at UTC+3, just after
// midnight local, the UTC date is still yesterday, so `until` would exclude the
// day she is looking at. The account's own offset (AdAccount.
// timezone_offset_hours_utc) is what governs, so it is fetched and applied here.
//
// `since_ms` is the real UTC instant that window OPENS. It is the number that
// makes the two halves of this report comparable: our own ledger is a rolling
// now-minus-N-days cutoff, and dividing that by a calendar-day spend would be
// dividing unlike windows (ours ~9-24h the longer of the two).
//
// One known imprecision, deliberately left: a single offset is applied across
// the whole window, so a window that straddles a daylight-saving change is out
// by an hour at its far end. An hour at the edge of a 30-day window is not a
// number anybody sets a budget from.
function accountWindow({ days = 30, now = Date.now(), offsetHours = 0 } = {}) {
  const span = Math.max(1, Math.floor(Number(days) || 30));
  const shift = Number(offsetHours) || 0;
  const shiftMs = shift * 60 * 60 * 1000;
  // The account's wall clock, expressed as if it were UTC, so the date can be
  // read straight off it.
  const dayStartLocal = Math.floor((now + shiftMs) / DAY_MS) * DAY_MS;
  const sinceLocal = dayStartLocal - (span - 1) * DAY_MS;
  return {
    since: new Date(sinceLocal).toISOString().slice(0, 10),
    until: new Date(dayStartLocal).toISOString().slice(0, 10),
    since_ms: sinceLocal - shiftMs,
    span,
    tz_offset_hours: shift,
  };
}

// Everything about an ad account this report needs: which one it is, what it is
// called, and — the load-bearing one — the timezone its days are counted in.
const ACCOUNT_FIELDS = 'account_id,name,currency,timezone_name,timezone_offset_hours_utc';

function normaliseAccount(a) {
  const raw = a || {};
  return {
    id: String(raw.account_id || '').replace(/^act_/, ''),
    name: raw.name || '',
    currency: raw.currency || '',
    tz_name: raw.timezone_name || '',
    tz_offset_hours: Number(raw.timezone_offset_hours_utc) || 0,
  };
}

/** One named ad account, by id. */
async function fetchAccount({ token, accountId, fetchImpl } = {}) {
  const id = String(accountId || '').replace(/^act_/, '');
  const r = await graph('act_' + encodeURIComponent(id) + '?fields=' + ACCOUNT_FIELDS, {
    token,
    fetchImpl,
  });
  if (!r.ok) return r;
  const account = normaliseAccount(r.data);
  if (!account.id) account.id = id;
  return { ok: true, account };
}

/**
 * The ad accounts this token can see. Used to save the owner from having to find
 * and paste an account id: with exactly one account there is nothing to choose.
 */
async function listAdAccounts({ token, fetchImpl } = {}) {
  // Followed to the end of the cursor like every other list here: an agency
  // token can see more accounts than one page holds, and a missing account is a
  // missing option in the picker.
  const r = await graphList('me/adaccounts?fields=' + ACCOUNT_FIELDS + '&limit=' + PAGE_SIZE, {
    token,
    fetchImpl,
  });
  if (!r.ok) return r;
  return { ok: true, accounts: (r.data || []).map(normaliseAccount), truncated: !!r.truncated };
}

// Meta reports actions as a list of { action_type, value }. Pull out the first
// purchase alias present, as a number.
function purchaseCount(actions) {
  if (!Array.isArray(actions)) return 0;
  for (const name of PURCHASE_ACTIONS) {
    const hit = actions.find((a) => a && a.action_type === name);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

/** One insights row, reduced to the columns the report shows. */
function normaliseRow(row) {
  const spend = Number(row.spend) || 0;
  const orders = purchaseCount(row.actions);
  const revenue = purchaseCount(row.action_values);
  return {
    campaign: row.campaign_name || '',
    adset: row.adset_name || '',
    ad: row.ad_name || '',
    spend: Math.round(spend * 100) / 100,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    // What META believes it sold. Deliberately named apart from our own orders:
    // the two are different measurements and the report shows both.
    meta_orders: orders,
    meta_revenue: Math.round(revenue * 100) / 100,
    // Meta's own return on spend, from Meta's own numbers. Null rather than 0
    // when nothing was spent — an ad that cost nothing has no ROAS, and printing
    // 0 would read as "it earned nothing".
    roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null,
  };
}

/**
 * Per-ad insights for the last `days` days.
 *
 * `accountId` may be omitted: with exactly one ad account behind the token it is
 * discovered, and with several the caller is told to choose rather than being
 * given one account's numbers labelled as all of them.
 */
async function fetchInsights({ token, accountId, days = 30, fetchImpl, now = Date.now() } = {}) {
  if (!isArmed(token)) return { ok: false, armed: false, error: 'no token' };

  const wanted = String(accountId || '').replace(/^act_/, '');
  let account = null;
  if (!wanted) {
    const found = await listAdAccounts({ token, fetchImpl });
    if (!found.ok) return { ok: false, armed: true, error: found.error };
    // `truncated` counts as "more than one", because it means the list is SHORT:
    // a second account may exist that this walk never saw, and taking the first
    // of a list we know is incomplete is exactly the guess this refuses to make.
    // Checked BEFORE the empty case, because a list that could not be read is not
    // the same answer as a token that can see nothing — and telling her the
    // second when the first is true sends her to fix the wrong thing.
    if (found.truncated || found.accounts.length > 1) {
      return {
        ok: false,
        armed: true,
        accounts: found.accounts,
        truncated: !!found.truncated,
        error_source: 'us',
        error: found.truncated
          ? 'could not read the whole ad-account list — say which account to report on'
          : 'more than one ad account — choose which one to report on',
      };
    }
    if (found.accounts.length === 0) {
      return {
        ok: false,
        armed: true,
        error_source: 'us',
        error: 'this token can see no ad account',
      };
    }
    account = found.accounts[0];
  } else {
    // Ask about the account before asking about its ads: its TIMEZONE decides
    // which days `time_range` means, and a window silently off by a day is a
    // spend figure the owner cannot reconcile with Ads Manager.
    const got = await fetchAccount({ token, accountId: wanted, fetchImpl });
    if (!got.ok) return { ok: false, armed: true, account: wanted, error: got.error };
    account = got.account;
  }

  const win = accountWindow({ days, now, offsetHours: account.tz_offset_hours });
  const query =
    'act_' +
    encodeURIComponent(account.id) +
    '/insights?level=ad&limit=' +
    PAGE_SIZE +
    '&fields=campaign_name,adset_name,ad_name,spend,impressions,clicks,actions,action_values' +
    `&time_range=${encodeURIComponent(JSON.stringify({ since: win.since, until: win.until }))}`;

  const r = await graphList(query, { token, fetchImpl });
  if (!r.ok) return { ok: false, armed: true, account: account.id, error: r.error };

  const rows = (r.data || []).map(normaliseRow);
  const totals = rows.reduce(
    (t, row) => ({
      spend: t.spend + row.spend,
      impressions: t.impressions + row.impressions,
      clicks: t.clicks + row.clicks,
      meta_orders: t.meta_orders + row.meta_orders,
      meta_revenue: t.meta_revenue + row.meta_revenue,
    }),
    { spend: 0, impressions: 0, clicks: 0, meta_orders: 0, meta_revenue: 0 }
  );
  totals.spend = Math.round(totals.spend * 100) / 100;
  totals.meta_revenue = Math.round(totals.meta_revenue * 100) / 100;
  // Biggest spender first: the question this page answers is "where is the money
  // going", and the answer starts at the top.
  rows.sort((a, b) => b.spend - a.spend || b.meta_orders - a.meta_orders);
  return {
    ok: true,
    armed: true,
    account: account.id,
    account_name: account.name,
    currency: account.currency,
    tz_name: account.tz_name,
    tz_offset_hours: win.tz_offset_hours,
    days: win.span,
    since: win.since,
    until: win.until,
    // The instant the window opens, in real UTC — see accountWindow(). The
    // caller divides OUR revenue by THIS spend, and needs to cut our ledger here
    // for that division to be of like by like.
    since_ms: win.since_ms,
    // True when the walk stopped before Meta ran out of rows. Spend and clicks
    // are then a FLOOR — and any return-on-spend computed from them a CEILING,
    // because the divisor is the short number. See graphList().
    truncated: !!r.truncated,
    rows,
    totals,
  };
}

// --- our own half, matched to Meta's -----------------------------------------
// The blended line on the page is OUR revenue over META's spend. Our revenue has
// to be the Meta-attributed part of it: dividing ALL site revenue by Meta spend
// prints a number that reads as ROAS and is not one (₪10,000 of revenue with
// ₪2,000 of it from Meta, against ₪1,000 of spend, reads 10.00 where the truth
// is 2.00 — and it is the number ad budgets get set from).
//
// WHAT THIS CANNOT DO, and why the page must say so. The result is an
// APPROXIMATION, and it is wrong in BOTH directions:
//
//   TOO LOW — a real ad click that arrives under a source name not in the list
//   below (a hand-tagged link with some other utm_source) is left out.
//
//   TOO HIGH — Facebook and Instagram append `fbclid` to EVERY outbound link
//   click, an organic post's included, and attribution.js reads a bare fbclid as
//   { source: 'meta', medium: 'paid' } because for most real ads that is the only
//   evidence there is. So revenue from an organic post lands here too. `isPaid`
//   cannot prevent that: the 'paid' medium is SYNTHESISED from a click id that
//   organic traffic carries as well. Excluding click-id-only touches would fix
//   the over-count and empty the numerator — Meta offers no way to tag ads once
//   (see RAILWAY_SETUP.md), so most genuine ad clicks arrive carrying nothing
//   else.
//
// What can be separated is TAGGED from UNTAGGED, and it is a STRONG SIGNAL rather
// than a proof. A touch carrying a campaign or an ad name came from a link built
// for an ad — but that link travels: the buyer who arrived on it can copy the
// address out of the in-app browser into the bachelorette group, and every click
// from that group then parses to the same campaign (safeUrl in
// site/js/attribution.js deliberately KEEPS the utm parameters, and parseTouch
// gives them top precedence). A bookmark works the same way. So word of mouth
// spread from an ad lands in the tagged half, which for a product distributed by
// group shares is the ordinary case, not a corner. It runs the other way too: a
// real ad whose {{campaign.name}} arrived unsubstituted has the placeholder
// blanked by MACRO_RE and lands in `untagged`.
//
// Both halves are returned, so the page can say how much of the figure came in on
// an ad's own link — near-certainly advertising — and how much on a click id
// alone, which could be either.
//
// The source names are the ones attribution.js can produce for a Meta click:
// 'meta' is an fbclid arriving with no utm parameters at all, and the rest are
// what Meta's {{site_source_name}} macro is spelled out to.
const META_SOURCES = new Set([
  'meta',
  'facebook',
  'instagram',
  'audience_network',
  'messenger',
  'business_suite',
]);

function isMetaSource(source) {
  return META_SOURCES.has(
    String(source || '')
      .trim()
      .toLowerCase()
  );
}

// A row that arrived on an ad's own link: it carries a campaign or an ad name,
// which nothing but a link built for an ad puts there. NOT a proof that the click
// itself was bought — the same address, pasted onward into a group chat or kept as
// a bookmark, brings its campaign with it. See the note above.
function isTaggedRow(row) {
  return Boolean((row && row.campaign) || (row && row.content));
}

/**
 * OUR revenue and orders from META traffic, over attribution.report() rows.
 *
 * Returns { revenue, orders, matched, tagged, untagged } — `tagged` is the part
 * that came in on an ad's own link and `untagged` the part that arrived on a click
 * id alone, which organic Facebook and Instagram traffic also carries. They sum to
 * the total. See the note above: the total is an estimate, the split says how far
 * it can be trusted, and the split is itself a signal rather than a proof.
 *
 * `isPaid` is REQUIRED, and is passed in rather than re-implemented so that "this
 * row cost money" has exactly one definition (attribution.isPaid). Defaulting it
 * to "count everything" would silently restore the very bug this exists to
 * prevent, so a missing one throws instead.
 */
function metaAttributed(rows, isPaid) {
  if (typeof isPaid !== 'function') {
    throw new TypeError('metaAttributed(rows, isPaid): isPaid is required');
  }
  const tally = () => ({ revenue: 0, orders: 0, rows: 0 });
  const tagged = tally();
  const untagged = tally();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !isMetaSource(r.source)) continue;
    if (!isPaid(r)) continue;
    const into = isTaggedRow(r) ? tagged : untagged;
    into.revenue += Number(r.revenue) || 0;
    into.orders += Number(r.orders) || 0;
    into.rows += 1;
  }
  const round = (t) => ({ ...t, revenue: Math.round(t.revenue * 100) / 100 });
  return {
    revenue: Math.round((tagged.revenue + untagged.revenue) * 100) / 100,
    orders: tagged.orders + untagged.orders,
    matched: tagged.rows + untagged.rows,
    tagged: round(tagged),
    untagged: round(untagged),
  };
}

// --- cache --------------------------------------------------------------------
// Keyed by account+window, because those are the only two things that change the
// answer. Cleared wholesale when it grows, which for one owner it never will.
const _cache = new Map();

async function cachedInsights(opts = {}) {
  const now = opts.now || Date.now();
  const key = [opts.accountId || '', opts.days || 30].join('|');
  const hit = _cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };
  const value = await fetchInsights({ ...opts, now });
  // Only a good answer is cached. Caching a failure would keep showing an error
  // for five minutes after the owner has fixed the token.
  if (value.ok) {
    if (_cache.size > 50) _cache.clear();
    _cache.set(key, { at: now, value });
  }
  return value;
}

function _clearCache() {
  _cache.clear();
}

module.exports = {
  isArmed,
  listAdAccounts,
  fetchAccount,
  accountWindow,
  graphList,
  isMetaSource,
  isTaggedRow,
  metaAttributed,
  fetchInsights,
  cachedInsights,
  normaliseRow,
  purchaseCount,
  _clearCache,
  GRAPH_VERSION,
  PURCHASE_ACTIONS,
};
