import { test, expect } from '@playwright/test';

// The whole loop, for real: a visitor arrives on an ad link, the server parses
// the campaign out of that URL, and the owner's report shows the row.
//
// Every test tags its own campaign with a unique name. The attribution ledger is
// a SHARED, append-only store (one server, two device projects, and a .e2e-data
// directory that survives between local runs), so a test that asserted totals
// would fail the moment anything else on the site was visited. Asserting on its
// own campaign row is both stable and closer to what the page is for.
const KEY = 'dugri-admin';

const unique = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

// The report row for one campaign, whatever else is in the table.
const rowFor = (page, campaign) => page.locator(`#rows tr:has(td:text-is("${campaign}"))`);

// Go to a page AND wait for its measurement beacon to be ANSWERED. The waiter has
// to be armed before the navigation: the beacon fires during load, so a wait
// registered afterwards is a wait for an event that has already happened.
//
// It waits for the RESPONSE, not the request. Every test below arrives somewhere
// and then immediately opens the report expecting to find the visit in it — and
// the request having left the browser says nothing about the server having
// recorded it. Under a loaded parallel run that gap is real, and it shows up as a
// row that is simply missing.
async function arriveAt(page, url) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/track') && r.request().method() === 'POST'),
    page.goto(url),
  ]);
  // The beacon being ANSWERED is not the same as it being accepted: /api/track is
  // rate-limited per client, and in E2E every worker is the same client. A 429
  // here would otherwise surface further down as a report row that is missing for
  // no stated reason.
  expect(response.status(), 'the /api/track beacon was refused').toBeLessThan(400);
  return response.request();
}

test.describe('the ad report', () => {
  test('without a key the page reveals nothing and calls no admin API', async ({ page }) => {
    let hitAdmin = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/ads')) hitAdmin = true;
    });
    await page.goto('/admin-ads.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#main')).toBeHidden();
    expect(hitAdmin).toBe(false);
  });

  test('a visit from a tagged ad link becomes a row in the report', async ({ page }) => {
    const campaign = unique('rovakot');
    const tracked = await arriveAt(
      page,
      `/index.html?utm_source=instagram&utm_medium=paid&utm_campaign=${campaign}&utm_content=reel_01`
    );
    // The beacon carries the LANDING URL, which is where the campaign lives —
    // the server never takes a campaign name from the payload itself.
    const body = JSON.parse(tracked.postData() || '{}');
    expect(body.kind).toBe('visit');
    expect(body.landing).toContain(campaign);

    await page.goto(`/admin-ads.html?key=${KEY}`);
    const row = rowFor(page, campaign);
    await expect(row).toBeVisible();
    await expect(row.locator('td').nth(0)).toHaveText('instagram');
    await expect(row.locator('td').nth(1)).toHaveText('paid');
    await expect(row.locator('td').nth(3)).toHaveText('reel_01');
    await expect(row.locator('td').nth(4)).toHaveText('1');
    // Paid traffic is marked, because it is the traffic that cost money.
    await expect(row).toHaveClass(/paid/);
  });

  test('the campaign is remembered across pages, not just on the landing one', async ({ page }) => {
    const campaign = unique('memory');
    await arriveAt(
      page,
      `/index.html?utm_source=instagram&utm_medium=paid&utm_campaign=${campaign}`
    );

    // A second page, with no parameters at all on its URL. The stored touch is
    // what a later checkout or purchase would be credited to.
    await page.goto('/products.html');
    const landing = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('dugri_attr') || '{}').landing || '';
      } catch {
        return '';
      }
    });
    expect(landing).toContain(campaign);
  });

  test('one browsing session is one visit, not one per page', async ({ page }) => {
    const campaign = unique('once');
    await arriveAt(
      page,
      `/index.html?utm_source=instagram&utm_medium=paid&utm_campaign=${campaign}`
    );
    for (const p of ['/products.html', '/how.html', '/index.html']) await page.goto(p);

    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(rowFor(page, campaign).locator('td').nth(4)).toHaveText('1');
  });

  test('an untagged arrival is reported as direct, not invented', async ({ page }) => {
    await arriveAt(page, '/index.html');
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.locator('#rows tr:has(td:text-is("direct"))').first()).toBeVisible();
  });

  test('the live feed shows the arrival as it happens', async ({ page }) => {
    const campaign = unique('live');
    await arriveAt(
      page,
      `/index.html?utm_source=instagram&utm_medium=paid&utm_campaign=${campaign}`
    );
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.locator(`#feed .ev:has-text("${campaign}")`).first()).toBeVisible();
  });

  test('the range buttons change the window the report answers for', async ({ page }) => {
    const seen = [];
    await page.goto(`/admin-ads.html?key=${KEY}`);
    page.on('request', (r) => {
      const u = new URL(r.url(), 'http://x');
      if (u.pathname === '/api/admin/ads') seen.push(u.searchParams.get('days'));
    });
    await page.getByRole('button', { name: '7 ימים' }).click();
    await expect.poll(() => seen).toContain('7');
    await expect(page.getByRole('button', { name: '7 ימים' })).toHaveClass(/on/);
  });

  // OPTIONAL, and the page has to say so. Meta has no way to apply URL
  // parameters across an account, so requiring them per ad would make the report
  // depend on work that will not happen. It buys one thing — campaign names in
  // OUR table too — and the string is at least identical for every ad.
  test('the Meta string is fixed, and the names it produces land in the report', async ({
    page,
  }) => {
    await page.goto(`/admin-ads.html?key=${KEY}`);
    const params = await page.getByTestId('auto-params').inputValue();
    expect(params).toContain('utm_campaign={{campaign.name}}');
    expect(params).toContain('utm_content={{ad.name}}');
    expect(params).toContain('utm_source={{site_source_name}}');
    expect(params).toContain('utm_medium=paid');
    // No field to fill in: it is the same string for every ad she ever runs.
    await expect(page.getByTestId('auto-params')).toHaveAttribute('readonly', '');

    // Now arrive the way a real click does — with Meta's substitutions already
    // made — and the campaign names itself in the table.
    const campaign = unique('auto');
    await arriveAt(
      page,
      `/index.html?utm_source=ig&utm_medium=paid&utm_campaign=${campaign}&utm_content=Reel%2003`
    );
    await page.goto(`/admin-ads.html?key=${KEY}`);
    const row = rowFor(page, campaign);
    await expect(row.locator('td').nth(0)).toHaveText('instagram');
    await expect(row.locator('td').nth(3)).toHaveText('reel 03');
  });

  test('an ad whose placeholders never got filled in makes no phantom campaign', async ({
    page,
  }) => {
    await arriveAt(
      page,
      '/index.html?utm_source=instagram&utm_medium=paid&utm_campaign={{campaign.name}}'
    );
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.locator('#rows tr:has(td:text-is("{{campaign.name}}"))')).toHaveCount(0);
  });

  test('the manual builder still writes a link for the bio and the stories', async ({ page }) => {
    await page.goto(`/admin-ads.html?key=${KEY}`);
    const campaign = unique('bio');
    await page.locator('#bCampaign').fill(campaign.toUpperCase() + ' סתיו');
    const link = await page.getByTestId('ad-link').inputValue();
    // Spaces and case are normalised on the way into the URL, because whatever
    // it is pasted into passes the destination through untouched.
    expect(link).toContain('utm_campaign=' + campaign + '_');
    expect(link).toContain('utm_medium=bio');

    await arriveAt(page, new URL(link).pathname + new URL(link).search);
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(
      rowFor(page, campaign + '_סתיו')
        .locator('td')
        .nth(1)
    ).toHaveText('bio');
  });

  // Meta's half of the page. The E2E server has no ad-account token, which is
  // the state the site ships in — so the page must SAY that, and say what to do
  // about it. A blank space here would read as "no ads ran".
  test('without a token, Meta’s table names the setting that is missing', async ({ page }) => {
    await page.goto(`/admin-ads.html?key=${KEY}`);
    const note = page.getByTestId('meta-note').first();
    await expect(note).toBeVisible();
    await expect(note).toContainText('META_CAPI_TOKEN');
    await expect(note).toContainText('ads_read');
  });

  // One Meta answer, shaped the way the server sends it. `ours` is OUR revenue,
  // already narrowed to the traffic Meta produced — the tile divides by it.
  const metaAnswer = (over = {}) => ({
    ok: true,
    armed: true,
    account: '99887766',
    account_setting: '99887766',
    account_env: '',
    days: 30,
    since: '2026-08-12',
    until: '2026-09-10',
    tz_name: 'Asia/Jerusalem',
    tz_offset_hours: 3,
    truncated: false,
    rows: [
      {
        campaign: 'Rovakot September',
        adset: 'Women 25-34',
        ad: 'Reel 03',
        spend: 400,
        impressions: 18422,
        clicks: 331,
        meta_orders: 3,
        meta_revenue: 717,
        roas: 1.79,
      },
    ],
    totals: { spend: 400, impressions: 18422, clicks: 331, meta_orders: 3, meta_revenue: 717 },
    ours: {
      revenue: 800,
      orders: 4,
      rows: 1,
      tagged: { revenue: 800, orders: 4, rows: 1 },
      untagged: { revenue: 0, orders: 0, rows: 0 },
      revenue_all: 800,
      orders_all: 4,
    },
    roas: 2,
    ...over,
  });

  const serveMeta = (page, answer) =>
    page.route('**/api/admin/ads/meta**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(typeof answer === 'function' ? answer(route.request()) : answer),
      })
    );

  test('Meta’s spend sits above our own count, and the two are labelled apart', async ({
    page,
  }) => {
    // Meta's API is somebody else's server; the E2E fixture stands in for it.
    await serveMeta(page, metaAnswer());
    await page.goto(`/admin-ads.html?key=${KEY}`);
    const table = page.getByTestId('meta-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr').first()).toContainText('Rovakot September');
    await expect(table.locator('tbody tr').first()).toContainText('Reel 03');
    // Spend — the number no first-party ledger can ever see.
    await expect(table.locator('tbody tr').first()).toContainText('400');
    // And Meta's orders are named as Meta's, never merged into ours.
    await expect(table.locator('thead')).toContainText('הזמנות (מטא)');
    await expect(page.locator('#metaBox')).toContainText('הפער בין השתיים');
    // The window is stated, because it is calendar days in the AD ACCOUNT's
    // timezone and not the rolling one our own table answers for.
    await expect(page.locator('#metaBox')).toContainText('2026-08-12');
    await expect(page.locator('#metaBox')).toContainText('Asia/Jerusalem');
  });

  // THE number the owner sets budgets from. Dividing ALL site revenue by Meta's
  // spend prints a figure that reads as ROAS and is not one — here ₪10,000 of
  // takings, ₪2,000 of it from Meta, against ₪1,000 of spend: 2.00, never 10.00.
  test('the ROAS tile divides Meta’s revenue by Meta’s spend, not the whole shop’s', async ({
    page,
  }) => {
    await serveMeta(
      page,
      metaAnswer({
        totals: {
          spend: 1000,
          impressions: 40000,
          clicks: 900,
          meta_orders: 9,
          meta_revenue: 3000,
        },
        ours: {
          revenue: 2000,
          orders: 2,
          rows: 2,
          tagged: { revenue: 1400, orders: 1, rows: 1 },
          untagged: { revenue: 600, orders: 1, rows: 1 },
          revenue_all: 10000,
          orders_all: 12,
        },
        roas: 2,
      })
    );
    await page.goto(`/admin-ads.html?key=${KEY}`);
    const tiles = page.locator('#metaBox .tiles');
    await expect(tiles).toContainText('2.00₪');
    await expect(tiles).not.toContainText('10.00₪');
    // And it says which revenue it divided, so the figure can be checked.
    await expect(page.locator('#metaBox')).toContainText('שיוחס לפרסום במטא');
  });

  // A short ad list makes SPEND a floor — and the return over it a CEILING, since
  // the divisor is the number that came up short: three pages of ads at ₪1,000
  // each, stopped after the first, prints 2.00 where the truth is 0.67. The note
  // used to say the numbers above were a floor, full stop, which is exactly
  // backwards for the one figure she reads.
  test('a short ad list is called a floor for spend and a ceiling for the return', async ({
    page,
  }) => {
    await serveMeta(
      page,
      metaAnswer({
        truncated: true,
        totals: { spend: 1000, impressions: 1, clicks: 900, meta_orders: 0, meta_revenue: 0 },
        ours: {
          revenue: 2000,
          orders: 4,
          rows: 1,
          tagged: { revenue: 2000, orders: 4, rows: 1 },
          untagged: { revenue: 0, orders: 0, rows: 0 },
          revenue_all: 2000,
          orders_all: 4,
        },
        roas: 2,
      })
    );
    await page.goto(`/admin-ads.html?key=${KEY}`);
    const box = page.locator('#metaBox');
    await expect(box).toContainText('לא נמשכו כל המודעות');
    // Both halves of the truth, in the right direction.
    await expect(box).toContainText('ההוצאה והקליקים למעלה הם רצפה');
    await expect(box).toContainText('תקרה');
    await expect(box).toContainText('ההחזר האמיתי נמוך יותר');
    // And never the old blanket claim.
    await expect(box).not.toContainText('המספרים למעלה הם רצפה');
  });

  // The untouched case must not carry the warning.
  test('a complete ad list says nothing about being short', async ({ page }) => {
    await serveMeta(page, metaAnswer());
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.getByTestId('meta-table')).toBeVisible();
    await expect(page.locator('#metaBox')).not.toContainText('לא נמשכו כל המודעות');
  });

  // The caveat used to call the figure a floor. It is not one: Facebook and
  // Instagram put a click id on EVERY outbound link, an organic post's included,
  // and a bare click id reads as paid — so organic sales push the ratio UP. The
  // page has to say that, and show how much of the figure is the certain half.
  test('the caveat admits the figure can be too high, and shows the certain half', async ({
    page,
  }) => {
    await serveMeta(
      page,
      metaAnswer({
        totals: {
          spend: 1000,
          impressions: 40000,
          clicks: 900,
          meta_orders: 9,
          meta_revenue: 3000,
        },
        ours: {
          revenue: 1000,
          orders: 4,
          rows: 2,
          tagged: { revenue: 400, orders: 1, rows: 1 },
          untagged: { revenue: 600, orders: 3, rows: 1 },
          revenue_all: 5000,
          orders_all: 20,
        },
        roas: 1,
      })
    );
    await page.goto(`/admin-ads.html?key=${KEY}`);
    const box = page.locator('#metaBox');
    // No longer claimed as a floor…
    await expect(box).not.toContainText('ולכן זו רצפה');
    // …and the over-count is named, with its cause.
    await expect(box).toContainText('הערכה');
    await expect(box).toContainText('פוסט אורגני');
    // The under-count is the one we do NOT recognise the source of. An untagged
    // ad click IS counted, via the click id, and saying otherwise reads as "my
    // real return is higher than this" — the exact direction of error this note
    // exists to close.
    await expect(box).toContainText('סומנה במקור שאנחנו לא מזהים');
    await expect(box).not.toContainText('הגיעה בלי סימון שאנחנו מזהים');
    // The split, in money: ₪400 on an ad's own link, ₪600 possibly organic.
    await expect(box).toContainText('400 ₪');
    await expect(box).toContainText('600 ₪');
    await expect(box).toContainText('מזהה קליק בלבד');
    // "Almost always", not "certainly": the ad's own link travels once a buyer
    // pastes it into a group chat, and every click from there carries the
    // campaign with it.
    await expect(box).toContainText('כמעט תמיד פרסום');
    await expect(box).not.toContainText('בוודאות פרסום');
    // And an untagged half larger than the tagged one is the ORDINARY state for
    // an owner who never pastes the optional tagging string, so it is printed
    // plainly. A warning that is always on is one she stops reading.
    await expect(box.locator('p.hint.err:has-text("מזהה קליק בלבד")')).toHaveCount(0);
    // The two printed halves add up to the printed total.
    await expect(box).toContainText('1,000 ₪');
  });

  // Nothing attributed at all: "of that: ₪0 … and ₪0" under a note that already
  // said nothing was attributed is noise, not information.
  test('with nothing attributed the split is left out, not printed as zeroes', async ({ page }) => {
    await serveMeta(
      page,
      metaAnswer({
        totals: { spend: 900, impressions: 100, clicks: 40, meta_orders: 0, meta_revenue: 0 },
        ours: {
          revenue: 0,
          orders: 0,
          rows: 0,
          tagged: { revenue: 0, orders: 0, rows: 0 },
          untagged: { revenue: 0, orders: 0, rows: 0 },
          revenue_all: 4000,
          orders_all: 9,
        },
        roas: 0,
      })
    );
    await page.goto(`/admin-ads.html?key=${KEY}`);
    const box = page.locator('#metaBox');
    await expect(box).not.toContainText('מתוך זה:');
    // The note that DOES belong there is still shown.
    await expect(box).toContainText('לא יוחסה אף הזמנה');
  });

  // A window switched faster than the answers come back. A cached 30-day reply
  // landing after a fresh 7-day one would paint spend for a window she is not
  // looking at — and nothing on screen would say so.
  test('a slow answer for the old range never overwrites the new one', async ({ page }) => {
    await page.route('**/api/admin/ads/meta**', async (route) => {
      const days = new URL(route.request().url()).searchParams.get('days');
      if (days !== '7') await new Promise((r) => setTimeout(r, 2500));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          metaAnswer(
            days === '7'
              ? {
                  days: 7,
                  totals: {
                    spend: 111,
                    impressions: 1,
                    clicks: 1,
                    meta_orders: 0,
                    meta_revenue: 0,
                  },
                }
              : {
                  totals: {
                    spend: 999,
                    impressions: 1,
                    clicks: 1,
                    meta_orders: 0,
                    meta_revenue: 0,
                  },
                }
          )
        ),
      });
    });
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await page.getByRole('button', { name: '7 ימים' }).click();
    const tiles = page.locator('#metaBox .tiles');
    await expect(tiles).toContainText('111');
    // Now let the 30-day answer land. It must be dropped, not drawn.
    await page.waitForTimeout(3000);
    await expect(tiles).toContainText('111');
    await expect(tiles).not.toContainText('999');
  });

  test('several ad accounts are listed rather than one being guessed at', async ({ page }) => {
    await serveMeta(page, {
      ok: false,
      armed: true,
      account_setting: '',
      account_env: '',
      error: 'more than one ad account — choose which one to report on',
      accounts: [
        { id: '111', name: 'Dugri' },
        { id: '222', name: 'Star Experiences' },
      ],
    });
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.locator('#metaBox')).toContainText('Dugri — 111');
    await expect(page.locator('#metaBox')).toContainText('Star Experiences — 222');
  });

  // Listing the accounts and offering no way to pick one is a dead end — and it
  // is the exact case the listing was built for.
  test('one of several accounts can be chosen, and the choice is saved', async ({ page }) => {
    await serveMeta(page, {
      ok: false,
      armed: true,
      account_setting: '',
      account_env: '',
      error: 'more than one ad account — choose which one to report on',
      accounts: [
        { id: '11122233', name: 'Dugri' },
        { id: '44455566', name: 'Star Experiences' },
      ],
    });
    // The save is intercepted rather than really written: this suite shares one
    // settings store with every other spec.
    let saved = null;
    await page.route('**/api/admin/settings**', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      saved = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ effective: saved.value }),
      });
    });

    await page.goto(`/admin-ads.html?key=${KEY}`);
    await page.locator('[data-account="44455566"]').click();
    await expect(page.getByTestId('meta-account-status')).toContainText('נשמר');
    expect(saved).toEqual({
      section: 'analytics',
      key: 'meta_ad_account_id',
      value: '44455566',
    });
  });

  // A helper that answers the settings POST and reports what was sent.
  const catchSaves = async (page, sent) =>
    page.route('**/api/admin/settings**', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      sent.push(JSON.parse(route.request().postData() || '{}').value);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ effective: sent[sent.length - 1] }),
      });
    });

  test('the account can also be typed in and cleared back to auto-discovery', async ({ page }) => {
    await serveMeta(page, metaAnswer({ account_setting: '' }));
    const sent = [];
    await catchSaves(page, sent);
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await page.getByTestId('meta-account-id').fill('');
    await page.getByTestId('save-meta-account').click();
    await expect(page.getByTestId('meta-account-status')).toContainText('גילוי אוטומטי');
    expect(sent).toEqual(['']);
  });

  // Ads Manager shows the account as `act_99887766` and that is what gets pasted.
  // The stored setting is digits only, so an unstripped paste came back as the
  // raw English regex printed in the middle of a Hebrew page.
  test('an account id pasted in Meta’s own act_ form is accepted, not refused', async ({
    page,
  }) => {
    await serveMeta(page, metaAnswer());
    const sent = [];
    await catchSaves(page, sent);
    await page.goto(`/admin-ads.html?key=${KEY}`);
    // The field shows what is in force now, so it can be changed rather than
    // guessed at.
    await expect(page.getByTestId('meta-account-id')).toHaveValue('99887766');
    await page.getByTestId('meta-account-id').fill('act_44455566');
    await page.getByTestId('save-meta-account').click();
    await expect(page.getByTestId('meta-account-status')).toContainText('44455566');
    expect(sent).toEqual(['44455566']);
  });

  // "Back to auto-discovery" is a lie when META_AD_ACCOUNT_ID is set on the
  // server: the save empties the admin field, the server falls through to the
  // environment, and the reload visibly refills the box with the env account.
  test('emptying the field says the server variable took over, when it did', async ({ page }) => {
    await serveMeta(page, metaAnswer({ account_setting: '', account_env: '55566677' }));
    const sent = [];
    await catchSaves(page, sent);
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await page.getByTestId('meta-account-id').fill('');
    await page.getByTestId('save-meta-account').click();
    const status = page.getByTestId('meta-account-status');
    await expect(status).toContainText('META_AD_ACCOUNT_ID');
    await expect(status).toContainText('55566677');
    await expect(status).not.toContainText('גילוי אוטומטי');
  });

  // Meta's server being slow or refusing must never keep OUR numbers off the
  // screen: they are the ones that do not depend on anybody else.
  test('our own table still renders when Meta’s half fails', async ({ page }) => {
    await page.route('**/api/admin/ads/meta**', (route) => route.abort());
    const campaign = unique('resilient');
    await arriveAt(page, `/index.html?utm_source=ig&utm_medium=paid&utm_campaign=${campaign}`);
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(rowFor(page, campaign)).toBeVisible();
    await expect(page.locator('#metaBox')).toContainText('נכשל');
  });

  // The page must fit the phone. It failed to: the tagged-link example in the
  // hint is one unbreakable token, so it widened the whole document, and the
  // controls at the top then sat off-screen — a click on the range buttons
  // landed on the header instead.
  test('the page never scrolls sideways on a phone', async ({ page }) => {
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.locator('#ranges button').first()).toBeVisible();
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // The wide table is allowed to scroll — inside its own box, not the page's.
      scroller: !!document.querySelector('.scroller'),
    }));
    expect(overflow.scroller).toBe(true);
    expect(overflow.doc).toBeLessThanOrEqual(1);

    // And the controls are therefore clickable where they sit.
    await page.getByRole('button', { name: '90 יום' }).click();
    await expect(page.getByRole('button', { name: '90 יום' })).toHaveClass(/on/);
  });

  // The confirmation page and the collection page are both opened with the
  // order's OWNER TOKEN in the address bar, and both load the measurement
  // module. The beacon must not carry that token to our own server, and the
  // browser must not keep a copy of it to replay with every later event.
  test('the beacon never carries the order token that is in the address', async ({ page }) => {
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/track') && r.method() === 'POST'),
      page.goto(
        '/pay-success.html?c=e2e-collection-id&k=e2e-owner-token&utm_source=instagram' +
          '&utm_medium=paid&utm_campaign=' +
          unique('token')
      ),
    ]);
    const body = JSON.parse(request.postData() || '{}');
    // The campaign still arrives — this is not a test of sending nothing.
    expect(body.landing).toContain('utm_source=instagram');
    expect(body.landing).toContain('/pay-success.html');
    expect(body.landing).not.toContain('e2e-owner-token');
    expect(body.landing).not.toContain('e2e-collection-id');

    const stored = await page.evaluate(() => localStorage.getItem('dugri_attr') || '');
    expect(stored).toContain('utm_source=instagram');
    expect(stored).not.toContain('e2e-owner-token');
    expect(stored).not.toContain('e2e-collection-id');
  });

  test('the admin pages are never counted as traffic', async ({ page }) => {
    let tracked = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/track')) tracked = true;
    });
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.locator('#main')).toBeVisible();
    await page.goto(`/dashboard.html?key=${KEY}`);
    expect(tracked).toBe(false);
  });
});
