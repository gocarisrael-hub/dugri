import { test, expect } from '@playwright/test';

// Regression for the order wizard's mobile "no hunting for the button" fix:
// on a phone the pickers AND the Continue/Back bar must be reachable without
// scrolling. The bar is fixed to the bottom, and the pickers are compacted so
// they fit above it. We assert on a representative phone viewport.

const PHONE = { width: 390, height: 844 };
test.use({ viewport: PHONE });

// A step "fits without scrolling" when: the Next control is in the viewport,
// the step's first + last picker options are in the viewport, and the page
// needs (at most) a negligible amount of scroll.
async function assertNoScroll(page, optionsSelector) {
  const next = page.getByTestId('next-btn');
  await expect(next).toBeInViewport();

  const options = page.locator(optionsSelector);
  const count = await options.count();
  await expect(options.first()).toBeInViewport();
  await expect(options.nth(count - 1)).toBeInViewport();

  // The document should not require meaningful vertical scrolling.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight
  );
  expect(overflow).toBeLessThanOrEqual(4);
}

test.describe('order wizard fits a phone screen without scrolling', () => {
  test('step 1 (design): pickers and Next are visible without scrolling', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.getByTestId('step-1')).toBeVisible();
    await assertNoScroll(page, '[data-testid="design-list"] .design');
  });

  test('step 2 (color): swatches and Next are visible without scrolling', async ({ page }) => {
    await page.goto('/options.html?step=2');
    await expect(page.getByTestId('step-2')).toBeVisible();
    await assertNoScroll(page, '[data-testid="color-list"] .swatch');
  });

  test('step 3 (extras): the add-on and Next are visible without scrolling', async ({ page }) => {
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    await assertNoScroll(page, '[data-testid="chasers-card"]');
  });

  test('the sticky bar keeps Next pinned to the bottom of the screen', async ({ page }) => {
    await page.goto('/options.html');
    const box = await page.getByTestId('next-btn').boundingBox();
    // Next sits in the lower portion of the 844px-tall viewport, always reachable.
    expect(box.y).toBeGreaterThan(PHONE.height / 2);
    expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height);
  });
});
