import { test, expect } from '@playwright/test';

// THE PHOTO HAS TO SURVIVE THE TRIP.
//
// The store (server/content.js: saveImageBytes) keeps PNG/JPEG/WEBP up to 4MB and
// throws on everything else; the pawn route catches that and skips the file. So
// two very ordinary things off a phone used to disappear between "she picked it"
// and "it is on her card":
//
//   * a 12MP photo, which iOS re-encodes for an <input type=file> at 5-10MB, and
//   * a HEIC, which is what the camera writes and which the magic-byte sniff does
//     not recognise at all.
//
// site/js/pawn-cutout.js#shrinkForUpload re-encodes on HER device before a byte is
// sent. This runs it in a real browser — the only place canvas, createImageBitmap
// and toBlob exist — against files with the two shapes that were being lost.
//
// It deliberately does NOT touch the segmenter: the 18MB model lives behind
// getSegmenter() and nothing here calls it, so this stays a fast test of the
// upload preparation alone.

const CAP = 3 * 1024 * 1024; // UPLOAD_SAFE_BYTES, under the server's 4MB

// Make a genuinely large image IN the page: random pixels, so PNG cannot
// compress it away and the result really is over the cap the way a photo is.
const MAKE_BIG = `
  async function big(w, h, type) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 65536) {
      crypto.getRandomValues(img.data.subarray(i, Math.min(i + 65536, img.data.length)));
    }
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return new File([blob], 'big.png', { type: type || 'image/png' });
  }
`;

test.beforeEach(async ({ page }) => {
  // Any page on the origin: the module is imported by URL, not by this page.
  await page.goto('/collect.html');
});

test('an over-cap photo is re-encoded to something the store will keep', async ({ page }) => {
  const out = await page.evaluate(async (makeBig) => {
    eval(makeBig);
    const { shrinkForUpload } = await import('/js/pawn-cutout.js');
    // eslint-disable-next-line no-undef
    const file = await big(1600, 1600);
    const ready = await shrinkForUpload(file);
    return { was: file.size, now: ready.size, type: ready.type };
  }, MAKE_BIG);

  expect(out.was).toBeGreaterThan(CAP); // the thing the server was dropping
  expect(out.now).toBeLessThanOrEqual(CAP); // …and what it now receives instead
  expect(out.type).toBe('image/jpeg');
});

test('a type the store cannot sniff is re-encoded even when it is small', async ({ page }) => {
  // HEIC, as an in-app browser hands it over: the bytes decode fine (browsers
  // sniff content), the TYPE is one saveImageBytes has no branch for. Before this
  // it was uploaded as-is and dropped with a 200 and no message.
  const out = await page.evaluate(async (makeBig) => {
    eval(makeBig);
    const { shrinkForUpload } = await import('/js/pawn-cutout.js');
    // eslint-disable-next-line no-undef
    const file = await big(64, 64, 'image/heic');
    const ready = await shrinkForUpload(file);
    return { was: file.type, wasSize: file.size, type: ready.type, size: ready.size };
  }, MAKE_BIG);

  expect(out.was).toBe('image/heic');
  expect(out.wasSize).toBeLessThan(CAP); // small — so ONLY the type forced this
  expect(out.type).toBe('image/jpeg');
  expect(out.size).toBeGreaterThan(0);
});

test('a photo already small enough is passed through untouched', async ({ page }) => {
  // Re-encoding a file the server would have taken anyway only costs quality.
  const same = await page.evaluate(async (makeBig) => {
    eval(makeBig);
    const { shrinkForUpload } = await import('/js/pawn-cutout.js');
    // eslint-disable-next-line no-undef
    const file = await big(32, 32);
    return (await shrinkForUpload(file)) === file;
  }, MAKE_BIG);
  expect(same).toBe(true);
});
