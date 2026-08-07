import { test, expect } from '@playwright/test';

// E2E for the DESIGN PICKER TILE on wizard step 1 ("בחרו עיצוב").
//
// The tiles used to show only the shipped build-time thumbnail — a render of the
// design. The owner photographs her real printed decks and uploads those in the
// admin gallery ("תמונות החפיסה"), and asked the tile to lead with the first of
// them: a photo of the actual product beats a render of it.
//
// The constraint the whole feature turns on is WEIGHT. Those uploads are
// 180KB–1MB each and the shipped thumbnails are 5–10KB on purpose, because a
// heavy first screen white-screens the Instagram in-app browser (our main
// audience). So the tile never requests the upload — it requests
// /design-thumb/<name>, a downscaled derivative. These tests assert that
// distinction directly: the picker must never fetch /content-uploads.

// A REAL, decodable PNG (64×64). A 1×1 would "load" but tell us nothing, and an
// undecodable body fires `error` — which is a path under test here, so it must
// not fire by accident everywhere else.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfbJGYyliH8OITBAtzmrP11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB2OhhtC3NOZwAAAAASUVORK5CYII=',
  'base64'
);
const FRONTS = '/content-uploads/00000000000000a1.webp';
const BOARD = '/content-uploads/00000000000000a3.webp';
// A built-in design that SHIPS a thumb.webp, so the fallback under test is real.
const DESIGN = 'bachelorette';

function stubDesignImages(page, images) {
  return page.route('**/api/design-images*', (route) => route.fulfill({ json: { images } }));
}
// The derivative endpoint. `serve:false` simulates the resize being impossible
// (no Python/Pillow on the box, an undecodable upload) — the server's 404.
function stubThumbs(page, { serve = true, seen } = {}) {
  return page.route('**/design-thumb/*', (route) => {
    if (seen) seen.push(new URL(route.request().url()).pathname);
    return serve
      ? route.fulfill({ contentType: 'image/png', body: PNG })
      : route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

// By design id, not by index: the tile's index depends on catalog order.
const tile = (page) => page.locator(`.design[data-design-id="${DESIGN}"]`);
const tileImg = (page) => tile(page).locator('img');

async function gotoPicker(page) {
  await page.goto(`/options.html?design=${DESIGN}&step=1`);
  await expect(tile(page)).toBeVisible();
}

test.describe('wizard step 1 — the design tile shows the deck photo', () => {
  test('the tile uses the FIRST deck picture, through the small-derivative URL', async ({
    page,
  }) => {
    const seen = [];
    const uploads = [];
    await page.route('**/content-uploads/*', (route) => {
      uploads.push(new URL(route.request().url()).pathname);
      return route.fulfill({ contentType: 'image/png', body: PNG });
    });
    await stubThumbs(page, { seen });
    await stubDesignImages(page, { [DESIGN]: { base: { deckFronts: { img: FRONTS } } } });
    await gotoPicker(page);

    await expect(tileImg(page)).toHaveAttribute('src', '/design-thumb/00000000000000a1.webp');
    // Polled, not read once: setting the attribute and the browser actually
    // issuing the request are two different moments.
    await expect.poll(() => seen).toContain('/design-thumb/00000000000000a1.webp');
    // THE POINT OF THE FEATURE: the heavy original is never requested by the
    // picker. Asking for it here would be a ~20× page-weight regression on
    // exactly the screen the shipped 5KB thumbnails exist to protect.
    expect(uploads).toEqual([]);
  });

  test('a design photographed board-first shows its board', async ({ page }) => {
    await stubThumbs(page);
    await stubDesignImages(page, { [DESIGN]: { base: { deckBoard: { img: BOARD } } } });
    await gotoPicker(page);
    await expect(tileImg(page)).toHaveAttribute('src', '/design-thumb/00000000000000a3.webp');
  });

  test('the deck picture actually renders — it is not a broken img', async ({ page }) => {
    await stubThumbs(page);
    await stubDesignImages(page, { [DESIGN]: { base: { deckFronts: { img: FRONTS } } } });
    await gotoPicker(page);
    // 64 is the stubbed derivative's own width, so this asserts the DECK photo
    // decoded — not merely that some picture (the shipped thumb) is on screen.
    await expect
      .poll(() => tileImg(page).evaluate((i) => (i.complete ? i.naturalWidth : 0)))
      .toBe(64);
  });
});

test.describe('wizard step 1 — the tile falls back, always', () => {
  test('NO deck picture → the shipped build-time thumbnail, as before', async ({ page }) => {
    const seen = [];
    await stubThumbs(page, { seen });
    await stubDesignImages(page, {});
    await gotoPicker(page);
    await expect(tileImg(page)).toHaveAttribute('src', /assets\/designs\/.*thumb\.webp$/);
    // Nothing was even asked of the derivative endpoint.
    expect(seen).toEqual([]);
  });

  test('a deck picture whose DERIVATIVE cannot be produced → the shipped thumbnail', async ({
    page,
  }) => {
    // The resize failed server-side (no Python/Pillow, a corrupt upload): the
    // route 404s and the tile steps down the chain. It must NOT step down to the
    // multi-hundred-KB original, and must not leave a torn-image icon.
    const uploads = [];
    await page.route('**/content-uploads/*', (route) => {
      uploads.push(route.request().url());
      return route.fulfill({ contentType: 'image/png', body: PNG });
    });
    await stubThumbs(page, { serve: false });
    await stubDesignImages(page, { [DESIGN]: { base: { deckFronts: { img: FRONTS } } } });
    await gotoPicker(page);

    await expect(tileImg(page)).toHaveAttribute('src', /assets\/designs\/.*thumb\.webp$/);
    await expect
      .poll(() => tileImg(page).evaluate((i) => i.complete && i.naturalWidth > 0))
      .toBe(true);
    expect(uploads).toEqual([]);
    // …and the page still works: the picker is operable and the wizard advances.
    await tile(page).click();
    await expect(tile(page)).toHaveAttribute('aria-pressed', 'true');
  });

  test('no deck picture AND no shipped thumbnail → the design NAME in text', async ({ page }) => {
    await stubThumbs(page);
    await stubDesignImages(page, {});
    // Strip the shipped thumbs so every tile has nothing left to show.
    await page.route('**/assets/designs/**/thumb.webp', (route) =>
      route.fulfill({ status: 404, body: '' })
    );
    await gotoPicker(page);
    await expect(tile(page).locator('.thumb')).toHaveText(/\S/);
    await expect(tile(page).locator('.thumb img')).toHaveCount(0);
  });

  test('a dead /api/design-images leaves every tile exactly as it was', async ({ page }) => {
    const seen = [];
    await stubThumbs(page, { seen });
    await page.route('**/api/design-images*', (route) => route.abort());
    await gotoPicker(page);
    await expect(tileImg(page)).toHaveAttribute('src', /assets\/designs\/.*thumb\.webp$/);
    expect(seen).toEqual([]);
    // …and the picker still works.
    await tile(page).click();
    await expect(tile(page)).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('wizard step 1 — one request for the gallery config', () => {
  // The picker and the deck row on the name step read the SAME map. It is
  // fetched once for the page; a second fetch would be a wasted round trip on
  // the funnel's first screen.
  test('/api/design-images is fetched once for the whole page', async ({ page }) => {
    let calls = 0;
    await stubThumbs(page);
    // The deck row itself renders the ORIGINALS (it shows them full size).
    await page.route('**/content-uploads/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG })
    );
    await page.route('**/api/design-images*', (route) => {
      calls += 1;
      return route.fulfill({
        json: { images: { [DESIGN]: { base: { deckFronts: { img: FRONTS } } } } },
      });
    });
    await page.goto(`/options.html?design=${DESIGN}&step=3`);
    await expect(page.getByTestId('continue-summary')).toBeVisible();
    await expect(page.getByTestId('deck-row')).toBeVisible();
    expect(calls).toBe(1);
  });
});
