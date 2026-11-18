import { test, expect } from '@playwright/test';

// The shop shows an uploaded design through a WebP ladder of its template pictures, not the template SVG.
//
// An uploaded design's picture is its template's filled SVG (/api/template-image/<slug>/<slot>): a Canva export with
// its photos embedded, 3 MB for one card on production. server/template-pics.js rasterizes the same SVGs and
// /api/custom-designs hands the ladder over as `pics`; every surface takes it through srcsetFor (js/design-images.js),
// with the SVG kept as the `src` behind it. These pin that the shop grid and the product page fetch the ladder and
// never the SVG, and that a design with no ladder yet still shows its SVG.
//
// The network is stubbed: no real template, no render.

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 139"><rect width="100" height="139" fill="#eee"/></svg>';
// a real 40x56 WebP
const WEBP = Buffer.from(
  'UklGRk4AAABXRUJQVlA4IEIAAACwAwCdASooADgAPtForlIoJaQioqgBABoJZwDRNoAAFRpjpDYzEAD+5AF/6uxPhQgn/xbn66b1Xf3F8hIuCqwsAAA=',
  'base64'
);
const REV = '0123456789abcdef';
const ladder = (role, widths) => ({
  src: `/template-pics/my-custom/${REV}/${role}-${widths[0]}.webp`,
  srcset: widths.map((w) => `/template-pics/my-custom/${REV}/${role}-${w}.webp ${w}w`).join(', '),
});
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
const WITH_PICS = {
  ...CUSTOM,
  pics: {
    front: ladder('front', [400, 800, 1200]),
    back: ladder('back', [400, 800, 1200]),
    board: ladder('board', [800, 1400, 2000]),
  },
};

async function stub(page, design) {
  const asked = { svg: [], pics: [] };
  await page.route('**/api/custom-designs', (route) =>
    route.fulfill({ json: { designs: [design] } })
  );
  await page.route('**/api/template-image/**', (route) => {
    asked.svg.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
  });
  await page.route('**/template-pics/**', (route) => {
    asked.pics.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'image/webp', body: WEBP });
  });
  await page.route('**/api/design-names', (route) => route.fulfill({ json: { names: {} } }));
  await page.route('**/api/design-images', (route) => route.fulfill({ json: { images: {} } }));
  return asked;
}

// the picture an <img> actually painted, once it has
async function painted(img) {
  await expect.poll(() => img.evaluate((e) => e.complete && e.naturalWidth > 0)).toBe(true);
  return img.evaluate((e) => new URL(e.currentSrc).pathname);
}

test.use({ viewport: { width: 390, height: 844 } });

test('the shop grid paints an uploaded design from its WebP ladder, never its SVG', async ({
  page,
}) => {
  const asked = await stub(page, WITH_PICS);
  await page.goto('/products.html');
  const card = page.locator('.product-card[data-design-id="my-custom"]');
  await card.scrollIntoViewIfNeeded();
  const img = card.locator('img[data-testid="product-image"]');
  // a phone's two-column tile takes a middle rung, not the top one
  expect(await painted(img)).toMatch(
    /^\/template-pics\/my-custom\/[a-f0-9]{16}\/front-(400|800)\.webp$/
  );
  expect(await img.getAttribute('src')).toBe('/api/template-image/my-custom/front'); // the fallback behind it
  expect(asked.svg).toEqual([]);
});

test('the product page paints the ladder too', async ({ page }) => {
  const asked = await stub(page, WITH_PICS);
  await page.goto('/product.html?design=my-custom');
  const img = page.locator('[data-testid="pdp-gallery"] img').first();
  expect(await painted(img)).toMatch(/^\/template-pics\/my-custom\/[a-f0-9]{16}\/front-\d+\.webp$/);
  expect(asked.svg.filter((p) => p.endsWith('/front'))).toEqual([]);
});

test('a design with no ladder yet still shows its template SVG', async ({ page }) => {
  const asked = await stub(page, CUSTOM);
  await page.goto('/products.html');
  const card = page.locator('.product-card[data-design-id="my-custom"]');
  await card.scrollIntoViewIfNeeded();
  expect(await painted(card.locator('img[data-testid="product-image"]'))).toBe(
    '/api/template-image/my-custom/front'
  );
  expect(asked.pics).toEqual([]);
});
