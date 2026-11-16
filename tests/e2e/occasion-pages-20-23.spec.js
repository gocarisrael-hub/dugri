import { test, expect } from '@playwright/test';

// Occasion pages 20-23 (server/occasions/*.json on site/occasion.html). What these pin:
// - pages 20, 21 and 23 load at 375px with their own H1, eight example words and their FAQ, no price, no sideways
//   scroll; every order button carries the page's slug and the hero's opens the wizard with it; the footer row links them;
// - page 22 (Valentine's Day and Tu B'Av) is built but not live: it answers 404 and no footer row links it.

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

for (const [slug, h1, label, faqs] of [
  [
    'yom-huledet-saba-savta',
    'מתנה ליום הולדת לסבא או לסבתא, שכל הנכדים כותבים',
    'יום הולדת לסבא וסבתא',
    5,
  ],
  [
    'tiyul-chavura-lechul',
    'משחק לטיול עם החבר׳ה בחו״ל, שכל המילים בו עליכם',
    'טיול חברים לחו״ל',
    5,
  ],
  ['deit-mafti-a', 'דייט מפתיע בבית: משחק שכל המילים בו על שניכם', 'דייט מפתיע', 4],
]) {
  test(`/${slug} loads with its H1 and every order button carries the slug`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const res = await page.goto('/' + slug);
    expect(res.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText(h1);
    await expect(page.locator('.chips li')).toHaveCount(8);
    await expect(page.locator('.hero .pn.sky')).toContainText('עד 412 מילים אישיות');
    await expect(page.locator('#faq details')).toHaveCount(faqs);
    await expect(page.locator('#faq')).toContainText('כמה שרוצים, עדיף בקבוצות.');
    const hrefs = await page
      .locator('a.pill:not([href^="https://wa.me"])')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toBe('options.html?occasion=' + slug);
    const row = page.getByTestId('footer-occasions');
    await expect(row.locator(`a[href="/${slug}"]`)).toHaveText(label);
    await expect(row.locator(`a[href="/${slug}"]`)).toHaveAttribute('aria-current', 'page');
    await expect(row.locator('a[href="/yom-haahava"]')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(await page.locator('body').innerText()).not.toMatch(/₪/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.locator('.hero .cta a.pill').click();
    await expect(page).toHaveURL(new RegExp(`/options\\.html\\?occasion=${slug}$`));
  });
}

test("/yom-huledet-saba-savta answers the card size in the owner's words", async ({ page }) => {
  await page.goto('/yom-huledet-saba-savta');
  await page.locator('summary', { hasText: 'הכתב מספיק גדול לסבא וסבתא?' }).click();
  await expect(page.locator('#faq')).toContainText('כן, הקלפים בגרסה הרגילה גדולים וקריאים.');
});

test('/yom-haahava is not live yet: 404, and the home footer row does not link it', async ({
  page,
  request,
}) => {
  expect((await request.get('/yom-haahava')).status()).toBe(404);
  await page.goto('/');
  const row = page.getByTestId('footer-occasions');
  await expect(row.locator('a[href="/deit-mafti-a"]')).toHaveText('דייט מפתיע');
  await expect(row.locator('a[href="/yom-haahava"]')).toHaveCount(0);
});
