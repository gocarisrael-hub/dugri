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
    const neonImg = page.locator(
      '.product-card[data-design-id="neon"] [data-testid="product-image"]'
    );
    await expect(neonImg).toHaveAttribute('src', /assets\/designs\/neon\/store\.webp$/);
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
    await expect(page.getByTestId('product-card')).toHaveCount(7);
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
  test('uses the overridden board render, ships the other slots (store not led)', async ({
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
        'assets/designs/posttrip/gallery-front.webp',
        'assets/designs/posttrip/gallery-back.webp',
        BOARD_OVERRIDE, // owner's uploaded board render wins for its slot
      ]);
  });

  test('the owner can add the store cover + a named extra to the detail gallery', async ({
    page,
  }) => {
    await stubUploads(page);
    await stubConfig(page, {
      posttrip: {
        base: { store: { onProduct: true } },
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
        'assets/designs/posttrip/store.webp', // store cover, opted into the product page
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
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
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
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        'assets/designs/kids/gallery-front.webp',
        'assets/designs/kids/gallery-back.webp',
        // the broken override-only board slide dropped itself — no 404 image remains
      ]);
  });
});
