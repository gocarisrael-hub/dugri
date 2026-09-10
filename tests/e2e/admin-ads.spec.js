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

// Go to a page AND wait for its measurement beacon. The waiter has to be armed
// before the navigation: the beacon fires during load, so a wait registered
// afterwards is a wait for an event that has already happened.
async function arriveAt(page, url) {
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/track') && r.method() === 'POST'),
    page.goto(url),
  ]);
  return request;
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

  // THE ONE THING SHE HAS TO DO, and it is one paste that is the same for every
  // ad. Meta substitutes the placeholders itself, so no campaign name is ever
  // typed by hand — a report that needed manual tagging per ad would be right in
  // principle and empty in practice.
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
