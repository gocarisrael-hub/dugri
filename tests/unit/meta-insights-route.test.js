// @vitest-environment node
//
// /api/admin/ads/meta at the server: the one line on the page that decides where
// the ad budget goes.
//
// The failure this file exists to prevent: dividing ALL site revenue by META's
// spend. ₪10,000 of revenue with ₪2,000 of it from Meta, against ₪1,000 of
// spend, prints 10.00 where the truth is 2.00 — and nobody can catch it, because
// only Meta knows the denominator and only we know the numerator.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;
const ADMIN_KEY = 'test-admin-key';
const ACCOUNT = '99887766';
const DAY_MS = 24 * 60 * 60 * 1000;
// Israel, which is the case that made the timezone matter: asked in UTC just
// after local midnight, Meta's `until` lands on yesterday.
const TZ_OFFSET = 3;

let app;
let settings;
let attribution;
let insights;
let server;
let base;
let graphCalls = [];
let adRows = [];

const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj });

// One purchase in our own ledger, `agoMs` milliseconds ago.
const purchase = (source, medium, value, agoMs = 60 * 1000) => ({
  t: new Date(Date.now() - agoMs).toISOString(),
  k: 'purchase',
  s: source,
  m: medium,
  val: value,
});

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-meta-ads-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.META_CAPI_TOKEN = 'EAA-test-token';
  delete process.env.META_AD_ACCOUNT_ID;
  for (const f of ['db.js', 'settings.js', 'attribution.js', 'meta-insights.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  attribution = require(path.join(serverDir, 'attribution.js'));
  insights = require(path.join(serverDir, 'meta-insights.js'));
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      graphCalls.push(u);
      if (/act_[^/?]+\?fields=account_id/.test(u)) {
        return jsonRes({
          account_id: ACCOUNT,
          name: 'Dugri',
          currency: 'ILS',
          timezone_name: 'Asia/Jerusalem',
          timezone_offset_hours_utc: TZ_OFFSET,
        });
      }
      if (u.includes('/insights')) return jsonRes({ data: adRows });
      throw new Error('unexpected fetch ' + u);
    })
  );

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  attribution._setEvents([]);
  if (server) server.close();
});

beforeEach(() => {
  insights._clearCache();
  settings.reset('analytics', 'meta_ad_account_id');
  delete process.env.META_AD_ACCOUNT_ID;
  graphCalls = [];
  // ₪1,000 of spend, and Meta's own idea of what it sold.
  adRows = [
    {
      campaign_name: 'Rovakot September',
      ad_name: 'Reel 03',
      spend: '1000',
      impressions: '40000',
      clicks: '900',
      actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '9' }],
      action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '3000' }],
    },
  ];
});

async function get(urlPath) {
  const res = await realFetch(base + urlPath);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const ads = (days = 7) =>
  get('/api/admin/ads/meta?days=' + days + '&key=' + encodeURIComponent(ADMIN_KEY));

describe('the blended ROAS line', () => {
  it('divides META revenue by META spend, not the whole shop’s takings', async () => {
    settings.set('analytics', 'meta_ad_account_id', ACCOUNT);
    attribution._setEvents([
      purchase('instagram', 'paid', 1500),
      purchase('meta', 'paid', 500),
      // Everything below is real revenue that Meta did not buy.
      purchase('google', 'cpc', 4000),
      purchase('instagram', 'social', 3000),
      purchase('direct', 'none', 1000),
    ]);

    const { body } = await ads(7);
    expect(body.ok).toBe(true);
    expect(body.totals.spend).toBe(1000);
    // ₪2,000 of the ₪10,000 came from Meta.
    expect(body.ours.revenue).toBe(2000);
    expect(body.ours.revenue_all).toBe(10000);
    expect(body.ours.orders).toBe(2);
    // Therefore 2.00 — not the 10.00 that all-revenue-over-Meta-spend prints.
    expect(body.roas).toBe(2);
  });

  it('has no ROAS at all when nothing was spent', async () => {
    settings.set('analytics', 'meta_ad_account_id', ACCOUNT);
    adRows = [{ ad_name: 'paused', spend: '0' }];
    attribution._setEvents([purchase('instagram', 'paid', 900)]);
    const { body } = await ads(7);
    // Null, not 0: an account that spent nothing has no return on spend, and 0
    // would read as "the ads earned nothing".
    expect(body.roas).toBeNull();
  });

  // Meta counts whole calendar days in the AD ACCOUNT's timezone; our ledger is a
  // rolling now-minus-N-days cutoff. Divided against each other untouched, ours
  // is the longer window by up to a day — so revenue from before Meta's window
  // even opened would be credited to spend inside it.
  it('counts only our revenue from inside the window Meta answered for', async () => {
    settings.set('analytics', 'meta_ad_account_id', ACCOUNT);
    const win = insights.accountWindow({ days: 1, now: Date.now(), offsetHours: TZ_OFFSET });
    const beforeItOpened = Date.now() - win.since_ms + 3 * 60 * 60 * 1000;
    attribution._setEvents([
      purchase('instagram', 'paid', 700),
      // Three hours before the account's day began — inside a rolling 24h window,
      // outside the calendar day Meta was asked about.
      purchase('instagram', 'paid', 5000, beforeItOpened),
    ]);
    const { body } = await ads(1);
    expect(body.since).toBe(win.since);
    expect(body.until).toBe(win.until);
    expect(body.ours.revenue).toBe(700);
    expect(body.roas).toBe(0.7);
  });
});

describe('which ad account', () => {
  it('reports on the account saved in the admin', async () => {
    settings.set('analytics', 'meta_ad_account_id', ACCOUNT);
    const { body } = await ads(7);
    expect(body.account_setting).toBe(ACCOUNT);
    expect(graphCalls.some((u) => u.includes('act_' + ACCOUNT + '/insights'))).toBe(true);
  });

  // Documented as an environment variable long before anything read one, so a
  // pinned account on Railway did nothing at all.
  it('honours META_AD_ACCOUNT_ID when nothing is saved in the admin', async () => {
    process.env.META_AD_ACCOUNT_ID = 'act_' + ACCOUNT;
    const { body } = await ads(7);
    expect(body.account_setting).toBe(ACCOUNT);
    expect(graphCalls.some((u) => u.includes('act_' + ACCOUNT + '/insights'))).toBe(true);
    // And never asked the token to guess between accounts.
    expect(graphCalls.some((u) => u.includes('me/adaccounts'))).toBe(false);
  });

  it('lets the saved setting win over the environment', async () => {
    process.env.META_AD_ACCOUNT_ID = '11112222';
    settings.set('analytics', 'meta_ad_account_id', ACCOUNT);
    const { body } = await ads(7);
    expect(body.account_setting).toBe(ACCOUNT);
    expect(graphCalls.some((u) => u.includes('act_11112222'))).toBe(false);
  });

  it('still needs the admin key', async () => {
    const res = await get('/api/admin/ads/meta?days=7');
    expect(res.status).toBe(403);
  });
});

describe('when Meta refuses', () => {
  it('says which account was asked for, so the page can offer to change it', async () => {
    settings.set('analytics', 'meta_ad_account_id', ACCOUNT);
    graphCalls = [];
    globalThis.fetch.mockImplementationOnce(async (url) => {
      graphCalls.push(String(url));
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: '(#200) Requires ads_read permission' } }),
      };
    });
    const { body } = await ads(7);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('(#200) Requires ads_read permission');
    expect(body.account_setting).toBe(ACCOUNT);
    // No half-computed money on a failed answer.
    expect(body.ours).toBeUndefined();
    expect(body.roas).toBeUndefined();
  });
});

describe('the rolling window is not silently the same as Meta’s', () => {
  it('reports the exact days Meta was asked about', async () => {
    settings.set('analytics', 'meta_ad_account_id', ACCOUNT);
    const { body } = await ads(7);
    expect(body.tz_offset_hours).toBe(TZ_OFFSET);
    expect(body.tz_name).toBe('Asia/Jerusalem');
    expect(body.days).toBe(7);
    expect(Date.parse(body.until + 'T00:00:00Z') - Date.parse(body.since + 'T00:00:00Z')).toBe(
      6 * DAY_MS
    );
  });
});
