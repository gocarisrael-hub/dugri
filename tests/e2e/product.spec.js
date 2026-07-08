import { test, expect } from '@playwright/test';

// The per-product detail page (product.html?design=<id>): a swipe photo gallery,
// title + price, the three sections (template description, "מה בפנים", buy now),
// and a related-designs rail at the bottom. It reads ?design=<id> and renders
// from js/designs.js; an unknown/missing id falls back to the first design.

const DESIGN_IDS = ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'neon', 'kids'];

test.describe('product detail page', () => {
  test('renders the gallery, title, price and a buy button into the order flow', async ({
    page,
  }) => {
    await page.goto('/product.html?design=bachelorette');

    await expect(page.getByTestId('pdp-gallery')).toBeVisible();
    await expect(page.locator('#pdpTitle')).not.toHaveText('');
    await expect(page.locator('#pdpPriceNow')).toContainText('79 ₪');

    // Buy now carries the chosen design into the order flow and jumps straight
    // to the colour step (step 2) for recolourable designs.
    const buy = page.getByTestId('pdp-buy');
    await expect(buy).toHaveAttribute('href', 'options.html?design=bachelorette&step=2');
  });

  test('the gallery sources crisp hi-res renders, not the tiny thumb-*.webp', async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    const imgs = page.locator('#galleryTrack img');
    await expect(imgs.first()).toBeVisible();
    const srcs = await imgs.evaluateAll((els) => els.map((i) => i.getAttribute('src') || ''));
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      // Must not point at the tiny picker thumbs (thumb-front/back/board.webp),
      // which upscale blurry full-width. Expect the hi-res gallery renders.
      expect(src).not.toMatch(/thumb-(front|back|board)\.webp$/);
      expect(src).toMatch(/gallery-(front|back|board)\.webp$/);
    }
  });

  test('the buy button reflects whichever design is in the URL', async ({ page }) => {
    // neon is a fixed-colour design (no colour step) → straight to step 3.
    await page.goto('/product.html?design=neon');
    await expect(page.getByTestId('pdp-buy')).toHaveAttribute(
      'href',
      'options.html?design=neon&step=3'
    );
  });

  test('the related rail shows every design and links back to the detail pages', async ({
    page,
  }) => {
    await page.goto('/product.html?design=bachelorette');

    const rail = page.getByTestId('pdp-related');
    // Real cards only — the endless-loop engine adds aria-hidden clones
    // ([data-carousel-clone]) so the rail wraps seamlessly.
    const cards = rail.locator('a.pdp-rel-card:not([data-carousel-clone])');
    await expect(cards).toHaveCount(7);

    const hrefs = await cards.evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    for (const href of hrefs) expect(href).toMatch(/^product\.html\?design=[a-z]+$/);
    for (const id of DESIGN_IDS) {
      expect(hrefs).toContain(`product.html?design=${id}`);
    }

    // The current design is marked in its own rail card.
    await expect(
      rail.locator('.pdp-rel-card[aria-current="true"]:not([data-carousel-clone])')
    ).toHaveCount(1);

    // Clicking a related card navigates to that design's detail page.
    await page
      .locator('.pdp-rel-card[href="product.html?design=birthday"]:not([data-carousel-clone])')
      .click();
    await page.waitForURL(/product\.html\?design=birthday/);
    await expect(page.getByTestId('pdp-buy')).toHaveAttribute(
      'href',
      'options.html?design=birthday&step=2'
    );
  });

  test('an unknown ?design falls back to the first design (no broken page)', async ({ page }) => {
    await page.goto('/product.html?design=does-not-exist');
    await expect(page.getByTestId('pdp-gallery')).toBeVisible();
    // Falls back to the first public design (bachelorette) → colour step (2).
    await expect(page.getByTestId('pdp-buy')).toHaveAttribute(
      'href',
      'options.html?design=bachelorette&step=2'
    );
  });

  test('the shared header order-now opens the store and the menu toggles', async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    await expect(page.getByTestId('order-now')).toHaveAttribute('href', 'products.html');
    const toggle = page.getByTestId('nav-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('the header has a back-to-store control pointing at products.html', async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    const back = page.getByTestId('pdp-back');
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute('href', 'products.html');
  });

  test('the back control returns to the store (history-aware from within the site)', async ({
    page,
  }) => {
    // Arrive at the product page FROM the store, so back should return there.
    await page.goto('/products.html');
    await page.goto('/product.html?design=bachelorette');
    await page.getByTestId('pdp-back').click();
    await page.waitForURL(/\/products\.html$/);
  });

  test('the enlarge button opens a fullscreen overlay with the swipeable images', async ({
    page,
  }) => {
    await page.goto('/product.html?design=bachelorette');

    const overlay = page.getByTestId('pdp-zoom');
    await expect(overlay).toBeHidden();

    // A visible enlarge affordance sits over the gallery.
    const enlarge = page.getByTestId('gallery-enlarge');
    await expect(enlarge).toBeVisible();
    await enlarge.click();

    // Overlay opens with a swipeable track of the SAME gallery images (no dots).
    await expect(overlay).toBeVisible();
    const slides = overlay.locator('.pdp-zoom-slide img');
    await expect(slides.first()).toBeVisible();
    expect(await slides.count()).toBeGreaterThan(1);
    await expect(overlay.locator('.carousel-dots .carousel-dot')).toHaveCount(0);

    // Body scroll is locked while the overlay is open.
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

    // Close via the close control restores the page.
    await page.getByTestId('pdp-zoom-close').click();
    await expect(overlay).toBeHidden();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  });

  test('Esc closes the enlarge overlay', async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    await page.getByTestId('gallery-enlarge').click();
    await expect(page.getByTestId('pdp-zoom')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pdp-zoom')).toBeHidden();
  });
});
