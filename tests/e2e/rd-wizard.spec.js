import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';
import { previewRedesign } from './helpers/redesign.js';

// The order wizard (options.html) in redesign mode: css/rd/options.css, C's section (docs/redesign-mode.md).
// The page's HTML and logic are untouched; this checks the restyle keeps the wizard working and on the screen:
// - the whole flow still runs to a created collection;
// - the wizard keeps its own top bar (--rd-header: none) and its Back/Next bar wears the shell's pills;
// - no step scrolls sideways at 360, 390 or 1440;
// - the fullscreen view's tabs stay on the screen (its RTL centring is fixed in the mode).

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function mockPreview(page) {
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      }),
    })
  );
}

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await mockPreview(page);
  await previewRedesign(page);
});

async function noSideScroll(page) {
  const [sw, iw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(sw, 'the page scrolls sideways').toBeLessThanOrEqual(iw);
}

test('the wizard runs to a created collection in the mode, in its own bar and the shell’s pills', async ({
  page,
}) => {
  await page.goto('/options.html');
  await expect(page.locator('html')).toHaveClass(/(^|\s)rd(\s|$)/);
  await expect(page.locator('link[href*="/css/rd/options"]')).toHaveCount(1);

  // its own top bar, not the shell's header
  await expect(page.locator('nav.nav')).toBeVisible();
  await expect(page.locator('.rd-hdr')).toHaveCount(0);

  // Next is the black pill with the drawn arrow, Back the outlined one; the step title is in the heading face
  const next = page.getByTestId('next-btn');
  await expect(next).toHaveClass(/\brd-btn\b/);
  await expect(next).toHaveClass(/\barrow\b/);
  await expect(page.getByTestId('back-btn')).toHaveClass(/\bsecondary\b/);
  expect(await next.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
  expect(
    await page
      .locator('[data-step="1"] .wiz-title')
      .evaluate((el) => getComputedStyle(el).fontFamily)
  ).toContain('Gveret Levin');

  // the chosen design tile is marked, not just outlined like the rest
  const chosen = page.locator('.design[aria-pressed="true"]');
  await expect(chosen).toHaveCount(1);
  expect(await chosen.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgb(255, 233, 240)'
  );

  await next.click(); // design → colour
  await expect(page.getByTestId('step-2')).toBeVisible();
  await next.click(); // colour → title
  await expect(page.getByTestId('step-3')).toBeVisible();
  await page.fill('#customTitleInput', 'Shira');
  await next.click();
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await next.click();
  await expect(page.getByTestId('step-4')).toBeVisible();

  await expect(next).toHaveText('צרו את המשחק');
  await expect(next).toBeDisabled();
  await page.fill('#ownerEmail', 'owner@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.fill('#buyerNameInput', 'דנה כהן');
  await expect(next).toBeEnabled();
  // the label and its arrow stay on one line
  const box = await next.boundingBox();
  expect(box.height).toBeLessThan(64);
  await next.click();
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
});

for (const width of [360, 390, 1440]) {
  test(`no step scrolls sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width > 900 ? 900 : 800 });
    await page.goto('/options.html');
    await expect(page.getByTestId('step-1')).toBeVisible();
    await noSideScroll(page);
    const next = page.getByTestId('next-btn');
    for (const step of ['step-2', 'step-3']) {
      await next.click();
      await expect(page.getByTestId(step)).toBeVisible();
      await noSideScroll(page);
    }
    await page.fill('#customTitleInput', 'ליאת חוגגת 40');
    await next.click();
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await noSideScroll(page);
    await next.click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await noSideScroll(page);
    // the Back/Next bar fits: the create button keeps its label inside it
    const fits = await next.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits, '"צרו את המשחק" is clipped').toBe(true);
  });
}

test('the fullscreen view keeps its tabs on the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/options.html');
  await expect(page.locator('.preview-panel[data-active="true"] img')).toBeVisible();
  await page.getByTestId('zoom-open').click();
  await expect(page.getByTestId('zoom-overlay')).toBeVisible();
  const bar = await page.locator('#zoomTabs').boundingBox();
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.x + bar.width).toBeLessThanOrEqual(390);
  // centred
  expect(Math.abs(bar.x + bar.width / 2 - 195)).toBeLessThan(3);
  await page.getByTestId('zoom-tab-board').click();
  await expect(page.getByTestId('zoom-tab-board')).toHaveAttribute('aria-selected', 'true');
});
