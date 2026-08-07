import { test, expect } from '@playwright/test';

// E2E for the PALE BANDS down the sides of every product picture.
//
// The grid pins every tile to one shape (A4, 1.41 — a legacy card SHEET) and
// painted --surface behind the picture. The owner's photographs are 5:4, so each
// one sat in a tile wider than itself with that shade showing down both sides:
// about 11 px per side, with a hard edge against the photo, on every card.
//
// Her uploads carry BOTH shapes (38 files at 1.25, 31 at 1.41), so no single tile
// shape can fit all of them and some letterboxing is unavoidable. The owner chose
// to keep the uniform tile — captions stay level across a row — and lose the
// PANEL instead: the spare space now reads as plain page rather than a bordered
// box. So these tests pin two things that must hold together, since either one
// alone is a different design:
//   1. no background panel behind the picture, and
//   2. the tile shape stays uniform across the catalog.

const PNG_4x3 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAABiwvbNAAAAaklEQVR4nO3QMQ0AMAzAsPIn3dHoXxKQPHt+9pxrdtsBHzOgMaAxoDGgMaAxoDGgMaAxoDGgMaAxoDGgMaAxoDGgMaAxoDGgMaAxoDGgMaAxoDGgMaAxoDGgMaAxoDGgMaAxoDGgMaB5oNIBSb6f8HcAAAAASUVORK5CYII=',
  'base64'
);
const DESIGN = 'bachelorette';
const A = '/content-uploads/00000000000000b1.webp';

const IMAGES = {
  [DESIGN]: {
    base: {
      store: { img: A },
      front: { img: A },
      back: { img: A },
      photo: { onProducts: false, onProduct: false },
      board: { onProducts: false, onProduct: false },
    },
  },
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
  await page.route('**/api/design-images*', (route) => route.fulfill({ json: { images: IMAGES } }));
  await page.route('**/design-thumb/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG_4x3 })
  );
  await page.route('**/content-uploads/*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG_4x3 })
  );
  await page.setViewportSize({ width: 390, height: 844 });
});

const media = (page) =>
  page.locator(`.product-card[data-design-id="${DESIGN}"] .product-card__media`).first();

test.describe('product pictures sit on the page, not in a bordered box', () => {
  // THE BAND ITSELF. It was the tile's own background showing through the gap,
  // a shade off the page — so the fix is that there is no fill to show.
  test('the tile paints no background panel behind the picture', async ({ page }) => {
    await page.goto('/products.html');
    await expect(media(page)).toBeVisible();
    const bg = await media(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    // Fully transparent: whatever is behind the card shows through instead.
    expect(bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test('every slide is transparent too, not just the frame', async ({ page }) => {
    await page.goto('/products.html');
    const bgs = await page
      .locator(`.product-card[data-design-id="${DESIGN}"] .product-card__slide`)
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
    expect(bgs.length).toBeGreaterThan(0);
    for (const bg of bgs) expect(bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  // The OTHER half of the owner's choice. Dropping the panel only works as a
  // design if the tiles stay uniform — a per-picture tile shape would remove the
  // letterboxing entirely but leave captions at different heights across a row,
  // which is the trade she explicitly did not want.
  test('tiles keep ONE shape across the catalog, so captions stay level', async ({ page }) => {
    await page.goto('/products.html');
    await expect(page.getByTestId('store-grid')).toBeVisible();
    const shapes = await page.locator('.product-card__media').evaluateAll((els) =>
      els.map((e) => {
        const b = e.getBoundingClientRect();
        return +(b.width / b.height).toFixed(2);
      })
    );
    expect(shapes.length).toBeGreaterThan(1);
    expect(new Set(shapes).size).toBe(1);
  });

  // A bare `1fr` floors a column at its content's MIN-CONTENT width, so a name
  // that cannot wrap widens its own column and shrinks its neighbour — which
  // then pushes that card's caption out of line with its row, the very thing the
  // uniform tile exists to protect. Measured on the live catalog at 390px, two
  // tiles in the same row came out 185px and 152px wide.
  //
  // The name has to be FORCED here: the shipped catalog names are short enough
  // that they never trip it, so testing the default page would pass either way
  // and prove nothing.
  test('a long design name cannot widen its own column', async ({ page }) => {
    await page.route('**/api/design-names', (route) =>
      route.fulfill({ json: { names: { [DESIGN]: 'א'.repeat(40) } } })
    );
    await page.goto('/products.html');
    await expect(page.getByTestId('store-grid')).toBeVisible();
    // The long name must actually have landed, or this proves nothing.
    await expect(
      page.locator(`.product-card[data-design-id="${DESIGN}"] .product-name`)
    ).toHaveText('א'.repeat(40));

    const widths = await page
      .locator('.product-card__media')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(widths.length).toBeGreaterThan(1);
    expect(new Set(widths).size).toBe(1);
  });

  // Not cropped: these are photographs OF THE PRODUCT, and filling the tile by
  // cropping would shave ~12% off a board to square up a grid.
  test('the picture is still shown whole, never cropped to fill', async ({ page }) => {
    await page.goto('/products.html');
    const fit = await media(page)
      .locator('img')
      .first()
      .evaluate((el) => getComputedStyle(el).objectFit);
    expect(fit).toBe('contain');
  });
});
