import { test, expect } from '@playwright/test';

// The per-design GALLERY admin page (admin-images.html) is behind the admin key.
// To keep the parallel device projects race-free against the shared server, the
// gallery API is MOCKED at the network layer — this spec verifies the admin UI
// wiring (gate, base + photo items, replace/reset, per-surface checkboxes, add
// photo, reorder), not real writes.
const KEY = 'dugri-admin';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const UPLOADED = '/content-uploads/0123456789abcdef.png';

function stubGet(page, images = {}) {
  return page.route('**/api/design-images*', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { images } });
    return route.continue();
  });
}
function stubUploads(page) {
  return page.route('**/content-uploads/*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG })
  );
}

test.describe('admin gallery page', () => {
  test('without a key the page reveals nothing and asks for ?key=', async ({ page }) => {
    let hitAdmin = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/design-images')) hitAdmin = true;
    });
    await page.goto('/admin-images.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    expect(hitAdmin).toBe(false);
  });

  test('offers all four base items for EVERY design (boardless board is empty, uploadable) + default flags', async ({
    page,
  }) => {
    await stubGet(page, {});
    await page.goto(`/admin-images.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    await expect(page.locator('.design')).toHaveCount(7);

    // posttrip ships a board → 4 base items (store/front/back/board).
    const posttripBase = page.locator('.item[data-design="posttrip"][data-type="base"]');
    await expect(posttripBase).toHaveCount(4);
    await expect(page.locator('.item[data-design="posttrip"][data-key="board"]')).toHaveCount(1);

    // kids ships NO board, but the board slot is STILL offered so the owner can
    // upload one (#159). It starts as an empty "upload a board" placeholder.
    await expect(page.locator('.item[data-design="kids"][data-type="base"]')).toHaveCount(4);
    const kidsBoard = page.locator('.item[data-design="kids"][data-key="board"]');
    await expect(kidsBoard).toHaveCount(1);
    await expect(kidsBoard.locator('.preview-empty')).toBeVisible();
    await expect(kidsBoard.locator('button[data-act="upload"]')).toBeVisible();
    await expect(kidsBoard.locator('button[data-act="reset"]')).toBeDisabled();

    // Default flags: the store cover shows on the grid but NOT the product page;
    // the card front shows on both.
    const store = page.locator('.item[data-design="posttrip"][data-key="store"]');
    await expect(store.locator('input[data-flag="onProducts"]')).toBeChecked();
    await expect(store.locator('input[data-flag="onProduct"]')).not.toBeChecked();
    const front = page.locator('.item[data-design="posttrip"][data-key="front"]');
    await expect(front.locator('input[data-flag="onProduct"]')).toBeChecked();

    await expect(page.locator('.nav a.active[data-page="admin-images.html"]')).toHaveCount(1);
  });

  test('replacing a base render flips it to "custom" and enables reset', async ({ page }) => {
    await stubGet(page, {});
    await stubUploads(page);
    await page.route('**/api/admin/design-images/base/image*', (route) =>
      route.fulfill({
        json: { ok: true, img: UPLOADED, gallery: { base: { board: { img: UPLOADED } } } },
      })
    );

    await page.goto(`/admin-images.html?key=${KEY}`);
    const board = page.locator('.item[data-design="posttrip"][data-key="board"]');
    await expect(board.locator('.badge.default')).toBeVisible();
    await expect(board.locator('button[data-act="reset"]')).toBeDisabled();

    await board.locator('input[type=file]').setInputFiles({
      name: 'board.png',
      mimeType: 'image/png',
      buffer: PNG,
    });

    const after = page.locator('.item[data-design="posttrip"][data-key="board"]');
    await expect(after.locator('.badge.custom')).toBeVisible();
    await expect(after.locator('img.preview')).toHaveAttribute('src', UPLOADED);
    await expect(after.locator('button[data-act="reset"]')).toBeEnabled();
  });

  test('#159: uploads a board to a BOARDLESS design (kids) — empty slot flips to custom', async ({
    page,
  }) => {
    await stubGet(page, {});
    await stubUploads(page);
    await page.route('**/api/admin/design-images/base/image*', (route) =>
      route.fulfill({
        json: { ok: true, img: UPLOADED, gallery: { base: { board: { img: UPLOADED } } } },
      })
    );

    await page.goto(`/admin-images.html?key=${KEY}`);
    const board = page.locator('.item[data-design="kids"][data-key="board"]');
    // Boardless: starts empty (no shipped render), reset disabled.
    await expect(board.locator('.preview-empty')).toBeVisible();
    await expect(board.locator('button[data-act="reset"]')).toBeDisabled();

    await board.locator('input[type=file]').setInputFiles({
      name: 'board.png',
      mimeType: 'image/png',
      buffer: PNG,
    });

    // After upload: the boardless board now carries the owner's picture.
    const after = page.locator('.item[data-design="kids"][data-key="board"]');
    await expect(after.locator('.badge.custom')).toBeVisible();
    await expect(after.locator('img.preview')).toHaveAttribute('src', UPLOADED);
    await expect(after.locator('button[data-act="reset"]')).toBeEnabled();
  });

  test('toggling a base checkbox posts the per-surface flag', async ({ page }) => {
    await stubGet(page, {});
    let flagBody = null;
    await page.route('**/api/admin/design-images/base/flags*', (route) => {
      flagBody = JSON.parse(route.request().postData() || '{}');
      route.fulfill({ json: { ok: true, gallery: { base: { store: { onProduct: true } } } } });
    });

    await page.goto(`/admin-images.html?key=${KEY}`);
    // Opt the store cover INTO the product page.
    await page
      .locator('.item[data-design="posttrip"][data-key="store"] input[data-flag="onProduct"]')
      .check();
    await expect.poll(() => flagBody).not.toBeNull();
    expect(flagBody).toMatchObject({ designId: 'posttrip', slot: 'store', onProduct: true });
  });

  test('adding a named photo appends a photo item to the gallery', async ({ page }) => {
    await stubGet(page, {});
    await stubUploads(page);
    await page.route('**/api/admin/design-images/photo*', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      route.fulfill({
        json: {
          ok: true,
          photo: { id: 'p1', img: UPLOADED, name: 'סטודיו', onProducts: true, onProduct: true },
          gallery: {
            photos: [
              { id: 'p1', img: UPLOADED, name: 'סטודיו', onProducts: true, onProduct: true },
            ],
          },
        },
      });
    });

    await page.goto(`/admin-images.html?key=${KEY}`);
    const section = page.locator('.design[data-design="birthday"]');
    await section.locator('.add-name').fill('סטודיו');
    await section.locator('.add-file').setInputFiles({
      name: 'x.png',
      mimeType: 'image/png',
      buffer: PNG,
    });

    const photo = page.locator('.item[data-design="birthday"][data-type="photo"]');
    await expect(photo).toHaveCount(1);
    await expect(photo.locator('.name-input')).toHaveValue('סטודיו');
    await expect(photo.locator('img.preview')).toHaveAttribute('src', UPLOADED);
  });

  test('reorder posts the full new key order', async ({ page }) => {
    await stubGet(page, {});
    let orderBody = null;
    await page.route('**/api/admin/design-images/order*', (route) => {
      orderBody = JSON.parse(route.request().postData() || '{}');
      route.fulfill({ json: { ok: true, gallery: { order: orderBody.order } } });
    });

    await page.goto(`/admin-images.html?key=${KEY}`);
    // Move the first item (store) one step later.
    await page
      .locator('.item[data-design="posttrip"][data-key="store"] button[data-act="down"]')
      .click();
    await expect.poll(() => orderBody).not.toBeNull();
    expect(orderBody.designId).toBe('posttrip');
    expect(orderBody.order.slice(0, 2)).toEqual(['front', 'store']);
  });
});
