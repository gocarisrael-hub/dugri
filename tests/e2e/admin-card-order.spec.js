import { test, expect } from '@playwright/test';

// Picking, on the order itself, how its words are laid onto the cards: the
// default blend, the buyer's own words first, or Hebrew and Latin cards kept
// apart. The arrangement itself is the generator's (pack.py, its own tests);
// this is the owner's end of it — the dropdown beside the seed pool, and the
// choice surviving a save and a reopen.
const KEY = 'dugri-admin';
const uniq = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

async function seed(request, name) {
  const r = await request.post('/api/collections', {
    data: { honoree_name: name, email: 'co@example.com' },
  });
  return (await r.json()).id;
}
const rowFor = (page, name) => page.locator('tr', { hasText: name });
async function openEdit(page, name) {
  await rowFor(page, name).getByRole('button', { name: 'ערוך' }).click();
  await expect(page.locator('#edit')).toBeVisible();
  await expect(page.locator('#e-card-order')).toBeVisible();
}

test('card order: defaults to the blend every deck had before this existed', async ({
  page,
  request,
}) => {
  const name = uniq('סדר');
  await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);
  await openEdit(page, name);

  await expect(page.locator('#e-card-order')).toHaveValue('');
  const options = page.locator('#e-card-order option');
  await expect(options.first()).toContainText('מעורבב');
  await expect(options).toHaveCount(4);
});

test('card order: the exact option warns about what it costs', async ({ page, request }) => {
  // It is the one order that gives up the phrase balance (generator/pack.py), so
  // some cards can print small. The label has to say so IN the picker — by the
  // time she can see it, the deck is produced.
  const name = uniq('מדויק');
  await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);
  await openEdit(page, name);
  const exact = page.locator('#e-card-order option[value="exact"]');
  await expect(exact).toHaveCount(1);
  await expect(exact).toContainText('בדיוק לפי הסדר');
  await expect(exact).toContainText('פונט קטן');
});

test('card order: exact persists and reaches the order', async ({ page, request }) => {
  const name = uniq('מדויק-שמירה');
  const id = await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);
  await openEdit(page, name);
  await page.selectOption('#e-card-order', 'exact');
  await page.locator('#e-save').click();
  await expect(page.locator('#edit')).toBeHidden();

  const after = await (await request.get(`/api/admin/collections?key=${KEY}`)).json();
  expect(after.collections.find((c) => c.id === id).card_order).toBe('exact');
});

test('card order: choosing one persists onto the order', async ({ page, request }) => {
  const name = uniq('בחירה');
  const id = await seed(request, name);

  await page.goto(`/admin.html?key=${KEY}`);
  await openEdit(page, name);
  await page.selectOption('#e-card-order', 'personal-first');
  await page.locator('#e-save').click();
  await expect(page.locator('#edit')).toBeHidden();

  const after = await (await request.get(`/api/admin/collections?key=${KEY}`)).json();
  expect(after.collections.find((c) => c.id === id).card_order).toBe('personal-first');

  // …and comes back selected when the dialog is reopened, so the owner can see
  // what this order is set to rather than guess from the deck.
  await page.reload();
  await openEdit(page, name);
  await expect(page.locator('#e-card-order')).toHaveValue('personal-first');
});

test('card order: clearing it returns the order to the blend', async ({ page, request }) => {
  const name = uniq('ניקוי');
  const id = await seed(request, name);
  await request.patch(`/api/admin/collections/${id}?key=${KEY}`, {
    data: { honoree_name: name, card_order: 'by-script' },
  });

  await page.goto(`/admin.html?key=${KEY}`);
  await openEdit(page, name);
  await expect(page.locator('#e-card-order')).toHaveValue('by-script');
  await page.selectOption('#e-card-order', '');
  await page.locator('#e-save').click();
  await expect(page.locator('#edit')).toBeHidden();

  const after = await (await request.get(`/api/admin/collections?key=${KEY}`)).json();
  expect(after.collections.find((c) => c.id === id).card_order).toBeFalsy();
});

test('card order: an edit that never touches it leaves it alone', async ({ page, request }) => {
  // Saving the dialog after changing only the title must not quietly reset a
  // deck's arrangement back to the blend.
  const name = uniq('שמירה');
  const id = await seed(request, name);
  await request.patch(`/api/admin/collections/${id}?key=${KEY}`, {
    data: { honoree_name: name, card_order: 'by-script' },
  });

  await page.goto(`/admin.html?key=${KEY}`);
  await openEdit(page, name);
  await page.fill('#e-title', 'החגיגה של שירה');
  await page.locator('#e-save').click();
  await expect(page.locator('#edit')).toBeHidden();

  const after = await (await request.get(`/api/admin/collections?key=${KEY}`)).json();
  expect(after.collections.find((c) => c.id === id).card_order).toBe('by-script');
});
