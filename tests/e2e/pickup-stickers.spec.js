import { test, expect } from '@playwright/test';

// THE NIGHT'S STICKER SHEET, FROM THE ORDERS PAGE.
//
// Every printed game the customer collects herself gets a label on its box, and
// that sheet was being typed out by hand every night. The button is where the
// night's work already is — with the order filters, above the table.
//
// WHICH orders belong on it lives in tests/unit/pickup-stickers.test.js, and the
// sheet's own shape in generator/test_pickup_stickers.py. What is under test
// here is the button: whether it appears, what it counts, and where it points.
// The PDF itself is a Chrome print inside a Chrome test, which is a fixture, not
// a fact — the two files above cover it against the real renderer.

const ADMIN = '/admin.html?key=dugri-admin';

// An order at the exact point the sticker is for: paid, self-collection, sent to
// the printer, not yet marked ready.
async function pickupAtPrinter(page, title) {
  const c = await page.request
    .post('/api/collections', {
      data: { honoree_name: title, theme: 'anniversary', email: 'stick@example.com' },
    })
    .then((r) => r.json());
  await page.request.post(`/api/collections/${c.id}/order`, {
    data: { owner_token: c.owner_token, version: 'pickup' },
  });
  await page.request.post(`/api/admin/collections/${c.id}/to-print?key=dugri-admin`, { data: {} });
  return c;
}

async function stickerCount(page) {
  return page.request
    .get('/api/admin/collections?key=dugri-admin')
    .then((r) => r.json())
    .then(
      (d) =>
        d.collections.filter((c) => {
          const o = c.order;
          return !!(o && o.version === 'pickup' && o.sent_to_print_at && !o.ready_at);
        }).length
    );
}

test('the button counts tonight’s stickers and points at the sheet', async ({ page }) => {
  await pickupAtPrinter(page, 'שירה מדבקה');
  const expected = await stickerCount(page);
  expect(expected).toBeGreaterThan(0);

  await page.goto(ADMIN);
  const btn = page.getByTestId('pickup-stickers');
  await expect(btn).toBeVisible();
  // The count is on the button, so it is never a press that turns out to have
  // had nothing behind it.
  await expect(btn).toContainText(String(expected));
  await expect(btn).toHaveAttribute('href', /\/api\/admin\/pickup-stickers\?key=dugri-admin/);
});

test('marking an order ready takes it off tonight’s sheet', async ({ page }) => {
  const c = await pickupAtPrinter(page, 'שירה נמסרה');
  await page.goto(ADMIN);
  const before = await stickerCount(page);
  await expect(page.getByTestId('pickup-stickers')).toContainText(String(before));

  // Ready means the box has been labelled and handed over.
  await page.request.post(`/api/admin/collections/${c.id}/ready?key=dugri-admin`, { data: {} });
  await page.reload();
  await expect(page.getByTestId('pickup-stickers')).toContainText(String(before - 1));
});

test('the count is not narrowed by the table’s filters', async ({ page }) => {
  // The sheet is the whole night's work. A count that quietly shrank because a
  // filter chip was left on is a customer whose box goes out unlabelled.
  await pickupAtPrinter(page, 'שירה מסוננת');
  await page.goto(ADMIN);
  const count = page.locator('#stickerCount');
  const before = await count.textContent();

  // "לידים" is every order that has NOT been paid for — which excludes every
  // order that could be on the sheet, since a sticker order is paid, printed and
  // waiting. If the button were reading the table, this would zero it.
  // "לידים" is every order that has NOT been paid for, which excludes every
  // order that could be on the sheet — a sticker order is paid, printed and
  // waiting. The chip carries its own count in its label ("לידים (3)"), so it
  // is picked by its data-filter rather than by its text.
  const chip = page.locator('#tabs button[data-filter="leads"]');
  await chip.click();
  await expect(chip).toHaveClass(/active/);

  // The filter is on, and the button still counts the whole night — the same
  // number the server would put on the sheet.
  await expect(count).toHaveText(before);
  expect(Number(before)).toBe(await stickerCount(page));
});

test('the sheet is admin-only', async ({ page }) => {
  const res = await page.request.get('/api/admin/pickup-stickers');
  expect(res.status()).toBe(403);
});
