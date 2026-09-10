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

/**
 * The ad accounts this token can see. Used to save the owner from having to find
 * and paste an account id: with exactly one account there is nothing to choose.
 */
async function listAdAccounts({ token, fetchImpl } = {}) {
  const r = await graph('me/adaccounts?fields=account_id,name,currency&limit=50', {
    token,
    fetchImpl,
  });
  if (!r.ok) return r;
  const accounts = (r.data && r.data.data ? r.data.data : []).map((a) => ({
    id: String(a.account_id || '').replace(/^act_/, ''),
    name: a.name || '',
    currency: a.currency || '',
  }));
  return { ok: true, accounts };
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

  let account = String(accountId || '').replace(/^act_/, '');
  if (!account) {
    const found = await listAdAccounts({ token, fetchImpl });
    if (!found.ok) return { ok: false, armed: true, error: found.error };
    if (found.accounts.length === 0) {
      return { ok: false, armed: true, error: 'this token can see no ad account' };
    }
    if (found.accounts.length > 1) {
      return {
        ok: false,
        armed: true,
        accounts: found.accounts,
        error: 'more than one ad account — choose which one to report on',
      };
    }
    account = found.accounts[0].id;
  }

  const until = new Date(now).toISOString().slice(0, 10);
  const since = new Date(now - (Math.max(1, days) - 1) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const query =
    'act_' +
    encodeURIComponent(account) +
    '/insights?level=ad&limit=200' +
    '&fields=campaign_name,adset_name,ad_name,spend,impressions,clicks,actions,action_values' +
    `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`;

  const r = await graph(query, { token, fetchImpl });
  if (!r.ok) return { ok: false, armed: true, account, error: r.error };

  const rows = (r.data && r.data.data ? r.data.data : []).map(normaliseRow);
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
  return { ok: true, armed: true, account, since, until, rows, totals };
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
  fetchInsights,
  cachedInsights,
  normaliseRow,
  purchaseCount,
  _clearCache,
  GRAPH_VERSION,
  PURCHASE_ACTIONS,
};
