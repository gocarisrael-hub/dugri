import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';
import { THEME_BY_DESIGN, isPublicDesign } from '../../site/js/designs.js';

// How many BUILT-IN designs the wizard offers, read from the catalog itself
// rather than written down here. Hardcoding the total is what broke main: this
// spec landed asserting 15 (7 built-in + 8 stubbed) and the very next merge
// retired a design, so the number was wrong before either change was deployed.
// The subject of the test is the LAYOUT holding at any count — the count itself
// is incidental, and it should never be the thing that fails.
const BUILTIN_PUBLIC = Object.keys(THEME_BY_DESIGN).filter((id) => isPublicDesign(id)).length;

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
    // Every built-in design PLUS all eight stubbed ones are offered…
    await expect(page.locator('[data-testid="design-list"] .design')).toHaveCount(
      BUILTIN_PUBLIC + designs.length
    );
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

  // STEP 3 IS ALLOWED TO SCROLL — the owner's decision, 2026-08-06.
  //
  // The deck pictures (#349) render only for a design whose owner uploaded the
  // three photographs, and the e2e server's design-images store is empty — so the
  // plain step-3 test above runs with NO row and passes however tall the row would
  // have been, while the row's own spec (wizard-deck-pictures) stubs the pictures
  // but never measures height. Between the two, nobody was watching: with pictures
  // the gender control sits ~11px BELOW the bar's top on a 390×844 phone.
  //
  // What that costs was measured before deciding, not assumed: the page scrolls
  // 194px, scrolling brings the control clear of the bar, and it taps. Nothing is
  // unreachable — the "no hunting, no scrolling" rule is a product preference, and
  // for THIS step the owner would rather scroll than shrink the pictures (three
  // squares small enough to fit measured 36px, at which they stop being a preview).
  //
  // So this step keeps the half of the promise that still matters — the buyer can
  // GET to every control — and drops the half she traded away. The other steps keep
  // the strict rule; do not weaken assertStepFits itself.
  test('step 3 with deck pictures: may scroll, but every control stays reachable', async ({
    page,
  }) => {
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfbJGYyliH8OITBAtzmrP11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB2OhhtC3NOZwAAAAASUVORK5CYII=',
      'base64'
    );
    await page.route('**/content-uploads/*', (r) =>
      r.fulfill({ contentType: 'image/png', body: PNG })
    );
    await page.route('**/api/design-images*', (r) =>
      r.fulfill({
        json: {
          images: {
            bachelorette: {
              base: {
                deckFronts: { img: '/content-uploads/00000000000000a1.webp' },
                deckBacks: { img: '/content-uploads/00000000000000a2.webp' },
                deckBoard: { img: '/content-uploads/00000000000000a3.webp' },
              },
            },
          },
        },
      })
    );
    await page.goto('/options.html?step=3');
    // The row must actually be there, or this quietly becomes the test above.
    await expect(page.getByTestId('deck-row')).toBeVisible();
    await expect(page.getByTestId('deck-thumb')).toHaveCount(3);

    // The pictures must still be worth looking at. If a future change "fixes" the
    // overflow by shrinking them, that is the outcome the owner rejected — fail.
    const thumb = await page
      .getByTestId('deck-thumb')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(thumb).toBeGreaterThan(60);

    // Scrolling is permitted here, so reach the control the way a buyer does…
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const gender = page.getByTestId('gender-group');
    await expect(gender).toBeVisible();

    // …and it must genuinely clear the fixed bar once scrolled, not merely exist.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const bar = document.querySelector('.wiz-bar').getBoundingClientRect();
          return Math.round(
            document.querySelector('[data-testid="gender-group"]').getBoundingClientRect().bottom -
              bar.top
          );
        })
      )
      .toBeLessThanOrEqual(0);

    // toBeVisible() would pass on a control the bar covers, so prove the tap lands
    // on the control itself and not on the bar sitting over it.
    await gender.locator('button, label').first().click({ timeout: 5000 });
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
