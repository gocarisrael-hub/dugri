import { test, expect } from '@playwright/test';

const KEY = 'dugri-admin';

// Unique per call so parallel device projects (which share one server + JSON
// store) never collide on a honoree name.
const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

// Seed a collection straight through the API (faster + more controllable than
// the wizard). Optionally attach words, an order, and mark it paid.
async function seed(request, { name, email, phone, words, version, paid }) {
  const create = await request.post('/api/collections', {
    data: { honoree_name: name, email, phone },
  });
  const { id, owner_token } = await create.json();
  if (words && words.length) {
    await request.post(`/api/collections/${id}/words`, { data: { words } });
  }
  if (version) {
    await request.post(`/api/collections/${id}/order`, { data: { owner_token, version } });
    if (paid) {
      await request.post(`/api/admin/collections/${id}/paid?key=${KEY}`);
    }
  }
  return { id, owner_token };
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
    version: 'pdf',
    paid: true,
  });
  await seed(request, { name: leadName, email: 'lead@example.com', phone: '0541234567' });

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

test('order table fits the viewport width — no horizontal scroll', async ({ page, request }) => {
  // Seed a row with deliberately long values (email + word list) that would
  // otherwise force the wide table to overflow sideways.
  await seed(request, {
    name: uniq('רחב'),
    email: 'a-really-long-admin-address-that-could-overflow@some-long-domain-name.example.com',
    phone: '0521234567',
    words: ['מילהארוכהמאודמאודמאודללארווחים', 'עוד', 'מילים', 'רבות'],
    version: 'pdf',
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
