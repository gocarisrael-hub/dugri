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
// The REAL rule, not a copy of it. metaAttributed() is handed attribution.isPaid
// in production; a locally re-typed regex here would let the two drift apart and
// pin nothing.
const attribution = require(path.join(__dirname, '..', '..', 'server', 'attribution.js'));
const isPaid = attribution.isPaid;

const TOKEN = 'EAA-test-token';
const NOW = Date.parse('2026-09-10T09:00:00Z');

const ok = (answer) => ({
  ok: !answer.error,
  status: answer.error ? 400 : 200,
  json: async () => answer,
});

// A fetch stub that answers by URL fragment, and records what was asked for.
//
// The ad ACCOUNT lookup is answered by default: every insights call now makes one
// first, because the account's timezone is what decides which days `time_range`
// means. A test that cares about the timezone passes its own route for it.
const ACCOUNT_LOOKUP = /act_([^/?]+)\?fields=account_id/;

function graphStub(routes) {
  const calls = [];
  const impl = vi.fn(async (url) => {
    calls.push(String(url));
    for (const [fragment, answer] of Object.entries(routes)) {
      if (String(url).includes(fragment)) {
        if (answer instanceof Error) throw answer;
        return ok(answer);
      }
    }
    const account = ACCOUNT_LOOKUP.exec(String(url));
    if (account) {
      return ok({
        account_id: account[1],
        name: 'Dugri',
        currency: 'ILS',
        timezone_name: 'Etc/GMT',
        timezone_offset_hours_utc: 0,
      });
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

const insightsCalls = (impl) => impl.calls.filter((u) => u.includes('/insights')).length;

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

  it('asks for the window it was given, ending today in the account’s timezone', async () => {
    const impl = graphStub({ insights: { data: [] } });
    await insights.fetchInsights({
      token: TOKEN,
      accountId: 'act_555',
      days: 7,
      fetchImpl: impl,
      now: NOW,
    });
    // Call one asks which timezone the account keeps; call two asks what it spent.
    const url = decodeURIComponent(impl.calls.find((u) => u.includes('/insights')));
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
    expect(insightsCalls(impl)).toBe(1);
  });

  it('keeps the windows apart', async () => {
    const impl = graphStub({ insights: { data: [AD_ROW] } });
    await insights.cachedInsights({ token: TOKEN, accountId: '1', days: 7, fetchImpl: impl });
    await insights.cachedInsights({ token: TOKEN, accountId: '1', days: 30, fetchImpl: impl });
    expect(insightsCalls(impl)).toBe(2);
  });

  // A cached failure would go on saying "bad token" for five minutes after she
  // had already fixed the token.
  it('never caches a failure', async () => {
    const impl = graphStub({ insights: { error: { message: 'nope' } } });
    const opts = { token: TOKEN, accountId: '1', fetchImpl: impl };
    await insights.cachedInsights(opts);
    await insights.cachedInsights(opts);
    expect(insightsCalls(impl)).toBe(2);
  });
});

// --- the window ---------------------------------------------------------------
// Meta reads `time_range` as whole CALENDAR DAYS in the AD ACCOUNT's timezone
// (documented on the Insights API; the account carries the offset as
// AdAccount.timezone_offset_hours_utc). Taking the date off a UTC clock is
// therefore wrong at the edges — and wrong in a way that is invisible, because
// the wrong window still returns numbers.
describe('the window Meta is asked for', () => {
  it('counts the days in the ad account’s timezone, not the server’s', () => {
    // 00:30 on the 10th in Israel (UTC+3) is still the 9th in UTC. Asked in UTC,
    // `until` would be the 9th — excluding the day the owner is looking at.
    const w = insights.accountWindow({
      days: 7,
      now: Date.parse('2026-09-09T21:30:00Z'),
      offsetHours: 3,
    });
    expect(w.until).toBe('2026-09-10');
    expect(w.since).toBe('2026-09-04');
  });

  it('reports the real instant the window opens, so our ledger can be cut there', () => {
    const w = insights.accountWindow({
      days: 7,
      now: Date.parse('2026-09-10T09:00:00Z'),
      offsetHours: 3,
    });
    // Midnight on the 4th in Tel Aviv is 21:00 on the 3rd in UTC. Our own report
    // is a rolling now-minus-N-days cutoff, so without this number the two halves
    // of the ROAS line describe windows up to a day apart.
    expect(new Date(w.since_ms).toISOString()).toBe('2026-09-03T21:00:00.000Z');
    expect(w.span).toBe(7);
  });

  it('handles a negative offset the same way', () => {
    const w = insights.accountWindow({
      days: 1,
      now: Date.parse('2026-09-10T02:00:00Z'),
      offsetHours: -8,
    });
    // 02:00 UTC is still the 9th in California.
    expect(w.since).toBe('2026-09-09');
    expect(w.until).toBe('2026-09-09');
  });

  it('asks Meta which timezone the account keeps before asking what it spent', async () => {
    const impl = graphStub({
      'act_777?fields=account_id': {
        account_id: '777',
        name: 'Dugri',
        timezone_name: 'Asia/Jerusalem',
        timezone_offset_hours_utc: 3,
      },
      insights: { data: [] },
    });
    const r = await insights.fetchInsights({
      token: TOKEN,
      accountId: 'act_777',
      days: 7,
      fetchImpl: impl,
      now: Date.parse('2026-09-09T21:30:00Z'),
    });
    expect(r.tz_offset_hours).toBe(3);
    expect(r.tz_name).toBe('Asia/Jerusalem');
    // The last day of the window is the account's today, not UTC's yesterday.
    expect(r.until).toBe('2026-09-10');
    expect(decodeURIComponent(impl.calls[1])).toContain(
      '{"since":"2026-09-04","until":"2026-09-10"}'
    );
  });

  it('passes Meta’s refusal through when the account itself cannot be read', async () => {
    const impl = graphStub({
      'act_777?fields=account_id': { error: { message: '(#200) Requires ads_read permission' } },
    });
    const r = await insights.fetchInsights({ token: TOKEN, accountId: '777', fetchImpl: impl });
    expect(r).toMatchObject({
      ok: false,
      armed: true,
      error: '(#200) Requires ads_read permission',
    });
  });
});

// --- paging -------------------------------------------------------------------
// Meta returns at most `limit` rows and a `paging.next` when there are more.
// Stopping at the first page loses ads AND under-reports the spend they add up
// to — which inflates every ROAS figure computed from that total.
describe('paging', () => {
  // A stub that hands back a scripted sequence of pages and records the cursors
  // it was asked with.
  function pager(pages) {
    let i = 0;
    const calls = [];
    const impl = vi.fn(async (url) => {
      calls.push(String(url));
      // The account lookup is not part of the scripted list — it is asked once,
      // before the walk, for the timezone.
      const account = ACCOUNT_LOOKUP.exec(String(url));
      if (account) return ok({ account_id: account[1], timezone_offset_hours_utc: 0 });
      const page = pages[Math.min(i, pages.length - 1)];
      i += 1;
      return ok(page);
    });
    impl.calls = calls;
    return impl;
  }

  it('follows the cursor to the end instead of stopping at the first page', async () => {
    const impl = pager([
      {
        data: [{ ...AD_ROW, ad_name: 'page one', spend: '100' }],
        paging: {
          cursors: { after: 'CURSOR2' },
          next: 'https://graph.facebook.com/x?after=CURSOR2',
        },
      },
      { data: [{ ...AD_ROW, ad_name: 'page two', spend: '25' }], paging: { cursors: {} } },
    ]);
    const r = await insights.fetchInsights({
      token: TOKEN,
      accountId: '99887766',
      fetchImpl: impl,
    });
    expect(r.rows.map((x) => x.ad)).toEqual(['page one', 'page two']);
    // The spend total is the whole account's, not the first page's.
    expect(r.totals.spend).toBe(125);
    expect(r.truncated).toBe(false);
    expect(impl.calls[impl.calls.length - 1]).toContain('after=CURSOR2');
  });

  // Meta's own instruction: stop when `next` disappears, not when a page comes
  // back empty — "a page may be empty but contain a next paging link".
  it('does not stop on an empty page that still carries a next link', async () => {
    const impl = pager([
      { data: [], paging: { cursors: { after: 'C2' }, next: 'https://graph.facebook.com/x' } },
      { data: [{ ...AD_ROW, ad_name: 'late', spend: '9' }] },
    ]);
    const r = await insights.fetchInsights({
      token: TOKEN,
      accountId: '99887766',
      fetchImpl: impl,
    });
    expect(r.rows.map((x) => x.ad)).toEqual(['late']);
  });

  it('says so rather than lying when the page cap stops the walk', async () => {
    // Distinct cursors, so it is the CAP that stops this and nothing else.
    let n = 0;
    const impl = vi.fn(async () => {
      n += 1;
      return ok({
        data: [{ ad_name: 'ad ' + n, spend: '1' }],
        paging: { cursors: { after: 'C' + n }, next: 'https://graph.facebook.com/x' },
      });
    });
    const r = await insights.graphList('act_1/insights?level=ad', {
      token: TOKEN,
      fetchImpl: impl,
      maxPages: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.data.map((x) => x.ad_name)).toEqual(['ad 1', 'ad 2']);
    expect(r.truncated).toBe(true);
  });

  // A cursor that does not move. Followed blindly, the same page is fetched and
  // concatenated up to the cap: one page of spend becomes twenty pages of it, the
  // total comes out multiplied, and `truncated` then makes the page call a figure
  // that is far too HIGH a floor. Every early stop here has to under-count.
  it('stops when Meta hands back the cursor it was just given', async () => {
    const impl = pager([
      {
        data: [{ ad_name: 'only', spend: '100' }],
        paging: { cursors: { after: 'STUCK' }, next: 'https://graph.facebook.com/x' },
      },
    ]);
    const r = await insights.fetchInsights({
      token: TOKEN,
      accountId: '99887766',
      fetchImpl: impl,
    });
    expect(r.rows.map((x) => x.ad)).toEqual(['only']);
    // 100, not 2000: the repeated page is discarded, not added a second time.
    expect(r.totals.spend).toBe(100);
    expect(r.truncated).toBe(true);
    // And it gave up straight away rather than spending twenty calls on it.
    expect(impl.calls.filter((u) => u.includes('/insights')).length).toBe(2);
  });

  it('stops on a longer loop too, keeping the rows it really saw', async () => {
    const pages = {
      '': { data: [{ ad_name: 'one', spend: '10' }], after: 'C2' },
      C2: { data: [{ ad_name: 'two', spend: '20' }], after: 'C3' },
      C3: { data: [{ ad_name: 'three', spend: '30' }], after: 'C2' },
    };
    const impl = vi.fn(async (url) => {
      const m = /[?&]after=([^&]+)/.exec(String(url));
      const page = pages[m ? decodeURIComponent(m[1]) : ''];
      return ok({
        data: page.data,
        paging: { cursors: { after: page.after }, next: 'https://graph.facebook.com/x' },
      });
    });
    const r = await insights.graphList('act_1/insights?level=ad', {
      token: TOKEN,
      fetchImpl: impl,
    });
    expect(r.data.map((x) => x.ad_name)).toEqual(['one', 'two', 'three']);
    expect(r.truncated).toBe(true);
  });

  // "It refuses to guess between accounts" is only true if a list it could not
  // read to the end counts as more than one. A short list with one visible
  // account would otherwise be taken as THE account, and its spend printed as the
  // whole picture.
  it('refuses to pick the only VISIBLE account when the list was cut short', async () => {
    const impl = vi.fn(async (url) => {
      if (String(url).includes('me/adaccounts')) {
        return ok({
          data: [{ account_id: '111', name: 'Dugri' }],
          // A next link with no cursor anywhere in it: the walk cannot continue.
          paging: { next: 'https://graph.facebook.com/next-page' },
        });
      }
      throw new Error('unexpected url ' + url);
    });
    const r = await insights.fetchInsights({ token: TOKEN, fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.error).toContain('whole ad-account list');
    expect(r.accounts.map((a) => a.id)).toEqual(['111']);
    // And it never went on to report that one account's spend as everything.
    expect(impl.mock.calls.some(([u]) => String(u).includes('/insights'))).toBe(false);
  });

  it('lists every ad account, not just the first page of them', async () => {
    const impl = pager([
      {
        data: [{ account_id: '111', name: 'Dugri' }],
        paging: { cursors: { after: 'C2' }, next: 'https://graph.facebook.com/x' },
      },
      { data: [{ account_id: '222', name: 'Star Experiences' }] },
    ]);
    const r = await insights.listAdAccounts({ token: TOKEN, fetchImpl: impl });
    expect(r.accounts.map((a) => a.id)).toEqual(['111', '222']);
  });
});

// --- our half of the blended line ---------------------------------------------
// ALL site revenue over META spend is not a return on ad spend. ₪10,000 of
// revenue with ₪2,000 of it from Meta, against ₪1,000 of spend, reads 10.00
// where the truth is 2.00 — on the page ad budgets get set from.
describe('matching our revenue to Meta’s spend', () => {
  it('counts only the paid rows our ledger attributed to Meta', () => {
    const rows = [
      { source: 'instagram', medium: 'paid', revenue: 1500, orders: 5 },
      { source: 'meta', medium: 'paid', revenue: 500, orders: 2 },
      // Google is paid, but not with Meta's money.
      { source: 'google', medium: 'cpc', revenue: 4000, orders: 9 },
      // Instagram, but organic — an ad account is not what produced it.
      { source: 'instagram', medium: 'social', revenue: 3000, orders: 7 },
      { source: 'direct', medium: 'none', revenue: 1000, orders: 3 },
    ];
    expect(insights.metaAttributed(rows, isPaid)).toMatchObject({
      revenue: 2000,
      orders: 7,
      matched: 2,
    });
  });

  it('knows the platform names Meta traffic can arrive under', () => {
    for (const s of ['meta', 'facebook', 'instagram', 'audience_network', 'messenger']) {
      expect(insights.isMetaSource(s)).toBe(true);
    }
    for (const s of ['google', 'tiktok', 'direct', '', null]) {
      expect(insights.isMetaSource(s)).toBe(false);
    }
  });

  it('is empty, not noisy, when there is nothing to match', () => {
    expect(insights.metaAttributed(undefined, isPaid)).toMatchObject({
      revenue: 0,
      orders: 0,
      matched: 0,
    });
  });

  // Called without the rule, the old version counted EVERY Meta-source row —
  // organic included — which is the bug the whole function exists to prevent.
  // A default that silently restores it is worse than no default.
  it('refuses to run without the paid rule rather than counting everything', () => {
    const organic = [{ source: 'instagram', medium: 'social', revenue: 5000, orders: 9 }];
    expect(() => insights.metaAttributed(organic)).toThrow(/isPaid is required/);
  });

  // THE thing the old "this is a floor" caveat got backwards. Facebook and
  // Instagram stamp `fbclid` on EVERY outbound link, an organic post's included,
  // and attribution.js reads a bare fbclid as { source: 'meta', medium: 'paid' }
  // because for a real ad that is usually the only evidence there is. So organic
  // revenue lands in the total and pushes it UP — it is not a floor.
  describe('the tagged half, which organic traffic cannot reach', () => {
    // ₪600 organic (a post she shared), ₪400 from a tagged ad.
    const rows = [
      { source: 'meta', medium: 'paid', campaign: '', content: '', revenue: 600, orders: 3 },
      {
        source: 'instagram',
        medium: 'paid',
        campaign: 'rovakot_september',
        content: 'reel_03',
        revenue: 400,
        orders: 2,
      },
    ];

    it('separates the deliberately tagged revenue from the click-id-only revenue', () => {
      const m = insights.metaAttributed(rows, isPaid);
      expect(m.revenue).toBe(1000);
      // Only this half is certainly an ad — organic sharing copies the bare URL
      // and can never carry a campaign name.
      expect(m.tagged).toEqual({ revenue: 400, orders: 2, rows: 1 });
      // And this half could be either, which is the whole caveat.
      expect(m.untagged).toEqual({ revenue: 600, orders: 3, rows: 1 });
      expect(m.tagged.revenue + m.untagged.revenue).toBe(m.revenue);
    });

    // The real rule, on the real shape attribution.js produces for a bare
    // fbclid: it IS 'paid', and no rule reading the medium can say otherwise.
    it('confirms a bare click id really does read as paid, so the split is the only guard', () => {
      const touch = attribution.parseTouch({ landing: 'https://x.test/?fbclid=AbC123' });
      expect(touch).toMatchObject({ source: 'meta', medium: 'paid', campaign: '' });
      expect(isPaid(touch)).toBe(true);
      expect(insights.isMetaSource(touch.source)).toBe(true);
      expect(insights.isTaggedRow(touch)).toBe(false);
    });

    it('counts an ad name alone as tagged, not just a campaign', () => {
      const m = insights.metaAttributed(
        [{ source: 'facebook', medium: 'paid', content: 'reel_07', revenue: 250, orders: 1 }],
        isPaid
      );
      expect(m.tagged.revenue).toBe(250);
      expect(m.untagged.revenue).toBe(0);
    });
  });
});
