import { test, expect } from '@playwright/test';

// Regression cover for the FULL 8-card deck preview, after the "bigger preview
// box" change. Invariants:
//  1. The live sheet is the DOMINANT focal element: it fills the preview card's
//     width (no longer a height-shrunk sliver) on desktop AND phone.
//  2. Box size now takes priority over strict no-scroll where they conflict, so a
//     wide/short viewport MAY scroll — but the fixed Back/Next bar must ALWAYS
//     stay reachable (the portrait-phone no-scroll guarantee still lives in
//     wizard-noscroll.spec.js, which forces a tall 390x844 viewport).
//  3. Every present product tab (front / back / board) renders a LANDSCAPE A4
//     page (~1.414:1) at a readable size; a board-less theme (kids) has no board
//     tab but its front/back preview still enlarges.

const LAPTOP = { width: 1366, height: 768 };
const LANDSCAPE = { width: 960, height: 480 };
const DESKTOP_MID = { width: 1440, height: 900 };

// The invariant that must always hold, even now that a step may scroll: the
// fixed Back/Next bar sits fully within the viewport and Next is visible/usable.
// (Previously this also asserted zero page scroll; that is intentionally relaxed
// because the preview box is prioritised over fitting every step on one screen.)
async function assertBarReachable(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));
  const barInView = await page.evaluate(() => {
    const b = document.querySelector('.wiz-bar').getBoundingClientRect();
    return b.bottom <= window.innerHeight + 1 && b.top >= 0;
  });
  expect(barInView).toBe(true);
  await expect(page.getByTestId('next-btn')).toBeVisible();
}

test.describe('order wizard keeps the sticky bar reachable on wide/short screens', () => {
  // viewport-specific layout checks — run once, on a single project.
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'Desktop Chrome',
      'viewport-specific layout checks run once'
    );
  });

  for (const [label, viewport] of [
    ['laptop', LAPTOP],
    ['landscape', LANDSCAPE],
    ['mid-height desktop', DESKTOP_MID],
  ]) {
    test.describe(`on a ${label} screen`, () => {
      for (const step of [1, 2, 3, 4, 5]) {
        test(`step ${step}: the sticky bar stays reachable`, async ({ page }) => {
          await page.setViewportSize(viewport);
          await page.goto('/options.html?step=' + step);
          await expect(page.getByTestId('step-' + step)).toBeVisible();
          await assertBarReachable(page);
        });
      }
    });
  }
});

test.describe('every product tab is a readable landscape page', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'Desktop Chrome',
      'viewport-specific layout checks run once'
    );
  });

  // measure the active panel's svg against its stage.
  async function measureActive(page, panel) {
    return page.evaluate((p) => {
      const stage = document.querySelector('.preview-stage').getBoundingClientRect();
      const svg = document.querySelector(`[data-panel="${p}"] svg`).getBoundingClientRect();
      return {
        ratio: svg.width / svg.height,
        widthFraction: svg.width / stage.width,
        heightFits: svg.height <= stage.height + 2,
      };
    }, panel);
  }

  for (const tab of ['front', 'back', 'board']) {
    test(`the ${tab} tab shows a landscape svg filling most of the stage`, async ({ page }) => {
      await page.setViewportSize(LAPTOP);
      await page.goto('/options.html?step=1');
      await expect(page.getByTestId('preview-front').locator('svg')).toBeVisible();

      await page.getByTestId('tab-' + tab).click();
      const p = page.getByTestId('preview-' + tab);
      await expect(p).toHaveAttribute('data-active', 'true');
      await expect(p.locator('svg')).toBeVisible();

      const m = await measureActive(page, tab);
      // landscape (clearly wider than tall) — a crushed/portrait page would be < 1.
      expect(m.ratio).toBeGreaterThan(1.15);
      // fills most of the stage width, so the 8 cards stay readable...
      expect(m.widthFraction).toBeGreaterThan(0.6);
      // ...and is contained within the stage height (not clipped/overflowing).
      expect(m.heightFits).toBe(true);
    });
  }

  test('a board-less theme (kids) has no board tab, but front/back still work', async ({
    page,
  }) => {
    await page.setViewportSize(LAPTOP);
    await page.goto('/options.html?step=1');
    await page.locator('.design[data-design-id="kids"]').click();

    await expect(page.getByTestId('tab-board')).toBeHidden();
    await expect(page.getByTestId('tab-front')).toBeVisible();
    await expect(page.getByTestId('tab-back')).toBeVisible();

    await expect(page.getByTestId('preview-front').locator('svg')).toBeVisible();
    await page.getByTestId('tab-back').click();
    await expect(page.getByTestId('preview-back')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('preview-back').locator('svg')).toBeVisible();
  });
});

// ---- the preview fills the card width on a PHONE (iPhone 14 + Pixel 7) ----
test.describe('the live sheet fills the card width on a phone', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === 'Desktop Chrome', 'phone width-fill check');
  });

  async function sheetMetrics(page) {
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));
    return page.evaluate(() => {
      const svg = document.querySelector('.preview-panel[data-active="true"] svg');
      const card = document.getElementById('previewCard');
      const cs = getComputedStyle(card);
      const inner = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const w = svg.getBoundingClientRect().width;
      return { w, inner, ratio: +(w / inner).toFixed(3), vw: window.innerWidth };
    });
  }

  test('the sheet fills ~all of the card width and spans most of the screen', async ({ page }) => {
    await page.goto('/options.html');
    const m = await sheetMetrics(page);
    // fills nearly the whole card (edge-to-edge), not a height-shrunk sliver
    expect(m.ratio).toBeGreaterThanOrEqual(0.9);
    // and is the dominant focal element: ~0.85+ of the phone's width
    expect(m.w / m.vw).toBeGreaterThanOrEqual(0.85);
  });

  test('kids has no board tab, and its preview still fills the width', async ({ page }) => {
    await page.goto('/options.html?design=kids');
    await expect(page.getByTestId('tab-board')).toBeHidden();
    const m = await sheetMetrics(page);
    expect(m.ratio).toBeGreaterThanOrEqual(0.9);
  });
});
