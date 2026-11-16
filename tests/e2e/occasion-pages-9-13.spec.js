import { test, expect } from '@playwright/test';

// Occasion pages 9-13 (server/occasions/<slug>.json on site/occasion.html): each loads at 375px with its own H1, example
// words and questions, every order button carries its slug (the hero's clicked through to the wizard), the footer row
// marks it, there is no price anywhere and nothing scrolls sideways.

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

for (const [slug, h1, label, faqs] of [
  ['yom-huledet-ben-zug', 'מתנה ליום הולדת לבן הזוג, שכל החברים כותבים', 'יום הולדת לבן הזוג', 4],
  ['bat-mitzva', 'מתנה לבת מצווה שכל המשפחה והחברות כותבות', 'בת מצווה ובר מצווה', 5],
  ['mesibat-erusin', 'משחק למסיבת אירוסין, שכל החברים של הזוג כותבים', 'מסיבת אירוסין', 5],
  ['zug', 'מתנה מקורית לחתן וכלה, משחק שכולו עליהם', 'חתונה וזוגות', 4],
  ['leida', 'מתנה ללידה, לברית או לבריתה, שכל המשפחה והחברות כותבות', 'לידה, ברית ובריתה', 5],
]) {
  test(`/${slug} loads with its H1 and every order button carries the slug`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const res = await page.goto('/' + slug);
    expect(res.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText(h1);
    await expect(page.locator('.hero .pn.sky')).toContainText('עד 412 מילים אישיות');
    await expect(page.locator('.chips li')).toHaveCount(8);
    await expect(page.locator('.chips-note')).toContainText('דוגמאות');
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
    await page.waitForLoadState('networkidle');
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/₪/);
    expect(text).not.toContain('בייבי שאוור');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.locator('.hero .cta a.pill').click();
    await expect(page).toHaveURL(new RegExp(`/options\\.html\\?occasion=${slug}$`));
  });
}
