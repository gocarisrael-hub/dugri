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

// Index of the visible frame in a fade tile carousel. The engine lights the
// active frame by REMOVING aria-hidden (inactive frames get aria-hidden="true"),
// so the active frame is the only .tile-frame without that attribute.
function activeFrameIndex(media) {
  return media
    .locator('.tile-frame')
    .evaluateAll((frames) => frames.findIndex((f) => !f.hasAttribute('aria-hidden')));
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

    // The pictures are shown in FULL, never cropped: object-fit is contain (not
    // the old cover), for both the store frame and the added frames.
    await expect(media.locator('[data-testid="product-image"]')).toHaveCSS('object-fit', 'contain');
    await expect(media.locator('[data-testid="carousel-frame"]').first()).toHaveCSS(
      'object-fit',
      'contain'
    );

    // A ≥2-frame tile gets one manual dot per frame (the shopper's controls).
    await expect(media.locator('.tile-dots .carousel-dot')).toHaveCount(3);
  });

  test('the tile does NOT auto-advance — it rests on the store frame until the shopper acts', async ({
    page,
  }) => {
    await stubUploads(page);
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { birthday: { carousel: [CAR1, CAR2] } } } })
    );

    await page.goto('/products.html');

    const media = page.locator('.product-card[data-design-id="birthday"] .product-card__media');
    await expect(media).toHaveClass(/carousel--fade/);
    // Starts on frame 0 (the store image).
    await expect.poll(() => activeFrameIndex(media)).toBe(0);

    // Wait well past the old 2500ms auto-advance interval with NO interaction —
    // the active frame must not have moved (autoplay is off).
    await page.waitForTimeout(3200);
    expect(await activeFrameIndex(media)).toBe(0);
  });

  test('clicking a dot changes the picture WITHOUT navigating away from the store', async ({
    page,
  }) => {
    await stubUploads(page);
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { birthday: { carousel: [CAR1, CAR2] } } } })
    );

    await page.goto('/products.html');

    const media = page.locator('.product-card[data-design-id="birthday"] .product-card__media');
    const dots = media.locator('.tile-dots .carousel-dot');
    await expect(dots).toHaveCount(3);
    await expect.poll(() => activeFrameIndex(media)).toBe(0);

    // Clicking the 2nd dot advances to frame 1 and does NOT follow the card link.
    await dots.nth(1).click();
    await expect.poll(() => activeFrameIndex(media)).toBe(1);
    await expect(page).toHaveURL(/\/products\.html$/);

    // A different dot jumps straight to that frame — still no navigation.
    await dots.nth(2).click();
    await expect.poll(() => activeFrameIndex(media)).toBe(2);
    await expect(page).toHaveURL(/\/products\.html$/);
  });

  test('tapping the picture still opens the product detail page', async ({ page }) => {
    await stubUploads(page);
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { birthday: { carousel: [CAR1, CAR2] } } } })
    );

    await page.goto('/products.html');

    const media = page.locator('.product-card[data-design-id="birthday"] .product-card__media');
    await expect(media).toHaveClass(/carousel--fade/);
    // The visible (active) store frame is the picture; tapping it navigates.
    await media.locator('[data-testid="product-image"]').click();
    await expect(page).toHaveURL(/\/product\.html\?design=birthday/);
  });

  test('a design WITHOUT carousel pictures stays a single static image (no carousel, no dots)', async ({
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
    // A single-picture tile shows no manual controls.
    await expect(neon.locator('.tile-dots')).toHaveCount(0);
    await expect(neon.locator('.carousel-dot')).toHaveCount(0);
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
