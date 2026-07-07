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
    const cards = rail.locator('a.pdp-rel-card');
    await expect(cards).toHaveCount(7);

    const hrefs = await cards.evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    for (const href of hrefs) expect(href).toMatch(/^product\.html\?design=[a-z]+$/);
    for (const id of DESIGN_IDS) {
      expect(hrefs).toContain(`product.html?design=${id}`);
    }

    // The current design is marked in its own rail card.
    await expect(rail.locator('.pdp-rel-card[aria-current="true"]')).toHaveCount(1);

    // Clicking a related card navigates to that design's detail page.
    await page.locator('.pdp-rel-card[href="product.html?design=birthday"]').click();
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
});
