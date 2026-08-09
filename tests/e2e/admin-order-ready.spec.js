import { test, expect } from '@playwright/test';

// The admin "מוכן" toggle: pressed when a deck comes off the press. It flips the
// order, counts toward the הודפסו tally, and (elsewhere) emails the customer.
const KEY = 'dugri-admin';
const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

// Seed one order. `sentToPrint` defaults to TRUE because "מוכן" is gated on the
// print shop — an order that never went to Galor cannot be marked ready, so most
// tests here want an order that already has. The gate's own tests pass false.
async function seedOrder(request, name, { sentToPrint = true } = {}) {
  const create = await request.post('/api/collections', {
    data: { honoree_name: name, email: 'ready@example.com' },
  });
  const { id, owner_token } = await create.json();
  // Pickup is the only version enabled on the E2E server by default; a delivery
  // order would also need an address. Tests that care about the DELIVERY label
  // patch the list response instead (see reportAsDelivery).
  const r = await request.post(`/api/collections/${id}/order`, {
    data: { owner_token, version: 'pickup' },
  });
  expect(r.ok()).toBeTruthy();
  if (sentToPrint) {
    const p = await request.post(`/api/admin/collections/${id}/to-print?key=${KEY}`, { data: {} });
    expect(p.ok()).toBeTruthy();
  }
  return { id, owner_token };
}

// Report ONE seeded row as a delivery order to the page. Server state untouched —
// this is about how the button LABELS itself per version, not about how an order
// becomes a delivery. Mirrors admin.spec.js's markRowPaid.
async function reportAsDelivery(page, honoreeName) {
  await page.route('**/api/admin/collections*', async (route) => {
    const resp = await route.fetch();
    const body = await resp.json();
    for (const c of body.collections || []) {
      if (c.honoree_name === honoreeName && c.order) c.order.version = 'delivery';
    }
    await route.fulfill({ response: resp, json: body });
  });
}

// The dashboard's "הודפסו" tile, as a number.
async function printedCount(page) {
  const tile = page.locator('.stat').filter({ hasText: 'הודפסו' });
  await expect(tile).toBeVisible();
  return Number((await tile.locator('.val').innerText()).replace(/\D+/g, ''));
}

// The tally is GLOBAL, and the two device projects share one server, so an exact
// before/after delta is racy — the other project marks orders while this one
// reads. What is actually worth pinning is the INVARIANT: the number equals the
// rows that show as ready, both painted from the same response. That holds no
// matter what else is happening, and it is the property the feature promises —
// the tile can never drift from the list.
async function expectTallyMatchesRows(page) {
  const readyRows = page.getByTestId('ready-toggle').filter({ hasText: 'מוכן ✅' });
  expect(await printedCount(page)).toBe(await readyRows.count());
}

// The row for one honoree, found by name so parallel projects don't collide.
function rowFor(page, name) {
  return page.locator('tbody tr').filter({ hasText: name });
}

test('ready: the label names what happens next, and differs by version', async ({
  page,
  request,
}) => {
  const pickup = uniq('איסוף');
  const delivery = uniq('משלוח');
  await seedOrder(request, pickup);
  await seedOrder(request, delivery);
  await reportAsDelivery(page, delivery);

  await page.goto(`/admin.html?key=${KEY}`);
  await expect(rowFor(page, pickup).getByTestId('ready-toggle')).toHaveText(/מוכן לאיסוף/);
  await expect(rowFor(page, delivery).getByTestId('ready-toggle')).toHaveText(/יוצא למשלוח/);
});

test('ready: pressing marks the order and raises the printed tally', async ({ page, request }) => {
  const name = uniq('מוכן');
  await seedOrder(request, name);
  await page.goto(`/admin.html?key=${KEY}`);
  await expectTallyMatchesRows(page);

  await rowFor(page, name).getByTestId('ready-toggle').click();
  // The button re-renders from server state, so this also proves the write stuck.
  await expect(rowFor(page, name).getByTestId('ready-toggle')).toHaveText(/מוכן ✅/);
  // ...and the tile moved with it.
  await expectTallyMatchesRows(page);
});

test('ready: undo asks first, warns the email is already gone, and lowers the tally', async ({
  page,
  request,
}) => {
  const name = uniq('ביטול');
  const { id } = await seedOrder(request, name);
  await request.post(`/api/admin/collections/${id}/ready?key=${KEY}`, { data: {} });

  await page.goto(`/admin.html?key=${KEY}`);
  const btn = rowFor(page, name).getByTestId('ready-toggle');
  await expect(btn).toHaveText(/מוכן ✅/);

  // Dismissing the confirm must change nothing at all.
  page.once('dialog', (d) => d.dismiss());
  await btn.click();
  await expect(btn).toHaveText(/מוכן ✅/);

  // Accepting it undoes — and the confirmation has to be honest that the
  // customer's email cannot be recalled.
  let message = '';
  page.once('dialog', (d) => {
    message = d.message();
    d.accept();
  });
  await btn.click();
  await expect(rowFor(page, name).getByTestId('ready-toggle')).toHaveText(/מוכן לאיסוף/);
  expect(message).toContain('כבר נשלח');
  await expectTallyMatchesRows(page);
});

test('ready: a collection with no order has nothing to mark', async ({ page, request }) => {
  const name = uniq('ליד');
  await request.post('/api/collections', { data: { honoree_name: name } });
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(rowFor(page, name).getByTestId('ready-toggle')).toHaveCount(0);
  await expect(rowFor(page, name).getByTestId('to-print-toggle')).toHaveCount(0);
});

/* ---- the print shop step, and the gate it puts under "מוכן" ---------------- */

test('to-print: pressing marks the order sent to Galor', async ({ page, request }) => {
  const name = uniq('לדפוס');
  await seedOrder(request, name, { sentToPrint: false });
  await page.goto(`/admin.html?key=${KEY}`);

  const btn = rowFor(page, name).getByTestId('to-print-toggle');
  await expect(btn).toHaveText(/נשלח לגלאור/);
  await btn.click();
  // Re-rendered from server state, so this also proves the write stuck.
  await expect(rowFor(page, name).getByTestId('to-print-toggle')).toHaveText(/בדפוס ✅/);
});

test('to-print: an order that never went to print cannot be marked ready', async ({
  page,
  request,
}) => {
  const name = uniq('שער');
  await seedOrder(request, name, { sentToPrint: false });
  await page.goto(`/admin.html?key=${KEY}`);

  // Disabled rather than hidden: the owner needs to SEE the step she still owes.
  const ready = rowFor(page, name).getByTestId('ready-toggle');
  await expect(ready).toBeDisabled();
  await expect(ready).toHaveAttribute('title', /נשלחה לדפוס/);

  // ...and it opens up the moment the order goes to the printer.
  await rowFor(page, name).getByTestId('to-print-toggle').click();
  await expect(rowFor(page, name).getByTestId('ready-toggle')).toBeEnabled();
});

test('to-print: cannot be un-sent once the order is marked ready', async ({ page, request }) => {
  // "ready" means BACK from print, so the stamp under it is history by then. The
  // button says so rather than firing a request the server will refuse.
  const name = uniq('חזרה');
  const { id } = await seedOrder(request, name);
  const r = await request.post(`/api/admin/collections/${id}/ready?key=${KEY}`, { data: {} });
  expect(r.ok()).toBeTruthy();

  await page.goto(`/admin.html?key=${KEY}`);
  await expect(rowFor(page, name).getByTestId('ready-toggle')).toHaveText(/מוכן ✅/);
  await expect(rowFor(page, name).getByTestId('to-print-toggle')).toBeDisabled();
});
