import { test, expect } from '@playwright/test';

// The store (products.html) is now a clean picture-first grid: one card per
// public design, each a single link into that design's detail page
// (product.html?design=<id>). No hero, no "בחרו את העיצוב" chooser, no inline
// carousel/zoom/add-to-cart — that logic moved to the detail page.

// The catalog ships 6 designs (single source of truth: js/designs.js).
const DESIGN_IDS = ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'kids'];

// These tests assert the BUILT-IN catalog grid. A custom design (an uploaded
// template surfaced by /api/custom-designs) would add extra cards — that path is
// covered in custom-designs.spec; stub it out here so the built-in counts stay
// deterministic regardless of which templates the server happens to have.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

// Pin the owner-editable store price so the card-price assertion is hermetic (the
// shared e2e server's settings could be mutated by the admin-pricing spec).
async function stubPricing(page, now = 199, was = 239) {
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        store: { now, was },
        // Sale mode ON: these specs assert the struck was-price, which
        // css/tokens.css hides unless /api/pricing reports a live sale.
        sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
        versions: {
          pdf: { enabled: false, price: 79 },
          pickup: { enabled: true, price: 199 },
          delivery: { enabled: false, price: 199 },
          custom: { enabled: false, price: 599 },
        },
      }),
    })
  );
}

test.describe('store grid (products.html)', () => {
  test('renders exactly one card per design, each linking to its detail page', async ({ page }) => {
    await stubPricing(page);
    await page.goto('/products.html');

    await expect(page.getByTestId('store-grid')).toBeVisible();

    const cards = page.getByTestId('product-card');
    await expect(cards).toHaveCount(6);

    for (const id of DESIGN_IDS) {
      const card = page.locator(`.product-card[data-design-id="${id}"]`);
      await expect(card).toHaveCount(1);
      // Whole card is one link into the detail page for this design.
      await expect(card.locator('[data-testid="product-link"]')).toHaveAttribute(
        'href',
        `product.html?design=${id}`
      );
      // The real store cover photo (deck + board on a table), a name and a price.
      await expect(card.locator('[data-testid="product-image"]')).toHaveAttribute(
        'src',
        /assets\/designs\/.+\/store\.webp$/
      );
      await expect(card.locator('.product-name')).not.toHaveText('');
      await expect(card.locator('.product-price')).toContainText('199 ₪');
    }
  });

  // "טיימס סקוור" (catalog id `neon`) was RETIRED — its artwork is gone, so every
  // order for it 500'd while it was still publicly on sale. The storefront must
  // not offer it, and nothing may still request its deleted assets.
  test('the retired neon design is not on sale and nothing 404s for its assets', async ({
    page,
  }) => {
    await stubPricing(page);
    const missed = [];
    page.on('response', (r) => {
      if (r.status() === 404 || /assets\/designs\/neon\//.test(r.url())) missed.push(r.url());
    });

    await page.goto('/products.html');
    await expect(page.getByTestId('store-grid')).toBeVisible();

    await expect(page.locator('.product-card[data-design-id="neon"]')).toHaveCount(0);
    await expect(page.locator('a[href*="design=neon"]')).toHaveCount(0);
    // no <img> anywhere still points at the deleted directory
    await expect(page.locator('img[src*="assets/designs/neon/"]')).toHaveCount(0);
    expect(missed, `unexpected 404 / neon asset requests: ${missed.join(', ')}`).toEqual([]);
  });

  test('the struck was-price sits to the LEFT of the current price (RTL)', async ({ page }) => {
    await stubPricing(page); // now 199, was 239
    await page.goto('/products.html');

    const price = page.locator('.product-card .product-price').first();
    const now = price.locator('.now');
    const was = price.locator('s');
    await expect(now).toHaveText('מ-199 ₪');
    await expect(was).toHaveText('239');

    const nb = await now.boundingBox();
    const wb = await was.boundingBox();
    // The struck price is fully to the LEFT of the current price.
    expect(wb.x + wb.width).toBeLessThanOrEqual(nb.x + 1);
  });

  test('has exactly one page heading, and it is VISIBLE above the grid', async ({ page }) => {
    await page.goto('/products.html');
    const h1 = page.locator('h1');
    await expect(h1).toHaveCount(1);
    await expect(h1).not.toHaveText('');
    // It used to be visually-hidden and the grid opened cold. The masthead now
    // carries the "write your own title" promise, so it has to actually render.
    await expect(h1).toBeVisible();
  });

  // The store is where a shopper decides a design belongs to somebody else's kind
  // of party. The masthead says otherwise, before the pictures get a chance to.
  test('the masthead says the title is the buyer’s, above the first design', async ({ page }) => {
    await page.goto('/products.html');

    const sub = page.getByTestId('store-sub');
    await expect(sub).toBeVisible();
    await expect(sub).toContainText('כותבים את הכותרת שלכם');

    // Above the grid, not floating somewhere below it.
    const subBox = await sub.boundingBox();
    const gridBox = await page.getByTestId('store-grid').boundingBox();
    expect(subBox.y + subBox.height).toBeLessThanOrEqual(gridBox.y);
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

  test('the header menu links to the timer page', async ({ page }) => {
    await page.goto('/products.html');
    const link = page.getByTestId('nav-menu').locator('a[href="timer.html"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText('טיימר');
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

  // Bug #4: the grid used to be built AFTER `await fetchPricing()`, so a slow or
  // hanging /api/pricing left the whole store blank for up to the 2.5s timeout.
  // It must now paint immediately with launch-default prices and overlay later.
  test('renders the grid immediately even when /api/pricing hangs (no blank store)', async ({
    page,
  }) => {
    // Pricing endpoint never answers — the page must not wait on it.
    await page.route('**/api/pricing', () => {
      /* deliberately left pending */
    });
    await page.goto('/products.html');

    // Cards are visible well before the 2.5s pricing timeout would elapse; the
    // old blocking code would only render at ~2500ms, so a 2000ms bound catches
    // the regression while staying comfortably above instant client render.
    await expect(page.getByTestId('product-card').first()).toBeVisible({ timeout: 2000 });
    await expect(page.getByTestId('product-card')).toHaveCount(6);
    // Shown with the launch-default store price (199 / struck 239), not blank.
    await expect(page.locator('.product-price').first()).toContainText('199 ₪');
  });
});
