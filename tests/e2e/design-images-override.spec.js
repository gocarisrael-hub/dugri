import { test, expect } from '@playwright/test';

// E2E for the owner's per-design GALLERY overrides (server/design-images.js + GET
// /api/design-images), consumed by products.html (grid card carousel) and
// product.html (detail gallery). The config is mocked at the NETWORK layer so the
// tests never write real data. A minimal PNG stands in for the (non-existent)
// uploaded files so the <img>s can load.

// A REAL, decodable 1×1 transparent PNG — the browser must actually DECODE the
// stubbed override, otherwise its <img> fires `error` and the onerror fallback
// swaps back to the shipped render (the opposite of what the "override" tests want).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const STORE_OVERRIDE = '/content-uploads/0123456789abcdef.webp';
const BOARD_OVERRIDE = '/content-uploads/fedcba9876543210.webp';

function stubUploads(page) {
  return page.route('**/content-uploads/*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG })
  );
}
// Serve a gallery-config map in the new store shape.
function stubConfig(page, images) {
  return page.route('**/api/design-images*', (route) => route.fulfill({ json: { images } }));
}

// These tests assert the BUILT-IN catalog grid + PDP. Stub /api/custom-designs
// empty so an uploaded template (surfaced as an extra product card, covered in
// custom-designs.spec) can't perturb the built-in card counts here.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

test.describe('products.html — store-tile override in the card carousel', () => {
  test('uses the overridden store picture when present, shipped store.webp when not', async ({
    page,
  }) => {
    await stubUploads(page);
    await stubConfig(page, { birthday: { base: { store: { img: STORE_OVERRIDE } } } });

    await page.goto('/products.html');

    // The first slide of the overridden design's card settles on the upload (first
    // paint shows store.webp, then the config resolves and rebuilds the carousel).
    const birthdayImg = page.locator(
      '.product-card[data-design-id="birthday"] [data-testid="product-image"]'
    );
    await expect(birthdayImg).toHaveAttribute('src', STORE_OVERRIDE);

    // A design WITHOUT an override keeps its shipped store.webp on the first slide.
    const japaneseImg = page.locator(
      '.product-card[data-design-id="japanese"] [data-testid="product-image"]'
    );
    await expect(japaneseImg).toHaveAttribute('src', /assets\/designs\/japanese\/store\.webp$/);
  });

  test('each card is a multi-picture swipe carousel with dots', async ({ page }) => {
    await stubUploads(page);
    await stubConfig(page, {});
    await page.goto('/products.html');

    const card = page.locator('.product-card[data-design-id="birthday"]');
    // Default gallery for a boarded design = store + front + back + board (4 shots).
    const slides = card.locator(
      '.product-card__track > .product-card__slide:not([data-carousel-clone])'
    );
    await expect(slides).toHaveCount(4);
    // The carousel engine rendered its dots (one per real slide).
    await expect(card.locator('.product-card__dots .carousel-dot')).toHaveCount(4);
    // Every slide links into the detail page (tap opens the product; drag swipes).
    await expect(slides.first()).toHaveAttribute('href', 'product.html?design=birthday');
  });

  test('the card carousel does NOT auto-advance — pictures change only on user input', async ({
    page,
  }) => {
    await stubUploads(page);
    await stubConfig(page, {});
    await page.goto('/products.html');

    const card = page.locator('.product-card[data-design-id="birthday"]');
    const dots = card.locator('.product-card__dots .carousel-dot');
    await expect(dots).toHaveCount(4);
    // The first dot is active on load.
    await expect(dots.nth(0)).toHaveClass(/is-active/);

    // Wait well past the engine's 5s slideshow autoplay interval: with autoplay off,
    // nothing moves on its own — the first picture is still the active one.
    await page.waitForTimeout(5600);
    await expect(dots.nth(0)).toHaveClass(/is-active/);
    await expect(dots.nth(1)).not.toHaveClass(/is-active/);

    // A user action (tapping dot 2) DOES change the picture — the carousel still works.
    await dots.nth(1).click();
    await expect(dots.nth(1)).toHaveClass(/is-active/);
  });

  test('a failed config fetch falls back to shipped renders and the grid still renders', async ({
    page,
  }) => {
    await page.route('**/api/design-images*', (route) => route.abort());

    await page.goto('/products.html');

    await expect(page.getByTestId('store-grid')).toBeVisible();
    await expect(page.getByTestId('product-card')).toHaveCount(6);
    const birthdayImg = page.locator(
      '.product-card[data-design-id="birthday"] [data-testid="product-image"]'
    );
    await expect(birthdayImg).toHaveAttribute('src', /assets\/designs\/birthday\/store\.webp$/);
  });

  test('a MISSING override file (404) degrades the first slide back to store.webp', async ({
    page,
  }) => {
    // Override is set, but the file 404s (NOT stubbed) → onerror swaps back to the
    // shipped render rather than showing a broken image.
    await stubConfig(page, { birthday: { base: { store: { img: STORE_OVERRIDE } } } });
    await page.goto('/products.html');
    const birthdayImg = page.locator(
      '.product-card[data-design-id="birthday"] [data-testid="product-image"]'
    );
    await expect
      .poll(() => birthdayImg.getAttribute('src'))
      .toMatch(/assets\/designs\/birthday\/store\.webp$/);
  });

  test('a hidden store slot drops the cover from the card (front leads instead)', async ({
    page,
  }) => {
    await stubUploads(page);
    await stubConfig(page, { birthday: { base: { store: { onProducts: false } } } });
    await page.goto('/products.html');

    const first = page.locator(
      '.product-card[data-design-id="birthday"] [data-testid="product-image"]'
    );
    // With store hidden on the products surface, the first slide is the card front.
    await expect(first).toHaveAttribute('src', /assets\/designs\/birthday\/gallery-front\.webp$/);
  });
});

test.describe('product.html — detail gallery from the curated selection', () => {
  test('uses the overridden board render, ships the other slots (store leads)', async ({
    page,
  }) => {
    await stubUploads(page);
    // Only the board slot is overridden for posttrip.
    await stubConfig(page, { posttrip: { base: { board: { img: BOARD_OVERRIDE } } } });
    // Keep the content-editor overrides empty so the design-images gallery drives it.
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    await page.goto('/product.html?design=posttrip');

    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        'assets/designs/posttrip/store.webp', // the shop tile's picture, leading here too
        'assets/designs/posttrip/gallery-front.webp',
        'assets/designs/posttrip/gallery-back.webp',
        BOARD_OVERRIDE, // owner's uploaded board render wins for its slot
      ]);
  });

  test('the owner can add a named extra photo to the detail gallery', async ({ page }) => {
    await stubUploads(page);
    await stubConfig(page, {
      posttrip: {
        photos: [
          { id: 'p1', img: STORE_OVERRIDE, name: 'סטודיו', onProducts: false, onProduct: true },
        ],
        order: ['store', 'front', 'back', 'board', 'p1'],
      },
    });
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    await page.goto('/product.html?design=posttrip');

    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        'assets/designs/posttrip/store.webp', // store cover — shown by default
        'assets/designs/posttrip/gallery-front.webp',
        'assets/designs/posttrip/gallery-back.webp',
        'assets/designs/posttrip/gallery-board.webp',
        STORE_OVERRIDE, // the named extra photo, last
      ]);
  });

  test('a failed config fetch falls back to the shipped renders (page still renders)', async ({
    page,
  }) => {
    await page.route('**/api/design-images*', (route) => route.abort());
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    await page.goto('/product.html?design=posttrip');

    await expect(page.getByTestId('pdp-gallery')).toBeVisible();
    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        'assets/designs/posttrip/store.webp',
        'assets/designs/posttrip/gallery-front.webp',
        'assets/designs/posttrip/gallery-back.webp',
        'assets/designs/posttrip/gallery-board.webp',
      ]);
  });

  test('a MISSING override file (404) degrades the board slide back to the static render', async ({
    page,
  }) => {
    // Override set, file 404s (NOT stubbed) → onerror swaps back to gallery-board.webp.
    await stubConfig(page, { posttrip: { base: { board: { img: BOARD_OVERRIDE } } } });
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    await page.goto('/product.html?design=posttrip');

    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    // The slides are loading="lazy", so the broken board only tries to load once the
    // shopper reaches it — which is also the only moment the degrade is visible.
    await slides.last().scrollIntoViewIfNeeded();
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        'assets/designs/posttrip/store.webp',
        'assets/designs/posttrip/gallery-front.webp',
        'assets/designs/posttrip/gallery-back.webp',
        'assets/designs/posttrip/gallery-board.webp', // onerror fell back to static
      ]);
  });

  test('#159: a boardless design (kids) surfaces a board slide from an uploaded board', async ({
    page,
  }) => {
    await stubUploads(page);
    // kids ships NO board (assets/designs/kids has no gallery-board.webp), but the
    // owner uploaded one → the board slide appears from the override alone.
    await stubConfig(page, { kids: { base: { board: { img: BOARD_OVERRIDE } } } });
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    await page.goto('/product.html?design=kids');

    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        'assets/designs/kids/store.webp',
        'assets/designs/kids/gallery-front.webp',
        'assets/designs/kids/gallery-back.webp',
        BOARD_OVERRIDE, // owner's uploaded board — no shipped kids board exists
      ]);
  });

  test('#159: a boardless board override that 404s DROPS the slide (no broken image)', async ({
    page,
  }) => {
    // Override set but the file 404s (NOT stubbed) → the override-only board slide
    // has no shipped fallback, so it is DROPPED rather than shown broken.
    await stubConfig(page, { kids: { base: { board: { img: BOARD_OVERRIDE } } } });
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    await page.goto('/product.html?design=kids');

    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    // loading="lazy" — on a wide viewport the broken slide only tries to load once
    // it is reached, so nudge it into view. On a narrow one it is already close
    // enough to have loaded, failed and taken its slide with it, and the nudge finds
    // nothing to scroll to — which is the outcome this test wants either way.
    await slides
      .last()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        'assets/designs/kids/store.webp',
        'assets/designs/kids/gallery-front.webp',
        'assets/designs/kids/gallery-back.webp',
        // the broken override-only board slide dropped itself — no 404 image remains
      ]);
  });
});

// THE REGRESSION the owner reported: "clicking a product and moving to the product
// page shows the SECOND picture instead of the FIRST".
//
// The shop tile and the detail gallery read ONE arrangement, but the detail page
// used to apply a slot-specific default on top of it — the store cover was hidden
// there unless the owner had ticked "בעמוד המוצר" by hand. So for every design she
// had not hand-ticked, /products led with the cover and clicking it opened the
// gallery one picture further along. Reproduced live on production for kids and
// football-boys before this fix.
//
// This walks the real journey (grid → detail) rather than asserting a slide list,
// because the bug was precisely the DISAGREEMENT between the two surfaces: either
// one alone looked correct.
test.describe('the shop tile and the product page open on the SAME picture', () => {
  for (const id of ['posttrip', 'kids']) {
    test(`the ${id} tile and its product page show the same first picture`, async ({ page }) => {
      // No stored config at all — the untouched design is exactly the case that broke.
      await stubConfig(page, {});
      await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

      await page.goto('/products.html');
      const tile = page.locator(`.product-card[data-design-id="${id}"]`);
      const tileImg = tile.locator('[data-testid="product-image"]').first();
      await expect(tileImg).toBeVisible();
      const shown = await tileImg.getAttribute('src');
      expect(shown).toMatch(/store\.webp$/); // the grid leads with the cover

      await page.goto(`/product.html?design=${id}`);
      const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
      await expect(slides.first()).toBeVisible();
      // Settled state (the config resolves after first paint and rebuilds the track).
      await expect.poll(() => slides.first().getAttribute('src')).toBe(shown);
      // …and the carousel really is resting on it, not merely holding it at index 0.
      await expect(page.locator('#galleryDots .carousel-dot').first()).toHaveClass(/is-active/);
    });
  }

  test('a picture the owner hid on the product page is still skipped there', async ({ page }) => {
    // The default flipped, the CONTROL did not: an explicit hide must still win, or
    // fixing the report would have taken her per-surface choice away.
    await stubConfig(page, { posttrip: { base: { store: { onProduct: false } } } });
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    await page.goto('/product.html?design=posttrip');
    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        'assets/designs/posttrip/gallery-front.webp',
        'assets/designs/posttrip/gallery-back.webp',
        'assets/designs/posttrip/gallery-board.webp',
      ]);
  });
});
