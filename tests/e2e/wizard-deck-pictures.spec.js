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
