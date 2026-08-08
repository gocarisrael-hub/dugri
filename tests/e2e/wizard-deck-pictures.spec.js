import { test, expect } from '@playwright/test';

// E2E for the DECK PICTURES in the buyer's wizard — the owner's photographs of
// the whole deck (all eight fronts, all eight backs, the board), uploaded in
// admin-images.html and shown under the collapsed summary on the name step.
//
// This is the last screen before "המשך" where a shopper can still decide the
// product isn't what they pictured, so the row exists to show the real thing.
// It is entirely additive: a design with no uploaded pictures renders no row and
// the step looks exactly as it did before.

// A REAL, decodable PNG: the browser must decode these, or each <img> fires
// `error` and the thumb removes itself — which is the intended behaviour for a
// broken upload and would silently hollow out every assertion here.
// 64×64 rather than the usual 1×1: these pictures are `object-fit: contain`, so a
// 1×1 renders as a 1×1 speck that cannot be clicked or measured.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfbJGYyliH8OITBAtzmrP11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB2OhhtC3NOZwAAAAASUVORK5CYII=',
  'base64'
);
const FRONTS = '/content-uploads/00000000000000a1.webp';
const BACKS = '/content-uploads/00000000000000a2.webp';
const BOARD = '/content-uploads/00000000000000a3.webp';

const DESIGN = 'bachelorette';

function stubUploads(page) {
  return page.route('**/content-uploads/*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG })
  );
}
function stubDeck(page, base) {
  return page.route('**/api/design-images*', (route) =>
    route.fulfill({ json: { images: { [DESIGN]: { base } } } })
  );
}
const ALL_THREE = {
  deckFronts: { img: FRONTS },
  deckBacks: { img: BACKS },
  deckBoard: { img: BOARD },
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

// Land directly on the name step, which is where the preview collapses and the
// row belongs. `?design=` + `?step=3` is the wizard's own restore path.
async function gotoNameStep(page) {
  await page.goto(`/options.html?design=${DESIGN}&step=3`);
  await expect(page.getByTestId('continue-summary')).toBeVisible();
}

// The three pictures used to sit as three squares side by side, each about a
// third of the phone's width — too small to see a deck of cards in. The owner
// asked for the carousel the rest of the site already uses, so they are now one
// picture per view with dots, the same slideshow as the store tile and the
// product gallery.
test.describe('wizard — the deck pictures are a carousel', () => {
  test('one picture per view, with a dot per picture', async ({ page }) => {
    await stubUploads(page);
    await stubDeck(page, ALL_THREE);
    await gotoNameStep(page);

    const slides = page.locator('#deckTrack .deck-slide');
    await expect(slides).toHaveCount(3);
    // One dot per picture, in the shared carousel's own markup.
    await expect(page.locator('#deckDots .carousel-dot')).toHaveCount(3);

    // Each slide spans the full track: a slideshow, not a row of thumbnails.
    const trackW = (await page.locator('#deckTrack').boundingBox()).width;
    const slideW = (await slides.first().boundingBox()).width;
    expect(Math.abs(slideW - trackW)).toBeLessThan(2);
    // …and the picture is big enough to be worth looking at, which is the point.
    expect(slideW).toBeGreaterThan(200);
  });

  // A lone picture has nothing to swipe between; a single dot would advertise
  // more than there is.
  test('a single picture gets no carousel and no dots', async ({ page }) => {
    await stubUploads(page);
    await stubDeck(page, { deckBoard: { img: BOARD } });
    await gotoNameStep(page);

    await expect(page.locator('#deckTrack .deck-slide')).toHaveCount(1);
    await expect(page.locator('#deckDots .carousel-dot')).toHaveCount(0);
  });

  // The engine stamps its own "slide N of M" label on whatever element IS the
  // slide. When the button was the slide that overwrote the picture's real name,
  // leaving it announced only as a position — so the button now sits INSIDE the
  // slide, and both labels survive.
  test('the enlarge button keeps its own accessible name', async ({ page }) => {
    await stubUploads(page);
    await stubDeck(page, ALL_THREE);
    await gotoNameStep(page);

    const thumbs = page.getByTestId('deck-thumb');
    await expect(thumbs.nth(0)).toHaveAttribute('aria-label', /שמונת הקלפים/);
    await expect(thumbs.nth(2)).toHaveAttribute('aria-label', /לוח/);
    // The slide carries the position label, separately.
    await expect(page.locator('#deckTrack .deck-slide').first()).toHaveAttribute(
      'aria-label',
      /שקופית/
    );
  });
});

test.describe('wizard — the deck pictures under the collapsed summary', () => {
  test('shows one thumb per uploaded picture, with no caption text', async ({ page }) => {
    await stubUploads(page);
    await stubDeck(page, ALL_THREE);
    await gotoNameStep(page);

    const row = page.getByTestId('deck-row');
    await expect(row).toBeVisible();
    const thumbs = page.getByTestId('deck-thumb');
    await expect(thumbs).toHaveCount(3);
    // The owner asked for no text at all under these.
    await expect(row).toHaveText('');
    // …but each is a real button carrying an accessible name, so the row is
    // operable by keyboard and announced. Invisible is not the same as unlabelled.
    await expect(thumbs.nth(0)).toHaveAttribute('aria-label', /שמונת הקלפים/);
    await expect(thumbs.nth(2)).toHaveAttribute('aria-label', /לוח/);
  });

  test('a design with NO uploaded pictures renders no row at all', async ({ page }) => {
    await stubUploads(page);
    await stubDeck(page, {});
    await gotoNameStep(page);
    // Present in the DOM but hidden — the step must look exactly as before.
    await expect(page.getByTestId('deck-row')).toBeHidden();
    await expect(page.getByTestId('deck-thumb')).toHaveCount(0);
    // …and occupying NO SPACE. `display: grid` overrides the `hidden` attribute's
    // `display: none`, so the empty row kept its margin and pushed the phone
    // layout past the sticky bar. toBeHidden() alone does NOT catch that — an
    // empty grid has no size, so Playwright calls it hidden either way.
    const box = await page.getByTestId('deck-row').boundingBox();
    expect(box).toBeNull();
    expect(
      await page.evaluate(() => getComputedStyle(document.getElementById('deckRow')).display)
    ).toBe('none');
  });

  test('a PARTIAL upload shows only what was uploaded', async ({ page }) => {
    await stubUploads(page);
    await stubDeck(page, { deckFronts: { img: FRONTS } });
    await gotoNameStep(page);
    await expect(page.getByTestId('deck-thumb')).toHaveCount(1);
    await expect(page.getByTestId('deck-row')).toBeVisible();
  });

  test('the row is absent on the earlier steps, where the preview is still full-size', async ({
    page,
  }) => {
    await stubUploads(page);
    await stubDeck(page, ALL_THREE);
    await page.goto(`/options.html?design=${DESIGN}&step=1`);
    await expect(page.getByTestId('deck-row')).toBeHidden();
  });

  test('a dead /api/design-images costs the wizard nothing', async ({ page }) => {
    await page.route('**/api/design-images*', (route) => route.abort());
    await gotoNameStep(page);
    // No row, no thrown error, and the step itself still works.
    await expect(page.getByTestId('deck-row')).toBeHidden();
    await expect(page.getByTestId('honoree-input')).toBeVisible();
  });

  test('a picture that 404s drops its own thumb and leaves the others', async ({ page }) => {
    // Only the FRONTS upload is served; the other two 404.
    await page.route('**/content-uploads/*', (route) =>
      route.request().url().includes('a1')
        ? route.fulfill({ contentType: 'image/png', body: PNG })
        : route.fulfill({ status: 404, body: '' })
    );
    await stubDeck(page, ALL_THREE);
    await gotoNameStep(page);
    // A broken upload must not print a torn-image icon on the last screen before
    // the buyer commits; it removes itself and the good one stays.
    await expect(page.getByTestId('deck-thumb')).toHaveCount(1);
  });
});

// A picture whose upload 404s is removed from the row. Everything downstream —
// the dots, "next", the fullscreen viewer — must agree that it is gone. The
// carousel and the viewer therefore read the SAME thing: the slides currently in
// #deckTrack. These tests are about that agreement, not about how it is reached.
test.describe('wizard — a broken picture leaves nothing behind', () => {
  // Which slide the buyer is actually looking at: the one whose leading edge sits
  // on the track's. Measured geometrically because that is what the eye sees —
  // no class or index is consulted, so a lying index cannot make this pass.
  function onScreenSlide(page) {
    return page.evaluate(() => {
      const track = document.getElementById('deckTrack');
      const trackLeft = track.getBoundingClientRect().left;
      const slides = Array.from(track.querySelectorAll('.deck-slide'));
      let best = -1;
      let bestGap = Infinity;
      slides.forEach((s, i) => {
        const gap = Math.abs(s.getBoundingClientRect().left - trackLeft);
        if (gap < bestGap) {
          bestGap = gap;
          best = i;
        }
      });
      return best;
    });
  }
  function activeDot(page) {
    return page.evaluate(() =>
      Array.from(document.querySelectorAll('#deckDots .carousel-dot')).findIndex((d) =>
        d.classList.contains('is-active')
      )
    );
  }

  // Serve the fronts and the board at once, but HOLD the backs until the test
  // releases it — so the 404 lands after the buyer has already swiped onto it,
  // which is when the row and the dots can drift apart. Firing the error before
  // any interaction hides the defect entirely (index 0 is right by luck).
  async function stubWithHeldBacks(page) {
    let release;
    const held = new Promise((r) => (release = r));
    await page.route('**/content-uploads/*', async (route) => {
      if (!route.request().url().includes('a2')) {
        return route.fulfill({ contentType: 'image/png', body: PNG });
      }
      await held;
      return route.fulfill({ status: 404, body: '' });
    });
    await stubDeck(page, ALL_THREE);
    return release;
  }

  test('the dots keep telling the truth after a picture drops out mid-swipe', async ({ page }) => {
    const releaseBacks = await stubWithHeldBacks(page);
    await gotoNameStep(page);
    await expect(page.locator('#deckTrack .deck-slide')).toHaveCount(3);

    // The buyer swipes to the second picture — the one that is about to 404.
    await page.locator('#deckDots .carousel-dot').nth(1).click();
    await expect.poll(() => onScreenSlide(page)).toBe(1);

    releaseBacks();

    // Two pictures survive, so two dots — never a dot for a picture that is gone.
    await expect(page.locator('#deckTrack .deck-slide')).toHaveCount(2);
    await expect(page.locator('#deckDots .carousel-dot')).toHaveCount(2);

    // The lit dot must be the picture actually on screen. This is the defect:
    // the dot said 1 while picture 2 was in view.
    const shown = await onScreenSlide(page);
    await expect.poll(() => activeDot(page)).toBe(shown);

    // …and "next" must still go somewhere. It did nothing before: the carousel
    // thought it was already on the slide the track was showing.
    const other = shown === 0 ? 1 : 0;
    await page.locator('#deckDots .carousel-dot').nth(other).click();
    await expect.poll(() => onScreenSlide(page)).toBe(other);
    await expect.poll(() => activeDot(page)).toBe(other);
  });

  test('a picture that dropped out cannot come back in the fullscreen viewer', async ({ page }) => {
    await page.route('**/content-uploads/*', (route) =>
      route.request().url().includes('a2')
        ? route.fulfill({ status: 404, body: '' })
        : route.fulfill({ contentType: 'image/png', body: PNG })
    );
    await stubDeck(page, ALL_THREE);
    await gotoNameStep(page);
    await expect(page.getByTestId('deck-thumb')).toHaveCount(2);

    // Open from a picture that survived…
    await page.getByTestId('deck-thumb').first().click();
    const view = page.getByTestId('deck-view');
    await expect(view).toBeVisible();

    // …and the broken one must not be in the viewer at all. It was: the viewer
    // was built from a list the removal never touched, so the buyer watched a
    // picture disappear from the row and then met it again, torn, full-screen.
    const slides = view.locator('#deckViewTrack > *');
    await expect(slides).toHaveCount(2);
    const srcs = await view
      .locator('#deckViewTrack img')
      .evaluateAll((els) => els.map((e) => e.getAttribute('src')));
    expect(srcs).toEqual([FRONTS, BOARD]);
  });

  test('the viewer opens on the picture that was tapped, counted among the survivors', async ({
    page,
  }) => {
    // The FIRST picture 404s, so every surviving picture's position shifted by one.
    // A tap must open the picture that was tapped — the stored position was read
    // from before the removal, so the viewer landed on the wrong photograph.
    await page.route('**/content-uploads/*', (route) =>
      route.request().url().includes('a1')
        ? route.fulfill({ status: 404, body: '' })
        : route.fulfill({ contentType: 'image/png', body: PNG })
    );
    await stubDeck(page, ALL_THREE);
    await gotoNameStep(page);
    await expect(page.getByTestId('deck-thumb')).toHaveCount(2);

    // Tap the LAST survivor (the board). The viewer must be showing the board.
    await page.getByTestId('deck-thumb').nth(1).click();
    const view = page.getByTestId('deck-view');
    await expect(view).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const track = document.getElementById('deckViewTrack');
          const left = track.getBoundingClientRect().left;
          const kids = Array.from(track.children);
          let best = -1;
          let bestGap = Infinity;
          kids.forEach((k, i) => {
            const gap = Math.abs(k.getBoundingClientRect().left - left);
            if (gap < bestGap) {
              bestGap = gap;
              best = i;
            }
          });
          return kids[best] ? kids[best].querySelector('img').getAttribute('src') : null;
        })
      )
      .toBe(BOARD);
  });
});

// WHAT A SHORT SCREEN DOES TO THE ROW.
//
// The row is capped on the steps that must fit without scrolling (4 and 5), and
// the cap is a fixed pixel budget — so on a short enough phone the budget runs
// out entirely and the row is dropped there rather than squeezed under the owner's
// 60px picture floor. That is a deliberate trade and it has two halves, both of
// which have to hold: the row goes away CLEANLY where it doesn't fit (a half-fitting
// row is the defect, not the fix), and it is untouched on the step that may scroll.
//
// wizard-noscroll.spec.js owns the other side of this — that the FORM works at
// these sizes. Here the subject is the pictures.
test.describe('wizard — the deck pictures on a short screen', () => {
  const SMALL_PHONE = { width: 375, height: 667 }; // iPhone SE / 8.

  test('the name step keeps its full-size pictures however short the phone', async ({ page }) => {
    await page.setViewportSize(SMALL_PHONE);
    await stubUploads(page);
    await stubDeck(page, ALL_THREE);
    await gotoNameStep(page);

    const row = page.getByTestId('deck-row');
    await expect(row).toBeVisible();
    await expect(page.getByTestId('deck-thumb')).toHaveCount(3);
    // Still one full-width picture per view with its dots — the same carousel a
    // big phone gets, not a degraded one.
    await expect(page.locator('#deckDots .carousel-dot')).toHaveCount(3);
    const trackW = (await page.locator('#deckTrack').boundingBox()).width;
    const slideW = (await page.locator('#deckTrack .deck-slide').first().boundingBox()).width;
    expect(Math.abs(slideW - trackW)).toBeLessThan(2);
  });

  // THE OWNER'S CALL, 2026-08-08: "let the form scroll there so the picture stays".
  // This code briefly hid the row on the tight steps below 800px tall, because the
  // row and a step that fits one screen cannot both be had on an SE. The owner
  // chose the picture and accepted the scroll, so the row is here on every phone —
  // capped, but present and above her 60px floor.
  // wizard-noscroll.spec.js owns the other half: that the form is still reachable
  // once the step scrolls. Here the subject is that the pictures survive at all.
  for (const step of [4, 5]) {
    test(`step ${step} on a small phone keeps the pictures rather than dropping them`, async ({
      page,
    }) => {
      await page.setViewportSize(SMALL_PHONE);
      await stubUploads(page);
      await stubDeck(page, ALL_THREE);
      await page.goto(`/options.html?design=${DESIGN}&step=${step}`);
      await expect(page.getByTestId(step === 4 ? 'step-4' : 'step-pawns')).toBeVisible();

      // Present, not merely in the DOM: a hidden row reports a zero box, which is
      // exactly what this used to do here.
      const row = page.getByTestId('deck-row');
      await expect(row).toBeVisible();
      await expect(page.getByTestId('deck-thumb')).toHaveCount(3);
      expect((await row.boundingBox()).height).toBeGreaterThan(0);

      // …and big enough to be a preview. The owner's floor, not a recorded pixel:
      // a row squeezed under 60px is the outcome she rejected just as much as a
      // row that isn't there.
      const thumbH = await page
        .getByTestId('deck-thumb')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height);
      expect(thumbH, 'the picture must stay at or above the 60px floor').toBeGreaterThanOrEqual(60);

      // The dots come too — they are the only sign there is more than one picture,
      // and buying space back by dropping them is not the trade that was made.
      await expect(page.locator('#deckDots .carousel-dot')).toHaveCount(3);
    });
  }
});

test.describe('wizard — the fullscreen deck viewer', () => {
  test('a thumb opens the viewer on that picture, and Escape closes it', async ({ page }) => {
    await stubUploads(page);
    await stubDeck(page, ALL_THREE);
    await gotoNameStep(page);

    const view = page.getByTestId('deck-view');
    await expect(view).toBeHidden();
    await page.getByTestId('deck-thumb').nth(1).click();
    await expect(view).toBeVisible();
    // All three are in the viewer, so the shopper can swipe between them.
    await expect(view.locator('#deckViewTrack > *')).toHaveCount(3);
    // Slides are stamped by the carousel — the fault that flattened the product
    // gallery (#345) was exactly these going unstamped.
    await expect(view.locator('#deckViewTrack > *').first()).toHaveClass(/carousel-slide/);

    await page.keyboard.press('Escape');
    await expect(view).toBeHidden();
  });

  test('reopening rebuilds the viewer — the second open is not a dead carousel', async ({
    page,
  }) => {
    await stubUploads(page);
    await stubDeck(page, ALL_THREE);
    await gotoNameStep(page);

    const view = page.getByTestId('deck-view');
    await page.getByTestId('deck-thumb').first().click();
    await expect(view).toBeVisible();
    await page.getByTestId('deck-view-close').click();
    await expect(view).toBeHidden();

    // initCarousel is idempotent: without a destroy on close it would hand back
    // the dead instance and the fresh slides would never be stamped, collapsing
    // them into one squashed row (#345).
    await page.getByTestId('deck-thumb').first().click();
    await expect(view).toBeVisible();
    const slides = view.locator('#deckViewTrack > *');
    await expect(slides).toHaveCount(3);
    await expect(slides.first()).toHaveClass(/carousel-slide/);
    const { slideW, trackW } = await page.evaluate(() => {
      const t = document.getElementById('deckViewTrack');
      return {
        slideW: t.children[0].getBoundingClientRect().width,
        trackW: t.getBoundingClientRect().width,
      };
    });
    expect(slideW).toBeGreaterThan(trackW * 0.9);
  });

  test('clicking around the picture closes; clicking the picture does not', async ({ page }) => {
    await stubUploads(page);
    await stubDeck(page, ALL_THREE);
    await gotoNameStep(page);

    const view = page.getByTestId('deck-view');
    await page.getByTestId('deck-thumb').first().click();
    await expect(view).toBeVisible();
    // A pinch or drag that ends on the picture must never be read as "done
    // looking" — that would close the viewer mid-gesture.
    await view.locator('#deckViewTrack img').first().click();
    await expect(view).toBeVisible();
    // The dark area AROUND the photo is the slide, not the overlay root — each
    // slide spans the whole track. Closing only on the root left barely a few
    // clickable pixels, so anywhere off the picture closes.
    await view
      .locator('#deckViewTrack > *')
      .first()
      .click({ position: { x: 8, y: 8 } });
    await expect(view).toBeHidden();
  });
});
