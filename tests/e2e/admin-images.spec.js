import { test, expect } from '@playwright/test';

// The per-design product-image admin page (admin-images.html) is behind the admin
// key. To keep the parallel device projects race-free against the shared server,
// the override API is MOCKED at the network layer — this spec verifies the admin
// UI wiring (gate, design/slot listing, upload + reset controls), not real writes.
const KEY = 'dugri-admin';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const UPLOADED = '/content-uploads/0123456789abcdef.png';

test.describe('admin images page', () => {
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

  test('with the key it lists designs and their slots (board only where it exists)', async ({
    page,
  }) => {
    await page.route('**/api/design-images*', (route) => route.fulfill({ json: { images: {} } }));
    await page.goto(`/admin-images.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    // One card per catalog design (all 7 are public).
    await expect(page.locator('.design')).toHaveCount(7);

    // posttrip ships a board → its board slot is present.
    const posttrip = page.locator('.slot[data-design="posttrip"]');
    await expect(posttrip).toHaveCount(4); // store, front, back, board
    await expect(page.locator('.slot[data-design="posttrip"][data-slot="board"]')).toHaveCount(1);

    // kids has NO board → only store, front, back.
    await expect(page.locator('.slot[data-design="kids"]')).toHaveCount(3);
    await expect(page.locator('.slot[data-design="kids"][data-slot="board"]')).toHaveCount(0);

    // The nav pill for this page is the active one.
    await expect(page.locator('.nav a.active[data-page="admin-images.html"]')).toHaveCount(1);
  });

  test('uploading a picture flips the slot to "custom" and enables reset', async ({ page }) => {
    // Start empty; the upload POST is mocked to echo back the stored override.
    await page.route('**/api/design-images*', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: { images: {} } });
      }
      return route.continue();
    });
    await page.route('**/api/admin/design-images/image*', (route) =>
      route.fulfill({ json: { ok: true, img: UPLOADED, images: { board: UPLOADED } } })
    );
    await page.route('**/content-uploads/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG })
    );

    await page.goto(`/admin-images.html?key=${KEY}`);
    const slot = page.locator('.slot[data-design="posttrip"][data-slot="board"]');
    await expect(slot).toBeVisible();
    // Before: the default badge, reset disabled.
    await expect(slot.locator('.badge.default')).toBeVisible();
    await expect(slot.locator('button[data-act="reset"]')).toBeDisabled();

    // Upload via the hidden file input.
    await slot.locator('input[type=file]').setInputFiles({
      name: 'board.png',
      mimeType: 'image/png',
      buffer: PNG,
    });

    // After: the slot re-renders as custom, preview points at the upload, reset enabled.
    const after = page.locator('.slot[data-design="posttrip"][data-slot="board"]');
    await expect(after.locator('.badge.custom')).toBeVisible();
    await expect(after.locator('img.preview')).toHaveAttribute('src', UPLOADED);
    await expect(after.locator('button[data-act="reset"]')).toBeEnabled();
  });
});
