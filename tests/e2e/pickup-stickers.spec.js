import { test, expect } from '@playwright/test';

// THE NIGHT'S STICKER SHEET, FROM THE ORDERS PAGE.
//
// Every printed game the customer collects herself gets a label on its box, and
// that sheet was being typed out by hand every night. The button is where the
// night's work already is — with the order filters, above the table.
//
// WHICH orders belong on it lives in tests/unit/pickup-stickers.test.js, against
// the real store. The sheet's own shape lives in
// generator/test_pickup_stickers.py, against the real renderer. What is under
// test here is the BUTTON: whether it appears, what it counts, and where it
// points.
//
// THE COUNT IS PINNED, NOT MEASURED. The e2e server is one process shared by
// every spec file, and other files create paid, printed orders while this one
// runs — so an assertion on "the number the server says right now" is an
// assertion on a number that moves between the two reads. (It did: the count
// went 14 → 15 → 16 across three retries of the same test.) So the collections
// payload is intercepted and every order but this test's own is taken off
// tonight's sheet, which makes the expected number a constant.

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

// Serve the REAL orders payload with every order but `mine` taken off tonight's
// sheet. The page's own logic still runs on a real response — only the size of
// the night is fixed.
async function onlyMine(page, mine) {
  const keep = new Set(mine.map((c) => c.id));
  await page.route('**/api/admin/collections*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const c of body.collections || []) {
      if (c.order && !keep.has(c.id)) c.order.sent_to_print_at = null;
    }
    return route.fulfill({ response: res, json: body });
  });
}

test('the button counts tonight’s stickers and points at the sheet', async ({ page }) => {
  const mine = [
    await pickupAtPrinter(page, 'שירה א'),
    await pickupAtPrinter(page, 'שירה ב'),
    await pickupAtPrinter(page, 'שירה ג'),
  ];
  await onlyMine(page, mine);
  await page.goto(ADMIN);

  const btn = page.getByTestId('pickup-stickers');
  await expect(btn).toBeVisible();
  // The count is on the button, so it is never a press that turns out to have
  // had nothing behind it.
  await expect(page.locator('#stickerCount')).toHaveText('3');
  await expect(btn).toHaveAttribute('href', /\/api\/admin\/pickup-stickers\?key=dugri-admin/);
});

test('an order already marked ready is not on tonight’s sheet', async ({ page }) => {
  const mine = [await pickupAtPrinter(page, 'שירה ד'), await pickupAtPrinter(page, 'שירה ה')];
  // Ready means the box has been labelled and handed over.
  await page.request.post(`/api/admin/collections/${mine[1].id}/ready?key=dugri-admin`, {
    data: {},
  });
  await onlyMine(page, mine);
  await page.goto(ADMIN);

  await expect(page.getByTestId('pickup-stickers')).toBeVisible();
  await expect(page.locator('#stickerCount')).toHaveText('1');
});

test('with nothing to collect the button is not there at all', async ({ page }) => {
  // A quiet night. A button that answers "there was nothing to print" is a
  // button that wasted a press.
  await onlyMine(page, []);
  await page.goto(ADMIN);
  await expect(page.locator('#controls')).toBeVisible();
  await expect(page.getByTestId('pickup-stickers')).toBeHidden();
});

test('the count is not narrowed by the table’s filters', async ({ page }) => {
  // The sheet is the whole night's work. A count that quietly shrank because a
  // filter chip was left on is a customer whose box goes out unlabelled.
  const mine = [await pickupAtPrinter(page, 'שירה ו'), await pickupAtPrinter(page, 'שירה ז')];
  await onlyMine(page, mine);
  await page.goto(ADMIN);
  const count = page.locator('#stickerCount');
  await expect(count).toHaveText('2');

  // "לידים" is every order that has NOT been paid for, which excludes every
  // order that could be on the sheet — a sticker order is paid, printed and
  // waiting. A count read off the table would drop to 0 here. The chip carries
  // its own count in its label ("לידים (3)"), so it is picked by its
  // data-filter rather than by its text.
  const chip = page.locator('#tabs button[data-filter="leads"]');
  await chip.click();
  await expect(chip).toHaveClass(/active/);
  await expect(count).toHaveText('2');
});

test('the sheet is admin-only', async ({ page }) => {
  const res = await page.request.get('/api/admin/pickup-stickers');
  expect(res.status()).toBe(403);
});
