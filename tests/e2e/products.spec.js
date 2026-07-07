import { test, expect } from '@playwright/test';

// The store (products.html) is now a clean picture-first grid: one card per
// public design, each a single link into that design's detail page
// (product.html?design=<id>). No hero, no "בחרו את העיצוב" chooser, no inline
// carousel/zoom/add-to-cart — that logic moved to the detail page.

// The catalog ships 7 designs (single source of truth: js/designs.js).
const DESIGN_IDS = ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'neon', 'kids'];

test.describe('store grid (products.html)', () => {
  test('renders exactly one card per design, each linking to its detail page', async ({ page }) => {
    await page.goto('/products.html');

    await expect(page.getByTestId('store-grid')).toBeVisible();

    const cards = page.getByTestId('product-card');
    await expect(cards).toHaveCount(7);

    for (const id of DESIGN_IDS) {
      const card = page.locator(`.product-card[data-design-id="${id}"]`);
      await expect(card).toHaveCount(1);
      // Whole card is one link into the detail page for this design.
      await expect(card.locator('[data-testid="product-link"]')).toHaveAttribute(
        'href',
        `product.html?design=${id}`
      );
      // A picture (filler thumb until the real cover photo is shot), a name and a price.
      await expect(card.locator('[data-testid="product-image"]')).toHaveAttribute(
        'src',
        /assets\/designs\/.+\/thumb-front\.webp$/
      );
      await expect(card.locator('.product-name')).not.toHaveText('');
      await expect(card.locator('.product-price')).toContainText('79 ₪');
    }
  });

  test('shows only the grid — no hero and no design chooser', async ({ page }) => {
    await page.goto('/products.html');

    const body = await page.locator('body').innerText();
    expect(body).not.toContain('בחרו את העיצוב');
    // Brand rule: never the trademarked word.
    expect(body).not.toContain('אליאס');

    // The old conversion chrome is gone.
    await expect(page.getByTestId('tile-grid')).toHaveCount(0);
    await expect(page.getByTestId('sticky-atc')).toHaveCount(0);
    await expect(page.getByTestId('zoom-overlay')).toHaveCount(0);
    await expect(page.locator('section.hero, #top.hero')).toHaveCount(0);
  });

  test('clicking a card opens that design’s detail page', async ({ page }) => {
    await page.goto('/products.html');
    await page
      .locator('.product-card[data-design-id="birthday"] [data-testid="product-link"]')
      .click();
    await page.waitForURL(/product\.html\?design=birthday/);
    await expect(page.getByTestId('pdp-gallery')).toBeVisible();
  });

  test('the shared header order-now opens the store and the menu toggles', async ({ page }) => {
    await page.goto('/products.html');
    await expect(page.getByTestId('order-now')).toHaveAttribute('href', 'products.html');
    const toggle = page.getByTestId('nav-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('the footer WhatsApp link resolves to a real wa.me URL (not "#")', async ({ page }) => {
    await page.goto('/products.html');
    const wa = page.locator('footer #waLink');
    await expect(wa).toHaveAttribute('href', /^https:\/\/wa\.me\/\d+$/);
    await expect(page.locator('footer a[href="tel:+972546577715"]')).toHaveCount(1);
    await expect(page.locator('footer a[href="mailto:dugri.israel@gmail.com"]')).toHaveCount(1);
    await expect(page.locator('footer #igLink')).toHaveAttribute(
      'href',
      'https://instagram.com/dugri_israel'
    );
  });
});
