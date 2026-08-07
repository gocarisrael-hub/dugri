import { test, expect } from '@playwright/test';

// E2E for the WEIGHT of the storefront's photographs.
//
// The owner uploads what her camera produced — measured on production, up to
// 3780×3024 and 1.2 MB each — and every storefront surface was serving those
// originals verbatim. /products.html shipped 33 MB across 64 image requests on a
// 390 px phone, and the home page 11 MB, because a card renders its picture into
// a 163 px tile: roughly a hundred times the pixels the screen can show.
//
// Two separate causes, and these tests pin both:
//   1. no downscaled derivative — the grid now asks through a srcset ladder
//      (/design-thumb/<w>/<name>) instead of /content-uploads;
//   2. every carousel slide loading up front — slides 2..n sit beside slide 1
//      inside an overflow:hidden track, where native lazy loading does NOT defer
//      them (the browser measures vertical distance only), so a ten-card grid
//      fetched forty photographs before the shopper had swiped anything.
//
// The last test is the one that decides whether this is safe to ship: a
// derivative that 404s must degrade to the full original, never to a broken tile.

// A REAL, decodable PNG (64×64). An undecodable body fires `error`, which is a
// path under test here, so it must not fire by accident everywhere else.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfbJGYyliH8OITBAtzmrP11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB2OhhtC3NOZwAAAAASUVORK5CYII=',
  'base64'
);
const DESIGN = 'bachelorette';
const A = '/content-uploads/00000000000000a1.webp';
const B = '/content-uploads/00000000000000a2.webp';
const C = '/content-uploads/00000000000000a3.webp';

// A three-slide card of OWNER UPLOADS — the multi-picture card the production
// grid actually renders. The optional slots are hidden explicitly so the slide
// count is exactly three whatever this design happens to ship, which is what lets
// the tests below index slides by position.
const IMAGES = {
  [DESIGN]: {
    base: {
      store: { img: A },
      front: { img: B },
      back: { img: C },
      photo: { onProducts: false, onProduct: false },
      board: { onProducts: false, onProduct: false },
    },
  },
};

function stubDesignImages(page) {
  return page.route('**/api/design-images*', (route) =>
    route.fulfill({ json: { images: IMAGES } })
  );
}

// `serve:false` simulates the resize being impossible (no Python/Pillow on the
// box, an undecodable upload) — the server's honest 404.
function stubThumbs(page, { serve = true, seen } = {}) {
  return page.route('**/design-thumb/**', (route) => {
    if (seen) seen.push(new URL(route.request().url()).pathname);
    return serve
      ? route.fulfill({ contentType: 'image/png', body: PNG })
      : route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
  });
}

function stubUploads(page, seen) {
  return page.route('**/content-uploads/*', (route) => {
    if (seen) seen.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'image/png', body: PNG });
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
  await page.setViewportSize({ width: 390, height: 844 });
});

const card = (page) => page.locator(`.product-card[data-design-id="${DESIGN}"]`);

test.describe('products grid — right-sized photographs', () => {
  test('asks for a derivative ladder, never the full-size upload', async ({ page }) => {
    const thumbs = [];
    const uploads = [];
    await stubThumbs(page, { seen: thumbs });
    await stubUploads(page, uploads);
    await stubDesignImages(page);
    await page.goto('/products.html');

    const first = card(page).locator('img').first();
    await expect(first).toHaveAttribute('srcset', /\/design-thumb\/400\//);

    // Every rung the client advertises, each with its width descriptor.
    const srcset = await first.getAttribute('srcset');
    for (const w of [400, 800, 1200]) {
      expect(srcset).toContain(`/design-thumb/${w}/00000000000000a1.webp ${w}w`);
    }
    // `sizes` is what makes the ladder work at all: without it the browser
    // assumes the full viewport and takes a rung far bigger than a 163px tile.
    await expect(first).toHaveAttribute('sizes', /vw|px/);
    // The original stays on src as the fallback, but must not be FETCHED.
    await expect(first).toHaveAttribute('src', A);

    await expect.poll(() => thumbs.length).toBeGreaterThan(0);
    expect(uploads).toEqual([]);
  });

  test('a card loads ONE picture, not all of its slides', async ({ page }) => {
    await stubThumbs(page);
    await stubUploads(page);
    await stubDesignImages(page);
    await page.goto('/products.html');
    await expect(card(page).locator('img').first()).toHaveAttribute('srcset', /design-thumb/);

    // Every slide still EXISTS — the dots and the swipe depend on the count, so
    // deferring a picture must not defer the slide that holds it …
    const imgs = card(page).locator('.product-card__slide img');
    await expect(imgs).toHaveCount(3);
    // … but only the visible one has been asked for. The rest are parked on
    // data-src, which is what native loading="lazy" could not do for slides
    // clipped HORIZONTALLY rather than vertically.
    expect(await imgs.nth(1).getAttribute('src')).toBe(null);
    expect(await imgs.nth(1).getAttribute('data-src')).toBe(B);
  });

  // The dots and arrows live in a strip BELOW .product-card__media. Hydration
  // bound to the media alone missed the most deliberate "next picture" gesture
  // there is: tapping a dot jumped to a slide whose image was never requested.
  test('tapping a DOT hydrates the slides it jumps to', async ({ page }) => {
    await stubThumbs(page);
    await stubUploads(page);
    await stubDesignImages(page);
    await page.goto('/products.html');
    const imgs = card(page).locator('.product-card__slide img');
    await expect(imgs.first()).toHaveAttribute('srcset', /design-thumb/);
    expect(await imgs.nth(1).getAttribute('src')).toBe(null);

    await card(page).locator('.product-card__dots button').nth(1).click();

    await expect(imgs.nth(1)).toHaveAttribute('src', B);
    await expect
      .poll(() => imgs.nth(1).evaluate((el) => el.complete && el.naturalWidth > 0))
      .toBe(true);
  });

  // A src-less <img> with a non-empty alt PAINTS THE ALT TEXT, so every deferred
  // slide was holding a block of Hebrew ready to flash into view on swipe.
  test('a deferred slide shows no stray alt text, and regains its alt on hydration', async ({
    page,
  }) => {
    await stubThumbs(page);
    await stubUploads(page);
    await stubDesignImages(page);
    await page.goto('/products.html');
    const second = card(page).locator('.product-card__slide img').nth(1);
    await expect(second).toHaveAttribute('alt', '');

    await card(page).locator('.product-card__media').hover();
    await expect(second).not.toHaveAttribute('alt', '');
  });

  test('touching the card hydrates the rest of its slides, through the ladder', async ({
    page,
  }) => {
    await stubThumbs(page);
    await stubUploads(page);
    await stubDesignImages(page);
    await page.goto('/products.html');
    const imgs = card(page).locator('.product-card__slide img');
    await expect(imgs.first()).toHaveAttribute('srcset', /design-thumb/);

    await card(page).locator('.product-card__media').hover();

    await expect(imgs.nth(1)).toHaveAttribute('srcset', /\/design-thumb\/400\//);
    await expect(imgs.nth(1)).toHaveAttribute('src', B);
    expect(await imgs.nth(1).getAttribute('data-src')).toBe(null);
    // …and it really DECODES. Asserting the attributes alone would still pass if
    // the browser deferred the newly-hydrated slide and left the shopper swiping
    // onto a blank frame — the exact failure this feature courts.
    await expect
      .poll(() => imgs.nth(1).evaluate((el) => el.complete && el.naturalWidth > 0))
      .toBe(true);
  });

  // THE SAFETY PROPERTY. A srcset candidate that 404s does not make the browser
  // try `src` on its own — the image simply fails. Derivatives legitimately 404
  // on a box without Pillow, so without this the fix would trade a slow
  // storefront for a broken one.
  test('when no derivative can be produced, it falls back to the full original', async ({
    page,
  }) => {
    const uploads = [];
    await stubThumbs(page, { serve: false });
    await stubUploads(page, uploads);
    await stubDesignImages(page);
    await page.goto('/products.html');

    const first = card(page).locator('img').first();
    // The ladder is dropped and the browser re-selects the original …
    await expect(first).toHaveAttribute('srcset', '');
    await expect(first).toHaveAttribute('src', A);
    // … which is actually fetched, so the shopper sees the owner's real photo.
    await expect.poll(() => uploads).toContain('/content-uploads/00000000000000a1.webp');
    // Heavy, but decoded — not a broken tile.
    await expect.poll(() => first.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
  });
});

// The shopper opens the fullscreen zoom to pinch in on the card's small print —
// the one place on the site where every pixel is the point. Feeding it a 1200 px
// rung and then magnifying 4x hands her a soft image exactly where the old
// behaviour was sharp.
test.describe('fullscreen zoom keeps the full-resolution original', () => {
  test('the zoom overlay loads the upload itself, with no ladder', async ({ page }) => {
    const uploads = [];
    await stubThumbs(page);
    await stubUploads(page, uploads);
    await stubDesignImages(page);
    await page.goto(`/product.html?design=${DESIGN}`);

    const zoomImgs = page.locator('#pdpZoomTrack .pdp-zoom-slide img');
    await expect(zoomImgs.first()).toHaveAttribute('src', A);
    // No srcset at all: the ladder's whole purpose is smaller pixels, which is
    // the opposite of what a zoom needs.
    expect(await zoomImgs.first().getAttribute('srcset')).toBe(null);
    await expect.poll(() => uploads).toContain('/content-uploads/00000000000000a1.webp');

    // …while the INLINE gallery on the same page still uses the ladder.
    await expect(page.locator('#galleryTrack .pdp-gallery-slide img').first()).toHaveAttribute(
      'srcset',
      /design-thumb/
    );
  });
});

test.describe('home rail — right-sized photographs', () => {
  test('the rail cover goes through the ladder too', async ({ page }) => {
    const uploads = [];
    await stubThumbs(page);
    await stubUploads(page, uploads);
    await stubDesignImages(page);
    await page.goto('/');

    const img = page.locator(`.home-prod-card[data-design-id="${DESIGN}"] img`).first();
    await expect(img).toHaveAttribute('srcset', /\/design-thumb\/400\//);
    await expect(img).toHaveAttribute('sizes', '260px');
    expect(uploads).toEqual([]);
  });
});
