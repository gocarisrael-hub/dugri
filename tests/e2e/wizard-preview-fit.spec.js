import { test, expect } from '@playwright/test';

// Regression cover for the FULL 8-card deck preview (supersedes the single-card
// preview). Two invariants:
//  1. the "every step fits, no page scroll, sticky bar reachable" behaviour must
//     hold beyond portrait mobile — on a laptop viewport AND a landscape one
//     (wider than the 600px mobile breakpoint), even though the previews are now
//     heavier full-page SVGs;
//  2. EVERY present product tab (front / back / board) renders a LANDSCAPE A4
//     page (~1.414:1) at a readable size — a large fraction of the stage — since
//     all three products are now full pages, not single portrait cards; and a
//     board-less theme (kids) simply has no board tab.
//
// These are viewport-specific layout checks, so they run ONCE (on a single
// project) rather than across all three device profiles. Assertions are kept
// tolerant (fractions / bounded gaps), not exact-pixel.

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'Desktop Chrome', 'viewport-specific layout checks run once');
});

const LAPTOP = { width: 1366, height: 768 };
const LANDSCAPE = { width: 960, height: 480 };

// A step "fits" when the document does not overflow the viewport (no scroll) and
// the fixed Back/Next bar sits fully within the viewport. We wait for the late
// webfont swap and poll so the measurement is stable rather than racing layout.
async function assertStepFits(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));

  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
    )
    .toBeLessThanOrEqual(4);

  const barInView = await page.evaluate(() => {
    const b = document.querySelector('.wiz-bar').getBoundingClientRect();
    return b.bottom <= window.innerHeight + 1 && b.top >= 0;
  });
  expect(barInView).toBe(true);
  await expect(page.getByTestId('next-btn')).toBeVisible();
}

for (const [label, viewport] of [
  ['laptop', LAPTOP],
  ['landscape', LANDSCAPE],
]) {
  test.describe(`order wizard fits a ${label} screen without scrolling`, () => {
    for (const step of [1, 2, 3, 4, 5]) {
      test(`step ${step} fits and the sticky bar stays reachable`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto('/options.html?step=' + step);
        await expect(page.getByTestId('step-' + step)).toBeVisible();
        await assertStepFits(page);
      });
    }
  });
}

test.describe('every product tab is a readable landscape page', () => {
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

    // board tab is hidden; front/back remain.
    await expect(page.getByTestId('tab-board')).toBeHidden();
    await expect(page.getByTestId('tab-front')).toBeVisible();
    await expect(page.getByTestId('tab-back')).toBeVisible();

    await expect(page.getByTestId('preview-front').locator('svg')).toBeVisible();
    await page.getByTestId('tab-back').click();
    await expect(page.getByTestId('preview-back')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('preview-back').locator('svg')).toBeVisible();
  });
});
