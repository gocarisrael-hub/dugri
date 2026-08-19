import { test, expect } from '@playwright/test';

// "בטל הפקה" — taking a produced order back OUT of the print queue.
//
// The dashboard decides where an order stands from its production record, so an
// order with a built PDF sits in "הופקו — לשליחה לדפוס" and, until this button,
// nothing could move it back. (Reopening the word list does not: that step asks
// whether a file was BUILT, not whether the list is open.)
//
// The page is fed a fixed payload rather than seeded orders — producing a real
// PDF needs the Python generator, and a paid order cannot be created through the
// API at all. What the route itself does with the record and the files is held
// by tests/unit/generate-routes.test.js against the real store.
const KEY = 'dugri-admin';
const iso = (d) => new Date(Date.UTC(2026, 6, d, 9, 0, 0)).toISOString();
const generated = { state: 'generated', pdf_file: 'x.pdf', board_file: null, press: 'ready' };

function collection(i, name, order) {
  return {
    id: 'stub-' + i,
    owner_token: 'tok-' + i,
    honoree_name: name,
    owner_email: `stub${i}@example.com`,
    owner_phone: '0521234567',
    word_count: 80,
    status: 'closed',
    cancelled: false,
    created_at: iso(10),
    closed_at: iso(12),
    expires_at: iso(28),
    design: 'קלאסי',
    color: 'שחור',
    pawn_images: [],
    pawn_cutouts: {},
    extra_fields: {},
    chasers: false,
    theme: 'trip comeback',
    order,
  };
}

const base = { version: 'pickup', total: 199, quantity: 1, paid: true, address: null };

const ROWS = [
  // Produced and still here — the one the button is for.
  collection(0, 'להחזרה', { ...base, production: generated }),
  // Never produced: its last run errored, so it never left "נסגרו — להפקה".
  collection(1, 'שגיאה', {
    ...base,
    production: { state: 'error', errors: ['חסר גיל'] },
  }),
  // Already at the printer.
  collection(2, 'בדפוס', { ...base, production: generated, sent_to_print_at: iso(13) }),
  // Back from the printer and handed over.
  collection(3, 'מוכנה', {
    ...base,
    production: generated,
    sent_to_print_at: iso(13),
    ready_at: iso(14),
  }),
];

async function stubOrders(page) {
  await page.route('**/api/admin/collections?*', (route) =>
    route.fulfill({ json: { collections: ROWS } })
  );
  await page.route('**/api/admin/whatsapp/groups?*', (route) => route.fulfill({ json: {} }));
}

const undoFor = (page, id) =>
  page.locator(`[data-testid="undo-production"][data-collection="${id}"]`);

test.beforeEach(async ({ page }) => {
  await stubOrders(page);
});

test('offered on a produced order, and only on a produced order', async ({ page }) => {
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(undoFor(page, 'stub-0')).toBeVisible();
  // An errored run never left the production queue — there is no stage to move
  // it back to, so offering the button would be offering a no-op.
  await expect(undoFor(page, 'stub-1')).toHaveCount(0);
});

test('present but DEAD once the deck went to the printer, and says why', async ({ page }) => {
  await page.goto(`/admin.html?key=${KEY}`);
  const sent = undoFor(page, 'stub-2');
  await expect(sent).toBeDisabled();
  await expect(sent).toHaveAttribute('title', /בדפוס/);

  // Marked ready: the reason names BOTH stamps, in the order they come off.
  const ready = undoFor(page, 'stub-3');
  await expect(ready).toBeDisabled();
  await expect(ready).toHaveAttribute('title', /מוכן/);
});

test('asks first, and says what it will destroy', async ({ page }) => {
  await page.goto(`/admin.html?key=${KEY}`);
  let asked = null;
  page.on('dialog', (d) => {
    asked = d.message();
    d.dismiss();
  });
  let called = false;
  await page.route('**/production?*', (route) => {
    called = true;
    return route.fulfill({ json: { ok: true } });
  });

  await undoFor(page, 'stub-0').click();
  // The two consequences a button label cannot carry: the file goes, and the
  // order moves back a step.
  await expect.poll(() => asked).toMatch(/הקובץ/);
  expect(asked).toMatch(/נסגרו/);
  // Dismissed means nothing happened.
  expect(called).toBe(false);
});

test('confirming sends the DELETE and reloads the table', async ({ page }) => {
  await page.goto(`/admin.html?key=${KEY}`);
  page.on('dialog', (d) => d.accept());
  let method = null;
  let url = null;
  await page.route('**/production?*', (route) => {
    method = route.request().method();
    url = route.request().url();
    return route.fulfill({ json: { ok: true } });
  });

  await undoFor(page, 'stub-0').click();
  await expect.poll(() => method).toBe('DELETE');
  expect(url).toContain('/api/admin/collections/stub-0/production');
  // The key travels on the query string, like every other admin action here.
  expect(url).toContain(`key=${KEY}`);
});

test('a refusal is shown, and the button comes back', async ({ page }) => {
  await page.goto(`/admin.html?key=${KEY}`);
  const messages = [];
  page.on('dialog', (d) => {
    messages.push(d.message());
    d.accept();
  });
  await page.route('**/production?*', (route) =>
    route.fulfill({ status: 409, json: { error: 'stamped', detail: 'ההזמנה סומנה כנשלחה לדפוס' } })
  );

  const btn = undoFor(page, 'stub-0');
  await btn.click();
  // The server's own reason reaches the owner, rather than a silent no-op…
  await expect.poll(() => messages.join(' ')).toMatch(/סומנה כנשלחה לדפוס/);
  // …and the row is usable again, so she can act on what she was told.
  await expect(btn).toBeEnabled();
});
