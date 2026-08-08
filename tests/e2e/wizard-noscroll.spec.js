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

// THE DECK PICTURES ARE ON MORE THAN THE NAME STEP.
//
// The row rides `is-collapsed`, which is every step from 3 up: the name step (3),
// the details step with the phone field (4) and the optional pawn photos (5). The
// four tests above are blind to all of that — the e2e server's design-images store
// is empty, so they run with NO row and pass however tall the row would be.
//
// Once the row became a full-width carousel it roughly doubled in height (a 112px
// square became a 249px 1.414 slide), and the extra height pushed the phone field
// 105px and the skip control 37px BELOW the sticky bar's top — under the bar, where
// a tap lands on the bar. That is the funnel blocked, so these tests check the only
// thing that matters: the buyer can put a finger on the control.
//
// On a screen with room (800px tall and up) steps 4 and 5 hold the row AND stay
// put. Below that they are allowed to scroll to keep the pictures (owner,
// 2026-08-08) — see "A PHONE IS NOT ONE SIZE" further down — and the promise
// narrows to reachability, never to less than that.
test.describe('the deck pictures never bury a control', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfbJGYyliH8OITBAtzmrP11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB2OhhtC3NOZwAAAAASUVORK5CYII=',
    'base64'
  );

  async function withDeckPictures(page) {
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
  }

  // `toBeVisible()` passes on a control the sticky bar sits on top of, and a
  // scrollHeight check says nothing about whether a finger lands. Ask the page the
  // question the buyer asks: at the middle of this control, what would I hit?
  async function assertTappable(page, selector) {
    const hit = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'missing';
      const r = el.getBoundingClientRect();
      if (r.bottom > window.innerHeight || r.top < 0) return 'outside the viewport';
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!at) return 'nothing (off-screen)';
      if (el.contains(at) || at === el) return 'ok';
      const bar = at.closest('.wiz-bar');
      return bar ? 'the sticky bar' : `${at.tagName.toLowerCase()}.${at.className}`;
    }, selector);
    expect(hit, `tapping ${selector} must land on it`).toBe('ok');
    // …and the tap itself must go through, with no scrolling to rescue it.
    await page.locator(selector).first().click({ timeout: 5000 });
  }

  // Guard against the row quietly not rendering, which would make every assertion
  // below vacuous — and against "fixing" the overflow by shrinking the pictures to
  // nothing, the outcome the owner already rejected.
  async function assertRowWorthLookingAt(page) {
    await expect(page.getByTestId('deck-row')).toBeVisible();
    await expect(page.getByTestId('deck-thumb')).toHaveCount(3);
    const h = await page
      .getByTestId('deck-thumb')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(h, 'the pictures must stay big enough to be a preview').toBeGreaterThan(60);
  }

  test('step 4 (details): the phone field is reachable with the pictures on screen', async ({
    page,
  }) => {
    await withDeckPictures(page);
    await page.goto('/options.html?design=bachelorette&step=4');
    await expect(page.getByTestId('step-4')).toBeVisible();
    await assertRowWorthLookingAt(page);
    // The outcome first: with no scrolling at all, can the buyer put a finger on
    // the field? (It was 105px under the sticky bar.)
    await assertTappable(page, '[data-testid="owner-phone"]');
    // And this step has no licence to scroll in the first place.
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
      )
      .toBeLessThanOrEqual(4);
  });

  test('step 5 (pawn photos): the skip control is reachable with the pictures on screen', async ({
    page,
  }) => {
    await withDeckPictures(page);
    await page.goto('/options.html?design=bachelorette&step=5');
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await assertRowWorthLookingAt(page);
    // It was 37px under the sticky bar, so the tap landed on the bar's button.
    await assertTappable(page, '[data-testid="pawn-skip"]');
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
      )
      .toBeLessThanOrEqual(4);
  });

  // A PHONE IS NOT ONE SIZE.
  //
  // Everything above runs at 390×844 (iPhone 14) because that is the only phone
  // playwright.config.js profiles, and that single number is what let an earlier
  // fix ship broken: capping the picture at 112px left ~30px of slack THERE, so
  // the tests went green while the same page on a 375×667 iPhone SE — 177px
  // shorter — put the phone field 145px below the fold and the sticky bar back on
  // top of the skip control.
  //
  // The budget these steps have for the row is a fixed number of PIXELS, not a
  // proportion: the form, the collapsed summary and the sticky bar are all fixed
  // height, so every pixel of screen the phone doesn't have comes out of the row.
  // Measured with no row at all, the step-4 field clears the bar by 198px at
  // 390×844 and by 21px at 375×667 — so on the small phone the row and a step that
  // fits one screen cannot both be had.
  //
  // THE OWNER PICKED THE PICTURE (2026-08-08): "let the form scroll there so the
  // picture stays". The previous answer here — hide the row on the tight steps
  // below 800px — is superseded, and these tests were rewritten to the new intent,
  // which is the STRONGER promise: the pictures are on every phone AND every
  // control, including the last one, can be brought fully clear of the sticky bar
  // and tapped there.
  //
  // That second half is not free just because the page scrolls. The bar is FIXED
  // over the bottom 82px of the viewport, so if the document can only scroll to a
  // position where the last control still sits under the bar, the funnel is
  // blocked exactly as before, only less visibly. The worst case is therefore
  // scroll-to-the-very-end, and that is where these tests measure.
  //
  // A third playwright project would put every spec in the suite through a third
  // browser for this; these two viewports are set per-test instead, where the size
  // is the actual subject.
  const SMALL_PHONE = { width: 375, height: 667 }; // iPhone SE / 8 — the floor.
  const SHORTEST_WITHOUT_SCROLLING = { width: 375, height: 800 }; // Galaxy S20 class.

  // TALL SCREENS ONLY. The control must be usable with no scrolling at all: fully
  // clear of the bar, tappable, and the step must not have started scrolling.
  async function assertControlIsUsable(page, selector) {
    await assertTappable(page, selector);
    await expect
      .poll(async () =>
        page.evaluate((sel) => {
          const bar = document.querySelector('.wiz-bar').getBoundingClientRect();
          return Math.round(document.querySelector(sel).getBoundingClientRect().bottom - bar.top);
        }, selector)
      )
      .toBeLessThanOrEqual(0);
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
      )
      .toBeLessThanOrEqual(4);
  }

  // SHORT SCREENS. Scrolling is allowed, so the question is no longer "did the
  // step stay put" but "can the buyer GET to the control and tap it there".
  //
  // Scrolls to the very END of the document rather than using scrollIntoView,
  // because for the LAST control those are the same position and the end is the
  // honest worst case: it is where a flick lands, and it is the only place that
  // proves the document carries a tail taller than the fixed bar. A page with too
  // little bottom padding still scrolls — it simply cannot scroll far enough, and
  // scrollIntoView would quietly report success at the same blocked position.
  async function assertControlReachableByScrolling(page, selector) {
    await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    // Nothing of the bar over any part of it, at the end of the scroll.
    await expect
      .poll(async () =>
        page.evaluate((sel) => {
          const bar = document.querySelector('.wiz-bar').getBoundingClientRect();
          return Math.round(document.querySelector(sel).getBoundingClientRect().bottom - bar.top);
        }, selector)
      )
      .toBeLessThanOrEqual(0);
    // …and a finger put on its middle lands on the control, not the bar.
    await assertTappable(page, selector);
  }

  test('step 4 on a small phone: the pictures stay, and the phone field can be scrolled to', async ({
    page,
  }) => {
    await page.setViewportSize(SMALL_PHONE);
    await withDeckPictures(page);
    await page.goto('/options.html?design=bachelorette&step=4');
    await expect(page.getByTestId('step-4')).toBeVisible();
    // The pictures are the point of the trade — without them this test would pass
    // on the hidden row it replaced.
    await assertRowWorthLookingAt(page);
    // The step really does scroll here; that is the deliberate half of the trade.
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
    ).toBeGreaterThan(0);
    // The other half, which is not optional: the last control comes fully clear.
    await assertControlReachableByScrolling(page, '[data-testid="owner-phone"]');
  });

  test('step 5 on a small phone: the pictures stay, and the skip control can be scrolled to', async ({
    page,
  }) => {
    await page.setViewportSize(SMALL_PHONE);
    await withDeckPictures(page);
    await page.goto('/options.html?design=bachelorette&step=5');
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await assertRowWorthLookingAt(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
    ).toBeGreaterThan(0);
    await assertControlReachableByScrolling(page, '[data-testid="pawn-skip"]');
  });

  // A SCROLLING STEP MUST NOT LOOK FINISHED AT SCROLL 0.
  //
  // If the picture filled the first screen and the whole form sat below the fold, a
  // buyer would have no reason to think there was anything more and would stop at
  // the pictures. So part of the form has to be showing before anything is
  // scrolled — a field or its label, above the sticky bar's top, at the position
  // the page opens at. (Measured 375×667 with the capped row: on step 4 the email
  // label and its input are both on screen; on step 5 the photo slots and the hint
  // are. If the row ever grows enough to swallow them, shrink the row — the floor
  // is the owner's 60px picture, not this test.)
  for (const step of [
    { n: 4, id: 'step-4', controls: '.wiz-field' },
    { n: 5, id: 'step-pawns', controls: '.pawn-slot, .pawn-hint' },
  ]) {
    test(`step ${step.n} on a small phone shows part of the form at first paint`, async ({
      page,
    }) => {
      await page.setViewportSize(SMALL_PHONE);
      await withDeckPictures(page);
      await page.goto(`/options.html?design=bachelorette&step=${step.n}`);
      await expect(page.getByTestId(step.id)).toBeVisible();
      await assertRowWorthLookingAt(page);
      await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));

      // Nothing has been scrolled — this is what the buyer opens on.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const showing = await page.evaluate(
        ({ id, controls }) => {
          const barTop = document.querySelector('.wiz-bar').getBoundingClientRect().top;
          return Array.from(document.querySelectorAll(`[data-testid="${id}"] ${controls}`))
            .filter((el) => {
              const r = el.getBoundingClientRect();
              // Some part of it is in the strip the buyer can actually see: below
              // the top of the page and above the sticky bar that covers the
              // bottom of the viewport.
              return r.height > 0 && r.top < barTop && r.bottom > 0;
            })
            .map((el) => el.className);
        },
        { id: step.id, controls: step.controls }
      );
      expect(
        showing.length,
        'the form must not be entirely below the fold — there would be no cue to scroll'
      ).toBeGreaterThan(0);
    });
  }

  // THE BOUNDARY, which is where a height budget actually gets tested. This is the
  // shortest screen on which these steps still fit without scrolling, so it has
  // the least slack of any case that has to hold the whole row — dots included.
  // An earlier fix capped the PICTURE at 112px and left the carousel's 44px dot
  // strip uncounted; at this size that overspend alone puts the field under the
  // bar. Below this height the step is allowed to scroll instead (owner) — above
  // it, nothing may move.
  test('the shortest phone that still fits without scrolling: the whole row fits, dots and all', async ({
    page,
  }) => {
    await page.setViewportSize(SHORTEST_WITHOUT_SCROLLING);
    await withDeckPictures(page);
    await page.goto('/options.html?design=bachelorette&step=4');
    await expect(page.getByTestId('step-4')).toBeVisible();
    // The pictures really are on screen here — otherwise this silently becomes a
    // test of the empty case and the budget goes unmeasured.
    await assertRowWorthLookingAt(page);
    // The dots are part of the row's cost, so prove they are on screen too: a fix
    // that bought the space back by dropping the only "there is more than one
    // picture" affordance is not the fix.
    await expect(page.locator('#deckDots .carousel-dot')).toHaveCount(3);
    await assertControlIsUsable(page, '[data-testid="owner-phone"]');
  });

  // Step 3 keeps the big picture AND its licence to scroll (owner, 2026-08-06), so
  // here the buyer is expected to scroll — but having scrolled, the control must be
  // clear of the sticky bar and the tap must go through.
  //
  // Not assertTappable(): with the big picture this step scrolls to its very end,
  // and there the site's floating WhatsApp button (.wa-help, fixed at 287..374 ×
  // 718..762) covers the RIGHT half of the first gender option — the option is
  // still tappable, and the second one is untouched, but the centre pixel is not
  // free. That overlap is the help button meeting the page's last control, not the
  // deck row burying it, and it is out of this change's hands (a separate owner).
  // What this test refuses to let slip is the thing the row DOES control: the
  // sticky bar swallowing the control the way it did on steps 4 and 5.
  test('step 3 (name): the control clears the sticky bar once scrolled to', async ({ page }) => {
    await withDeckPictures(page);
    await page.goto('/options.html?design=bachelorette&step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    await assertRowWorthLookingAt(page);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    const gender = page.locator('[data-testid="gender-group"]');
    await expect(gender).toBeInViewport({ ratio: 1 });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const bar = document.querySelector('.wiz-bar').getBoundingClientRect();
          const el = document.querySelector('[data-testid="gender-group"]').getBoundingClientRect();
          return Math.round(el.bottom - bar.top);
        })
      )
      .toBeLessThanOrEqual(0);
    // Nothing of the sticky bar is over either option …
    const overBar = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="gender-group"] label')).some((el) => {
        const r = el.getBoundingClientRect();
        for (const x of [r.left + 4, r.left + r.width / 2, r.right - 4]) {
          const at = document.elementFromPoint(x, r.top + r.height / 2);
          if (at && at.closest('.wiz-bar')) return true;
        }
        return false;
      })
    );
    expect(overBar, 'the sticky bar must not sit on a gender option').toBe(false);
    // … and the tap lands.
    await page.locator('[data-testid="gender-group"] label').last().click({ timeout: 5000 });
  });

  // The small phone loses the pictures on NO step. Step 3 may scroll and keeps the
  // full-size picture at any screen height; steps 4 and 5 now scroll too and keep
  // the capped one. Without this, "hide the row whenever the screen is short" would
  // pass every test above while quietly taking the product photos away from every
  // SE owner, which is the outcome the owner rejected.
  test('step 3 on a small phone: full-size pictures, and the control still reachable', async ({
    page,
  }) => {
    await page.setViewportSize(SMALL_PHONE);
    await withDeckPictures(page);
    await page.goto('/options.html?design=bachelorette&step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    // Not merely present: still the big preview, not a token the buyer can't read.
    await expect(page.getByTestId('deck-row')).toBeVisible();
    const thumb = await page
      .getByTestId('deck-thumb')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(thumb, 'a short screen must not shrink the step that may scroll').toBeGreaterThan(150);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const bar = document.querySelector('.wiz-bar').getBoundingClientRect();
          const el = document.querySelector('[data-testid="gender-group"]').getBoundingClientRect();
          return Math.round(el.bottom - bar.top);
        })
      )
      .toBeLessThanOrEqual(0);
    await page.locator('[data-testid="gender-group"] label').last().click({ timeout: 5000 });
  });
});
