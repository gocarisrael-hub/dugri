import { test, expect } from '@playwright/test';
import { ALL_ON, ALL_OFF, stubFeatures } from './feature-flags.js';

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

// ---------------------------------------------------------------------------
// THE BUY BUTTON MUST NOT SELL A DIFFERENT DESIGN
//
// Reported by the owner: "when I'm in אואזיס and press קנו עכשיו I get to a פריז
// order flow — not the right template." אואזיס is the uploaded template
// `grapefruit`; פריז is `bachelorette`, the FIRST design in the bundled catalog.
//
// The product page was innocent: its CTA is stamped with the resolved design and
// correctly reads options.html?design=grapefruit&step=2. The wizard was the
// culprit — it knew only the bundled catalog, so restore()'s
// `DESIGNS.findIndex(d => d.id === dId)` returned -1 for an uploaded design and
// designIndex was silently LEFT AT 0. The shopper arrived at step 2 of the first
// built-in design's flow and could pay for a product they never chose.
//
// The built-in first design stands in for פריז in these tests; a wrong selection
// is a wrong selection whichever design happens to sit at index 0.
const FIRST_BUILTIN = 'bachelorette';
const HEB_CUSTOM = { ...CUSTOM, language: 'hebrew', extra_fields: [] };

test.describe('options.html — the wizard opens the design the shopper actually clicked', () => {
  test('?design=<uploaded template> selects THAT design, not the first built-in', async ({
    page,
  }) => {
    await stubFeatures(page, ALL_ON);
    await stubCustom(page, [HEB_CUSTOM]);
    await page.goto('/options.html?design=my-custom&step=2');

    const custom = page.locator('.design[data-design-id="my-custom"]');
    // It is offered at all — the wizard used to have no tile for it whatsoever, so
    // the design on sale in the store could not be ordered from the store.
    await expect(custom).toHaveCount(1);
    await expect(custom).toHaveAttribute('aria-pressed', 'true');
    // …and the design the shopper did NOT ask for is not the one selected.
    await expect(page.locator(`.design[data-design-id="${FIRST_BUILTIN}"]`)).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    // The summary chip the shopper reads before paying names the right design.
    await expect(page.locator('#continueSummary')).toContainText('עיצוב מותאם');
  });

  test('it previews the uploaded template’s own artwork, board tab included', async ({ page }) => {
    await stubFeatures(page, ALL_ON);
    await stubCustom(page, [HEB_CUSTOM]);
    await page.goto('/options.html?design=my-custom&step=1');

    // The wizard inlines previews from `products` — a custom design's template
    // pictures are mirrored there, so it renders through the same path as a
    // built-in one instead of showing an empty stage. The stub SVG's viewBox is
    // what pins this to the TEMPLATE's artwork rather than any built-in design's.
    const front = page.locator('[data-panel="front"] svg');
    await expect(front).toHaveCount(1);
    await expect(front).toHaveAttribute('viewBox', '0 0 100 100');
    // This template ships a board, so the board tab is offered.
    await expect(page.locator('.tab[data-tab="board"]')).toBeVisible();
  });

  test('a board-less uploaded template hides the board tab', async ({ page }) => {
    await stubFeatures(page, ALL_ON);
    const noBoard = {
      ...HEB_CUSTOM,
      hasBoard: false,
      img: { front: HEB_CUSTOM.img.front, back: HEB_CUSTOM.img.back },
    };
    await stubCustom(page, [noBoard]);
    await page.goto('/options.html?design=my-custom&step=1');

    await expect(page.locator('.design[data-design-id="my-custom"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.locator('.tab[data-tab="board"]')).toBeHidden();
  });

  // The money assertion: what the SERVER is told to make.
  test('the order it creates carries the uploaded template, not the first built-in', async ({
    page,
  }) => {
    await stubFeatures(page, ALL_OFF);
    await stubCustom(page, [HEB_CUSTOM]);
    const captured = {};
    await page.route('**/api/collections', async (route) => {
      captured.body = route.request().postDataJSON();
      await route.fulfill({ json: { id: 'test-col', owner_token: 'test-tok' } });
    });

    await page.goto('/options.html?design=my-custom&step=1');
    await expect(page.getByTestId('step-1')).toBeVisible();
    await page.getByTestId('next-btn').click(); // -> name step (step 2 is gated off)
    await expect(page.getByTestId('step-3')).toBeVisible();
    await page.fill('#honoreeInput', 'שירה');
    await page.getByTestId('gender-female').check();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'owner@example.com');
    await page.fill('#ownerPhone', '0521234567');
    const create = page.getByTestId('next-btn');
    await expect(create).toBeEnabled();
    await create.click();
    await page.waitForURL(/collect\.html\?c=test-col&k=test-tok/);

    expect(captured.body.design).toBe('עיצוב מותאם');
    // The generator theme has to be the TEMPLATE's — the built-in id→theme map has
    // never heard of an uploaded design, so resolving by id alone sent null and the
    // paid deck would have had no template to render from.
    expect(captured.body.theme).toBe('my-custom');
  });

  test('a design id it still cannot resolve stops at the picker instead of selling another design', async ({
    page,
  }) => {
    await stubFeatures(page, ALL_ON);
    // /api/custom-designs is down: 'my-custom' is unknown to this wizard.
    await page.route('**/api/custom-designs', (route) => route.abort());
    await page.goto('/options.html?design=my-custom&step=2');

    // It must NOT sail past the picker with someone else's design selected.
    await expect(page.getByTestId('step-1')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('1');
  });

  test('a normal built-in ?design= link is unaffected', async ({ page }) => {
    await stubFeatures(page, ALL_ON);
    await stubCustom(page, [HEB_CUSTOM]);
    await page.goto('/options.html?design=japanese&step=2');

    await expect(page.locator('.design[data-design-id="japanese"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.getByTestId('step-2')).toBeVisible();
  });
});

test.describe('product.html — the buy CTA follows the LATE custom-design switch', () => {
  // First paint falls back to a built-in design; the real one only resolves when
  // /api/custom-designs answers. Delay it so that ordering is deterministic, then
  // assert the CTA points at the design the page ended up showing — not at the
  // fallback it was painted from.
  test('#pdpBuy points at the custom design, not the fallback it first painted', async ({
    page,
  }) => {
    await page.route('**/api/template-image/**', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: SVG })
    );
    await page.route('**/api/design-names', (route) => route.fulfill({ json: { names: {} } }));
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
    await page.route('**/api/custom-designs', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ json: { designs: [HEB_CUSTOM] } });
    });

    await page.goto('/product.html?design=my-custom');
    await expect(page.locator('#pdpTitle')).toHaveText('עיצוב מותאם');
    await expect(page.getByTestId('pdp-buy')).toHaveAttribute(
      'href',
      'options.html?design=my-custom&step=2'
    );
  });
});
