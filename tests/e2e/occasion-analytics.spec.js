import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// Measuring the occasion pages (spec: "Analytics and Google connections"). What these pin:
// - /yom-huledet sends occasion_view, an order button sends occasion_cta_click with its place, and an
//   opened question sends faq_open with the occasion (GA, through js/analytics.js);
// - the wizard opened from the page pre-fills the event type with the page's label, and the order it
//   creates carries the page's slug (read back from the admin's orders API);
// - the admin's ads page shows "orders by occasion page", with the visits the page's beacon counted.

const KEY = 'dugri-admin';
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

const events = (page) =>
  page.evaluate(() =>
    window.dataLayer.filter((a) => a[0] === 'event').map((a) => [a[1], { ...a[2] }])
  );

test('the occasion page sends its view, its order clicks and its FAQ opens, all with the occasion', async ({
  page,
}) => {
  await page.goto('/yom-huledet');
  await page.waitForLoadState('load');
  await expect
    .poll(() => events(page))
    .toContainEqual(['occasion_view', { audience: 'private', occasion: 'yom-huledet' }]);
  // keep the page where it is so its dataLayer can be read after the clicks
  await page.evaluate(() =>
    document.addEventListener('click', (e) => e.target.closest('a') && e.preventDefault(), true)
  );
  await page.locator('.hero .cta a.pill').click();
  await page.locator('#faq details').nth(1).locator('summary').click();
  const question = (
    await page.locator('#faq details').nth(1).locator('summary').innerText()
  ).trim();
  await expect
    .poll(() => events(page))
    .toContainEqual(['occasion_cta_click', { occasion: 'yom-huledet', cta: 'hero' }]);
  // `toggle` is queued, so the open is read when it lands
  await expect
    .poll(() => events(page))
    .toContainEqual(['faq_open', { question, position: 2, occasion: 'yom-huledet' }]);
  expect(await events(page)).toContainEqual([
    'order_started',
    { cta: 'hero', occasion: 'yom-huledet' },
  ]);
});

test('an order started from the page has its label as the event type, and keeps its slug', async ({
  page,
  request,
}) => {
  await stubFeatures(page, ALL_ON);
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      json: {
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      },
    })
  );
  // the wizard as the page's hero button opens it
  await page.goto('/options.html?occasion=yom-huledet');
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId('next-btn').click(); // -> colour
  await page.getByTestId('next-btn').click(); // -> name
  await expect(page.getByTestId('step-3')).toBeVisible();
  const title = 'Occ' + Math.random().toString(36).slice(2, 8).replace(/\d/g, 'x');
  await page.getByTestId('custom-title-input').fill(title);
  await page.getByTestId('next-btn').click(); // -> pawn photos
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await page.getByTestId('next-btn').click(); // -> details
  await expect(page.getByTestId('step-4')).toBeVisible();
  // the page's own label, from its data file (server/occasions/yom-huledet.json)
  await expect(page.getByTestId('event-type-input')).toHaveValue('יום הולדת לאמא');
  await page.getByTestId('owner-email').fill('occasion-e2e@example.com');
  await page.getByTestId('owner-phone').fill('0521234567');
  await page.getByTestId('buyer-name-input').fill('דנה כהן');
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/collections') && r.request().method() === 'POST'
  );
  await page.getByTestId('next-btn').click(); // create the order
  expect((await created).status()).toBe(201);

  const r = await request.get(`/api/admin/collections?key=${KEY}`);
  const row = (await r.json()).collections.find((c) => c.honoree_name === title);
  expect(row, 'the test order').toBeTruthy();
  expect(row.occasion).toBe('yom-huledet');
  expect(row.event_type).toBe('יום הולדת לאמא');
});

test('the admin sees orders by occasion page, with the page’s visits', async ({
  page,
  request,
}) => {
  // a visit the page's beacon would send (js/attribution.js trackVisit on /yom-huledet-aba)
  const visitor = 'e2e-occ-' + Math.random().toString(36).slice(2, 10);
  await request.post('/api/track', {
    data: {
      kind: 'visit',
      landing: 'http://localhost/yom-huledet-aba',
      referrer: '',
      visitor,
      occasion: 'yom-huledet-aba',
    },
  });
  await page.goto(`/admin-ads.html?key=${KEY}`);
  const table = page.getByTestId('occasion-table');
  const dad = table.locator('tr[data-slug="yom-huledet-aba"]');
  await expect(dad).toBeVisible();
  await expect(dad.locator('td').nth(0)).toHaveText('יום הולדת לאבא');
  await expect(dad.locator('td').nth(1)).toHaveText('/yom-huledet-aba');
  expect(Number(await dad.locator('td').nth(2).innerText())).toBeGreaterThanOrEqual(1);
  await expect(table.locator('tr[data-slug="yom-huledet"]')).toBeVisible();
  await expect(table.locator('thead')).toContainText('הזמנות ששולמו');
});
