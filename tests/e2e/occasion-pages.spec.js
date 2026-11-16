import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// The occasion landing pages (site/occasion.html filled by server/occasions.js). What these pin:
// - /yom-huledet and /yom-huledet-aba load with their own H1, steps, example words and FAQ, and no price anywhere;
// - every order button opens the wizard with the occasion in the URL (the hero's, clicked through to options.html);
// - the hero deck deals the page's own designs (the custom ones once /api/custom-designs answers) and the strip starts with them;
// - the raw template is never served; the footer's "לפי אירוע" row links the pages;
// - the page looks the same in redesign mode (production runs it) and nothing scrolls sideways at 375px.

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

const MOM_DESIGNS = ['daniel-amit', 'birthday', 'grapefruit', 'marriage', 'bachelorette'];
const DAD_DESIGNS = ['japanese', 'kids', 'football-boys', 'posttrip'];

for (const mode of ['plain', 'redesign']) {
  test.describe(`/yom-huledet (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      if (mode === 'redesign') await previewRedesign(page);
      await page.setViewportSize({ width: 375, height: 800 });
    });

    test('renders the page from its data file, with no price and no sideways scroll', async ({
      page,
    }) => {
      const res = await page.goto('/yom-huledet');
      expect(res.status()).toBe(200);
      await expect(page.locator('h1')).toHaveText('המתנה ליום הולדת 60 שכל המשפחה כותבת');
      await expect(page).toHaveTitle('מתנה ליום הולדת 60 לאמא – משחק שכל המשפחה כותבת | דוגרי');
      await expect(page.locator('.hero .pn.sky')).toContainText('עד 412 מילים אישיות');
      await expect(page.locator('.catch .big')).toHaveText('כל המילים עליה!');
      await expect(page.locator('.steps .step')).toHaveCount(3);
      await expect(page.locator('.chips li')).toHaveCount(8);
      await expect(page.locator('.chips-note')).toContainText('דוגמאות');
      await expect(page.locator('#faq details')).toHaveCount(5);
      await expect(page.locator('#faq')).toContainText('כמה שרוצים, עדיף בקבוצות.');
      // the reviews row is the home page's; the story is gone and the business section hidden
      await expect(page.locator('#recs .rc').first()).toBeAttached();
      await expect(page.locator('#story')).toHaveCount(0);
      await expect(page.locator('#biz')).toBeHidden();
      // no price on the page, not even in a design's view
      await page.waitForLoadState('networkidle');
      expect(await page.locator('body').innerText()).not.toMatch(/₪/);
      await page.locator('#strip .dz:not([aria-hidden])').first().click();
      await expect(page.locator('#flood')).toHaveAttribute('open', '');
      await expect(page.locator('#floodPrice')).toBeHidden();
      await expect(page.locator('#floodOrder')).toHaveAttribute('href', /&occasion=yom-huledet$/);
      await page.keyboard.press('Escape');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      if (mode === 'redesign')
        await expect(page.locator('html')).toHaveClass(/(^|\s)rd-native(\s|$)/);
    });

    test('the hero button opens the wizard with the occasion in the URL', async ({ page }) => {
      await page.goto('/yom-huledet');
      for (const href of await page
        .locator('a.pill:not([href^="https://wa.me"])')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href'))))
        expect(href).toBe('options.html?occasion=yom-huledet');
      await page.locator('.hero .cta a.pill').click();
      await expect(page).toHaveURL(/\/options\.html\?occasion=yom-huledet/);
    });
  });
}

// her uploaded designs on the pages (daniel-amit, grapefruit, football-boys) come from /api/custom-designs, after first paint
const customDesign = (id) => ({
  id,
  name: id,
  theme: id,
  custom: true,
  public: true,
  img: {
    front: `/api/template-image/${id}/front`,
    back: `/api/template-image/${id}/back`,
    board: `/api/template-image/${id}/board`,
  },
});
const CUSTOM = ['daniel-amit', 'grapefruit', 'football-boys'].map(customDesign);
// the custom designs answer only when `release` is called, so the page's first paint can be checked on its own
async function holdCustomDesigns(page) {
  let release;
  const gate = new Promise((r) => (release = r));
  await page.unroute('**/api/custom-designs');
  await page.route('**/api/custom-designs', async (route) => {
    await gate;
    await route.fulfill({ json: { designs: CUSTOM } });
  });
  return () => release();
}
const dealtIds = (page) =>
  page
    .locator('#stage .card img.f')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('src').match(/cards\/([a-z-]+)-f\d\.webp$/)[1])
    );
const stripIds = (page, n) =>
  page
    .locator('#strip .dz:not([aria-hidden])')
    .evaluateAll((els, n) => els.slice(0, n).map((e) => e.dataset.k), n);

for (const [slug, want, firstPaint, dealt] of [
  [
    'yom-huledet',
    MOM_DESIGNS,
    ['birthday', 'marriage', 'bachelorette'],
    ['daniel-amit', 'birthday', 'grapefruit', 'marriage', 'bachelorette'],
  ],
  [
    'yom-huledet-aba',
    DAD_DESIGNS,
    ['japanese', 'kids', 'posttrip'],
    // ברוקלין (kids) is on the strip but never dealt (NOT_DEALT, site/js/home-data.js)
    ['japanese', 'football-boys', 'posttrip'],
  ],
]) {
  test(`/${slug}: the deck deals the page’s own designs, custom ones once they arrive`, async ({
    page,
  }) => {
    const release = await holdCustomDesigns(page);
    await page.goto('/' + slug);
    const cards = page.locator('#stage .card');
    // first paint, before the custom designs answer: a full deck of the page's built-ins, nothing unrelated
    await expect(cards).toHaveCount(1);
    for (let i = 0; i < 3; i++) await page.locator('#deck').click();
    await expect(cards).toHaveCount(4);
    for (const id of await dealtIds(page)) expect(firstPaint).toContain(id);
    expect(await stripIds(page, firstPaint.length)).toEqual(firstPaint);
    // the custom designs arrive: the strip starts with her list, in her order
    release();
    await expect.poll(() => stripIds(page, want.length)).toEqual(want);
    for (let i = 0; i < 16; i++) await page.locator('#deck').click();
    const ids = await dealtIds(page);
    for (const id of ids) expect(dealt).toContain(id);
    // and a custom design is dealt too (the earliest cards may have left the pile)
    expect(ids.some((id) => CUSTOM.some((d) => d.id === id))).toBe(true);
  });
}

test('the dad page is its own page', async ({ page }) => {
  await page.goto('/yom-huledet-aba');
  await expect(page.locator('h1')).toHaveText('המתנה ליום הולדת 60 לאבא שכל המשפחה כותבת');
  await expect(page.locator('.catch .big')).toHaveText('כל המילים עליו!');
  await expect(page.locator('.hero .cta a.pill')).toHaveAttribute(
    'href',
    'options.html?occasion=yom-huledet-aba'
  );
});

test('the raw template is never served', async ({ request }) => {
  expect((await request.get('/occasion.html')).status()).toBe(404);
  expect((await request.get('/occasion')).status()).toBe(404);
});

test('the footer row links the occasion pages, on the home page and on each occasion page', async ({
  page,
}) => {
  for (const url of ['/', '/yom-huledet']) {
    await page.goto(url);
    const row = page.getByTestId('footer-occasions');
    await expect(row).toContainText('לפי אירוע');
    await expect(row.locator('a[href="/yom-huledet"]')).toHaveText('יום הולדת לאמא');
    await expect(row.locator('a[href="/yom-huledet-aba"]')).toHaveText('יום הולדת לאבא');
  }
  await expect(
    page.getByTestId('footer-occasions').locator('a[href="/yom-huledet"]')
  ).toHaveAttribute('aria-current', 'page');
});

// pages 2-4: each loads with its own H1, its order buttons carry its slug, and the footer row links it
for (const [slug, h1, label] of [
  ['mesibat-ravakot', 'משחק למסיבת רווקות, מותאם אישית לכלה', 'מסיבת רווקות'],
  [
    'tiyul-mishpachti-lechul',
    'משחק לטיול משפחתי בחו״ל, שכל המילים בו על המשפחה שלכם',
    'טיול משפחתי לחו״ל',
  ],
  ['pensia', 'מתנה ליציאה לפנסיה שכל המשרד כותב', 'יציאה לפנסיה'],
]) {
  test(`/${slug} loads with its H1 and every order button carries the slug`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const res = await page.goto('/' + slug);
    expect(res.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText(h1);
    await expect(page.locator('.chips li')).toHaveCount(8);
    await expect(page.locator('.hero .pn.sky')).toContainText('עד 412 מילים אישיות');
    const hrefs = await page
      .locator('a.pill:not([href^="https://wa.me"])')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toBe('options.html?occasion=' + slug);
    const row = page.getByTestId('footer-occasions');
    await expect(row.locator(`a[href="/${slug}"]`)).toHaveText(label);
    await expect(row.locator(`a[href="/${slug}"]`)).toHaveAttribute('aria-current', 'page');
    await page.waitForLoadState('networkidle');
    expect(await page.locator('body').innerText()).not.toMatch(/₪/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.locator('.hero .cta a.pill').click();
    await expect(page).toHaveURL(new RegExp(`/options\\.html\\?occasion=${slug}$`));
  });
}
