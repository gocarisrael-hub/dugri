import { test, expect } from '@playwright/test';

// Templates gallery (products.html): a shoppable 2-up grid of every design, built
// from js/designs.js (single source of truth). Each tile is a front→back→board
// carousel (lightweight raster thumbs) with an enlarge → fullscreen zoom of the
// full SVG, plus a deep-link CTA into the order wizard
// (options.html?design=<id>&step=<2 slider|3 fixed>). Also guards the
// templates-first funnel. Runs on every device profile.

// The catalog ships 7 designs; neon is the only FIXED-colour one; kids has no board.
const DESIGN_IDS = ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'neon', 'kids'];

test.describe('templates gallery (products.html)', () => {
  test('renders exactly 7 tiles, each with a name, front thumb and price', async ({ page }) => {
    await page.goto('/products.html');

    const tiles = page.getByTestId('tile');
    await expect(tiles).toHaveCount(7);

    // Every tile: a non-empty name, a raster thumbnail (front to start) and the price line.
    const count = await tiles.count();
    for (let i = 0; i < count; i++) {
      const tile = tiles.nth(i);
      await expect(tile.locator('.tname')).not.toHaveText('');
      const img = tile.locator('.thumb img');
      await expect(img).toHaveAttribute('src', /assets\/designs\/.+\/thumb-front\.webp$/);
      await expect(tile.locator('.price')).toContainText('החל מ-79 ₪');
    }
  });

  test('the grid is 2-up (two columns) at a normal phone/desktop width', async ({ page }) => {
    await page.goto('/products.html');
    const cols = await page
      .getByTestId('tile-grid')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    // getComputedStyle resolves the template to concrete pixel tracks — two of them.
    expect(cols.trim().split(/\s+/).length).toBe(2);
  });

  test('slider tiles show many colour dots; the neon (fixed) tile shows the fixed note, not the palette', async ({
    page,
  }) => {
    await page.goto('/products.html');

    // A slider design (bachelorette) renders the full 8-colour palette of dots.
    const slider = page.locator('.tile[data-design-id="bachelorette"]');
    await expect(slider.locator('.dots .dot')).toHaveCount(8);
    await expect(slider.locator('.dots')).toHaveAttribute('aria-label', /8 צבעים/);

    // Neon is FIXED: a single dot + a "fixed colour" note, and NOT the 8-dot palette.
    const neon = page.locator('.tile[data-design-id="neon"]');
    await expect(neon.locator('.dots .dot')).toHaveCount(1);
    await expect(neon.locator('.dots-more')).toHaveText('צבע קבוע');
  });

  test('each tile CTA links to the right wizard step for its own design id (fixed skips colour)', async ({
    page,
  }) => {
    await page.goto('/products.html');
    for (const id of DESIGN_IDS) {
      const tile = page.locator(`.tile[data-design-id="${id}"]`);
      // Fixed-colour designs (neon) skip the colour step → step 3; sliders → step 2.
      const step = id === 'neon' ? 3 : 2;
      await expect(tile.locator('.tile-cta')).toHaveAttribute(
        'href',
        `options.html?design=${id}&step=${step}`
      );
      // The name is a secondary navigating link to the same place.
      await expect(tile.locator('a.tname')).toHaveAttribute(
        'href',
        `options.html?design=${id}&step=${step}`
      );
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

  // ---- per-tile carousel (front → back → board) ----

  test('a tile carousel flips front → back → board via the next arrow', async ({ page }) => {
    await page.goto('/products.html');
    const tile = page.locator('.tile[data-design-id="bachelorette"]');
    const img = tile.locator('.thumb img');
    const next = tile.getByTestId('tile-next');

    await expect(img).toHaveAttribute('src', /thumb-front\.webp$/);
    await next.click();
    await expect(img).toHaveAttribute('src', /thumb-back\.webp$/);
    await next.click();
    await expect(img).toHaveAttribute('src', /thumb-board\.webp$/);
    // three products → three indicator dots
    await expect(tile.getByTestId('car-dot')).toHaveCount(3);
    // flipping the carousel does NOT navigate away from the gallery
    expect(page.url()).toContain('/products.html');
  });

  test('kids has no board: its carousel is front ↔ back only (two dots)', async ({ page }) => {
    await page.goto('/products.html');
    const tile = page.locator('.tile[data-design-id="kids"]');
    const img = tile.locator('.thumb img');
    const next = tile.getByTestId('tile-next');

    await expect(tile.getByTestId('car-dot')).toHaveCount(2);
    await expect(img).toHaveAttribute('src', /thumb-front\.webp$/);
    await next.click();
    await expect(img).toHaveAttribute('src', /thumb-back\.webp$/);
    await next.click(); // wraps back to front — there is no board
    await expect(img).toHaveAttribute('src', /thumb-front\.webp$/);
  });

  // ---- fullscreen enlarge ----

  test('the enlarge button opens a fullscreen overlay with a large SVG; +/ESC zoom and close', async ({
    page,
  }) => {
    await page.goto('/products.html');
    const overlay = page.getByTestId('zoom-overlay');
    await expect(overlay).toBeHidden();

    // birthday's front SVG is a moderate size — enlarge opens the fullscreen view.
    await page.locator('.tile[data-design-id="birthday"]').getByTestId('enlarge').click();
    await expect(overlay).toBeVisible();
    // it renders the actual full SVG (not the raster) at the design's colours
    await expect(page.locator('#zoomContent svg')).toBeVisible();
    // body scroll is locked while open
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

    // + button increases the zoom scale
    await page.getByTestId('zoom-in').click();
    const scale = await page
      .locator('#zoomContent')
      .evaluate((el) => el.style.getPropertyValue('--zoom'));
    expect(parseFloat(scale)).toBeGreaterThan(1);

    // ESC closes and restores the page scroll
    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    // enlarging never navigated away
    expect(page.url()).toContain('/products.html');
  });

  test('tapping the tile image also opens the fullscreen overlay (× closes it)', async ({
    page,
  }) => {
    await page.goto('/products.html');
    const overlay = page.getByTestId('zoom-overlay');

    await page.locator('.tile[data-design-id="birthday"]').getByTestId('tile-image').click();
    await expect(overlay).toBeVisible();
    await expect(page.locator('#zoomContent svg')).toBeVisible();

    await page.getByTestId('zoom-close').click();
    await expect(overlay).toBeHidden();
  });

  test('fullscreen arrows switch product (front/back/board); kids has no board option', async ({
    page,
  }) => {
    await page.goto('/products.html');

    // Slider design with a board: open on front, the segmented control has 3 options.
    await page.locator('.tile[data-design-id="birthday"]').getByTestId('enlarge').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    await expect(page.getByTestId('zoom-seg-front')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('zoom-seg-board')).toBeVisible();

    // the next arrow advances to the back product and reloads its SVG
    await page.getByTestId('zoom-next').click();
    await expect(page.getByTestId('zoom-seg-back')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#zoomContent svg')).toBeVisible();
    // switching product does not navigate
    expect(page.url()).toContain('/products.html');
    await page.keyboard.press('Escape');

    // kids: no board — the segmented control offers only front + back.
    await page.locator('.tile[data-design-id="kids"]').getByTestId('enlarge').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    await expect(page.getByTestId('zoom-seg-front')).toBeVisible();
    await expect(page.getByTestId('zoom-seg-back')).toBeVisible();
    await expect(page.getByTestId('zoom-seg-board')).toHaveCount(0);
  });

  // ---- deep-link CTA still drives the funnel ----

  test('clicking a tile CTA lands on the wizard STEP 2 (colour) with that design selected', async ({
    page,
  }) => {
    await page.goto('/products.html');
    await page.locator('.tile[data-design-id="birthday"] .tile-cta').click();

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

  test('clicking the neon (fixed) tile CTA skips the empty colour step and lands on step 3 (add-ons)', async ({
    page,
  }) => {
    await page.goto('/products.html');
    await page.locator('.tile[data-design-id="neon"] .tile-cta').click();

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

  test('tapping the card body (not a control) navigates into the wizard', async ({ page }) => {
    await page.goto('/products.html');
    // The whole tile is clickable again: tapping a non-control area (the price line)
    // of a slider design proceeds to its colour step — not just the CTA button.
    await page.locator('.tile[data-design-id="bachelorette"] .price').click();
    await page.waitForURL(/options\.html\?design=bachelorette&step=2/);
    await expect(page.getByTestId('step-2')).toBeVisible();
  });

  test('the deep-link CTA carries an accessible name that includes the design', async ({
    page,
  }) => {
    await page.goto('/products.html');
    const tile = page.locator('.tile[data-design-id="bachelorette"]');
    const name = (await tile.locator('.tname').textContent()).trim();
    await expect(tile.locator('.tile-cta')).toHaveAttribute('aria-label', `בחרו עיצוב ${name}`);
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
