import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// wordlists.html and proof.html in redesign mode: css/rd/wordlists.css and css/rd/proof.css (docs/redesign-mode.md).
// Their HTML and logic are untouched; this checks the restyle keeps them working and on the screen:
// - the word lists take the shell's header in place of their own logo bar, and the search still filters;
// - the proof keeps its own header, takes the light table even in a dark scheme, and its enlarged card still steps;
// - neither scrolls sideways at 320, 360, 390 or 1440.

const LISTS = {
  lists: [
    { id: 'a', label: 'רווקות', count: 3, words: ['כלה', 'שושבינה', 'ריקוד'] },
    { id: 'b', label: 'ילדים', count: 2, words: ['כדורגל', 'ריקוד'] },
  ],
};
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

async function serveLists(page) {
  await page.route('**/api/wordlist-preview', (route) => route.fulfill({ json: LISTS }));
}
async function serveDeck(page, pages) {
  await page.route('**/api/collections/*/proof?*', (route) =>
    route.fulfill({ json: { pages, width: 320, name: 'הדר בת 30' } })
  );
  await page.route('**/api/collections/*/proof/*', (route) =>
    route.fulfill({ contentType: 'image/webp', body: WEBP })
  );
}
async function noSideScroll(page) {
  const [sw, iw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(sw, 'the page scrolls sideways').toBeLessThanOrEqual(iw);
}

test.beforeEach(async ({ page }) => {
  await previewRedesign(page);
});

test('the word lists wear the shell’s header, and the search still filters', async ({ page }) => {
  await serveLists(page);
  await page.goto('/wordlists.html');
  await expect(page.locator('link[href*="/css/rd/wordlists"]')).toHaveCount(1);
  await expect(page.locator('.rd-hdr')).toBeVisible();
  await expect(page.locator('body > .bar')).toBeHidden();
  expect(await page.locator('h1').evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
    'Gveret Levin'
  );

  await expect(page.locator('main section')).toHaveCount(2);
  await page.fill('#q', 'ריקוד');
  await expect(page.locator('.words span.hit')).toHaveCount(2);
  expect(
    await page
      .locator('.words span.hit')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor)
  ).toBe('rgb(0, 0, 0)');
});

test('the proof takes the light table even in a dark scheme, and its large card still steps', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await serveDeck(page, 6);
  await page.goto('/proof.html?c=proof-rd&t=tok');
  await expect(page.locator('link[href*="/css/rd/proof"]')).toHaveCount(1);
  await expect(page.locator('.rd-hdr')).toHaveCount(0);
  await expect(page.locator('#sheet .card')).toHaveCount(6);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    'rgb(255, 241, 222)'
  );

  await page.locator('#sheet .card').nth(2).click();
  await expect(page.locator('#big')).toBeVisible();
  await page.locator('#next').click();
  await expect(page.locator('#bigImg')).toHaveAttribute('alt', 'קלף 4');
  await page.locator('#close').click();
  await expect(page.locator('#big')).toBeHidden();
});

for (const width of [320, 360, 390, 1440]) {
  test(`neither page scrolls sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await serveLists(page);
    await serveDeck(page, 8);
    await page.goto('/wordlists.html');
    await expect(page.locator('main section')).toHaveCount(2);
    await noSideScroll(page);
    await page.goto('/proof.html?c=proof-rd&t=tok');
    await expect(page.locator('#sheet .card')).toHaveCount(8);
    await noSideScroll(page);
  });
}
