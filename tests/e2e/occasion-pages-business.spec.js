import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// The company pages (site/occasion-business.html filled by server/occasions.js renderBusinessPage). What these pin:
// - /asakim, /matanot-leeruei-chevra, /matana-memutegget and /matana-mekorit-laovdim load with their H1, the logo row under
//   the hero, the three reasons, the kit, four company steps, the example words, only business reviews, the FAQ and the lead
//   form; no price, no wizard link, no sideways scroll at 375px, in and out of redesign mode;
// - every button reads "לקבלת הצעה לחברה" and goes to the lead form, the design view's too;
// - the sent lead form reports business_lead_submit with the page's occasion;
// - the holiday page (/matanot-lechag-laovdim) is not live yet; the home page links /asakim.

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

const PAGES = [
  ['asakim', 'דוגרי – מתנה שהעובדים עוד לא ראו, כזאת שמדברת בשפה שלכם'],
  ['matanot-leeruei-chevra', 'מתנה לאירוע חברה ולהרמת כוסית, שמדברת בשפה שלכם'],
  ['matana-memutegget', 'מתנה פרסונלית לעובדים, שמשדרת את רוח החברה'],
  ['matana-mekorit-laovdim', 'מתנה שהעובדים עוד לא ראו'],
];

for (const mode of ['plain', 'redesign']) {
  for (const [slug, h1] of PAGES) {
    test(`/${slug} (${mode}): the company page, every button a quote button, no price`, async ({
      page,
    }) => {
      if (mode === 'redesign') await previewRedesign(page);
      await page.setViewportSize({ width: 375, height: 800 });
      const res = await page.goto('/' + slug);
      expect(res.status()).toBe(200);
      await expect(page.locator('h1')).toHaveText(h1);
      await expect(page.locator('.catch .big')).toHaveText('כל המילים עליכם!');
      await expect(page.locator('.occ-logos .logos img')).toHaveCount(5);
      await expect(page.locator('.occ-logos')).toBeVisible();
      await expect(page.locator('.why li')).toHaveCount(3);
      await expect(page.locator('.kit li')).toHaveCount(4);
      await expect(page.locator('.kit')).toContainText('דף עזר שנכין במיוחד בשבילכם');
      await expect(page.locator('[data-testid="kit-quantity"]')).toHaveText(
        'יש כמובן מחירים מיוחדים לכמויות גדולות'
      );
      await expect(page.locator('.steps .step')).toHaveCount(4);
      await expect(page.locator('.chips li')).toHaveCount(8);
      await expect(page.locator('#faq')).toContainText('העובדים צריכים לעשות משהו?');
      await expect(page.locator('#faq')).toContainText('יש מחירים מיוחדים לכמויות?');
      // reviews: the business customers' cards only
      const tags = await page.locator('#recs .rc .tag').allInnerTexts();
      expect(tags.length).toBeGreaterThan(0);
      for (const t of tags) expect(t.trim()).toBe('לקוח עסקי');
      // the lead form, shown, under the quote heading
      await expect(page.locator('#biz')).toBeVisible();
      await expect(page.locator('#h-biz')).toHaveText('לקבלת הצעה לחברה');
      await expect(page.locator('#lead')).toBeVisible();
      // no wizard, no price
      await page.waitForLoadState('networkidle');
      expect(await page.locator('a[href*="options.html"], a[href*="products.html"]').count()).toBe(
        0
      );
      expect(await page.locator('body').innerText()).not.toMatch(/₪|חשבונית/);
      for (const a of await page.locator('a.pill').all()) {
        const href = await a.getAttribute('href');
        if (href.startsWith('https://wa.me/')) continue;
        expect(href).toBe('#biz');
        expect((await a.textContent()).trim()).toBe('לקבלת הצעה לחברה');
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
    });
  }
}

test('the hero button brings the lead form into view', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/asakim');
  await page.locator('.hero .cta .pill').click();
  await expect(page.locator('#lead')).toBeInViewport();
});

test("the design view's button asks for a quote: it closes the view and goes to the lead form", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/asakim');
  await page.locator('#strip .dz:not([aria-hidden])').first().click();
  await expect(page.locator('#flood')).toHaveAttribute('open', '');
  await expect(page.locator('#floodPrice')).toBeHidden();
  const order = page.locator('#floodOrder');
  await expect(order).toHaveAttribute('href', '#biz');
  await expect(order).toHaveText('לקבלת הצעה לחברה');
  await order.click();
  await expect(page.locator('#flood')).not.toHaveAttribute('open', '');
  await expect(page.locator('#lead')).toBeInViewport();
});

test('a sent lead reports business_lead_submit with the page, and the lead knows the page', async ({
  page,
}) => {
  let body = null;
  await page.route('**/api/business-lead', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/matana-memutegget');
  await page.locator('#lName').fill('דנה');
  await page.locator('#lCo').fill('חברה בע"מ');
  await page.locator('#lTel').fill('0541234567');
  await page.locator('#lead button[type=submit]').click();
  await expect(page.locator('#leadOk')).toBeVisible();
  expect(body.source).toBe('/matana-memutegget');
  const sent = await page.evaluate(() =>
    (window.dataLayer || [])
      .map((a) => Array.from(a))
      .filter((a) => a[0] === 'event')
      .map((a) => [a[1], a[2]])
  );
  expect(sent).toContainEqual([
    'occasion_view',
    { audience: 'business', occasion: 'matana-memutegget' },
  ]);
  expect(sent).toContainEqual(['business_lead_submit', { occasion: 'matana-memutegget' }]);
});

test('the holiday page waits for its season, and the raw company template is never served', async ({
  request,
}) => {
  expect((await request.get('/matanot-lechag-laovdim')).status()).toBe(404);
  expect((await request.get('/occasion-business.html')).status()).toBe(404);
});

for (const mode of ['plain', 'redesign']) {
  test(`the home page's business section links /asakim (${mode})`, async ({ page }) => {
    if (mode === 'redesign') await previewRedesign(page);
    await page.goto('/');
    const link = page.locator('#biz a[href="/asakim"], #business a[href="/asakim"]');
    await expect(link).toHaveCount(1);
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeVisible();
  });
}
