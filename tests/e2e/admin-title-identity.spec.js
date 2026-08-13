import { test, expect } from '@playwright/test';

// THE ADMIN NAMES AN ORDER BY ITS TITLE — "in the admin panel you can replace the
// name and gender with a title column" (the owner).
//
// The table used to carry two identity columns, בעל/ת השמחה and כותרת, because a
// title was an OPTIONAL override on one the theme composed from the name. The
// buyer types the title and nothing else now, so the two said the same thing
// twice. Gender is gone from the dialog for the same reason: it only ever chose
// between the forms of a composed title.
//
// The part that needs care is the orders placed BEFORE all of that. They have a
// name and no title, and the theme still composes their title from that name —
// so the table must not show them as blank rows, and the dialog must not imply
// their title box is what prints.
const KEY = 'dugri-admin';
const uniq = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

const rowFor = (page, text) => page.locator('tbody tr', { hasText: text }).first();

async function seedOrder(request, data) {
  const r = await request.post('/api/collections', {
    data: { email: 'admin-title@example.com', phone: '0521234567', ...data },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).id;
}

test('the table names an order by the title that gets printed', async ({ page, request }) => {
  const title = uniq('ליאת חוגגת 40');
  await seedOrder(request, { honoree_name: title, custom_title: title });

  await page.goto(`/admin.html?key=${KEY}`);
  await expect(rowFor(page, title).locator('td:nth-child(2)')).toHaveText(title);
});

test('an order from before the change shows its name instead of an empty cell', async ({
  page,
  request,
}) => {
  // No custom_title — the shape every order had until the title replaced the
  // name. Its deck still prints a title the THEME composes from this name, so the
  // cell borrows it rather than leaving the owner with an unidentifiable row.
  const name = uniq('שירה');
  await seedOrder(request, { honoree_name: name });

  await page.goto(`/admin.html?key=${KEY}`);
  const cell = rowFor(page, name).locator('td:nth-child(2)');
  await expect(cell).toHaveText(name);
  // Muted, because it is a label we are borrowing — not something printed.
  await expect(cell.locator('.muted')).toHaveCount(1);
});

test('the dialog has no gender control at all', async ({ page, request }) => {
  const title = uniq('בלי מגדר');
  await seedOrder(request, { honoree_name: title, custom_title: title });

  await page.goto(`/admin.html?key=${KEY}`);
  await rowFor(page, title).getByRole('button', { name: 'ערוך' }).click();
  await expect(page.locator('#edit')).toBeVisible();
  await expect(page.locator('#e-gender')).toHaveCount(0);
});

test('the dialog says what the title box decides — and it differs by order', async ({
  page,
  request,
}) => {
  const titled = uniq('עם כותרת');
  const legacy = uniq('בלי כותרת');
  await seedOrder(request, { honoree_name: titled, custom_title: titled });
  await seedOrder(request, { honoree_name: legacy });

  await page.goto(`/admin.html?key=${KEY}`);

  // An order that carries its own title: the box IS the printed title.
  await rowFor(page, titled).getByRole('button', { name: 'ערוך' }).click();
  await expect(page.getByTestId('e-title')).toHaveValue(titled);
  await expect(page.locator('#e-title-note')).toContainText('מודפס');
  await page.locator('#edit-x').click();

  // One from before: the box is empty and the theme is still composing a title
  // out of the name — "leave it alone" and "nothing prints until I type here" are
  // different instructions, so the note says which.
  await rowFor(page, legacy).getByRole('button', { name: 'ערוך' }).click();
  await expect(page.getByTestId('e-title')).toHaveValue('');
  await expect(page.locator('#e-title-note')).toContainText('לפני שהכותרת החליפה את השם');
});

test('editing the title changes what the order is called', async ({ page, request }) => {
  const before = uniq('כותרת ראשונה');
  const after = uniq('כותרת חדשה');
  const id = await seedOrder(request, { honoree_name: before, custom_title: before });

  await page.goto(`/admin.html?key=${KEY}`);
  await rowFor(page, before).getByRole('button', { name: 'ערוך' }).click();
  await page.getByTestId('e-title').fill(after);
  await page.locator('#e-save').click();
  await expect(page.locator('#edit')).toBeHidden();

  const rows = await (await request.get(`/api/admin/collections?key=${KEY}`)).json();
  expect(rows.collections.find((c) => c.id === id).custom_title).toBe(after);
  await expect(rowFor(page, after).locator('td:nth-child(2)')).toHaveText(after);
});
