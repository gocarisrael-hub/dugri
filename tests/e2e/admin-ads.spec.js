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

  // The optional "paste this into URL parameters" block is gone from the page:
  // Meta's own table already names every ad, and she never used it. What it was
  // FOR still works, because the parsing lives on the server — an ad that does
  // carry Meta's substitutions still names itself in our table.
  test('the optional Meta string is gone, and a Meta-tagged click still names itself', async ({
    page,
  }) => {
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.locator('#main')).toBeVisible();
    await expect(page.getByTestId('auto-params')).toHaveCount(0);
    await expect(page.getByTestId('copy-auto-params')).toHaveCount(0);
    await expect(page.locator('#main')).not.toContainText('שמות קמפיינים בטבלה שלנו');
    // And the manual builder's hint stops sending her away on the strength of a
    // block that no longer exists. Nothing fills a name by itself now — an ad
    // included — so the builder is for every named link, not the leftovers.
    await expect(page.locator('#main')).not.toContainText('שאין בהם מודעה שתמלא את השמות לבד');
    await expect(page.locator('#main')).toContainText('שום מקום לא ממלא את השם לבד');

    // Arrive the way a real click does — with Meta's substitutions already
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

  // THE BIO LINK BUG. The builder used the address the admin page was open at,
  // so a link built from the Railway hostname went into the owner's Instagram
  // bio pointing at *.up.railway.app. It worked, which is why nothing caught it.
  test('the built link uses the site’s real domain, not whatever host the admin is open at', async ({
    page,
  }) => {
    await page.route('**/api/admin/ads?*', async (route) => {
      const resp = await route.fetch();
      const body = await resp.json();
      body.base_url = 'https://dugri-israel.co.il';
      await route.fulfill({ response: resp, json: body });
    });
    await page.goto(`/admin-ads.html?key=${KEY}`);
    // The builder hands out nothing until the server has said what the site's
    // address is, and the copy button going live is how it says so. Waiting on
    // that is also what stops this test racing the report request.
    await expect(page.getByTestId('copy-ad-link')).toBeEnabled();
    await page.locator('#bCampaign').fill('bio');

    const link = await page.getByTestId('ad-link').inputValue();
    expect(link.startsWith('https://dugri-israel.co.il/')).toBe(true);
    expect(link).not.toContain('localhost');
    expect(link).toContain('utm_medium=bio');
  });

  // PUBLIC_BASE_URL is typed by hand into Railway and nothing validates it on the
  // way in (paymentBaseUrl only trims trailing slashes), so a value with no
  // scheme is a plausible thing to find there — and this page is the one asking
  // the owner to go and change that variable. new URL() throws on it, and thrown
  // inside loadReport's try it would be swallowed into "טעינה נכשלה" and take the
  // WHOLE report down, tiles and rows and all, over a link builder.
  test('a malformed PUBLIC_BASE_URL costs the link, not the report', async ({ page }) => {
    const campaign = unique('malformed');
    await arriveAt(
      page,
      `/index.html?utm_source=instagram&utm_medium=paid&utm_campaign=${campaign}`
    );
    await page.route('**/api/admin/ads?*', async (route) => {
      const resp = await route.fetch();
      const body = await resp.json();
      body.base_url = 'dugri-israel.co.il'; // no scheme
      await route.fulfill({ response: resp, json: body });
    });
    await page.goto(`/admin-ads.html?key=${KEY}`);

    // The report is the point of the page, and it is all still there.
    await expect(rowFor(page, campaign)).toBeVisible();
    await expect(page.locator('#tiles')).not.toBeEmpty();
    await expect(page.locator('#main')).not.toContainText('טעינה נכשלה');

    // The link is the part that cannot be built, and it says which setting is
    // wrong rather than quietly handing back a link to the wrong host.
    await expect(page.getByTestId('ad-link')).toHaveValue('');
    await expect(page.getByTestId('copy-ad-link')).toBeDisabled();
    await expect(page.locator('#bStatus')).toContainText('PUBLIC_BASE_URL');
  });

  // A transient failure used to leave the builder silently resolving against
  // this page's own origin for the rest of the session — emitting
  // *.up.railway.app links with nothing on screen saying so, which is the exact
  // bug the base_url handover was added to stop.
  test('a failed report leaves no wrong-host link to copy', async ({ page }) => {
    await page.route('**/api/admin/ads?*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
    );
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.locator('#main')).toContainText('טעינה נכשלה');

    await page.locator('#bCampaign').fill('bio');
    await expect(page.getByTestId('ad-link')).toHaveValue('');
    await expect(page.getByTestId('copy-ad-link')).toBeDisabled();
  });

  test('the manual builder still writes a link for the bio and the stories', async ({ page }) => {
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.getByTestId('copy-ad-link')).toBeEnabled();
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

  // The builder is the half of the tagging section she actually uses — for the
  // Instagram bio link — so removing the optional Meta string beside it must not
  // have taken any of its choices with it.
  test('every choice in the manual builder reaches the link', async ({ page }) => {
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.getByTestId('copy-ad-link')).toBeEnabled();
    await page.locator('#bDest').selectOption('/products.html');
    await page.locator('#bSource').selectOption('tiktok');
    await page.locator('#bMedium').selectOption('story');
    await page.locator('#bCampaign').fill('fall');
    const link = new URL(await page.getByTestId('ad-link').inputValue());
    expect(link.pathname).toBe('/products.html');
    expect(link.searchParams.get('utm_source')).toBe('tiktok');
    expect(link.searchParams.get('utm_medium')).toBe('story');
    expect(link.searchParams.get('utm_campaign')).toBe('fall');
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
    // an owner who never tags her ads, so it is printed plainly. A warning that
    // is always on is one she stops reading.
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
    // This is the case the field exists for, so here it is offered.
    await expect(page.getByTestId('meta-account-id')).toBeVisible();
  });

  // The owner has ONE ad account, found by itself. A field asking which account
  // to report on, in that state, is a question with only one answer.
  test('with one account found by itself, the account field is not shown', async ({ page }) => {
    let answer = metaAnswer({ account_setting: '' });
    await serveMeta(page, () => answer);
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.getByTestId('meta-table')).toBeVisible();
    await expect(page.getByTestId('meta-account')).toHaveCount(0);

    // Nor on a window with no ads in it, nor when the account comes from the
    // server's environment — the field cannot change that one either way.
    answer = metaAnswer({ account_setting: '', account_env: '55566677', rows: [] });
    await page.getByRole('button', { name: '7 ימים' }).click();
    await expect(page.locator('#metaBox')).toContainText('אין מודעות שרצו בטווח הזה');
    await expect(page.getByTestId('meta-account')).toHaveCount(0);
  });

  // The refusal is quoted verbatim — and the field comes with it. A refusal may
  // BE the account (a wrong META_AD_ACCOUNT_ID, or a token that cannot list the
  // accounts to choose from), and this page is the only one that can outrank the
  // environment variable. A field she doesn't need beats a report she cannot fix.
  test('Meta’s refusal is shown, with the field that may be what fixes it', async ({ page }) => {
    await serveMeta(page, {
      ok: false,
      armed: true,
      account_setting: '',
      account_env: '',
      error: '(#200) Missing Permissions',
    });
    await page.goto(`/admin-ads.html?key=${KEY}`);
    const note = page.getByTestId('meta-note').first();
    await expect(note).toContainText('מטא החזירה: (#200) Missing Permissions');
    await expect(note).toHaveClass(/err/);
    await expect(page.getByTestId('meta-account-id')).toBeVisible();
  });

  // The dead end this guards: a bad META_AD_ACCOUNT_ID in the server's
  // environment. Meta refuses, nothing is offered to choose from, no override is
  // saved — and a saved override is the ONLY thing that outranks the env var, so
  // without the field the report waits for a redeploy.
  test('a wrong account in the environment can be overridden from the page', async ({ page }) => {
    let saved = null;
    await page.route('**/api/admin/settings**', async (route) => {
      const body = route.request().postData();
      if (body) saved = JSON.parse(body);
      await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });
    let answer = {
      ok: false,
      armed: true,
      account_setting: '',
      account_env: '99999999',
      error: '(#100) Object with ID act_99999999 does not exist',
    };
    await serveMeta(page, () => answer);
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.locator('#metaBox')).toContainText('act_99999999 does not exist');
    // Empty, because nothing is saved yet — the number on screen is the server's.
    await expect(page.getByTestId('meta-account-id')).toHaveValue('');
    answer = metaAnswer({ account_setting: '12345678' });
    await page.getByTestId('meta-account-id').fill('12345678');
    await page.getByTestId('save-meta-account').click();
    await expect(page.getByTestId('meta-account-status')).toContainText('12345678');
    expect(saved).toMatchObject({
      section: 'analytics',
      key: 'meta_ad_account_id',
      value: '12345678',
    });
  });

  // The "saved" flag is a one-shot for the next render, and the picker that
  // consumes it is no longer built on every render. If the reload a save triggers
  // FAILS, nothing consumes it — and a later, healthy report would then show a
  // field it means to hide, stamped with a "נשמר ✓" from a save long gone.
  test('a save whose reload fails leaves no stale ✓ on the next report', async ({ page }) => {
    await page.route('**/api/admin/settings**', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) })
    );
    let mode = 'saved';
    await page.route('**/api/admin/ads/meta**', (route) => {
      if (mode === 'boom') {
        return route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'מטא לא זמינה' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(metaAnswer({ account_setting: mode === 'saved' ? '99887766' : '' })),
      });
    });
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.getByTestId('meta-account-id')).toHaveValue('99887766');

    // Clear the override; the reload that would confirm it dies.
    mode = 'boom';
    await page.getByTestId('meta-account-id').fill('');
    await page.getByTestId('save-meta-account').click();
    await expect(page.locator('#metaBox')).toContainText('טעינת נתוני מטא נכשלה');
    // The save itself landed, and says so rather than vanishing with the render.
    await expect(page.locator('#metaBox')).toContainText('ההגדרה נשמרה');

    // A healthy report afterwards: one account, found by itself, nothing saved —
    // so no field, and certainly no ✓ from the save before last.
    mode = 'clean';
    await page.getByRole('button', { name: '7 ימים' }).click();
    await expect(page.getByTestId('meta-table')).toBeVisible();
    await expect(page.getByTestId('meta-account')).toHaveCount(0);
  });

  // A saved override is shown whatever state the report is in: a wrong one is
  // exactly what makes Meta refuse, and it can only be cleared if it can be seen.
  test('a saved account is shown even on an error, so it can be cleared', async ({ page }) => {
    await serveMeta(page, {
      ok: false,
      armed: true,
      account: '12345678',
      account_setting: '12345678',
      account_env: '',
      error: '(#100) Object with ID act_12345678 does not exist',
    });
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.locator('#metaBox')).toContainText('מטא החזירה');
    await expect(page.getByTestId('meta-account-id')).toHaveValue('12345678');
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

  // The stub answers with whatever was last saved, the way the server would, so
  // the reload after a save sees the override gone.
  const savedAnswer =
    (sent, first, over = {}) =>
    () =>
      metaAnswer({ account_setting: sent.length ? sent[sent.length - 1] : first, ...over });

  test('a saved account can be cleared back to auto-discovery', async ({ page }) => {
    const sent = [];
    await serveMeta(page, savedAnswer(sent, '99887766'));
    await catchSaves(page, sent);
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.getByTestId('meta-account-id')).toHaveValue('99887766');
    await page.getByTestId('meta-account-id').fill('');
    await page.getByTestId('save-meta-account').click();
    // The save's own message is still said, on the render the save caused…
    await expect(page.getByTestId('meta-account-status')).toContainText('גילוי אוטומטי');
    expect(sent).toEqual(['']);

    // …and after that, with nothing saved and one account found, the field has
    // nothing left to do and is put away.
    await page.getByRole('button', { name: '7 ימים' }).click();
    await expect(page.getByTestId('meta-table')).toBeVisible();
    await expect(page.getByTestId('meta-account')).toHaveCount(0);
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
    const sent = [];
    await serveMeta(page, savedAnswer(sent, '11122233', { account_env: '55566677' }));
    await catchSaves(page, sent);
    await page.goto(`/admin-ads.html?key=${KEY}`);
    await expect(page.getByTestId('meta-account-id')).toHaveValue('11122233');
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
