import { test, expect } from '@playwright/test';

// Cover for two order-flow fixes on options.html:
//   B4 — a RASTER board preview must fill the panel width like the SVG cards
//        (the old width:auto rule shrank a raster board to its tiny intrinsic
//        size, a sliver next to the width-filling SVG front/back cards).
//   B8 — the example-value placeholders ("למשל: שירה", "name@example.com", …)
//        were removed from the order inputs (visible labels convey each field).

// A tiny intrinsic PNG: with the OLD width:auto rule this renders ~1px wide (the
// bug); with the fix (width:100% on the board panel) it fills the panel width.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// Tall viewport so neither the SVG card nor the raster board is height-capped —
// both size purely by width, making the fill comparison clean and deterministic.
const TALL = { width: 700, height: 1300 };

test.describe('B4: a raster board preview fills the panel like the SVG cards', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'layout measurement runs once');
  });

  test('a raster board renders at a comparable, generous size to the front card', async ({
    page,
  }) => {
    await page.setViewportSize(TALL);
    await page.goto('/options.html?step=1');
    await expect(page.getByTestId('preview-front').locator('svg')).toBeVisible();

    // baseline: the front card SVG fills (nearly) its whole panel width
    const front = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel="front"]');
      const svg = panel.querySelector('svg');
      return {
        svgW: svg.getBoundingClientRect().width,
        panelW: panel.getBoundingClientRect().width,
      };
    });
    expect(front.svgW / front.panelW).toBeGreaterThan(0.95);

    // switch to the board tab, let its SVG resolve, then swap in a RASTER image —
    // the case the old width:auto rule shrank to a tiny intrinsic sliver.
    await page.getByTestId('tab-board').click();
    await expect(page.getByTestId('preview-board')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('preview-board').locator('svg')).toBeVisible();
    await page.evaluate((png) => {
      document.querySelector('[data-panel="board"]').innerHTML =
        '<img alt="board" src="' + png + '" />';
    }, PNG);

    const board = await page.evaluate(() => {
      const panel = document.querySelector('[data-panel="board"]');
      const img = panel.querySelector('img');
      return {
        imgW: img.getBoundingClientRect().width,
        panelW: panel.getBoundingClientRect().width,
      };
    });

    // the raster board FILLS its panel width (the fix), not a small intrinsic sliver
    expect(board.imgW / board.panelW).toBeGreaterThan(0.95);
    // and is a comparable, generous size to the SVG card panel (within tolerance)
    expect(board.panelW).toBeGreaterThan(front.panelW * 0.9);
    expect(board.imgW).toBeGreaterThan(front.svgW * 0.85);
    expect(board.imgW).toBeLessThan(front.svgW * 1.15);
  });
});

test.describe('B8: order inputs carry no example-value placeholders', () => {
  // A field's placeholder must be absent or empty — the fields keep visible labels.
  const NO_PLACEHOLDER_IDS = [
    'honoreeInput',
    'extraAge',
    'extraYears',
    'extraName1',
    'extraName2',
    'ownerEmail',
    'ownerPhone',
  ];

  test('the listed inputs have no example placeholder text', async ({ page }) => {
    await page.goto('/options.html');
    for (const id of NO_PLACEHOLDER_IDS) {
      const ph = await page.locator('#' + id).getAttribute('placeholder');
      expect(ph == null || ph === '', `#${id} should have no example placeholder, got: ${ph}`).toBe(
        true
      );
    }
  });

  test('the functional design-code placeholder is intentionally kept', async ({ page }) => {
    await page.goto('/options.html');
    // this one is an instruction, not an example value — it stays.
    await expect(page.getByTestId('design-code-input')).toHaveAttribute('placeholder', 'קוד עיצוב');
  });
});
