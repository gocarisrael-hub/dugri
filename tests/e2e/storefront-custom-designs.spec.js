import { test, expect } from '@playwright/test';

// EVERY storefront surface must offer EVERY design the shop sells.
//
// The owner's report was that after starting an order and going back she was not
// shown all the templates. The catalogue is assembled in more than one place: the
// store grid (products.html) appends the UPLOADED templates it gets from
// GET /api/custom-designs, but the HOMEPAGE product rail and the product page's
// "more designs" rail were built from the BUNDLED manifest alone — so a template
// the owner had uploaded, priced and put on sale in /products was invisible on the
// page the whole site funnels through, and unreachable from any product page.
//
// These are the SHOP-WINDOW surfaces. The wizard's own design picker
// (options.html step 1) is covered by tests/e2e/custom-designs.spec.js.
//
// Everything is stubbed at the network layer so no real template is needed.

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
    // Keep the owner overlays empty so each design keeps its own name / pictures.
    page.route('**/api/design-names', (route) => route.fulfill({ json: { names: {} } })),
    page.route('**/api/design-images', (route) => route.fulfill({ json: { images: {} } })),
    page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } })),
  ]);
}

// The design ids a rail offers, de-duplicated: the endless-loop engine injects
// aria-hidden CLONES of the cards, which carry the same data-design-id.
function railIds(page, selector) {
  return page.locator(selector).evaluateAll((els) => {
    const seen = [];
    for (const e of els) {
      const id = e.getAttribute('data-design-id');
      if (id && !seen.includes(id)) seen.push(id);
    }
    return seen;
  });
}

test.describe('the homepage rail sells what the store sells', () => {
  test('an uploaded template gets a card on the homepage rail', async ({ page }) => {
    await stubCustom(page);
    await page.goto('/index.html');

    // The REAL card, not one of the endless-loop clones: a clone's position is
    // owned by the loop's recentring, so it is not a thing a test can scroll to.
    const card = page
      .locator('.home-prod-card[data-design-id="my-custom"]:not([data-carousel-clone])')
      .first();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('href', 'product.html?design=my-custom');
    // Its picture is the template's own front (an uploaded template ships no
    // committed store cover), and it actually loads.
    const img = card.locator('img');
    await expect
      .poll(() => img.evaluate((el) => el.getAttribute('src') || el.dataset.lazySrc || null))
      .toBe('/api/template-image/my-custom/front');
    // The rail loads its pictures lazily (js/lazy-media.js) — a card off the side
    // of a horizontal rail is not fetched until it is scrolled to, which is the
    // whole point of the deferral. So drive the rail the way a finger does and
    // require the picture to actually appear.
    //
    // ANY copy of the card counts: this is an endless-loop rail, so the engine
    // recentres the track onto pixel-identical clones whenever it drifts — which
    // is also why scrolling to one specific element and expecting it to stay put
    // does not work here.
    const anyCopyLoaded = () =>
      page
        .locator('.home-prod-card[data-design-id="my-custom"] img')
        .evaluateAll((els) => els.some((e) => e.complete && e.naturalWidth > 0));
    await expect
      .poll(
        async () => {
          await page.evaluate(() => {
            const t = document.getElementById('productsTrack');
            if (t) t.scrollBy({ left: t.clientWidth, behavior: 'instant' });
          });
          return anyCopyLoaded();
        },
        { timeout: 15_000 }
      )
      .toBe(true);
    // The bundled designs are still there — the rail is additive.
    await expect(
      page.locator('.home-prod-card[data-design-id="bachelorette"]').first()
    ).toBeVisible();
  });

  test('the homepage rail offers exactly what /products offers', async ({ page }) => {
    await stubCustom(page);

    await page.goto('/products.html');
    await expect(page.locator('.product-card[data-design-id="my-custom"]')).toBeVisible();
    const store = await railIds(page, '[data-testid="product-card"]');

    await page.goto('/index.html');
    await expect(page.locator('.home-prod-card[data-design-id="my-custom"]').first()).toBeVisible();
    const home = await railIds(page, '.home-prod-card[data-design-id]');

    expect(home.slice().sort()).toEqual(store.slice().sort());
  });

  test('the repainted rail is still a working carousel, and keeps a late rename', async ({
    page,
  }) => {
    // Names resolve BEFORE the custom design does: the repaint must replay the
    // rename onto the new cards rather than reverting the rail to built-in names.
    await page.route('**/api/design-names', (route) =>
      route.fulfill({ json: { names: { bachelorette: 'פריז' } } })
    );
    await page.route('**/api/template-image/**', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: SVG })
    );
    await page.route('**/api/custom-designs', async (route) => {
      await new Promise((r) => setTimeout(r, 400));
      await route.fulfill({ json: { designs: [CUSTOM] } });
    });

    await page.goto('/index.html');
    await expect(page.locator('.home-prod-card[data-design-id="my-custom"]').first()).toBeVisible();

    // The rename survived the repaint.
    const renamed = page.locator('.home-prod-card[data-design-id="bachelorette"]').first();
    await expect(renamed.locator('.home-prod-name')).toHaveText('פריז');

    // Every card is a live carousel slide — the repaint tore the old instance
    // down, so initCarousel actually re-stamped instead of returning early.
    const unstamped = await page.locator('.home-prod-card:not(.carousel-card)').count();
    expect(unstamped).toBe(0);
  });

  test('a failed custom-designs fetch just leaves the bundled rail', async ({ page }) => {
    await page.route('**/api/custom-designs', (route) => route.abort());
    await page.goto('/index.html');
    await expect(
      page.locator('.home-prod-card[data-design-id="bachelorette"]').first()
    ).toBeVisible();
    await expect(page.locator('.home-prod-card[data-design-id="my-custom"]')).toHaveCount(0);
  });
});

test.describe('the product page’s "more designs" rail sells what the store sells', () => {
  test('an uploaded template appears in the rail on a BUILT-IN design’s page', async ({ page }) => {
    await stubCustom(page);
    await page.goto('/product.html?design=bachelorette');

    const rel = page.locator('.pdp-rel-card[data-design-id="my-custom"]').first();
    await expect(rel).toBeVisible();
    await expect(rel).toHaveAttribute('href', 'product.html?design=my-custom');
    await expect(rel.locator('.pdp-rel-name')).toHaveText('עיצוב מותאם');
  });

  test('on the uploaded template’s OWN page the rail includes it, marked current', async ({
    page,
  }) => {
    await stubCustom(page);
    await page.goto('/product.html?design=my-custom');
    await expect(page.locator('#pdpTitle')).toHaveText('עיצוב מותאם');

    const rel = page.locator('.pdp-rel-card[data-design-id="my-custom"]').first();
    await expect(rel).toBeVisible();
    await expect(rel).toHaveAttribute('aria-current', 'true');
    // …and the bundled designs are still offered beside it.
    await expect(
      page.locator('.pdp-rel-card[data-design-id="bachelorette"]').first()
    ).toBeVisible();
  });

  test('the rebuilt rail is a working carousel — every card is a stamped slide', async ({
    page,
  }) => {
    await stubCustom(page);
    await page.goto('/product.html?design=bachelorette');
    await expect(page.locator('.pdp-rel-card[data-design-id="my-custom"]').first()).toBeVisible();

    const unstamped = await page.locator('.pdp-rel-card:not(.carousel-card)').count();
    expect(unstamped).toBe(0);
  });

  test('a failed custom-designs fetch just leaves the bundled rail', async ({ page }) => {
    await page.route('**/api/custom-designs', (route) => route.abort());
    await page.goto('/product.html?design=bachelorette');
    await expect(
      page.locator('.pdp-rel-card[data-design-id="bachelorette"]').first()
    ).toBeVisible();
    await expect(page.locator('.pdp-rel-card[data-design-id="my-custom"]')).toHaveCount(0);
  });
});
