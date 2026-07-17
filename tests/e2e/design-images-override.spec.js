import { test, expect } from '@playwright/test';

// E2E for the owner's per-design image overrides (server/design-images.js +
// GET /api/design-images, consumed by products.html + js/product.js). Overrides
// are mocked at the NETWORK layer so the tests never write real data. A minimal
// PNG stands in for the (non-existent) uploaded files so the <img>s can load.

// A REAL, decodable 1×1 transparent PNG (not just the signature) — the browser
// must actually DECODE the stubbed override, otherwise its <img> fires `error`
// and the new onerror fallback would (correctly) swap back to the static asset,
// which is the opposite of what the "override applied" tests assert.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const STORE_OVERRIDE = '/content-uploads/0123456789abcdef.webp';
const BOARD_OVERRIDE = '/content-uploads/fedcba9876543210.webp';
const CAR1 = '/content-uploads/1111111111111111.webp';
const CAR2 = '/content-uploads/2222222222222222.webp';

function stubUploads(page) {
  return page.route('**/content-uploads/*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG })
  );
}

test.describe('products.html — store-tile override', () => {
  test('uses the overridden store picture when present, static store.webp when not', async ({
    page,
  }) => {
    await stubUploads(page);
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { birthday: { store: STORE_OVERRIDE } } } })
    );

    await page.goto('/products.html');

    // The overridden design's tile settles on the uploaded picture (first paint
    // shows store.webp, then the map resolves and swaps it — poll the settled src).
    const birthdayImg = page.locator(
      '.product-card[data-design-id="birthday"] [data-testid="product-image"]'
    );
    await expect(birthdayImg).toHaveAttribute('src', STORE_OVERRIDE);

    // A design WITHOUT an override keeps its shipped static store.webp.
    const neonImg = page.locator(
      '.product-card[data-design-id="neon"] [data-testid="product-image"]'
    );
    await expect(neonImg).toHaveAttribute('src', /assets\/designs\/neon\/store\.webp$/);
  });

  test('a failed override fetch falls back to the static store.webp and the grid still renders', async ({
    page,
  }) => {
    // Simulate a broken/timed-out override endpoint: the client must fail-safe.
    await page.route('**/api/design-images*', (route) => route.abort());

    await page.goto('/products.html');

    await expect(page.getByTestId('store-grid')).toBeVisible();
    await expect(page.getByTestId('product-card')).toHaveCount(7);
    // Every tile shows its static asset (nothing broken by the failed fetch).
    const birthdayImg = page.locator(
      '.product-card[data-design-id="birthday"] [data-testid="product-image"]'
    );
    await expect(birthdayImg).toHaveAttribute('src', /assets\/designs\/birthday\/store\.webp$/);
  });

  test('a MISSING override file (404) degrades the tile back to the static store.webp', async ({
    page,
  }) => {
    // Override is set, but the file 404s (NOT stubbed) → the tile's onerror must
    // swap back to data-store-default rather than show a broken image.
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { birthday: { store: STORE_OVERRIDE } } } })
    );
    await page.goto('/products.html');
    const birthdayImg = page.locator(
      '.product-card[data-design-id="birthday"] [data-testid="product-image"]'
    );
    // First it swaps to the override, then onerror falls back to the static asset.
    await expect
      .poll(() => birthdayImg.getAttribute('src'))
      .toMatch(/assets\/designs\/birthday\/store\.webp$/);
  });
});

test.describe('products.html — store-tile carousel', () => {
  test('a design WITH carousel pictures becomes a fast seamless fade carousel of [store, ...added]', async ({
    page,
  }) => {
    await stubUploads(page);
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { birthday: { carousel: [CAR1, CAR2] } } } })
    );

    await page.goto('/products.html');

    const media = page.locator('.product-card[data-design-id="birthday"] .product-card__media');
    // The shared fade carousel engine initialised on the tile.
    await expect(media).toHaveClass(/carousel--fade/);
    await expect(media).toHaveAttribute('aria-roledescription', 'carousel');

    // Frames = [store image] + the two added pictures, in order.
    const frames = media.locator('.tile-frame');
    await expect(frames).toHaveCount(3);
    // Frame 0 is the store image (keeps the product-image testid + static src).
    await expect(media.locator('[data-testid="product-image"]')).toHaveAttribute(
      'src',
      /assets\/designs\/birthday\/store\.webp$/
    );
    // The added carousel frames point at the owner's uploads.
    await expect
      .poll(() =>
        media.locator('[data-testid="carousel-frame"]').evaluateAll((els) => els.map((i) => i.src))
      )
      .toEqual([expect.stringContaining(CAR1), expect.stringContaining(CAR2)]);
  });

  test('a design WITHOUT carousel pictures stays a single static image (no carousel)', async ({
    page,
  }) => {
    await stubUploads(page);
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { birthday: { carousel: [CAR1] } } } })
    );

    await page.goto('/products.html');

    const neon = page.locator('.product-card[data-design-id="neon"] .product-card__media');
    await expect(neon.locator('[data-testid="product-image"]')).toHaveAttribute(
      'src',
      /assets\/designs\/neon\/store\.webp$/
    );
    await expect(neon).not.toHaveClass(/carousel--fade/);
    await expect(neon.locator('.tile-frame')).toHaveCount(0);
  });

  test('a 404 carousel picture degrades to the store image without breaking the tile', async ({
    page,
  }) => {
    // The carousel path is set but its file 404s (NOT stubbed) → the frame's
    // onerror must fall back to the store image; the grid still renders in full.
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { birthday: { carousel: [CAR1] } } } })
    );

    await page.goto('/products.html');

    await expect(page.getByTestId('store-grid')).toBeVisible();
    await expect(page.getByTestId('product-card')).toHaveCount(7);

    const media = page.locator('.product-card[data-design-id="birthday"] .product-card__media');
    // The store frame is intact.
    await expect(media.locator('[data-testid="product-image"]')).toHaveAttribute(
      'src',
      /assets\/designs\/birthday\/store\.webp$/
    );
    // The broken carousel frame fell back to the static store image.
    await expect
      .poll(() => media.locator('[data-testid="carousel-frame"]').getAttribute('src'))
      .toMatch(/assets\/designs\/birthday\/store\.webp$/);
  });
});

test.describe('index.html — homepage rail store override', () => {
  test('the homepage tile picks up the same store override as /products', async ({ page }) => {
    await stubUploads(page);
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { birthday: { store: STORE_OVERRIDE } } } })
    );

    await page.goto('/');

    // The homepage products rail tile for the overridden design shows the upload.
    const tileImg = page
      .locator('.home-prod-card[data-design-id="birthday"] .home-prod-thumb img')
      .first();
    await expect(tileImg).toHaveAttribute('src', STORE_OVERRIDE);
  });
});

test.describe('product.html — gallery slot override', () => {
  test('uses the overridden board picture, static renders for the other slots', async ({
    page,
  }) => {
    await stubUploads(page);
    // Only the board slot is overridden for posttrip.
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { posttrip: { board: BOARD_OVERRIDE } } } })
    );
    // Keep the content-editor overrides empty so per-slot overrides take effect.
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    await page.goto('/product.html?design=posttrip');

    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        'assets/designs/posttrip/gallery-front.webp',
        'assets/designs/posttrip/gallery-back.webp',
        BOARD_OVERRIDE, // owner's uploaded board picture wins for its slot
      ]);
  });

  test('a failed override fetch falls back to the static gallery renders (page still renders)', async ({
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
    // Override is set, but the file 404s (NOT stubbed) → the board slide's onerror
    // must swap back to the shipped gallery-board.webp, not show a broken slide.
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { posttrip: { board: BOARD_OVERRIDE } } } })
    );
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
});

test.describe('product.html — boardless design (kids) board override', () => {
  test('surfaces an uploaded board as a gallery slide even though kids ships no board', async ({
    page,
  }) => {
    await stubUploads(page);
    // kids ships NO board render, but the owner uploaded one.
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { kids: { board: BOARD_OVERRIDE } } } })
    );
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    await page.goto('/product.html?design=kids');

    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    // First paint shows only front/back (no override yet); once the map resolves the
    // uploaded board is appended as a third slide.
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        'assets/designs/kids/gallery-front.webp',
        'assets/designs/kids/gallery-back.webp',
        BOARD_OVERRIDE, // owner's uploaded board — sourced from the override alone
      ]);
  });

  test('with NO board override, kids shows no board slide and nothing is broken', async ({
    page,
  }) => {
    await stubUploads(page);
    await page.route('**/api/design-images*', (route) => route.fulfill({ json: { images: {} } }));
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    await page.goto('/product.html?design=kids');

    await expect(page.getByTestId('pdp-gallery')).toBeVisible();
    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    // Exactly two slides (front, back) — the board slide is omitted, and no slide
    // points at the non-existent gallery-board.webp (no broken/404 image).
    await expect(slides).toHaveCount(2);
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual(['assets/designs/kids/gallery-front.webp', 'assets/designs/kids/gallery-back.webp']);
  });
});
