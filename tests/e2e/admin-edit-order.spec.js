import { test, expect } from '@playwright/test';

// Editing an order's stored choices from the orders table: the customer settles
// details with the owner on WhatsApp after checkout, and the owner fixes the row
// in place (names + theme extra fields, design/theme, pickup vs delivery + the
// shipping address, and the pawn photos).
const KEY = 'dugri-admin';

// Unique per call so the parallel device projects (one shared server + JSON
// store) never collide on a honoree name.
const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

// 'pickup' is the only version enabled by default, so it is what a public order
// POST can seed. Switching it to delivery is exactly what the dialog is for.
async function seed(request, name) {
  const create = await request.post('/api/collections', {
    data: { honoree_name: name, email: 'edit-test@example.com', phone: '0521234567' },
  });
  const { id, owner_token } = await create.json();
  await request.post(`/api/collections/${id}/order`, { data: { owner_token, version: 'pickup' } });
  return { id, owner_token };
}

// The table row for a honoree, and the edit dialog opened from it.
const rowFor = (page, name) => page.locator('tr', { hasText: name });
async function openEditor(page, name) {
  await rowFor(page, name).getByRole('button', { name: 'ערוך' }).click();
  await expect(page.locator('#edit')).toBeVisible();
}

test('edits the honoree name, theme and the theme extra fields', async ({ page, request }) => {
  const name = uniq('עריכה');
  await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);
  await openEditor(page, name);

  const newName = uniq('אחרי');
  await page.fill('#e-name', newName);
  // Picking the anniversary theme reveals ITS required extra fields.
  await page.selectOption('#e-theme', 'anniversary');
  await expect(page.locator('#e-extra input[data-ek="YEARS"]')).toBeVisible();
  await page.fill('#e-extra input[data-ek="YEARS"]', '6');
  await page.fill('#e-extra input[data-ek="NAME1"]', 'דנה');
  await page.fill('#e-extra input[data-ek="NAME2"]', 'אופיר');
  await page.click('#e-save');

  await expect(page.locator('#edit')).toBeHidden();
  const row = rowFor(page, newName);
  await expect(row).toContainText('שנות נישואין: 6');
  await expect(row).toContainText('שם 1: דנה');
  await expect(row).toContainText('שם 2: אופיר');
});

test('switches pickup to delivery and stores the shipping address', async ({ page, request }) => {
  const name = uniq('משלוח');
  await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);
  await openEditor(page, name);

  // The address block is for delivery only — hidden while the order is pickup.
  await expect(page.locator('#e-address')).toBeHidden();
  await page.selectOption('#e-version', 'delivery');
  await expect(page.locator('#e-address')).toBeVisible();

  // Saving a delivery with an incomplete address is refused, dialog stays open.
  await page.fill('#e-street', 'הרצל 5');
  await page.click('#e-save');
  await expect(page.locator('#e-err')).toBeVisible();
  await expect(page.locator('#edit')).toBeVisible();

  await page.fill('#e-city', 'תל אביב');
  await page.fill('#e-postal', '6100000');
  await page.fill('#e-apartment', '3');
  await page.click('#e-save');

  await expect(page.locator('#edit')).toBeHidden();
  const row = rowFor(page, name);
  await expect(row).toContainText('המפונקת (משלוח)');
  await expect(row).toContainText('הרצל 5, תל אביב, 6100000, דירה 3');
});

test('removes a pawn photo the customer sent by mistake', async ({ page, request }) => {
  const name = uniq('פיונים');
  const { id, owner_token } = await seed(request, name);
  // Two 1x1-ish PNGs (typed by magic bytes, so a header + padding is enough).
  const png = (tag) =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(tag.padEnd(8, '.')),
    ]);
  await request.post(`/api/collections/${id}/pawns?k=${owner_token}`, {
    multipart: {
      p1: { name: 'a.png', mimeType: 'image/png', buffer: png('one') },
      p2: { name: 'b.png', mimeType: 'image/png', buffer: png('two') },
    },
  });

  await page.goto(`/admin.html?key=${KEY}`);
  await expect(rowFor(page, name).locator('img')).toHaveCount(2);
  await openEditor(page, name);
  await expect(page.locator('#e-photos .photo')).toHaveCount(2);
  await page.locator('#e-photos .photo button').first().click();
  await expect(page.locator('#e-photos .photo')).toHaveCount(1);
  await page.click('#e-save');

  await expect(page.locator('#edit')).toBeHidden();
  await expect(rowFor(page, name).locator('img')).toHaveCount(1);
});
