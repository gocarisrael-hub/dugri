import { test, expect } from '@playwright/test';
import { deflateSync } from 'node:zlib';

// WHAT A PHONE ACTUALLY DOWNLOADS to look at the shop.
//
// The owner's gallery uploads are camera files — up to 4032 px and 3.4 MB — and
// every surface paints them into a 100–400 CSS px box. Measured on production at
// 390x844 before this work: /products.html transferred 33 MB of images across 64
// requests before a single tap, because (a) no downscaled derivative existed and
// (b) `loading="lazy"` only defers on VERTICAL distance, so every slide of every
// card's carousel loaded up front even though only one of them is on screen.
//
// These tests assert the OUTCOME — bytes on the wire and requests made — not the
// mechanism. Each one fails if the feature is deleted:
//   • drop the derivative ladder → the grid pulls originals → far over budget
//   • drop the deferral        → four pictures per tile → far over budget
// A test that would still pass with the feature removed is not a test.

// REAL PNGs, encoded here rather than pasted as base64, for two reasons: the
// browser must actually DECODE them (an undecodable stand-in fires `error` and
// sends every picture down the fallback chain, which quietly turns a weight test
// into a fallback test), and the byte size has to be a knob so "did it fetch the
// original?" shows up as WEIGHT rather than as a URL comparison a refactor could
// satisfy by accident.
function crcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC = crcTable();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/**
 * A w x h truecolour PNG. `noisy` decides whether the pixels are incompressible
 * random data or a flat fill, which is what makes the two fixtures below
 * genuinely far apart in WEIGHT rather than merely in dimensions.
 *
 * The noise comes from a seeded xorshift, not an arithmetic pattern: something
 * like `(x * K + y * K2) & 0xff` LOOKS like noise but is a linear ramp that
 * deflate crushes — a 1200x900 "photograph" built that way encodes to 20 KB, and
 * the budget below would have a fraction of the margin it appears to. Seeded, so
 * the fixture is byte-stable across runs.
 */
function png(w, h, noisy) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let p = 0;
  let rng = 0x9e3779b9;
  const next = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return rng & 0xff;
  };
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const v = noisy ? next() : 200;
      raw[p++] = v;
      raw[p++] = noisy ? next() : 180;
      raw[p++] = noisy ? next() : 160;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A camera-sized ORIGINAL — megabytes of photographic detail — and a
// ladder-sized DERIVATIVE, which really is a few KB, exactly as the real ones
// are (measured on the owner's 74 uploads: 5 KB at the 200 rung, 15 KB at 400).
// The gap between them is what every budget below is measuring, so it is pinned
// by its own test rather than assumed.
const HEAVY = png(1200, 900, true);
const SMALL = png(200, 150, false);

const U = (n) => `/content-uploads/${String(n).padStart(16, '0')}.jpg`;

/** A gallery config giving every built-in design FOUR owner photos, plus the
 *  srcset manifest the server publishes alongside it. */
function galleryConfig(ids) {
  const images = {};
  const srcsets = {};
  let n = 1;
  for (const id of ids) {
    const photos = [];
    for (let i = 0; i < 4; i++) {
      const img = U(n++);
      photos.push({ id: `p${i + 1}`, img, name: '', onProducts: true, onProduct: true });
      const file = img.split('/').pop();
      // The shape server/image-thumbs.js emits: rung in the path, descriptor
      // equal to the width that rung produces.
      srcsets[file] = [200, 400, 800, 1200, 1600]
        .map((r) => `/design-img/r1/${r}/${file} ${r}w`)
        .join(', ');
    }
    // Only the owner photos, so every tile's pictures are ours to count.
    images[id] = { photos, order: photos.map((p) => p.id), base: {} };
  }
  return { images, srcsets };
}

const IDS = ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'kids'];

test('the fixtures really are heavy and light (the budget below assumes it)', () => {
  // A budget test is only as good as the gap between the two fixtures. If the
  // "original" ever became small — an arithmetic pattern that deflate crushes,
  // say — every assertion below would keep passing while measuring nothing.
  expect(HEAVY.length).toBeGreaterThan(1_000_000);
  expect(SMALL.length).toBeLessThan(100_000);
});

/** Wire the network: heavy originals, light derivatives, and a byte tally. */
async function instrument(page, { config = galleryConfig(IDS) } = {}) {
  const tally = { originals: 0, derivatives: 0, bytes: 0, urls: [] };
  await page.route('**/api/custom-designs', (r) => r.fulfill({ json: { designs: [] } }));
  await page.route('**/api/design-images*', (r) => r.fulfill({ json: config }));
  await page.route('**/content-uploads/*', (r) => {
    tally.originals++;
    tally.bytes += HEAVY.length;
    tally.urls.push(r.request().url());
    return r.fulfill({ contentType: 'image/png', body: HEAVY });
  });
  await page.route('**/design-img/**', (r) => {
    tally.derivatives++;
    tally.bytes += SMALL.length;
    tally.urls.push(r.request().url());
    return r.fulfill({ contentType: 'image/png', body: SMALL });
  });
  return tally;
}

test.describe('the shop grid downloads one small picture per tile, not four big ones', () => {
  test('the gallery pictures on first paint stay under a byte budget', async ({ page }) => {
    const tally = await instrument(page);
    await page.goto('/products.html');
    await expect(page.locator('[data-testid="product-card"]').first()).toBeVisible();
    // Let anything that was going to load, load.
    await page.waitForTimeout(1500);

    const cards = await page.locator('[data-testid="product-card"]').count();
    expect(cards).toBeGreaterThanOrEqual(6);

    // THE BUDGET. One derivative per tile is ~2 KB, so six tiles is ~12 KB.
    // Losing EITHER half of the fix blows straight past 60 KB: without the
    // deferral it is 4 slides per tile (~48 KB of derivatives, and ~77 MB if the
    // ladder went too), and without the ladder even one picture per tile is
    // 6 x ~3.2 MB. The headroom absorbs the gallery gaining a picture; it does
    // not absorb the feature being removed.
    expect(
      tally.bytes,
      `gallery pictures weighed ${Math.round(tally.bytes / 1024)} KB across ` +
        `${tally.originals} originals + ${tally.derivatives} derivatives:\n` +
        tally.urls.join('\n')
    ).toBeLessThan(60 * 1024);

    // Not one full-size original: the grid asks the ladder for every picture.
    expect(tally.originals, `fetched originals: ${tally.urls.join(', ')}`).toBe(0);
    // …and it asked for at most one picture per tile, not one per slide.
    expect(tally.derivatives, `derivatives:\n${tally.urls.join('\n')}`).toBeLessThanOrEqual(cards);
  });

  test('a slide scrolled off the side is NOT fetched until it is swiped to', async ({ page }) => {
    await instrument(page);
    await page.goto('/products.html');
    const card = page.locator('[data-testid="product-card"]').first();
    await expect(card).toBeVisible();
    await page.waitForTimeout(1000);

    const slides = card.locator('.product-card__slide img');
    expect(await slides.count()).toBeGreaterThan(1);

    // Exactly ONE picture of this tile has been fetched — the one on screen. The
    // other three are clipped sideways, where `loading="lazy"` does not help.
    const loadedBefore = await slides.evaluateAll(
      (els) => els.filter((i) => i.naturalWidth > 0).length
    );
    expect(loadedBefore, 'an off-screen slide was fetched before it was swiped to').toBe(1);

    // Swipe. The next picture must then arrive — deferral must not mean "never".
    await card.locator('.product-card__track').evaluate((t) => {
      t.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      t.scrollBy({ left: t.clientWidth, behavior: 'instant' });
    });
    await expect
      .poll(() => slides.evaluateAll((els) => els.filter((i) => i.naturalWidth > 0).length), {
        timeout: 10_000,
      })
      .toBeGreaterThan(1);
  });

  test('the picture chosen off the ladder fits the tile, not the camera', async ({ page }) => {
    await instrument(page);
    await page.goto('/products.html');
    await expect(page.locator('[data-testid="product-image"]').first()).toBeVisible();
    await page.waitForTimeout(800);

    // `sizes` must be present, or the browser assumes 100vw and takes a rung
    // several times bigger than the box — which would undo most of the saving.
    const chosen = await page
      .locator('[data-testid="product-image"]')
      .first()
      .evaluate((i) => ({ sizes: i.sizes, current: i.currentSrc, box: i.clientWidth }));
    expect(chosen.sizes, 'no sizes attribute — the browser would over-pick').toBeTruthy();
    expect(chosen.current).toContain('/design-img/');
    // The rung it settled on is a small one, appropriate to a ~163 px tile at 2x.
    const rung = Number((chosen.current.match(/\/design-img\/[^/]+\/(\d+)\//) || [])[1]);
    expect(rung, `picked the ${rung}w rung for a ${chosen.box} px box`).toBeLessThanOrEqual(800);
  });
});

test.describe('the product page', () => {
  test('loads one gallery picture, and the zoom overlay costs nothing until opened', async ({
    page,
  }) => {
    const tally = await instrument(page);
    await page.goto('/product.html?design=bachelorette');
    await expect(page.getByTestId('pdp-gallery')).toBeVisible();
    await page.waitForTimeout(1500);

    const atRest = tally.bytes;
    expect(tally.originals, `fetched originals: ${tally.urls.join(', ')}`).toBe(0);
    // The inline gallery and the (hidden) zoom overlay render the SAME four
    // pictures. Loading both tracks eagerly is what an earlier attempt did.
    expect(tally.derivatives, 'more than the on-screen picture was fetched').toBeLessThanOrEqual(2);

    // Opening the zoom must fetch the ONE photo being looked at — not the gallery.
    await page.getByTestId('gallery-enlarge').click();
    await expect(page.getByTestId('pdp-zoom')).toBeVisible();
    await page.waitForTimeout(1500);
    const zoomCost = tally.bytes - atRest;
    expect(
      tally.derivatives - Math.round(atRest / SMALL.length),
      'opening the zoom fetched more than the photo on screen'
    ).toBeLessThanOrEqual(2);
    expect(zoomCost).toBeLessThan(30 * 1024);
  });
});

test.describe('a derivative that cannot be produced never leaves a broken picture', () => {
  // The ladder legitimately 404s (a host without Pillow, an undecodable upload).
  // A failing `srcset` candidate does NOT make the browser fall back to `src` on
  // its own — it just fires `error` — so this has to be handled, including for
  // the loop CLONES that cloneNode never copies a listener onto.
  test('every ladder URL 404ing still shows the picture, via the original', async ({ page }) => {
    const config = galleryConfig(IDS);
    // Give the first design a BASE slot with a shipped fallback, so there is
    // something concrete to degrade to.
    await page.route('**/api/custom-designs', (r) => r.fulfill({ json: { designs: [] } }));
    await page.route('**/api/design-images*', (r) => r.fulfill({ json: config }));
    await page.route('**/design-img/**', (r) => r.fulfill({ status: 404, body: 'Not found' }));
    let originals = 0;
    await page.route('**/content-uploads/*', (r) => {
      originals++;
      return r.fulfill({ contentType: 'image/png', body: SMALL });
    });

    await page.goto('/products.html');
    const first = page.locator('[data-testid="product-image"]').first();
    await expect(first).toBeVisible();

    // The tile must end up showing a REAL, DECODED picture — not a broken icon.
    await expect
      .poll(() => first.evaluate((i) => i.naturalWidth), { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect(originals, 'nothing fell back to the original after the ladder 404d').toBeGreaterThan(0);
    // srcset must have been CLEARED on the fallback; leaving it would have the
    // browser re-resolve straight back to the 404ing candidate.
    expect(await first.evaluate((i) => i.getAttribute('srcset'))).toBeFalsy();
  });
});
