import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';

// Regression cover for two step-4 name-preview UX fixes:
//  Bug 1 — preview <img>s were DISTORTED: a raster card forced into the fixed
//          1.414 landscape page box with the default object-fit: fill stretched
//          portrait art. The fix keeps each image's TRUE ratio (object-fit:
//          contain, no forced landscape aspect-ratio on img content).
//  Bug 2 — the inline name preview was NOT swipeable: front/back/board were static
//          side-by-side images whose only interaction opened the fullscreen zoom.
//          The fix makes the inline preview a directly swipeable carousel with dots
//          for desktop, mirroring the zoom's card → back → board order.

// ---- a tiny solid-colour PNG encoder, so we can mint an image of a KNOWN,
// controllable aspect ratio (e.g. portrait 5:7) and assert the rendered box keeps
// that ratio (i.e. it is NOT stretched into the landscape frame). ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(w, h, [r, g, b] = [140, 120, 200]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  // raw scanlines: each row = filter byte (0) + w*3 RGB bytes
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function pngDataUrl(w, h, rgb) {
  return 'data:image/png;base64,' + makePng(w, h, rgb).toString('base64');
}

// a deliberately PORTRAIT card (5:7 ≈ 0.714) — the case the old CSS squished flat.
const PORTRAIT_CARD = pngDataUrl(90, 126);
const PORTRAIT_BACK = pngDataUrl(90, 126, [90, 160, 140]);
const PORTRAIT_BOARD = pngDataUrl(126, 90, [200, 160, 90]); // board is landscape

const FONT_OPTIONS = [
  { label: 'Cafe', file: 'Cafe Regular.ttf' },
  { label: 'Fredoka', file: 'Fredoka-Medium.ttf' },
];

// Intercept /api/preview and return the given views (null = view absent).
function mockPreview(
  page,
  { card = PORTRAIT_CARD, back = PORTRAIT_BACK, board = PORTRAIT_BOARD } = {}
) {
  return page.route('**/api/preview', async (route) => {
    const body = route.request().postDataJSON() || {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        card,
        back,
        board,
        warning: null,
        word_font: body.word_font || null,
        word_font_options: FONT_OPTIONS,
      }),
    });
  });
}

async function toNameStep(page) {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId('design-0').click();
  await page.getByTestId('next-btn').click(); // -> step 2
  await page.getByTestId('next-btn').click(); // -> step 3
  await page.getByTestId('next-btn').click(); // -> step 4 (name)
  await expect(page.getByTestId('step-4')).toBeVisible();
}

test.describe('Bug 1 — name-preview images are not distorted', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'aspect-ratio measurement runs once');
  });

  test('a PORTRAIT card renders at its true ratio (object-fit: contain, not stretched)', async ({
    page,
  }) => {
    await mockPreview(page, { card: PORTRAIT_CARD, back: null, board: null });
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    const card = page.getByTestId('name-preview-card');
    await expect(card).toHaveAttribute('src', /^data:image\/png/);
    // wait for the raster to actually decode so naturalWidth/Height are real
    await expect.poll(() => card.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);

    const m = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        nw: el.naturalWidth,
        nh: el.naturalHeight,
        bw: r.width,
        bh: r.height,
        objectFit: getComputedStyle(el).objectFit,
      };
    });

    // the source really is portrait
    expect(m.nw / m.nh).toBeLessThan(1);
    // object-fit: contain is the mechanism that guarantees no stretch
    expect(m.objectFit).toBe('contain');
    // the RENDERED box keeps the natural ratio (within 3%) — a stretched (fill)
    // image forced into the 1.414 landscape frame would read ~1.41 here, not ~0.71
    const natRatio = m.nw / m.nh;
    const boxRatio = m.bw / m.bh;
    expect(Math.abs(boxRatio - natRatio) / natRatio).toBeLessThan(0.03);
    // and it stays visibly portrait (taller than wide), not squished landscape
    expect(boxRatio).toBeLessThan(1);
  });

  test('the top live-preview panel contains raster art without stretching it', async ({ page }) => {
    // Guards the reported root cause directly: a raster <img> dropped into a
    // preview panel must keep its true ratio (contain), never be filled into the
    // fixed landscape box. We inject a portrait image and read its computed style.
    await page.goto('/options.html?step=1');
    await expect(page.getByTestId('preview-front').locator('svg')).toBeVisible();

    const res = await page.evaluate((src) => {
      return new Promise((resolve) => {
        const panel = document.querySelector('.preview-panel[data-panel="front"]');
        const img = document.createElement('img');
        img.onload = () => {
          const r = img.getBoundingClientRect();
          const cs = getComputedStyle(img);
          resolve({
            objectFit: cs.objectFit,
            nw: img.naturalWidth,
            nh: img.naturalHeight,
            bw: r.width,
            bh: r.height,
          });
        };
        img.onerror = () => resolve(null);
        img.src = src;
        panel.appendChild(img);
      });
    }, PORTRAIT_CARD);

    expect(res).not.toBeNull();
    expect(res.objectFit).toBe('contain');
    // portrait art stays portrait — the old fill+landscape box made it ~1.41 wide
    expect(res.bw / res.bh).toBeLessThan(1);
    expect(Math.abs(res.bw / res.bh - res.nw / res.nh)).toBeLessThan(0.05);
  });
});

test.describe('Bug 2 — the inline name preview is swipeable/navigable', () => {
  // read which dot is active; the active dot mirrors the visible carousel view.
  async function activeView(page) {
    return page.evaluate(() => {
      const sel = document.querySelector('#namePreviewDots .np-dot[aria-selected="true"]');
      return sel ? sel.dataset.npdot : null;
    });
  }
  async function trackIndex(page) {
    return page.evaluate(() => {
      const t = document.getElementById('namePreviewImgs').style.transform || '';
      const mtch = t.match(/-?\d+(?:\.\d+)?/);
      return mtch ? Math.round(Math.abs(parseFloat(mtch[0])) / 100) : 0;
    });
  }
  const swipe = async (page, fromX, toX) => {
    const vp = page.getByTestId('name-preview-viewport');
    await vp.dispatchEvent('pointerdown', { clientX: fromX, clientY: 200 });
    await vp.dispatchEvent('pointerup', { clientX: toX, clientY: 200 });
  };

  test('a horizontal swipe walks card → back → board and back', async ({ page }) => {
    await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview-card')).toBeVisible();

    // dots exist for all three present views; opens on the card
    await expect(page.getByTestId('name-preview-dots')).toBeVisible();
    await expect(page.getByTestId('name-preview-dot-card')).toBeVisible();
    await expect(page.getByTestId('name-preview-dot-back')).toBeVisible();
    await expect(page.getByTestId('name-preview-dot-board')).toBeVisible();
    expect(await activeView(page)).toBe('card');
    expect(await trackIndex(page)).toBe(0);

    // swipe left (LTR track) → back
    await swipe(page, 300, 60);
    await expect.poll(() => activeView(page)).toBe('back');
    expect(await trackIndex(page)).toBe(1);

    // swipe left again → board
    await swipe(page, 300, 60);
    await expect.poll(() => activeView(page)).toBe('board');
    expect(await trackIndex(page)).toBe(2);

    // clamps at the end — another left swipe stays on board
    await swipe(page, 300, 60);
    expect(await activeView(page)).toBe('board');

    // swipe right → back (retreats)
    await swipe(page, 60, 300);
    await expect.poll(() => activeView(page)).toBe('back');
    expect(await trackIndex(page)).toBe(1);
  });

  test('desktop dots navigate without any touch gesture', async ({ page }) => {
    await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview-dot-board')).toBeVisible();

    await page.getByTestId('name-preview-dot-board').click();
    await expect.poll(() => activeView(page)).toBe('board');
    expect(await trackIndex(page)).toBe(2);

    await page.getByTestId('name-preview-dot-card').click();
    await expect.poll(() => activeView(page)).toBe('card');
    expect(await trackIndex(page)).toBe(0);
  });

  test('with no back/board the swipe set is card-only (dots hidden)', async ({ page }) => {
    await mockPreview(page, { card: PORTRAIT_CARD, back: null, board: null });
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview-card')).toBeVisible();

    // only the card view exists → nothing to navigate, dots stay hidden
    await expect(page.getByTestId('name-preview-dots')).toBeHidden();
    await expect(page.getByTestId('name-preview-dot-back')).toHaveCount(0);
    await expect(page.getByTestId('name-preview-dot-board')).toHaveCount(0);
  });

  test('a plain tap (no drag) still opens the fullscreen zoom', async ({ page }) => {
    await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview-card')).toBeVisible();

    const vp = page.getByTestId('name-preview-viewport');
    // a tap = pointerdown + pointerup at (nearly) the same spot
    await vp.dispatchEvent('pointerdown', { clientX: 200, clientY: 200 });
    await vp.dispatchEvent('pointerup', { clientX: 202, clientY: 201 });

    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    await expect(page.locator('#zoomContent img')).toBeVisible();
    // opens on the card view (nothing was swiped)
    await expect(page.getByTestId('zoom-tab-card')).toHaveAttribute('aria-selected', 'true');
  });

  test('tapping after a swipe opens the zoom on the CURRENT view, not the card', async ({
    page,
  }) => {
    await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview-card')).toBeVisible();

    // swipe the inline carousel to the board view
    await swipe(page, 300, 60); // → back
    await swipe(page, 300, 60); // → board
    await expect.poll(() => activeView(page)).toBe('board');

    // tap the viewport → zoom must open on BOARD (the view under the finger)
    const vp = page.getByTestId('name-preview-viewport');
    await vp.dispatchEvent('pointerdown', { clientX: 200, clientY: 200 });
    await vp.dispatchEvent('pointerup', { clientX: 202, clientY: 201 });

    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    await expect(page.getByTestId('zoom-tab-board')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('zoom-tab-card')).toHaveAttribute('aria-selected', 'false');
  });

  test('a tap that slides slightly (below the swipe threshold) still opens the zoom', async ({
    page,
  }) => {
    await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview-card')).toBeVisible();

    const vp = page.getByTestId('name-preview-viewport');
    // ~20px of horizontal slide: not a swipe (< 45px threshold), but it must not
    // fall into a dead zone — it should still register as a tap and open the zoom.
    await vp.dispatchEvent('pointerdown', { clientX: 200, clientY: 200 });
    await vp.dispatchEvent('pointerup', { clientX: 220, clientY: 205 });

    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    // no view change (below swipe threshold) → still the card
    await expect(page.getByTestId('zoom-tab-card')).toHaveAttribute('aria-selected', 'true');
  });
});
