import { test, expect } from '@playwright/test';

// Templates gallery (products.html): a shoppable grid of every design, built
// from js/designs.js (single source of truth). Each tile deep-links into the
// order wizard already on the colour step (options.html?design=<id>&step=2).
// Also guards the templates-first funnel: the landing's order CTAs now open
// this page instead of the wizard directly. Runs on every device profile.

// The catalog ships 7 designs; neon is the only FIXED-colour one.
const DESIGN_IDS = ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'neon', 'kids'];

test.describe('templates gallery (products.html)', () => {
  test('renders exactly 7 tiles, each with a name, thumb and price', async ({ page }) => {
    await page.goto('/products.html');

    const tiles = page.getByTestId('tile');
    await expect(tiles).toHaveCount(7);

    // Every tile: a non-empty name, an <img> thumbnail with a real src, and the price line.
    const count = await tiles.count();
    for (let i = 0; i < count; i++) {
      const tile = tiles.nth(i);
      await expect(tile.locator('.tname')).not.toHaveText('');
      const img = tile.locator('.thumb img');
      await expect(img).toHaveAttribute('src', /assets\/designs\/.+\/thumb\.webp$/);
      await expect(tile.locator('.price')).toContainText('החל מ-79 ₪');
    }
  });

  test('slider tiles show many colour dots; the neon (fixed) tile shows the fixed note, not the palette', async ({
    page,
  }) => {
    await page.goto('/products.html');

    // A slider design (bachelorette) renders the full 8-colour palette of dots.
    const slider = page.locator('.tile[data-design-id="bachelorette"]');
    await expect(slider.locator('.dot')).toHaveCount(8);
    await expect(slider.locator('.dots')).toHaveAttribute('aria-label', /8 צבעים/);

    // Neon is FIXED: a single dot + a "fixed colour" note, and NOT the 8-dot palette.
    const neon = page.locator('.tile[data-design-id="neon"]');
    await expect(neon.locator('.dot')).toHaveCount(1);
    await expect(neon.locator('.dots-more')).toHaveText('צבע קבוע');
  });

  test('each tile links to the wizard colour step for its own design id', async ({ page }) => {
    await page.goto('/products.html');
    for (const id of DESIGN_IDS) {
      const tile = page.locator(`.tile[data-design-id="${id}"]`);
      await expect(tile).toHaveAttribute('href', `options.html?design=${id}&step=2`);
    }
  });

  test('clicking a tile lands on the wizard STEP 2 (colour) with that design selected', async ({
    page,
  }) => {
    await page.goto('/products.html');
    await page.locator('.tile[data-design-id="birthday"]').click();

    // Landed in the wizard on the colour step.
    await page.waitForURL(/options\.html\?design=birthday&step=2/);
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('2');
    await expect(page.getByTestId('color-list')).toBeVisible();

    // The chosen design is the selected one in the wizard's design list.
    await expect(page.locator('.design[data-design-id="birthday"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  test('clicking the neon tile lands on step 2 with neon selected and the colour picker hidden', async ({
    page,
  }) => {
    await page.goto('/products.html');
    await page.locator('.tile[data-design-id="neon"]').click();

    await page.waitForURL(/options\.html\?design=neon&step=2/);
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.locator('.design[data-design-id="neon"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // Fixed design => swatch picker hidden, fixed-colour note shown.
    await expect(page.getByTestId('color-list')).toBeHidden();
    await expect(page.getByTestId('raster-note')).toContainText('קבוע');
  });
});

test.describe('templates-first funnel (index.html)', () => {
  test('the landing main order CTAs now point to products.html', async ({ page }) => {
    await page.goto('/index.html');

    // Nav CTA, hero CTA and the final-section CTA all open the templates gallery.
    await expect(page.locator('.nav-cta[data-ga-cta="nav"]')).toHaveAttribute(
      'href',
      'products.html'
    );
    await expect(page.locator('.btn[data-ga-cta="hero"]')).toHaveAttribute('href', 'products.html');
    await expect(page.locator('.btn[data-ga-cta="final"]')).toHaveAttribute(
      'href',
      'products.html'
    );
    // Sticky mobile order button too.
    await expect(page.locator('#stickyOrder')).toHaveAttribute('href', 'products.html');
  });
});
