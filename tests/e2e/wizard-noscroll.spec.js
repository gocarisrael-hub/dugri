import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

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

  // The catalog GROWS: the picker lists the bundled designs PLUS every template
  // the owner uploads and puts on sale (/api/custom-designs). Once those tiles
  // wrapped past two rows the whole step slid under the fixed Back/Next bar and
  // the page scrolled — a real regression the moment a second template went on
  // sale. Stub a deliberately GENEROUS set: the picker must cap itself and scroll
  // internally, so the step fits the same whether there are seven designs or
  // twenty. An empty custom-designs response would not exercise this at all.
  //
  // The names are deliberately LONG and unbreakable: a template's display name is
  // owner-typed, and a flex item's automatic minimum size is its min-content width,
  // so a long word could otherwise widen the tiles, drop a row from four tiles to
  // three and add rows nobody budgeted for.
  test('step 1 stays put however many uploaded designs are on sale', async ({ page }) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#eee"/></svg>';
    const designs = Array.from({ length: 8 }, (_, i) => ({
      id: `tpl-${i}`,
      name: `תבניתמאודארוכהללאמרווחים${i}`,
      theme: `tpl-${i}`,
      custom: true,
      public: true,
      language: 'hebrew',
      extra_fields: [],
      img: {
        front: `/api/template-image/tpl-${i}/front`,
        back: `/api/template-image/tpl-${i}/back`,
      },
    }));
    await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs } }));
    await page.route('**/api/template-image/**', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: svg })
    );

    await page.goto('/options.html');
    await expect(page.getByTestId('step-1')).toBeVisible();
    // All 15 are offered…
    await expect(page.locator('[data-testid="design-list"] .design')).toHaveCount(15);
    // …and the step still fits the phone.
    await assertStepFits(page, '[data-testid="design-list"] .design');
    // The overflow went to the picker's OWN scroll, not the page's.
    expect(
      await page.evaluate(() => {
        const el = document.getElementById('designList');
        return el.scrollHeight > el.clientHeight;
      })
    ).toBe(true);
  });

  test('step 2 (color + extras): the add-on (last control) clears the sticky bar', async ({
    page,
  }) => {
    await page.goto('/options.html?step=2');
    await expect(page.getByTestId('step-2')).toBeVisible();
    // The chasers add-on now sits BELOW the colour list on the merged step, so it
    // is the last control — if it clears the bar, the swatches above it do too.
    await assertStepFits(page, '[data-testid="chasers-card"]');
  });

  test('step 3 (name + gender): the last control clears the sticky bar', async ({ page }) => {
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    await assertStepFits(page, '[data-testid="gender-group"]');
  });

  test('step 4 (email + phone): the phone field clears the sticky bar', async ({ page }) => {
    await page.goto('/options.html?step=4');
    await expect(page.getByTestId('step-4')).toBeVisible();
    // The phone field is the last input; it must not sit behind the create bar.
    await assertStepFits(page, '[data-testid="owner-phone"]');
  });

  test('step 5 (optional pawn photos): the skip control clears the sticky bar', async ({
    page,
  }) => {
    await page.goto('/options.html?step=5');
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    // The skip link is the last control below the 4 photo slots.
    await assertStepFits(page, '[data-testid="pawn-skip"]');
  });
});
