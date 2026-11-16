import { test, expect } from '@playwright/test';

// Occasion pages 15-19 (server/occasions/<slug>.json on site/occasion.html): each loads with its own H1, its order buttons
// carry its slug, the footer row links and marks it, no price shows and nothing scrolls sideways at 375px. The farewell page
// says shipping is inside Israel only; the bachelorette page's footer row reaches the bachelor page.

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

for (const [slug, h1, label] of [
  ['preida', 'מתנת פרידה לחברה שעוברת לחו״ל', 'פרידה ומעבר לחו״ל'],
  ['siyum', 'מתנת סוף שנה לקבוצה, לקורס או לצוות', 'סוף שנה וסיום קורס'],
  ['mesibat-hafta-a', 'משחק למסיבת הפתעה, שכל המוזמנים כותבים מראש', 'מסיבת הפתעה'],
  ['giyus', 'מתנה לגיוס לצה״ל, שכל המשפחה והחברים כותבים', 'גיוס לצה״ל'],
  ['mesibat-ravakim', 'משחק למסיבת רווקים, שכל החברים כותבים על החתן', 'מסיבת רווקים'],
]) {
  test(`/${slug} loads with its H1 and every order button carries the slug`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const res = await page.goto('/' + slug);
    expect(res.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText(h1);
    await expect(page.locator('.chips li')).toHaveCount(8);
    await expect(page.locator('.hero .pn.sky')).toContainText('עד 412 מילים אישיות');
    await expect(page.locator('#faq details')).toHaveCount(5);
    await expect(page.locator('#faq')).toContainText('כמה שרוצים, עדיף בקבוצות.');
    const hrefs = await page
      .locator('a.pill:not([href^="https://wa.me"])')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toBe('options.html?occasion=' + slug);
    const row = page.getByTestId('footer-occasions');
    await expect(row.locator(`a[href="/${slug}"]`)).toHaveText(label);
    await expect(row.locator(`a[href="/${slug}"]`)).toHaveAttribute('aria-current', 'page');
    await page.waitForLoadState('networkidle');
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/₪/);
    expect(text).not.toContain('{eta}');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.locator('.hero .cta a.pill').click();
    await expect(page).toHaveURL(new RegExp(`/options\\.html\\?occasion=${slug}$`));
  });
}

test('/preida says shipping is inside Israel only, in the open first question and in the steps', async ({
  page,
}) => {
  await page.goto('/preida');
  const first = page.locator('#faq details').first();
  await expect(first).toHaveAttribute('open', '');
  await expect(first.locator('summary')).toHaveText('אפשר לשלוח לחו״ל?');
  await expect(first).toContainText('משלוחים רק בתוך ישראל');
  await expect(first).toContainText('מזמינים לכתובת בארץ לפני הטיסה');
  await expect(page.locator('.steps')).toContainText('רק בתוך ישראל');
});

test('the bachelorette page reaches the bachelor page', async ({ page }) => {
  await page.goto('/mesibat-ravakot');
  await page.getByTestId('footer-occasions').locator('a[href="/mesibat-ravakim"]').click();
  await expect(page).toHaveURL(/\/mesibat-ravakim$/);
  await expect(page.locator('h1')).toHaveText('משחק למסיבת רווקים, שכל החברים כותבים על החתן');
});
