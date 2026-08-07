import { test, expect } from '@playwright/test';
import { GENERATED } from '../../site/js/designs.generated.js';

// E2E for the PORTRAIT card-structure gallery (docs/card-structure-schema.md).
//
// The deck is moving from landscape A4 sheets of 8 cards to portrait SINGLE cards
// (viewBox "0 0 223.92 312"), so the slide labelled "קלף" becomes an actual card
// instead of a whole sheet. `grapefruit` is the first (today the only) template
// re-exported into that structure. It is NOT a storefront product yet — it has no
// generator theme, so it is deliberately absent from the design catalog — but its
// portrait renders ARE committed at site/assets/designs/grapefruit/, so this spec
// injects it into the catalog and drives the REAL storefront against those real
// files. That is what proves the portrait pipeline end-to-end today; the seven live
// designs are still on the landscape art and must be completely unaffected.
//
// The catalog is a bundled ES module (js/designs.generated.js), so the injection
// happens at the network layer — the page's own designs.js / product.js / gallery
// code all run unmodified.

const PORTRAIT_ID = 'grapefruit';
const GALLERY = `assets/designs/${PORTRAIT_ID}`;

// A REAL, decodable 1×1 PNG so a stubbed override actually loads (a failing <img>
// would fire `error` and be swapped/dropped — the opposite of what we assert).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const PHOTO_OVERRIDE = '/content-uploads/0123456789abcdef.webp';

// The catalog entry grapefruit gets the day the owner promotes it: portrait
// artwork, no board (the board is not part of the 1–9 card set), fixed colours
// (the card art is a raster pattern the colour slider cannot recolor).
const PORTRAIT_DESIGN = {
  anchors: [],
  hasRaster: true,
  recolor: 'fixed',
  accent: '#f4763c',
  portrait: true,
  thumb: `${GALLERY}/gallery-front.webp`,
  thumbs: { front: `${GALLERY}/gallery-front.webp`, back: `${GALLERY}/gallery-back.webp` },
  products: {},
};

// The gallery leads with a design's STORE COVER on both surfaces. Every design the
// shop actually sells ships one (site/assets/designs/<id>/store.webp), but this
// fixture design is deliberately NOT a product yet and only has its two card
// renders committed — so its store slide would 404. Hide that one slot for it, and
// the slides these tests measure are the portrait card renders they are about.
const NO_STORE_COVER = {
  [PORTRAIT_ID]: { base: { store: { onProducts: false, onProduct: false } } },
};

/** Serve the real catalog plus the portrait design. */
function withPortraitDesign(page) {
  const catalog = { ...GENERATED, [PORTRAIT_ID]: PORTRAIT_DESIGN };
  return page.route('**/js/designs.generated.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `export const GENERATED = ${JSON.stringify(catalog)};\n`,
    })
  );
}

// An uploaded template surfaced as an extra product card would perturb the grid
// counts, and a real gallery config would perturb the slide list. Neutralise both.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
  await page.route('**/api/design-images*', (route) =>
    route.fulfill({ json: { images: NO_STORE_COVER } })
  );
});

/** The rendered slide box + the natural size of the picture inside it. */
// The gallery's pictures load lazily — a slide scrolled off the side of the
// carousel has not been fetched (js/lazy-media.js), because `loading="lazy"`
// only defers vertically and every slide but one is clipped sideways. So to
// MEASURE a slide's decoded picture we first have to show it, exactly as a
// shopper would by swiping.
async function showSlide(page, index) {
  await page.evaluate((i) => {
    const track = document.getElementById('galleryTrack');
    const slide = track.querySelectorAll('.pdp-gallery-slide')[i];
    if (slide) slide.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'instant' });
  }, index);
}

async function galleryMetrics(page, index = 0) {
  await showSlide(page, index);
  return page.evaluate((i) => {
    const slide = document.querySelectorAll('.pdp-gallery-slide')[i];
    const img = slide.querySelector('img');
    const r = slide.getBoundingClientRect();
    return {
      boxW: r.width,
      boxH: r.height,
      natW: img.naturalWidth,
      natH: img.naturalHeight,
      // The picture this slide points at, whether or not it has been fetched yet.
      src: img.getAttribute('src') || img.dataset.lazySrc || null,
    };
  }, index);
}

/** The picture a slide points at, fetched or not. */
function slideSrc(slide) {
  return slide.locator('img').evaluate((i) => i.getAttribute('src') || i.dataset.lazySrc || null);
}

test.describe('product.html — a portrait design shows single cards, not sheets', () => {
  test('the card + back slides are real portrait card renders that decode', async ({ page }) => {
    await withPortraitDesign(page);
    await page.goto(`/product.html?design=${PORTRAIT_ID}`);

    const slides = page.locator('#galleryTrack .pdp-gallery-slide:not([data-carousel-clone])');
    // No board and no photo card yet, and this fixture ships no store cover →
    // exactly the two card slides.
    await expect(slides).toHaveCount(2);
    await expect.poll(() => slideSrc(slides.nth(0))).toBe(`${GALLERY}/gallery-front.webp`);
    await expect.poll(() => slideSrc(slides.nth(1))).toBe(`${GALLERY}/gallery-back.webp`);

    // The committed renders must actually decode AND be portrait — if the front
    // render were still the old landscape sheet this flips.
    await expect
      .poll(async () => (await galleryMetrics(page)).natW, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const m = await galleryMetrics(page);
    expect(m.natW).toBeLessThan(m.natH);
    expect(m.natW / m.natH).toBeCloseTo(223.92 / 312, 2);
  });

  test('the picture box is square, so the card is not squeezed into a sliver', async ({ page }) => {
    await withPortraitDesign(page);
    await page.goto(`/product.html?design=${PORTRAIT_ID}`);
    await expect
      .poll(async () => (await galleryMetrics(page)).natW, { timeout: 10_000 })
      .toBeGreaterThan(0);

    const m = await galleryMetrics(page);
    expect(m.boxW / m.boxH).toBeCloseTo(1, 1); // square box

    // object-fit: contain — how much of the box width the card actually occupies.
    // In the LANDSCAPE sheet box (1.41) a 0.72 card would fill only ~51%; the square
    // box gives it ~72%. This is the assertion that catches a regression back to the
    // landscape box.
    const shown = Math.min(m.boxW, m.boxH * (m.natW / m.natH));
    expect(shown / m.boxW).toBeGreaterThan(0.6);
  });

  test('a legacy landscape design keeps its sheet box and slides, unchanged', async ({ page }) => {
    // Same page, NO catalog injection: the seven live designs must behave exactly as
    // they do on main.
    await page.goto('/product.html?design=birthday');
    const slides = page.locator('#galleryTrack .pdp-gallery-slide:not([data-carousel-clone])');
    await expect(slides).toHaveCount(4); // store + front + back + board

    await expect
      .poll(async () => (await galleryMetrics(page)).natW, { timeout: 10_000 })
      .toBeGreaterThan(0);
    // Slide 0 is the store cover; 1 is the sheet. Polled, because showing slide 1
    // is what triggers its lazy fetch — it has to decode before it can be measured.
    await expect
      .poll(async () => (await galleryMetrics(page, 1)).natW, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const m = await galleryMetrics(page, 1);
    expect(m.boxW / m.boxH).toBeCloseTo(841.92 / 595.5, 1); // the landscape sheet box
    expect(m.natW).toBeGreaterThan(m.natH); // still a landscape sheet render
  });
});

test.describe('the photo-card slide', () => {
  test('appears between the cards and the board once a picture exists', async ({ page }) => {
    // The generic Dugri fallback ART has not shipped yet, so no design renders a
    // photo card. The owner can still curate one — which is the same code path the
    // shipped render will take, so this proves the slot end-to-end.
    await withPortraitDesign(page);
    await page.route('**/content-uploads/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG })
    );
    await page.unroute('**/api/design-images*');
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({
        json: {
          images: {
            [PORTRAIT_ID]: {
              base: {
                ...NO_STORE_COVER[PORTRAIT_ID].base,
                photo: { img: PHOTO_OVERRIDE },
              },
            },
          },
        },
      })
    );

    await page.goto(`/product.html?design=${PORTRAIT_ID}`);
    const slides = page.locator('#galleryTrack .pdp-gallery-slide:not([data-carousel-clone])');
    await expect(slides).toHaveCount(3);
    const photo = slides.nth(2);
    await expect.poll(() => slideSrc(photo)).toBe(PHOTO_OVERRIDE);
    // Labelled as the photo card, not as a generic extra picture.
    await expect(photo).toHaveAttribute('data-label', /קלף התמונות/);
  });

  test('is absent for every design as shipped today', async ({ page }) => {
    await page.goto('/product.html?design=birthday');
    const labels = await page
      .locator('#galleryTrack .pdp-gallery-slide:not([data-carousel-clone])')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-label')));
    expect(labels.join(' ')).not.toContain('קלף התמונות');
  });
});

test.describe('products.html — one grid, one tile shape', () => {
  test('tiles stay landscape while the whole catalog is on the legacy artwork', async ({
    page,
  }) => {
    await page.goto('/products.html');
    const media = page.locator('.product-card[data-design-id="birthday"] .product-card__media');
    const box = await media.boundingBox();
    expect(box.width / box.height).toBeCloseTo(841.92 / 595.5, 1);
  });

  test('every tile turns square once any design ships portrait cards', async ({ page }) => {
    // Uniformity is the point: a per-card aspect would leave captions at different
    // heights across a row, so the shape follows the catalog, not the individual card.
    await withPortraitDesign(page);
    await page.goto('/products.html');
    await expect(page.locator(`.product-card[data-design-id="${PORTRAIT_ID}"]`)).toBeVisible();

    for (const id of [PORTRAIT_ID, 'birthday']) {
      const box = await page
        .locator(`.product-card[data-design-id="${id}"] .product-card__media`)
        .boundingBox();
      expect(box.width / box.height, `${id} tile aspect`).toBeCloseTo(1, 1);
    }
  });
});
