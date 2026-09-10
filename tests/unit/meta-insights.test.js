// @vitest-environment node
//
// Meta's own ad numbers (server/meta-insights.js). Spend is the half of ROAS no
// first-party ledger can ever see, so this is where the money question gets its
// second half — and where a wrong number would be believed, since nobody can
// check it against anything else.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const insights = require(path.join(__dirname, '..', '..', 'server', 'meta-insights.js'));

const TOKEN = 'EAA-test-token';
const NOW = Date.parse('2026-09-10T09:00:00Z');

// A fetch stub that answers by URL fragment, and records what was asked for.
function graphStub(routes) {
  const calls = [];
  const impl = vi.fn(async (url) => {
    calls.push(String(url));
    for (const [fragment, answer] of Object.entries(routes)) {
      if (String(url).includes(fragment)) {
        if (answer instanceof Error) throw answer;
        return { ok: !answer.error, status: answer.error ? 400 : 200, json: async () => answer };
      }
    }
    throw new Error('unexpected url ' + url);
  });
  impl.calls = calls;
  return impl;
}

const AD_ROW = {
  campaign_name: 'Rovakot September',
  adset_name: 'Women 25-34',
  ad_name: 'Reel 03',
  spend: '412.50',
  impressions: '18422',
  clicks: '331',
  actions: [
    { action_type: 'link_click', value: '331' },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
  ],
  action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '717' }],
};

beforeEach(() => insights._clearCache());

describe('reading a row', () => {
  it('separates what Meta believes it sold from what it cost', () => {
    const r = insights.normaliseRow(AD_ROW);
    expect(r).toMatchObject({
      campaign: 'Rovakot September',
      ad: 'Reel 03',
      spend: 412.5,
      clicks: 331,
      meta_orders: 3,
      meta_revenue: 717,
    });
    expect(r.roas).toBeCloseTo(1.74, 2);
  });

  // An ad that cost nothing has no return on spend. Printing 0 would read as
  // "this ad earned nothing", which is a different and wrong statement.
  it('has no ROAS for an ad that spent nothing', () => {
    expect(insights.normaliseRow({ spend: '0', ad_name: 'x' }).roas).toBeNull();
  });

  it('is not confused by an ad with no conversions at all', () => {
    const r = insights.normaliseRow({ spend: '80', ad_name: 'x', actions: [] });
    expect(r).toMatchObject({ meta_orders: 0, meta_revenue: 0, roas: 0 });
  });

  // Meta reports a purchase under several aliases depending on how the pixel and
  // the Conversions API reported it. Counting more than one would double the
  // sale — which, on the page that decides where the ad budget goes, is the
  // worst available error.
  it('counts a purchase once even when Meta lists it under two names', () => {
    const both = [
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
      { action_type: 'omni_purchase', value: '3' },
    ];
    expect(insights.purchaseCount(both)).toBe(3);
    expect(insights.purchaseCount([{ action_type: 'omni_purchase', value: '2' }])).toBe(2);
    expect(insights.purchaseCount(undefined)).toBe(0);
  });
});

describe('fetching', () => {
  it('does nothing at all without a token', async () => {
    const impl = graphStub({});
    const r = await insights.fetchInsights({ token: '', fetchImpl: impl });
    expect(r).toMatchObject({ ok: false, armed: false });
    expect(impl).not.toHaveBeenCalled();
  });

  // The owner should not have to go and find an ad account id. With one account
  // behind the token there is nothing to choose.
  it('discovers the only ad account rather than asking for it', async () => {
    const impl = graphStub({
      'me/adaccounts': { data: [{ account_id: '99887766', name: 'Dugri', currency: 'ILS' }] },
      insights: { data: [AD_ROW] },
    });
    const r = await insights.fetchInsights({ token: TOKEN, days: 30, fetchImpl: impl, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.account).toBe('99887766');
    expect(impl.calls.some((u) => u.includes('act_99887766/insights'))).toBe(true);
  });

  // Guessing here would put one account's spend on the page labelled as all of
  // it — a number that looks right and is not.
  it('refuses to guess when the token can see several accounts, and names them', async () => {
    const impl = graphStub({
      'me/adaccounts': {
        data: [
          { account_id: '111', name: 'Dugri' },
          { account_id: '222', name: 'Star Experiences' },
        ],
      },
    });
    const r = await insights.fetchInsights({ token: TOKEN, fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.accounts.map((a) => a.id)).toEqual(['111', '222']);
    expect(impl.calls.some((u) => u.includes('/insights'))).toBe(false);
  });

  it('asks for the window it was given, ending today', async () => {
    const impl = graphStub({ insights: { data: [] } });
    await insights.fetchInsights({
      token: TOKEN,
      accountId: 'act_555',
      days: 7,
      fetchImpl: impl,
      now: NOW,
    });
    const url = decodeURIComponent(impl.calls[0]);
    expect(url).toContain('act_555/insights');
    expect(url).toContain('level=ad');
    expect(url).toContain('{"since":"2026-09-04","until":"2026-09-10"}');
  });

  it('totals the rows and puts the biggest spender first', async () => {
    const impl = graphStub({
      insights: {
        data: [
          { ...AD_ROW, ad_name: 'small', spend: '10', actions: [], action_values: [] },
          AD_ROW,
        ],
      },
    });
    const r = await insights.fetchInsights({ token: TOKEN, accountId: '1', fetchImpl: impl });
    expect(r.rows.map((x) => x.ad)).toEqual(['Reel 03', 'small']);
    expect(r.totals).toMatchObject({ spend: 422.5, meta_orders: 3, meta_revenue: 717 });
  });

  // "(#200) Requires ads_read permission" tells the owner exactly which token to
  // make. "http 400" sends her to us instead.
  it('passes Meta’s own refusal through, whole', async () => {
    const impl = graphStub({
      insights: { error: { message: '(#200) Requires ads_read permission' } },
    });
    const r = await insights.fetchInsights({ token: TOKEN, accountId: '1', fetchImpl: impl });
    expect(r).toMatchObject({
      ok: false,
      armed: true,
      error: '(#200) Requires ads_read permission',
    });
  });

  it('never throws when the network does', async () => {
    const impl = graphStub({ insights: new Error('ENOTFOUND') });
    const r = await insights.fetchInsights({ token: TOKEN, accountId: '1', fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ENOTFOUND');
  });
});

describe('the cache', () => {
  it('answers a repeat question without spending the rate limit again', async () => {
    const impl = graphStub({ insights: { data: [AD_ROW] } });
    const opts = { token: TOKEN, accountId: '1', days: 30, fetchImpl: impl, now: NOW };
    const first = await insights.cachedInsights(opts);
    const second = await insights.cachedInsights(opts);
    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('keeps the windows apart', async () => {
    const impl = graphStub({ insights: { data: [AD_ROW] } });
    await insights.cachedInsights({ token: TOKEN, accountId: '1', days: 7, fetchImpl: impl });
    await insights.cachedInsights({ token: TOKEN, accountId: '1', days: 30, fetchImpl: impl });
    expect(impl).toHaveBeenCalledTimes(2);
  });

  // A cached failure would go on saying "bad token" for five minutes after she
  // had already fixed the token.
  it('never caches a failure', async () => {
    const impl = graphStub({ insights: { error: { message: 'nope' } } });
    const opts = { token: TOKEN, accountId: '1', fetchImpl: impl };
    await insights.cachedInsights(opts);
    await insights.cachedInsights(opts);
    expect(impl).toHaveBeenCalledTimes(2);
  });
});
