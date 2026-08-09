import { test, expect } from '@playwright/test';

// Picking, on the order itself, which seed pool tops the deck up when the buyer
// hasn't sent enough words. Default is the theme's own pool — the behaviour every
// order had before this existed.
const KEY = 'dugri-admin';
const uniq = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

async function seed(request, name) {
  const r = await request.post('/api/collections', {
    data: { honoree_name: name, email: 'wl@example.com' },
  });
  return (await r.json()).id;
}
const rowFor = (page, name) => page.locator('tr', { hasText: name });
async function openEdit(page, name) {
  await rowFor(page, name).getByRole('button', { name: 'ערוך' }).click();
  await expect(page.locator('#edit')).toBeVisible();
  await expect(page.locator('#e-wordlist')).toBeVisible();
}

test('wordlist: defaults to the theme pool and lists the real pools', async ({ page, request }) => {
  const name = uniq('מאגר');
  await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);
  await openEdit(page, name);

  // "" is a real choice meaning "use the theme's own".
  await expect(page.locator('#e-wordlist')).toHaveValue('');
  const options = page.locator('#e-wordlist option');
  await expect(options.first()).toContainText('המאגר של התבנית');
  // The pools come from the server, so there is more than just the default.
  expect(await options.count()).toBeGreaterThan(1);
});

test('wordlist: choosing one persists onto the order', async ({ page, request }) => {
  const name = uniq('בחירה');
  const id = await seed(request, name);
  // Whatever pools the server really has — never a hardcoded fixture.
  const pools = await (await request.get(`/api/admin/wordlists?key=${KEY}`)).json();
  const pick = pools.wordlists[0].name;

  await page.goto(`/admin.html?key=${KEY}`);
  await openEdit(page, name);
  await page.selectOption('#e-wordlist', pick);
  await page.locator('#e-save').click();
  await expect(page.locator('#edit')).toBeHidden();

  const after = await (await request.get(`/api/admin/collections?key=${KEY}`)).json();
  const row = after.collections.find((c) => c.id === id);
  expect(row.wordlist).toBe(pick);

  // ...and it comes back selected when the dialog is reopened.
  await page.reload();
  await openEdit(page, name);
  await expect(page.locator('#e-wordlist')).toHaveValue(pick);
});

test('wordlist: clearing it returns the order to the theme pool', async ({ page, request }) => {
  const name = uniq('ניקוי');
  const id = await seed(request, name);
  const pools = await (await request.get(`/api/admin/wordlists?key=${KEY}`)).json();
  await request.patch(`/api/admin/collections/${id}?key=${KEY}`, {
    data: { honoree_name: name, wordlist: pools.wordlists[0].name },
  });

  await page.goto(`/admin.html?key=${KEY}`);
  await openEdit(page, name);
  await page.selectOption('#e-wordlist', '');
  await page.locator('#e-save').click();
  await expect(page.locator('#edit')).toBeHidden();

  const after = await (await request.get(`/api/admin/collections?key=${KEY}`)).json();
  expect(after.collections.find((c) => c.id === id).wordlist).toBeFalsy();
});
