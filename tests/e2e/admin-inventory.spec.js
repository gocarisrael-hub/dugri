import { test, expect } from '@playwright/test';

// THE SHELF, ON A SCREEN.
//
// "How many Santorini boards are left?" used to be answered by walking to the
// shelf. This page is the answer, and marking an order ready is what changes it.
//
// The counting RULES are held against the real store in tests/unit/stock.test.js.
// What is under test here is the screen: that it lists the designs, that a typed
// correction reaches the server and comes back from it, and that the two states
// worth noticing at a glance — nearly out, and out — actually look different.

const ADMIN = '/admin-inventory.html?key=dugri-admin';

// The e2e server shares one data dir across specs, so these tests set every
// number they assert on rather than trusting the seed: another spec may well
// have marked an order ready between them.
async function setStock(page, body) {
  const res = await page.request.put('/api/admin/stock?key=dugri-admin', { data: body });
  expect(res.status()).toBe(200);
  return res.json();
}

test('it lists the designs with what is left, and takes a correction', async ({ page }) => {
  await setStock(page, { kind: 'board', theme: 'anniversary', count: 40 });
  await page.goto(ADMIN);

  const count = page.getByTestId('board-count-anniversary');
  await expect(count).toHaveValue('40');
  // The design is named the way the owner names it, not by its theme key.
  await expect(page.getByTestId('board-anniversary')).toContainText('סנטוריני');

  // A correction is saved on blur — never per keystroke, or "1" would be written
  // on the way to "12".
  await count.fill('62');
  await count.blur();
  await expect(page.getByTestId('stock-status')).toContainText('נשמר');

  // …and it is the SERVER that now says 62, not just the box on screen.
  const snap = await page.request.get('/api/admin/stock?key=dugri-admin').then((r) => r.json());
  expect(snap.boards.find((b) => b.theme === 'anniversary').count).toBe(62);

  await page.reload();
  await expect(page.getByTestId('board-count-anniversary')).toHaveValue('62');
});

test('the packing supplies carry both numbers: how many are left, and how many an order uses', async ({
  page,
}) => {
  await setStock(page, { kind: 'supply', key: 'packaging', count: 139, per_order: 1 });
  await setStock(page, { kind: 'supply', key: 'thankyou', count: 80, per_order: 1 });
  await setStock(page, { kind: 'supply', key: 'stickers', count: 80, per_order: 0 });
  await page.goto(ADMIN);

  await expect(page.getByTestId('supply-count-packaging')).toHaveValue('139');
  await expect(page.getByTestId('supply-per-packaging')).toHaveValue('1');
  await expect(page.getByTestId('supply-count-thankyou')).toHaveValue('80');
  await expect(page.getByTestId('supply-per-thankyou')).toHaveValue('1');

  // Stickers are counted and NOT deducted: the brief named them as stock and did
  // not name them in what an order uses. The 0 is visible and editable rather
  // than a guess baked into the code.
  await expect(page.getByTestId('supply-count-stickers')).toHaveValue('80');
  await expect(page.getByTestId('supply-per-stickers')).toHaveValue('0');

  // …and if they should have been counted all along, that is one box to change.
  await page.getByTestId('supply-per-stickers').fill('1');
  await page.getByTestId('supply-per-stickers').blur();
  await expect
    .poll(async () =>
      page.request
        .get('/api/admin/stock?key=dugri-admin')
        .then((r) => r.json())
        .then((s) => s.supplies.find((x) => x.key === 'stickers').per_order)
    )
    .toBe(1);
  await setStock(page, { kind: 'supply', key: 'stickers', per_order: 0 });
});

test('nearly out and out are visible without reading the number', async ({ page }) => {
  await setStock(page, { kind: 'board', theme: 'japanese', count: 3 });
  await setStock(page, { kind: 'board', theme: 'football-boys', count: 0 });
  await page.goto(ADMIN);

  await expect(page.getByTestId('board-japanese')).toHaveClass(/low/);
  await expect(page.getByTestId('board-japanese')).toContainText('עומד להיגמר');
  await expect(page.getByTestId('board-football-boys')).toHaveClass(/out/);
  await expect(page.getByTestId('board-football-boys')).toContainText('נגמר');
});

// ONE PROJECT ONLY, and the reason is the whole point of the feature: the shelf
// is a single global counter. Playwright runs every test once per device
// project, so this one used to run TWICE AT ONCE against one server, both copies
// setting the count to 40 and both expecting 39 — whichever finished second saw
// 38. It is the same rule the wordlist-menu spec follows for the same reason,
// and it was failing on main until this.
//
// The counting itself is held against the real store in tests/unit/stock.test.js
// on every run; what needs a browser here is only that the READY button is what
// moves it.
const ONLY = 'Desktop Chrome';

test('marking an order ready is what moves the shelf, and undoing it moves it back', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== ONLY, 'mutates one global counter: runs once per server');

  // A real order, standing where the shelf gets touched: paid and at the printer.
  const created = await page.request
    .post('/api/collections', {
      data: { honoree_name: 'מלאי', theme: 'anniversary', email: 'stock@example.com' },
    })
    .then((r) => r.json());
  await page.request.post(`/api/collections/${created.id}/order`, {
    data: { owner_token: created.owner_token, version: 'pickup' },
  });
  // There is no admin "mark as paid" route by design, so this order is marked
  // ready through the print stamp only — which is the gate that matters here.
  await page.request.post(`/api/admin/collections/${created.id}/to-print?key=dugri-admin`, {
    data: {},
  });
  await setStock(page, { kind: 'board', theme: 'anniversary', count: 40 });

  await page.request.post(`/api/admin/collections/${created.id}/ready?key=dugri-admin`, {
    data: {},
  });
  await page.goto(ADMIN);
  await expect(page.getByTestId('board-count-anniversary')).toHaveValue('39');

  await page.request.post(`/api/admin/collections/${created.id}/ready?key=dugri-admin`, {
    data: { undo: true },
  });
  await page.reload();
  await expect(page.getByTestId('board-count-anniversary')).toHaveValue('40');
});

test('it is reachable from the admin nav, and says so when the key is missing', async ({
  page,
}) => {
  await page.goto('/admin.html?key=dugri-admin');
  const link = page.locator('#nav a[data-page="admin-inventory.html"]');
  await expect(link).toHaveCount(1);
  await link.click();
  await expect(page).toHaveURL(/admin-inventory\.html\?key=dugri-admin/);
  await expect(page.locator('#nav a.active[data-page="admin-inventory.html"]')).toHaveCount(1);

  // Without a key there is nothing to show and nothing to fetch — say that
  // rather than render an empty shelf that reads as "you have none of anything".
  await page.goto('/admin-inventory.html');
  await expect(page.locator('#needKey')).toBeVisible();
  await expect(page.getByTestId('stock-boards')).toBeHidden();
});
