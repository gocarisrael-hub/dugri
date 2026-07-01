import { test, expect } from '@playwright/test';

// Regression for the order wizard's mobile "no hunting, no scrolling" fix:
// on a phone every step's controls must sit fully ABOVE the fixed Back/Next
// bar (never hidden behind it) and the page must not overflow the viewport.
//
// This is a pure layout check at one phone size, so it runs ONCE (on a single
// project) rather than across all three desktop+mobile profiles.

const PHONE = { width: 390, height: 844 };
test.use({ viewport: PHONE });

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'iPhone 14', 'mobile no-scroll layout check runs once');
});

// A step "fits" when the last control in it sits fully above the fixed
// .wiz-bar (so it is not overlapped/hidden behind the sticky button bar) and
// the document does not overflow the viewport. We wait for the late webfont
// swap (Heebo loads via media=print/onload) and poll so the measurement is
// stable rather than racing layout.
async function assertStepFits(page, lastControlSelector) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));

  const last = page.locator(lastControlSelector).last();
  await expect(last).toBeVisible();

  // The last control's bottom must not poke below (behind) the fixed bar's top.
  await expect
    .poll(async () =>
      page.evaluate((sel) => {
        const barTop = document.querySelector('.wiz-bar').getBoundingClientRect().top;
        const el = document.querySelector(sel).getBoundingClientRect();
        return Math.round(el.bottom - barTop);
      }, lastControlSelector)
    )
    .toBeLessThanOrEqual(0);

  // ...and the page itself must not require vertical scrolling.
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
    )
    .toBeLessThanOrEqual(4);
}

test.describe('order wizard fits a phone screen without scrolling', () => {
  test('step 1 (design): tiles clear the sticky bar and the page does not scroll', async ({
    page,
  }) => {
    await page.goto('/options.html');
    await expect(page.getByTestId('step-1')).toBeVisible();
    await assertStepFits(page, '[data-testid="design-list"] .design');
  });

  test('step 2 (color): the swatch grid (with labels) clears the sticky bar', async ({ page }) => {
    await page.goto('/options.html?step=2');
    await expect(page.getByTestId('step-2')).toBeVisible();
    // Measure the whole colour list: its padding clears the labels that overhang
    // below each swatch, so its bottom clearing the bar means the labels do too.
    await assertStepFits(page, '[data-testid="color-list"]');
  });

  test('step 3 (extras): the add-on clears the sticky bar', async ({ page }) => {
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    await assertStepFits(page, '[data-testid="chasers-card"]');
  });

  test('step 4 (name + gender): the last control clears the sticky bar', async ({ page }) => {
    await page.goto('/options.html?step=4');
    await expect(page.getByTestId('step-4')).toBeVisible();
    await assertStepFits(page, '[data-testid="gender-group"]');
  });

  test('step 5 (email + phone): the phone field clears the sticky bar', async ({ page }) => {
    await page.goto('/options.html?step=5');
    await expect(page.getByTestId('step-5')).toBeVisible();
    // The phone field is the last input; it must not sit behind the create bar.
    await assertStepFits(page, '[data-testid="owner-phone"]');
  });
});
