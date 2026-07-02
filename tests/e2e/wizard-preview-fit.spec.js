import { test, expect } from '@playwright/test';

// Regression cover for the enlarged order-wizard preview (PR #87 follow-up):
//  1. the "every step fits, no page scroll, sticky bar reachable" invariant must
//     hold beyond portrait mobile — on a laptop viewport AND a landscape one
//     (wider than the 600px mobile breakpoint), where the preview must yield so
//     the step's controls still fit;
//  2. the board tab must render its LANDSCAPE board svg at a readable size (a
//     large fraction of the stage width) — not squeezed into the portrait card
//     box — while the card (front/back) stays portrait with its bleed frame
//     hugging it (no big empty letterbox gaps).
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

test.describe('preview keeps each product at its own aspect ratio', () => {
  test('board tab shows a landscape board svg at a readable size (not crushed)', async ({
    page,
  }) => {
    await page.setViewportSize(LAPTOP);
    await page.goto('/options.html?step=1');
    await expect(page.getByTestId('preview-front').locator('svg')).toBeVisible();

    await page.getByTestId('tab-board').click();
    const board = page.getByTestId('preview-board');
    await expect(board).toHaveAttribute('data-active', 'true');
    await expect(board.locator('svg')).toBeVisible();

    const m = await page.evaluate(() => {
      const stage = document.querySelector('.preview-stage').getBoundingClientRect();
      const svg = document.querySelector('[data-panel="board"] svg').getBoundingClientRect();
      return { widthFraction: svg.width / stage.width, ratio: svg.width / svg.height };
    });
    // landscape (clearly wider than tall) — a crushed board would be < 1 here...
    expect(m.ratio).toBeGreaterThan(1.15);
    // ...and it fills most of the stage width, so it stays readable.
    expect(m.widthFraction).toBeGreaterThan(0.6);
  });

  test('card front stays portrait with the bleed frame hugging it', async ({ page }) => {
    await page.setViewportSize(LAPTOP);
    await page.goto('/options.html?step=1');
    const svg = page.getByTestId('preview-front').locator('svg');
    await expect(svg).toBeVisible();

    const m = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel="front"]').getBoundingClientRect();
      const s = document.querySelector('[data-panel="front"] svg').getBoundingClientRect();
      return {
        ratio: s.width / s.height,
        vGap: panel.height - s.height,
        hGap: panel.width - s.width,
      };
    });
    // portrait card (taller than wide)...
    expect(m.ratio).toBeLessThan(0.85);
    // ...and the bleed frame hugs it: only the (modest) bleed padding sits around
    // the card, never a large empty letterbox band.
    expect(m.vGap).toBeLessThan(90);
    expect(m.hGap).toBeLessThan(90);
  });
});
