import { test, expect } from '@playwright/test';

// E2E for CUSTOM designs — uploaded templates that become storefront products
// (GET /api/custom-designs + GET /api/template-image/:slug/:slot). Mocked at the
// network layer so the tests never touch real templates. A tiny valid SVG stands
// in for each template picture.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#eee"/></svg>';
const CUSTOM = {
  id: 'my-custom',
  name: 'עיצוב מותאם',
  theme: 'my-custom',
  custom: true,
  public: true,
  hasBoard: true,
  img: {
    front: '/api/template-image/my-custom/front',
    back: '/api/template-image/my-custom/back',
    board: '/api/template-image/my-custom/board',
  },
};

function stubCustom(page, designs = [CUSTOM]) {
  return Promise.all([
    page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs } })),
    page.route('**/api/template-image/**', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: SVG })
    ),
    // Keep names/content empty so the custom design keeps its own name.
    page.route('**/api/design-names', (route) => route.fulfill({ json: { names: {} } })),
    page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } })),
  ]);
}

test.describe('products.html — an uploaded template appears as a product', () => {
  test('the custom design gets a card whose pictures are its template SVGs', async ({ page }) => {
    await stubCustom(page);
    await page.goto('/products.html');

    const card = page.locator('.product-card[data-design-id="my-custom"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.product-name')).toHaveText('עיצוב מותאם');
    // Its first picture is the template's front SVG (served by /api/template-image).
    await expect(card.locator('[data-testid="product-image"]')).toHaveAttribute(
      'src',
      '/api/template-image/my-custom/front'
    );
    // 3 pictures (front/back/board) → a multi-slide swipe carousel.
    const slides = card.locator('.product-card__track > .product-card__slide');
    await expect(slides).toHaveCount(3);
    // The card links to the custom design's detail page.
    await expect(card.locator('[data-testid="product-link"]')).toHaveAttribute(
      'href',
      'product.html?design=my-custom'
    );
    // The built-in designs still render too — the grid is additive.
    await expect(page.locator('.product-card[data-design-id="bachelorette"]')).toBeVisible();
  });

  test('a failed custom-designs fetch just leaves the built-in grid', async ({ page }) => {
    await page.route('**/api/custom-designs', (route) => route.abort());
    await page.goto('/products.html');
    await expect(page.getByTestId('store-grid')).toBeVisible();
    await expect(page.locator('.product-card[data-design-id="bachelorette"]')).toBeVisible();
    await expect(page.locator('.product-card[data-design-id="my-custom"]')).toHaveCount(0);
  });
});

test.describe('product.html — a custom design has a working detail page', () => {
  test('resolves the custom design and shows its template SVGs as the gallery', async ({
    page,
  }) => {
    await stubCustom(page);
    await page.goto('/product.html?design=my-custom');

    // First paint falls back to a built-in design; then it switches to the custom one.
    await expect(page.locator('#pdpTitle')).toHaveText('עיצוב מותאם');
    await expect(page).toHaveTitle(/עיצוב מותאם/);

    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect
      .poll(() => slides.evaluateAll((els) => els.map((i) => i.getAttribute('src'))))
      .toEqual([
        '/api/template-image/my-custom/front',
        '/api/template-image/my-custom/back',
        '/api/template-image/my-custom/board',
      ]);
  });
});

// A custom design resolves AFTER first paint, so switchToDesign re-renders a
// gallery that boot() has already wired a carousel onto. initCarousel is
// idempotent: handed a track it has already claimed it returns early, before the
// loop that stamps `carousel-slide` on each slide. Rendering straight into the
// live track therefore left the new slides unstamped inside a track still set to
// display:flex — so instead of one slide per view they all shrank into one row
// and the gallery collapsed to a letterboxed strip of thumbnails.
//
// The race decided whether anyone saw it: /api/design-images arriving LAST
// silently repaired the damage (that path does tear the carousel down), and both
// requests are fired back-to-back, so it was a coin flip per page load — and
// never repaired at all for a custom design with no gallery config.
test.describe('product.html — the gallery survives a late custom-design switch', () => {
  // Force the losing order deterministically: design-images first, custom-designs
  // last. That is the exact sequence the bug needed, and it must now be harmless.
  async function stubLateCustom(page) {
    await page.route('**/api/design-images', (route) => route.fulfill({ json: { images: {} } }));
    await page.route('**/api/template-image/**', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: SVG })
    );
    await page.route('**/api/design-names', (route) => route.fulfill({ json: { names: {} } }));
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
    await page.route('**/api/custom-designs', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ json: { designs: [CUSTOM] } });
    });
  }

  test('every slide is still a carousel slide — one per view, not a squashed row', async ({
    page,
  }) => {
    await stubLateCustom(page);
    await page.goto('/product.html?design=my-custom');
    await expect(page.locator('#pdpTitle')).toHaveText('עיצוב מותאם');

    const slides = page.locator('#galleryTrack > *');
    await expect(slides).toHaveCount(3);
    // The stamp is the fix: without it the slides keep flex's shrinking default.
    for (let i = 0; i < 3; i++) {
      await expect(slides.nth(i)).toHaveClass(/carousel-slide/);
    }
    // …and the observable consequence — each slide fills the track, rather than
    // three of them sharing its width. Asserted on real geometry, because the
    // class is only the mechanism; this is what the shopper actually sees.
    const { slideW, trackW } = await page.evaluate(() => {
      const track = document.getElementById('galleryTrack');
      return {
        slideW: track.children[0].getBoundingClientRect().width,
        trackW: track.getBoundingClientRect().width,
      };
    });
    expect(slideW).toBeGreaterThan(trackW * 0.9);
  });

  test('the fullscreen zoom slides are re-stamped too', async ({ page }) => {
    await stubLateCustom(page);
    await page.goto('/product.html?design=my-custom');
    await expect(page.locator('#pdpTitle')).toHaveText('עיצוב מותאם');

    const zoomSlides = page.locator('#pdpZoomTrack > *');
    await expect(zoomSlides).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(zoomSlides.nth(i)).toHaveClass(/carousel-slide/);
    }
  });
});
