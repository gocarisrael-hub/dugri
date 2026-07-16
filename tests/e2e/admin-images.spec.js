import { test, expect } from '@playwright/test';

// The per-design product-image admin page (admin-images.html) is behind the admin
// key. To keep the parallel device projects race-free against the shared server,
// the override API is MOCKED at the network layer — this spec verifies the admin
// UI wiring (gate, design/slot listing, upload + reset controls), not real writes.
const KEY = 'dugri-admin';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const UPLOADED = '/content-uploads/0123456789abcdef.png';
const CAR1 = '/content-uploads/1111111111111111.png';
const CAR2 = '/content-uploads/2222222222222222.png';

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

    // The nav cross-links to the other owner-editable admin sections so the
    // owner can reach features/pricing/images from any of them (they were once
    // missing each other — regression guard).
    await expect(page.locator('.nav a[data-page="admin-features.html"]')).toHaveCount(1);
    await expect(page.locator('.nav a[data-page="admin-pricing.html"]')).toHaveCount(1);
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

  test('lists a design’s existing carousel pictures with a delete button each', async ({
    page,
  }) => {
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({ json: { images: { birthday: { carousel: [CAR1, CAR2] } } } })
    );
    await page.route('**/content-uploads/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG })
    );
    await page.goto(`/admin-images.html?key=${KEY}`);

    const car = page.locator('.carousel-admin[data-design="birthday"]');
    await expect(car).toBeVisible();
    await expect(car.locator('.cthumb')).toHaveCount(2);
    await expect(car.locator('button[data-act="carousel-del"]')).toHaveCount(2);
    // A design with no carousel shows the empty hint.
    const neon = page.locator('.carousel-admin[data-design="neon"]');
    await expect(neon.locator('.cthumb')).toHaveCount(0);
    await expect(neon.locator('.cempty')).toBeVisible();
  });

  test('adding a carousel picture appends a thumbnail; deleting removes it', async ({ page }) => {
    // Start with one carousel picture; the POST appends a second, the DELETE removes one.
    await page.route('**/api/design-images*', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: { images: { birthday: { carousel: [CAR1] } } } });
      }
      return route.continue();
    });
    await page.route('**/api/admin/design-images/carousel*', (route) => {
      const m = route.request().method();
      if (m === 'POST') {
        return route.fulfill({ json: { ok: true, img: CAR2, carousel: [CAR1, CAR2] } });
      }
      if (m === 'DELETE') {
        return route.fulfill({ json: { ok: true, carousel: [CAR2] } });
      }
      return route.continue();
    });
    await page.route('**/content-uploads/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG })
    );

    await page.goto(`/admin-images.html?key=${KEY}`);
    const car = page.locator('.carousel-admin[data-design="birthday"]');
    await expect(car.locator('.cthumb')).toHaveCount(1);

    // Add: set the file on the hidden carousel input (fires the upload).
    await car.locator('input[type=file][data-carousel]').setInputFiles({
      name: 'c.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await expect(car.locator('.cthumb')).toHaveCount(2);

    // Delete: remove the first picture → the DELETE mock returns the shorter array.
    await car.locator('button[data-act="carousel-del"]').first().click();
    await expect(car.locator('.cthumb')).toHaveCount(1);
  });
});
