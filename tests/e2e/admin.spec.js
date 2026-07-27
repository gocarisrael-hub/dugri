import { test, expect } from '@playwright/test';

const KEY = 'dugri-admin';

// Unique per call so parallel device projects (which share one server + JSON
// store) never collide on a honoree name.
const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

// Seed a collection straight through the API (faster + more controllable than
// the wizard). Optionally attach words and an order.
//
// It cannot seed a PAID order: there is no admin "mark as paid" route, because an
// order may go paid only on a real money event (a verified card callback, or a
// 100%-coupon order — and the E2E server runs without card credentials on
// purpose). A test that needs a paid row injects the flag into the admin list
// response instead — see markRowPaid.
async function seed(request, { name, email, phone, words, version, extra_fields }) {
  const create = await request.post('/api/collections', {
    data: { honoree_name: name, email, phone, extra_fields },
  });
  const { id, owner_token } = await create.json();
  if (words && words.length) {
    await request.post(`/api/collections/${id}/words`, { data: { words } });
  }
  if (version) {
    await request.post(`/api/collections/${id}/order`, { data: { owner_token, version } });
  }
  return { id, owner_token };
}

// Report ONE seeded collection as paid to the admin page, by patching the admin
// list response on its way to the browser. The server state is untouched — this
// is for tests about how the page RENDERS a paid order (stat bar, filter tabs),
// not about how an order becomes paid.
async function markRowPaid(page, honoreeName) {
  await page.route('**/api/admin/collections*', async (route) => {
    const resp = await route.fetch();
    const body = await resp.json();
    for (const c of body.collections || []) {
      if (c.honoree_name === honoreeName && c.order) c.order.paid = true;
    }
    return route.fulfill({ json: body });
  });
}

test('admin lists created collections (with key) and rejects wrong key', async ({
  page,
  request,
}) => {
  await seed(request, {
    name: uniq('אוט'),
    email: 'admin-test@example.com',
    phone: '0521234567',
  });

  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('table')).toBeVisible();
  await expect(page.locator('table')).toContainText('admin-test@example.com');

  await page.goto('/admin.html?key=wrong');
  await expect(page.locator('body')).toContainText('מפתח גישה שגוי');
});

test('stat bar + filter tabs narrow the rows', async ({ page, request }) => {
  const paidName = uniq('שולם');
  const leadName = uniq('ליד');
  await seed(request, {
    name: paidName,
    email: 'paid@example.com',
    phone: '0501112222',
    words: ['א', 'ב', 'ג'],
    version: 'pickup', // pickup is the enabled-by-default checkout version
  });
  await seed(request, { name: leadName, email: 'lead@example.com', phone: '0541234567' });
  await markRowPaid(page, paidName);

  await page.goto(`/admin.html?key=${KEY}`);

  // Stat bar: five tiles, one of them revenue.
  await expect(page.locator('#stats .stat')).toHaveCount(5);
  await expect(page.locator('#stats')).toContainText('הכנסות');
  await expect(page.locator('#stats')).toContainText('לידים');

  // "הכל" shows both rows.
  const paidRow = page.locator('tbody tr').filter({ hasText: paidName });
  const leadRow = page.locator('tbody tr').filter({ hasText: leadName });
  await expect(paidRow).toHaveCount(1);
  await expect(leadRow).toHaveCount(1);

  // "שולמו" hides the unpaid lead, keeps the paid order.
  await page.locator('.tab', { hasText: 'שולמו' }).click();
  await expect(paidRow).toHaveCount(1);
  await expect(leadRow).toHaveCount(0);
});

test('follow-up buttons carry the right hrefs', async ({ page, request }) => {
  const name = uniq('מעקב');
  await seed(request, { name, email: 'follow@example.com', phone: '0541234567' });

  await page.goto(`/admin.html?key=${KEY}`);
  const row = page.locator('tbody tr').filter({ hasText: name });
  await expect(row.locator('a.wa')).toHaveAttribute('href', 'https://wa.me/972541234567');
  await expect(row.locator('a', { hasText: 'חיוג' })).toHaveAttribute('href', 'tel:0541234567');
  await expect(row.locator('a', { hasText: 'מייל' })).toHaveAttribute(
    'href',
    'mailto:follow@example.com'
  );
});

test('בטל marks cancelled + שחזר restores; מחק removes the row', async ({ page, request }) => {
  page.on('dialog', (dialog) => dialog.accept());
  const name = uniq('בטל');
  await seed(request, { name, email: 'cancel@example.com', phone: '0539998888' });

  await page.goto(`/admin.html?key=${KEY}`);
  const row = page.locator('tbody tr').filter({ hasText: name });
  await expect(row).toHaveCount(1);

  // Cancel -> muted מבוטלת badge appears in the row.
  await row.getByRole('button', { name: 'בטל' }).click();
  await expect(row.locator('.pill.cancelled').first()).toBeVisible();
  await expect(row.getByRole('button', { name: 'שחזר' })).toBeVisible();

  // Restore -> back to an active row with a בטל button.
  await row.getByRole('button', { name: 'שחזר' }).click();
  await expect(row.getByRole('button', { name: 'בטל' })).toBeVisible();

  // Delete (double confirm auto-accepted) -> the row disappears.
  await row.getByRole('button', { name: 'מחק' }).click();
  await expect(page.locator('tbody tr').filter({ hasText: name })).toHaveCount(0);
});

test('פתח מחדש reopens a closed collection so it accepts words again', async ({
  page,
  request,
}) => {
  page.on('dialog', (dialog) => dialog.accept());
  const name = uniq('פתח');
  const { id, owner_token } = await seed(request, {
    name,
    email: 'reopen@example.com',
    phone: '0537776666',
    words: ['ראשונה'],
  });
  // Owner closes the list — it now refuses new words (409).
  await request.post(`/api/collections/${id}/close`, { data: { owner_token } });
  const rejected = await request.post(`/api/collections/${id}/words`, {
    data: { words: ['לפני'] },
  });
  expect(rejected.status()).toBe(409);

  await page.goto(`/admin.html?key=${KEY}`);
  const row = page.locator('tbody tr').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.pill.closed').first()).toBeVisible();

  // Reopen -> status flips back to open (פתוח) and the reopen button is gone.
  await row.getByRole('button', { name: 'פתח מחדש' }).click();
  await expect(row.locator('.pill.open').first()).toBeVisible();
  await expect(row.getByRole('button', { name: 'פתח מחדש' })).toHaveCount(0);

  // The collection accepts words again.
  const accepted = await request.post(`/api/collections/${id}/words`, {
    data: { words: ['אחרי'] },
  });
  expect(accepted.status()).toBe(200);
});

test('order table fits the viewport width — no horizontal scroll', async ({ page, request }) => {
  // Seed a row with deliberately long values (email + word list) that would
  // otherwise force the wide table to overflow sideways.
  await seed(request, {
    name: uniq('רחב'),
    email: 'a-really-long-admin-address-that-could-overflow@some-long-domain-name.example.com',
    phone: '0521234567',
    words: ['מילהארוכהמאודמאודמאודללארווחים', 'עוד', 'מילים', 'רבות'],
    version: 'pickup', // pickup is the enabled-by-default checkout version
  });

  const noOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  // Narrow phone (~375px): the table stacks into cards and must not side-scroll.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('tbody tr').first()).toBeVisible();
  expect(await noOverflow()).toBe(true);

  // Desktop (1280px): same guarantee.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('tbody tr').first()).toBeVisible();
  expect(await noOverflow()).toBe(true);
});

test('per-order extra fields (age / anniversary years + names) show in the table', async ({
  page,
  request,
}) => {
  // Anniversary order: YEARS + NAME1 + NAME2 collected on the order.
  const anniv = uniq('נישואין');
  await seed(request, {
    name: anniv,
    email: 'anniv@example.com',
    phone: '0521110000',
    extra_fields: { YEARS: '25', NAME1: 'דנה', NAME2: 'יוסי' },
  });
  // Kids birthday order: AGE only.
  const kid = uniq('גילה');
  await seed(request, {
    name: kid,
    email: 'kid@example.com',
    phone: '0522220000',
    extra_fields: { AGE: '8' },
  });

  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('table')).toBeVisible();

  const annivRow = page.locator('tbody tr').filter({ hasText: anniv });
  await expect(annivRow).toContainText('שנות נישואין: 25');
  await expect(annivRow).toContainText('שם 1: דנה');
  await expect(annivRow).toContainText('שם 2: יוסי');

  const kidRow = page.locator('tbody tr').filter({ hasText: kid });
  await expect(kidRow).toContainText('גיל: 8');
});

// The WhatsApp column. The E2E server runs with the bot dormant, so no order has
// a group and every row must offer the "open one via the bot" action. The group
// map is served by a SEPARATE endpoint, so this also covers the two responses
// being stitched together per row rather than the column silently going blank.
test('WhatsApp column offers to open a group for an order that has none', async ({
  page,
  request,
}) => {
  const name = uniq('וואטס');
  await seed(request, { name, email: 'wa-col@example.com', phone: '0521234567' });

  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('table')).toBeVisible();
  await expect(page.locator('thead')).toContainText('וואטסאפ');

  const row = page.locator('tbody tr', { hasText: name });
  await expect(row.getByRole('button', { name: 'פתח קבוצה בבוט' })).toBeVisible();
  // No group exists, so the "open the existing group" action must NOT be offered
  // — it would 404 and read as a broken button.
  await expect(row.getByRole('button', { name: 'פתח קבוצה', exact: true })).toHaveCount(0);
});

// A row whose collection HAS a group flips to the link-into-the-group action.
// The group map endpoint is stubbed because linking a real group needs a live
// Whapi channel, which E2E deliberately does not have.
test('WhatsApp column links into the group when one exists', async ({ page, request }) => {
  const name = uniq('וואטסג');
  const { id } = await seed(request, { name, email: 'wa-grp@example.com', phone: '0521234567' });

  await page.route('**/api/admin/whatsapp/groups?*', async (route) =>
    route.fulfill({ json: { groups: { [id]: { groupId: '120363001@g.us', closed: false } } } })
  );

  await page.goto(`/admin.html?key=${KEY}`);
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row.getByRole('button', { name: 'פתח קבוצה', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'פתח קבוצה בבוט' })).toHaveCount(0);
});
