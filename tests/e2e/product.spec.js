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
    // The now-price is an anchor: "from ₪79" (מ-79) with the crossed-out was.
    await expect(page.locator('#pdpPriceNow')).toContainText('מ-79 ₪');
    await expect(page.locator('#pdpPriceWas')).toContainText('129 ₪');

    // Buy now carries the chosen design into the order flow and jumps straight
    // to the colour + add-ons step (step 2).
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
    // neon is a fixed-colour design, but colour + add-ons are one step now, so it
    // lands on the same step 2 as every other design.
    await page.goto('/product.html?design=neon');
    await expect(page.getByTestId('pdp-buy')).toHaveAttribute(
      'href',
      'options.html?design=neon&step=2'
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

  test('the header menu links to the timer page', async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    const link = page.getByTestId('nav-menu').locator('a[href="timer.html"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText('טיימר');
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

  test('the title and price keep a comfortable gutter from the screen edge (mobile)', async ({
    page,
  }) => {
    // Regression: .pdp used the padding shorthand and zeroed the horizontal
    // gutter that .wrap provides, so the title + price sat flush against the
    // (leading, RTL-right) screen edge on phones. They must stay inset.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/product.html?design=bachelorette');

    const vw = 390;
    const MIN_GUTTER = 16; // comfortably inside the intended 26px gutter

    for (const sel of ['#pdpTitle', '#pdpPriceNow']) {
      const box = await page.locator(sel).boundingBox();
      expect(box, `${sel} should have a bounding box`).not.toBeNull();
      // Inset from both the left edge and the (RTL leading) right edge.
      expect(box.x, `${sel} left gap`).toBeGreaterThanOrEqual(MIN_GUTTER);
      expect(vw - (box.x + box.width), `${sel} right gap`).toBeGreaterThanOrEqual(MIN_GUTTER);
    }
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

  // Item 4: the enlarge icon lives in the PHYSICAL top-left corner of the gallery.
  // The page is dir="rtl", so this asserts the real rendered geometry (not a
  // logical inset that could land on the opposite side). Runs on every device
  // project (Desktop Chrome + iPhone 14 + Pixel 7).
  test('the enlarge icon sits in the physical top-left of the gallery (RTL)', async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    const gallery = page.getByTestId('pdp-gallery');
    const btn = page.getByTestId('gallery-enlarge');
    await expect(btn).toBeVisible();
    const g = await gallery.boundingBox();
    const b = await btn.boundingBox();
    expect(g).not.toBeNull();
    expect(b).not.toBeNull();
    // Near the gallery's LEFT edge…
    expect(b.x - g.x).toBeLessThan(g.width * 0.3);
    // …fully in the left half (never drifting toward the right/leading edge)…
    expect(b.x + b.width).toBeLessThan(g.x + g.width / 2);
    // …and near the TOP edge.
    expect(b.y - g.y).toBeLessThan(60);
  });
});

// A minimal valid PNG (magic bytes) for uploads / stand-in image responses.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test.describe('per-product photo carousel + editable content', () => {
  // Item 3: a product whose owner added photos shows them as the SAME shared
  // carousel the rest of the site uses (dots, swipe, RTL). Overrides are mocked at
  // the network layer so the test never writes real data.
  test('custom photos render as a swipeable carousel with one dot per photo', async ({ page }) => {
    const imgs = [
      '/content-uploads/aaaaaaaaaaaaaaaa.png',
      '/content-uploads/bbbbbbbbbbbbbbbb.webp',
      '/content-uploads/cccccccccccccccc.jpg',
    ];
    await page.route('**/api/content*', (route) =>
      route.fulfill({ json: { overrides: { 'product-bachelorette-photos': { imgs } } } })
    );
    // The uploaded files don't exist on the throwaway server — stand them in.
    await page.route('**/content-uploads/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG })
    );

    await page.goto('/product.html?design=bachelorette');

    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect(slides).toHaveCount(3);
    const srcs = await slides.evaluateAll((els) => els.map((i) => i.getAttribute('src')));
    expect(srcs).toEqual(imgs); // custom photos, in order (not the default renders)
    // Dots: one per photo (the shared carousel look).
    await expect(page.locator('#galleryDots .carousel-dot')).toHaveCount(3);
  });

  test('with NO custom photos the gallery falls back to the default renders', async ({ page }) => {
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
    await page.goto('/product.html?design=bachelorette');
    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect(slides.first()).toBeVisible();
    const srcs = await slides.evaluateAll((els) => els.map((i) => i.getAttribute('src') || ''));
    for (const src of srcs) expect(src).toMatch(/gallery-(front|back|board)\.webp$/);
  });

  // Item 5: the per-design ABOUT text is injected by product.js AFTER the editor's
  // static scan, yet it is editable and posts back under the per-design key.
  test('the per-product ABOUT text is editable and saves under the per-design key', async ({
    page,
  }) => {
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
    let body = null;
    await page.route('**/api/admin/content*', (route) => {
      const req = route.request();
      // The photos/image routes are '/content/photos' & '/content/image'; the text
      // route is exactly '/api/admin/content'. Only capture the text POST.
      if (req.method() === 'POST' && !req.url().includes('/content/')) {
        body = req.postDataJSON();
      }
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto('/product.html?design=bachelorette&edit=1&key=dugri-admin');
    await expect(page.getByText('מצב עריכה')).toBeVisible();

    const about = page.locator('#pdpAbout');
    await expect(about).toHaveAttribute('data-edit', 'product-bachelorette-about');
    await expect(about).toHaveAttribute('contenteditable', /plaintext-only|true/);
    await about.evaluate((n) => {
      n.focus();
      n.textContent = 'תיאור חדש לרווקות';
      n.dispatchEvent(new Event('blur'));
    });

    await expect.poll(() => body).toBeTruthy();
    expect(body).toEqual({
      page: 'product.html',
      key: 'product-bachelorette-about',
      text: 'תיאור חדש לרווקות',
    });
    await expect(page.locator('.dugri-editbar__status')).toHaveText('נשמר');
  });

  test('a saved ABOUT override renders for a normal visitor (per-design)', async ({ page }) => {
    await page.route('**/api/content*', (route) =>
      route.fulfill({
        json: { overrides: { 'product-bachelorette-about': { text: 'תיאור שמור מהבדיקה' } } },
      })
    );
    await page.goto('/product.html?design=bachelorette');
    await expect(page.locator('#pdpAbout')).toHaveText('תיאור שמור מהבדיקה');
    // …and a normal visitor gets NO edit affordances (fail-closed).
    await expect(page.locator('.dugri-editbar')).toHaveCount(0);
  });

  // Item 3 (edit mode): the owner ADDS a photo; it persists and shows to a normal
  // visitor. The server store is simulated by a mutable `saved` array reflected by
  // the mocked GET, so nothing is written to real storage.
  test('in edit mode the owner can ADD a photo; it persists and shows to a visitor', async ({
    page,
  }) => {
    let saved = [];
    const uploaded = '/content-uploads/1234567890abcdef.png';
    await page.route('**/api/content*', (route) =>
      route.fulfill({
        json: {
          overrides: saved.length ? { 'product-bachelorette-photos': { imgs: saved } } : {},
        },
      })
    );
    await page.route('**/content-uploads/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG })
    );
    await page.route('**/api/admin/content/photos*', (route) => {
      if (route.request().method() === 'POST') {
        saved = saved.concat(uploaded);
        return route.fulfill({ json: { ok: true, img: uploaded, imgs: saved } });
      }
      return route.fulfill({ json: { ok: true, imgs: saved } });
    });

    await page.goto('/product.html?design=bachelorette&edit=1&key=dugri-admin');
    await expect(page.getByText('מצב עריכה')).toBeVisible();

    // The photo manager is rendered for the gallery (owner-only).
    const add = page.locator('.dugri-photos__add');
    await expect(add).toBeVisible();

    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), add.click()]);
    await chooser.setFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });

    // The manager lists the new photo and the live carousel rebuilds to show it.
    await expect(page.locator('.dugri-photos__item')).toHaveCount(1);
    const slide = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect(slide).toHaveCount(1);
    await expect(slide.first()).toHaveAttribute('src', uploaded);
    await expect(page.locator('.dugri-editbar__status')).toHaveText('נשמר');

    // A normal visitor (no edit) now sees the persisted photo.
    await page.goto('/product.html?design=bachelorette');
    const visitorSlides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect(visitorSlides).toHaveCount(1);
    await expect(visitorSlides.first()).toHaveAttribute('src', uploaded);
    await expect(page.locator('.dugri-photos')).toHaveCount(0); // no manager for visitors
  });

  test('the owner can REMOVE a photo (reverts to defaults when emptied)', async ({ page }) => {
    let saved = ['/content-uploads/aaaaaaaaaaaaaaaa.png'];
    await page.route('**/api/content*', (route) =>
      route.fulfill({
        json: {
          overrides: saved.length ? { 'product-bachelorette-photos': { imgs: saved } } : {},
        },
      })
    );
    await page.route('**/content-uploads/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG })
    );
    await page.route('**/api/admin/content/photos*', (route) => {
      if (route.request().method() === 'PUT') {
        saved = route.request().postDataJSON().imgs;
        return route.fulfill({ json: { ok: true, imgs: saved } });
      }
      return route.fulfill({ json: { ok: true, imgs: saved } });
    });

    await page.goto('/product.html?design=bachelorette&edit=1&key=dugri-admin');
    await expect(page.getByText('מצב עריכה')).toBeVisible();

    // Starts with one custom photo → one manager item + one carousel slide.
    await expect(page.locator('.dugri-photos__item')).toHaveCount(1);
    await expect(page.locator('#galleryTrack .pdp-gallery-slide img')).toHaveCount(1);

    // Remove it → manager empties and the carousel falls back to the default renders.
    await page.locator('.dugri-photos__del').click();
    await expect(page.locator('.dugri-photos__item')).toHaveCount(0);
    const slides = page.locator('#galleryTrack .pdp-gallery-slide img');
    await expect(async () => {
      const srcs = await slides.evaluateAll((els) => els.map((i) => i.getAttribute('src') || ''));
      expect(srcs.length).toBeGreaterThan(0);
      for (const src of srcs) expect(src).toMatch(/gallery-(front|back|board)\.webp$/);
    }).toPass();
  });
});
