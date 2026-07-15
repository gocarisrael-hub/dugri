import { test, expect } from '@playwright/test';

// E2E for the owner's per-design image overrides (server/design-images.js +
// GET /api/design-images, consumed by products.html + js/product.js). Overrides
// are mocked at the NETWORK layer so the tests never write real data. A minimal
// PNG stands in for the (non-existent) uploaded files so the <img>s can load.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const STORE_OVERRIDE = '/content-uploads/0123456789abcdef.webp';
const BOARD_OVERRIDE = '/content-uploads/fedcba9876543210.webp';

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
});
