import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';

// THE PALE BANDS BESIDE PRODUCT PHOTOS — asserted in PIXELS, on purpose.
//
// The previous attempt at this bug shipped a test that read back
// `getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)'` — i.e. it
// restated the CSS line the same commit had just deleted. That kind of test
// cannot tell "the band is gone" from "the band was never that element's
// background", so it went green over a change that moved zero pixels: the rule
// removed was `background: var(--surface)`, and --surface and --bg are BOTH
// #ffffff, so the letterbox sampled 255,255,255 before and after.
//
// So everything below screenshots the real element and reads real pixels, and
// compares the band against a pixel sampled from the bare page in the SAME
// screenshot. No assertion here can be satisfied by declaring a colour.
//
// What that buys, concretely:
//   * on product.html the gallery and the related-designs thumbs painted
//     --section (#f4efe6 sand) behind a contained photo on a white page — the
//     band sampled 244,239,230 against 255,255,255. Those tests FAIL on the
//     parent commit.
//   * on products.html the band already sampled page-white, so that test PASSES
//     on the parent commit too. It is kept deliberately, as the sentinel that
//     records why nothing in this file claims to have changed that grid.

// ---- a solid PNG of a chosen size and colour ------------------------------
// Generated rather than pasted as base64 so the SHAPE is explicit: the fixture
// has to be much narrower than the 1.41 frames under test, or there would be no
// letterbox to measure and every assertion below would be vacuous.
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(h * (1 + w * 3)); // filter byte 0 per row + RGB
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 1:2 portrait, pure black. Contained in any of the 1.41 frames on these pages it
// paints a black column down the middle with a wide gap either side, so the band
// is unmissable and cannot be confused with the photo.
const PHOTO = solidPng(60, 120, [0, 0, 0]);
const INK = [0, 0, 0];
// The colour that WAS painted: --section, #f4efe6. Named so a regression reads as
// "the sand came back" rather than "some numbers differ".
const SAND = [244, 239, 230];

const NEAR = 3; // per-channel tolerance, for subpixel/AA bleed at the sample points

function close(a, b) {
  return a.every((v, i) => Math.abs(v - b[i]) <= NEAR);
}
const rgb = (p) => `rgb(${p[0]}, ${p[1]}, ${p[2]})`;

/** Decode a PNG buffer inside the page and read the pixels at the given CSS-px
 *  points. Sampling happens in DEVICE pixels (the screenshot is dpr-scaled),
 *  which is why the caller passes CSS coordinates and the scale is applied here —
 *  the two projects run at dpr 1 and dpr 3. */
async function pixelsAt(page, shot, cssPoints) {
  return page.evaluate(
    async ({ b64, cssPoints }) => {
      const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const dpr = window.devicePixelRatio || 1;
      return cssPoints.map(([cx, cy]) => {
        const x = Math.min(bmp.width - 1, Math.max(0, Math.round(cx * dpr)));
        const y = Math.min(bmp.height - 1, Math.max(0, Math.round(cy * dpr)));
        const d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2]];
      });
    },
    { b64: shot.toString('base64'), cssPoints }
  );
}

/** Screenshot the viewport once and return, for `locator`, the pixel in the
 *  letterbox on each side, the pixel at the picture's centre, and a pixel of the
 *  bare page beside it — all from the SAME frame, so "the band matches the page"
 *  is a comparison of two measurements rather than of a measurement and a
 *  constant we chose. */
async function measure(page, locator) {
  const box = await locator.boundingBox();
  expect(box, 'element must be laid out').toBeTruthy();
  const midY = box.y + box.height / 2;
  const shot = await page.screenshot();
  const [left, right, centre, pageBg] = await pixelsAt(page, shot, [
    [box.x + box.width * 0.05, midY],
    [box.x + box.width * 0.95, midY],
    [box.x + box.width * 0.5, midY],
    // 3px in from the viewport edge: the page gutter, outside every content box
    // on both pages at every width these projects run at.
    [3, midY],
  ]);
  return { left, right, centre, pageBg, box };
}

/** measure(), but not until the photo is on screen AND painted.
 *
 *  Both matter, and neither is implied by the element being visible. Several of
 *  these frames are lazy and one (the related rail) sits well below the fold, so
 *  the picture does not even begin loading until it is scrolled to; and an
 *  <img>'s `complete` is true before it has started, so waiting on that alone
 *  lets a screenshot catch a blank frame. Under a full parallel suite that is
 *  exactly what happened, and it tripped the "centre is the photo" guard for a
 *  reason with nothing to do with the band.
 *
 *  So: scroll, wait for real pixels to exist (`naturalWidth`), wait for decode,
 *  then re-sample until the photo is actually painted. The poll is bounded, so a
 *  frame that stays blank still fails — it just fails as a timeout with this
 *  message rather than as a mystery colour mismatch. */
async function bandAndPage(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const img = locator.locator('img').first();
  await expect
    .poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0), {
      message: 'the picture never finished loading',
      // 12s + the 8s below stays clear of the 30s per-test cap, so a real failure
      // surfaces as one of these messages rather than an opaque test timeout.
      timeout: 12_000,
    })
    .toBe(true);
  await img.evaluate((el) => el.decode().catch(() => {}));

  let sample = null;
  await expect
    .poll(
      async () => {
        sample = await measure(page, locator);
        return close(sample.centre, INK);
      },
      { message: 'the picture never appeared in the rendered frame', timeout: 8_000 }
    )
    .toBe(true);
  return sample;
}

/** The whole assertion, in one place: the gap beside the picture is the page. */
function expectNoBand(where, { left, right, centre, pageBg }) {
  // Guard first — if the fixture failed to load, or the frame happened to fit the
  // photo exactly, there IS no letterbox and the band assertions would pass
  // vacuously. Centre must be the photo, the sides must not be.
  expect(close(centre, INK), `${where}: the photo should be painted at the centre`).toBe(true);
  expect(close(left, INK), `${where}: sampled inside the photo, not the letterbox`).toBe(false);

  for (const [side, px] of [
    ['start', left],
    ['end', right],
  ]) {
    expect(
      close(px, SAND),
      `${where}: the ${side} letterbox is still the old --section sand ${rgb(px)}`
    ).toBe(false);
    expect(
      close(px, pageBg),
      `${where}: the ${side} letterbox is ${rgb(px)} but the page beside it is ${rgb(pageBg)}`
    ).toBe(true);
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
  for (const pattern of ['**/design-thumb/**', '**/content-uploads/*', '**/assets/designs/**']) {
    await page.route(pattern, (route) => route.fulfill({ contentType: 'image/png', body: PHOTO }));
  }
});

test.describe('product pictures sit on the page, not on a coloured panel', () => {
  // ---- product.html: the band that was actually visible -------------------
  test('the PDP gallery letterbox is the page, not a sand panel', async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    const gallery = page.getByTestId('pdp-gallery');
    await expect(gallery).toBeVisible();
    expectNoBand('pdp gallery', await bandAndPage(page, gallery));
  });

  // The gallery box and its slides are two stacked painted layers. Clearing only
  // the box leaves the slide's fill still drawing the band, so the slide gets its
  // own measurement rather than being assumed.
  test('the gallery SLIDE paints no panel of its own either', async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    const slide = page.locator('.pdp-gallery-slide').first();
    await expect(slide).toBeVisible();
    expectNoBand('pdp gallery slide', await bandAndPage(page, slide));
  });

  // Same defect, same page, a few hundred pixels lower: the related-designs rail
  // framed its thumbs at 1.41 over the same --section fill.
  test('the related-designs thumbs have no sand band either', async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    const thumb = page.locator('.pdp-rel-thumb').first();
    await expect(thumb).toBeVisible();
    expectNoBand('pdp related thumb', await bandAndPage(page, thumb));
  });

  // ---- products.html: the sentinel ---------------------------------------
  // This one PASSES on the parent commit as well, and that is the finding, not a
  // weakness: on this grid the letterbox was ALREADY page-white, so no CSS change
  // could have removed a band from it. What the owner sees beside her photos here
  // is her own photograph's cream backdrop stopping short of the tile edge — a
  // property of the image files, not of this stylesheet. The test stays to hold
  // the invariant ("the gap is the page") and to stop anyone re-introducing a
  // coloured fill here later.
  test('the products-grid letterbox is the page (and always was)', async ({ page }) => {
    await page.goto('/products.html');
    const media = page.locator('.product-card__media').first();
    await expect(media).toBeVisible();
    expectNoBand('products grid tile', await bandAndPage(page, media));
  });

  // ---- the owner's explicit choice, pinned -------------------------------
  // She chose a uniform tile with captions level across a row over per-photo
  // tiles. Both of these guard that decision against a well-meaning "just make
  // the tile fit the photo" or "just use cover".
  test('tiles keep ONE shape across the catalog, so captions stay level', async ({ page }) => {
    await page.goto('/products.html');
    await expect(page.getByTestId('store-grid')).toBeVisible();
    const shapes = await page.locator('.product-card__media').evaluateAll((els) =>
      els.map((el) => {
        const b = el.getBoundingClientRect();
        return +(b.width / b.height).toFixed(2);
      })
    );
    expect(shapes.length).toBeGreaterThan(1);
    expect(new Set(shapes).size).toBe(1);
  });

  test('the picture is shown whole, never cropped to fill', async ({ page }) => {
    await page.goto('/products.html');
    const fits = await page
      .locator('.product-card__media img, .pdp-gallery-slide img')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).objectFit));
    expect(fits.length).toBeGreaterThan(0);
    for (const fit of fits) expect(fit).toBe('contain');
  });
});

// ---- the caption, which the previous attempt broke -------------------------
// Design names are owner-editable (/api/design-names) and Hebrew rarely offers a
// break opportunity, so a long one arrives as ONE unbreakable token. Two failure
// modes, opposite causes, and a fix for either alone reintroduces the other:
//   * a bare `1fr` floors the column at min-content, so the name widens its own
//     column and starves its neighbour (measured: 249px beside 77px at 390px);
//   * `minmax(0, 1fr)` without a break opportunity lets the name overflow the
//     column instead — over the neighbouring caption, and past ~40 characters
//     past the viewport, so the store scrolls sideways on a phone.
test.describe('a long design name stays inside its own column', () => {
  const NAME = (n) => 'א'.repeat(n);

  async function loadWithName(page, chars) {
    await page.route('**/api/design-names', (route) =>
      route.fulfill({ json: { names: { bachelorette: NAME(chars) } } })
    );
    await page.goto('/products.html');
    await expect(page.getByTestId('store-grid')).toBeVisible();
    // The long name must actually have landed, or everything below proves nothing.
    await expect(
      page.locator('.product-card[data-design-id="bachelorette"] .product-name')
    ).toHaveText(NAME(chars));
  }

  /** Ink boxes (Range rects, not the block box) for every caption, so "overlap"
   *  means glyphs printed over glyphs and not merely adjacent full-width blocks. */
  async function captionInk(page) {
    return page.locator('.product-name').evaluateAll((els) =>
      els.map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const b = range.getBoundingClientRect();
        return { x: b.x, right: b.right, y: Math.round(b.y), bottom: Math.round(b.bottom) };
      })
    );
  }

  test('it does not starve its neighbour: every column keeps the same width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadWithName(page, 24);
    const widths = await page
      .locator('.product-card__media')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
    expect(widths.length).toBeGreaterThan(1);
    expect(new Set(widths), `tile widths were ${widths.join(', ')}`).toHaveProperty('size', 1);
  });

  test('it does not print over the caption beside it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadWithName(page, 24);
    const ink = await captionInk(page);
    expect(ink.length).toBeGreaterThan(1);
    for (let i = 0; i < ink.length; i++) {
      for (let j = i + 1; j < ink.length; j++) {
        const a = ink[i];
        const b = ink[j];
        const sameRow = a.y < b.bottom && b.y < a.bottom;
        if (!sameRow) continue;
        const overlap = Math.min(a.right, b.right) - Math.max(a.x, b.x);
        expect(
          overlap,
          `captions ${i} and ${j} share a row and overlap by ${overlap.toFixed(1)}px`
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  test('it does not make the whole store scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadWithName(page, 40);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
});
