import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// The word collection (collect.html) in redesign mode: css/rd/collect.css, C's section (docs/redesign-mode.md).
// The page's HTML and logic are untouched; this checks the restyle keeps it working and on the screen:
// - a word can be added, by the owner and by a contributor, and shows as a chip;
// - the page keeps its own header (the home link a contributor uses), with the title in the heading face;
// - what the page hides with its own .hidden class stays hidden;
// - the owner's five tabs stay on one line, and nothing scrolls sideways, from 320px to 1440px.

test.beforeEach(async ({ page }) => {
  await previewRedesign(page);
});

async function makeCollection(request) {
  const res = await request.post('/api/collections', {
    data: {
      honoree_name: 'ליאת',
      email: 'rd@example.com',
      phone: '0521234567',
      design: 'פריז',
      theme: 'bachelorette',
      extra_fields: {},
      custom_title: 'ליאת חוגגת 40',
      buyer_name: 'דנה כהן',
    },
  });
  expect(res.ok()).toBe(true);
  const { id, owner_token: k } = await res.json();
  return { id, k };
}

async function addWord(page, word) {
  await page.fill('#wordInput', word);
  await page.locator('#addBtn').click();
  await expect(page.locator('#wordsWrap .word', { hasText: word })).toBeVisible();
}

async function noSideScroll(page) {
  const [sw, iw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(sw, 'the page scrolls sideways').toBeLessThanOrEqual(iw);
}

test('the owner adds a word in the mode; the page keeps its own header and its hidden blocks stay hidden', async ({
  page,
  request,
}) => {
  const { id, k } = await makeCollection(request);
  await page.goto(`/collect.html?c=${id}&k=${k}`);
  await expect(page.locator('html')).toHaveClass(/(^|\s)rd(\s|$)/);
  await expect(page.locator('link[href*="/css/rd/collect"]')).toHaveCount(1);

  // its own header: the home link stays, the shell's header is not added; the title is in the heading face
  await expect(page.getByTestId('home-link')).toBeVisible();
  await expect(page.locator('.rd-hdr')).toHaveCount(0);
  await expect(page.locator('#title')).toContainText('ליאת');
  expect(await page.locator('#title').evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
    'Gveret Levin'
  );

  // the owner's tabs, and the words card as a cut-out card
  await expect(page.getByTestId('tabs')).toBeVisible();
  expect(
    await page.locator('#wordsCard').evaluate((el) => getComputedStyle(el).boxShadow)
  ).toContain('4px 4px 0px');

  // hidden by the page's own .hidden class, and still hidden in the mode
  await expect(page.getByTestId('free-limit-lock')).toBeHidden();
  await expect(page.locator('#wordLenHint')).toBeHidden();

  await addWord(page, 'שקשוקה');
  await expect(page.locator('#count')).toHaveText('1');

  // the design tab opens its panel and hides the words
  await page.getByTestId('tab-design').click();
  await expect(page.locator('#designPanel')).toBeVisible();
  await expect(page.locator('#addCard')).toBeHidden();
});

test('a contributor adds a word in the mode', async ({ page, request }) => {
  const { id } = await makeCollection(request);
  await page.goto(`/collect.html?c=${id}`);
  await expect(page.getByTestId('home-link')).toBeVisible();
  await expect(page.getByTestId('tabs')).toBeHidden();
  await page.fill('#byName', 'נועה');
  await addWord(page, 'אילת');
  await expect(page.locator('#wordsWrap .word', { hasText: 'אילת' })).toContainText('נועה');
});

for (const width of [320, 360, 390, 1440]) {
  test(`the tabs keep one line and nothing scrolls sideways at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: width > 900 ? 900 : 800 });
    const { id, k } = await makeCollection(request);
    await page.goto(`/collect.html?c=${id}&k=${k}`);
    await expect(page.getByTestId('tabs')).toBeVisible();
    await addWord(page, 'קפה שחור');
    await noSideScroll(page);
    const [sw, cw] = await page
      .getByTestId('tabs')
      .evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(sw, 'a tab is off the strip').toBeLessThanOrEqual(cw + 1);
    for (const tab of ['design', 'pawns', 'finish', 'words']) {
      await page.getByTestId('tab-' + tab).click();
      await noSideScroll(page);
    }
    // the contributor's view too
    await page.goto(`/collect.html?c=${id}`);
    await expect(page.locator('#wordInput')).toBeVisible();
    await noSideScroll(page);
  });
}
