import { test, expect } from '@playwright/test';

// What is left of wizard-gender-bleed.spec.js. The gender half of that file
// covered a control that no longer exists: the wizard asked for the honoree's
// gender so the THEME could pick between the forms of a title it composed
// ("{NAME} {m:בן|f:בת} {AGE}"). The owner removed the whole mechanism — "no name
// no gender only free text title" — so there is no choice to make, nothing to
// send, and no prompt to dismiss. Those tests were deleted rather than adapted:
// they asserted a behaviour that is gone, not one that moved.
//
// This half has nothing to do with gender and still holds.

test.describe('full-page preview has no fake bleed frame', () => {
  test('the active preview renders edge-to-edge (no inset bleed padding)', async ({ page }) => {
    await page.goto('/options.html?plan=base');
    const front = page.getByTestId('preview-front');
    await expect(front.locator('img')).toBeVisible();
    const pad = await front.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        padTop: parseFloat(cs.paddingTop) || 0,
        padLeft: parseFloat(cs.paddingLeft) || 0,
        padBottom: parseFloat(cs.paddingBottom) || 0,
      };
    });
    // The full-page design already prints its background to the edge, so the old
    // fake print-bleed frame is gone — the page shows edge-to-edge with no inset.
    expect(pad.padTop).toBeLessThanOrEqual(2);
    expect(pad.padLeft).toBeLessThanOrEqual(2);
    expect(pad.padBottom).toBeLessThanOrEqual(2);
  });
});
