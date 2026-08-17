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

// An order at the exact point the sticker is for: paid, self-collection, the deck
// PRODUCED, and not yet marked ready — the box exists and has not gone out.
//
// The e2e server has no admin "mark as paid" route (an order goes paid only on a
// real money event) and no Python to run a real generator, so the two states
// that cannot be reached through the API are injected into the collections
// payload by `onlyMine` below.
async function pickupAwaitingPrint(page, title) {
  const c = await page.request
    .post('/api/collections', {
      data: { honoree_name: title, theme: 'anniversary', email: 'stick@example.com' },
    })
    .then((r) => r.json());
  await page.request.post(`/api/collections/${c.id}/order`, {
    data: { owner_token: c.owner_token, version: 'pickup' },
  });
  return c;
}

// Serve the REAL orders payload with exactly `mine` on tonight's sheet and
// everything else off it. The page's own counting logic still runs on a real
// response — only the size of the night is fixed.
// `ready` names the ones among them that have already been handed over — a
// state this server cannot be walked into (it needs a real print run), and one
// that must be applied in the SAME handler: a second page.route on the same
// pattern replaces the first rather than chaining onto it.
async function onlyMine(page, mine, { ready = [] } = {}) {
  const keep = new Set(mine.map((c) => c.id));
  const done = new Set(ready.map((c) => c.id));
  await page.route('**/api/admin/collections*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const c of body.collections || []) {
      if (!c.order) continue;
      if (keep.has(c.id)) {
        c.order.paid = true;
        c.order.production = { state: 'generated' };
        c.order.ready_at = done.has(c.id) ? '2026-08-16T00:00:00.000Z' : null;
        c.cancelled = false;
      } else {
        c.order.production = null;
        c.production = null;
        c.order.sent_to_print_at = null;
      }
    }
    return route.fulfill({ response: res, json: body });
  });
}

test('the button counts tonight’s stickers and points at the sheet', async ({ page }) => {
  const mine = [
    await pickupAwaitingPrint(page, 'שירה א'),
    await pickupAwaitingPrint(page, 'שירה ב'),
    await pickupAwaitingPrint(page, 'שירה ג'),
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
  const mine = [
    await pickupAwaitingPrint(page, 'שירה ד'),
    await pickupAwaitingPrint(page, 'שירה ה'),
  ];
  // Ready means the box has been labelled and handed over.
  await onlyMine(page, mine, { ready: [mine[1]] });
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
  const mine = [
    await pickupAwaitingPrint(page, 'שירה ו'),
    await pickupAwaitingPrint(page, 'שירה ז'),
  ];
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
