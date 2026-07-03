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

  test('each tile links to the right wizard step for its own design id (fixed skips colour)', async ({
    page,
  }) => {
    await page.goto('/products.html');
    for (const id of DESIGN_IDS) {
      const tile = page.locator(`.tile[data-design-id="${id}"]`);
      // Fixed-colour designs (neon) skip the colour step → step 3; sliders → step 2.
      const step = id === 'neon' ? 3 : 2;
      await expect(tile).toHaveAttribute('href', `options.html?design=${id}&step=${step}`);
    }
  });

  test('the footer WhatsApp link resolves to a real wa.me URL (not "#")', async ({ page }) => {
    await page.goto('/products.html');
    const wa = page.locator('footer #waLink');
    await expect(wa).toHaveAttribute('href', /^https:\/\/wa\.me\/\d+$/);
    // The other footer contact links are correct too.
    await expect(page.locator('footer a[href="tel:+972546577715"]')).toHaveCount(1);
    await expect(page.locator('footer a[href="mailto:dugri.israel@gmail.com"]')).toHaveCount(1);
    await expect(page.locator('footer #igLink')).toHaveAttribute(
      'href',
      'https://instagram.com/dugri_israel'
    );
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

  test('clicking the neon (fixed) tile skips the empty colour step and lands on step 3 (add-ons)', async ({
    page,
  }) => {
    await page.goto('/products.html');
    await page.locator('.tile[data-design-id="neon"]').click();

    // Fixed design → deep-links past the colour step straight to add-ons.
    await page.waitForURL(/options\.html\?design=neon&step=3/);
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('3');
    // The colour step (which has nothing to pick for neon) is NOT the active screen.
    await expect(page.getByTestId('step-2')).toBeHidden();
    await expect(page.getByTestId('color-list')).toBeHidden();
    // The chosen design carried through and the add-ons step renders normally.
    await expect(page.locator('.design[data-design-id="neon"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.getByTestId('chasers-card')).toBeVisible();
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
