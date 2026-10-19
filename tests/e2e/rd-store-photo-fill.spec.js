import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';
import { previewRedesign } from './helpers/redesign.js';

// THE STORE CARD'S PHOTO FILLS ITS FRAME in redesign mode (the owner, 2026-10-19). Her store photos are 5:4 and the
// frame was the A4 sheet's 1.414, so each photo stood between two white bands. In the mode the frame is 5:4 and an
// uploaded photo covers it; a shipped render (an A4 sheet of 8 cards) stays whole. Asserted in pixels: solid red
// fixtures of known shapes, sampled from a screenshot of the frame, so a declared style cannot pass for a painted one.

// ---- a solid PNG of a chosen size and colour (as tests/e2e/picture-letterbox.spec.js) ----
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

const RED = [220, 0, 0];
const STORE_54 = '/content-uploads/aaaaaaaaaaaaaaaa.png'; // the owner's usual photo: 5:4
const STORE_PORTRAIT = '/content-uploads/bbbbbbbbbbbbbbbb.png'; // an odd one: 5:6
const PNGS = {
  [STORE_54]: solidPng(500, 400, RED),
  [STORE_PORTRAIT]: solidPng(400, 480, RED),
  shipped: solidPng(1414, 1000, RED), // an A4 sheet render
};
const isRed = ([r, g, b]) => r > 180 && g < 50 && b < 50;

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
  await page.route('**/api/design-images*', (route) =>
    route.fulfill({
      json: {
        images: {
          birthday: { base: { store: { img: STORE_54 } } },
          bachelorette: { base: { store: { img: STORE_PORTRAIT } } },
        },
      },
    })
  );
  await page.route('**/content-uploads/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    route.fulfill({ contentType: 'image/png', body: PNGS[path] || PNGS[STORE_54] });
  });
  await page.route('**/assets/designs/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: PNGS.shipped })
  );
});

/** The frame's first picture, loaded and painted, sampled near each edge's middle. */
async function edges(page, id) {
  const media = page.locator(`.product-card[data-design-id="${id}"] .product-card__media`);
  await media.scrollIntoViewIfNeeded();
  const img = media.locator('img').first();
  await expect
    .poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0), { timeout: 12_000 })
    .toBe(true);
  await img.evaluate((el) => el.decode().catch(() => {}));
  const box = await media.boundingBox();
  const shot = await media.screenshot();
  const px = await page.evaluate(
    async ({ b64, pts }) => {
      const bmp = await createImageBitmap(
        await (await fetch('data:image/png;base64,' + b64)).blob()
      );
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return pts.map(([fx, fy]) => {
        const d = ctx.getImageData(
          Math.round(fx * (bmp.width - 1)),
          Math.round(fy * (bmp.height - 1)),
          1,
          1
        ).data;
        return [d[0], d[1], d[2]];
      });
    },
    {
      b64: shot.toString('base64'),
      // 3% in from each edge: clear of the frame's rounded corners, well inside any letterbox
      pts: [
        [0.03, 0.5],
        [0.97, 0.5],
        [0.5, 0.03],
        [0.5, 0.97],
        [0.5, 0.5],
      ],
    }
  );
  const [left, right, top, bottom, centre] = px;
  return { left, right, top, bottom, centre, aspect: box.width / box.height };
}

test.describe('redesign store: the photo fills its frame', () => {
  test.beforeEach(async ({ page }) => {
    await previewRedesign(page);
    await page.goto('/products.html');
    await expect(page.getByTestId('store-grid')).toBeVisible();
  });

  test("the frame is the photos' 5:4, and a 5:4 photo fills it to every edge", async ({ page }) => {
    const e = await edges(page, 'birthday');
    expect(e.aspect).toBeGreaterThan(1.22);
    expect(e.aspect).toBeLessThan(1.28);
    for (const side of ['left', 'right', 'top', 'bottom', 'centre'])
      expect(isRed(e[side]), `${side} is the photo, not a band: ${e[side]}`).toBe(true);
  });

  test('an odd-shaped (portrait) photo is cropped to the frame, not banded', async ({ page }) => {
    const e = await edges(page, 'bachelorette');
    for (const side of ['left', 'right', 'top', 'bottom'])
      expect(isRed(e[side]), `${side} is the photo, not a band: ${e[side]}`).toBe(true);
  });

  test('a shipped render (an A4 sheet of cards) stays whole, never cropped', async ({ page }) => {
    const e = await edges(page, 'posttrip');
    // the sheet spans the width and is letterboxed above and below: nothing of it was cut off
    expect(isRed(e.left) && isRed(e.right) && isRed(e.centre)).toBe(true);
    expect(isRed(e.top), `top should be the frame, the whole sheet shown: ${e.top}`).toBe(false);
    expect(isRed(e.bottom), `bottom should be the frame, the whole sheet shown: ${e.bottom}`).toBe(
      false
    );
  });
});

test('the live site keeps the A4 frame', async ({ page }) => {
  await page.goto('/products.html');
  const media = page.locator('.product-card[data-design-id="birthday"] .product-card__media');
  await expect(media).toBeVisible();
  const box = await media.boundingBox();
  expect(box.width / box.height).toBeGreaterThan(1.38);
});
