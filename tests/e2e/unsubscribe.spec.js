import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';

// The page a buyer lands on from the link in her mail: one tap to stop, one tap
// back. Unauthenticated on purpose — she has an email, not an account — so the
// signature in the link stands in for a login.
//
// The E2E server signs with a known key (playwright.config.js), so these tests
// mint exactly the link the server would have put in her mail. No route exists to
// hand one out, and none should.
const KEY = 'dugri-admin';
const SECRET = 'e2e-unsubscribe-secret';

const uniqEmail = () => `stop-${Math.random().toString(36).slice(2, 10)}@example.com`;
const tokenFor = (email) =>
  crypto.createHmac('sha256', SECRET).update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
const linkFor = (email) =>
  `/unsubscribe.html?e=${encodeURIComponent(email)}&t=${encodeURIComponent(tokenFor(email))}`;

const isListed = async (request, email) => {
  const r = await request.get(`/api/admin/unsubscribed?key=${KEY}`);
  const body = await r.json();
  return (body.addresses || []).some((a) => a.email === email);
};

test('stop, and back again — the page reports the state it finds each time', async ({
  page,
  request,
}) => {
  const email = uniqEmail();

  await page.goto(linkFor(email));
  await expect(page.locator('#title')).toContainText('להפסיק');
  // Before she presses, the page says what she is giving up. The suppression is
  // total, so promising less than that here would be a lie by omission.
  await expect(page.locator('.what')).toContainText('קבלה');
  await expect(page.locator('.what')).toContainText('מוכן');

  await page.locator('#stop').click();
  await expect(page.locator('#title')).toHaveText('הפסקנו לשלוח לך מיילים');
  expect(await isListed(request, email)).toBe(true);

  // Reopening shows the state it FINDS — a mail client's own one-click control
  // may have unsubscribed before the page was ever opened.
  await page.goto(linkFor(email));
  await expect(page.locator('#title')).toHaveText('הפסקנו לשלוח לך מיילים');

  // …and the way back, because one tap in a mail client is easy to do by accident.
  await page.locator('#undo').click();
  await expect(page.locator('#title')).toHaveText('חזרת לרשימה');
  expect(await isListed(request, email)).toBe(false);
});

test('a tampered link does nothing at all', async ({ page, request }) => {
  const email = uniqEmail();
  // Somebody else's valid token against this address — the shape is right, the
  // signature is not.
  const stolen = tokenFor('someone-else@example.com');
  await page.goto(`/unsubscribe.html?e=${encodeURIComponent(email)}&t=${stolen}`);
  await expect(page.locator('#title')).toHaveText('קישור לא תקין');
  await expect(page.locator('button')).toHaveCount(0);
  expect(await isListed(request, email)).toBe(false);
});

test('a link with no address says so rather than half-working', async ({ page }) => {
  await page.goto('/unsubscribe.html');
  await expect(page.locator('#title')).toHaveText('קישור לא תקין');
});

test('the API refuses an address without its own token', async ({ request }) => {
  const email = uniqEmail();
  const r = await request.post('/api/unsubscribe', { data: { email, token: 'x'.repeat(32) } });
  expect(r.status()).toBe(403);
  expect(await isListed(request, email)).toBe(false);
});

// Mail clients POST to the List-Unsubscribe URL without opening anything (RFC
// 8058). Same route as the page's button, so the two cannot drift apart.
test('the one-click POST a mail client sends works on its own', async ({ request }) => {
  const email = uniqEmail();
  const r = await request.post(
    `/api/unsubscribe?e=${encodeURIComponent(email)}&t=${tokenFor(email)}`
  );
  expect(r.ok()).toBeTruthy();
  expect(await isListed(request, email)).toBe(true);
});

test('the owner can stop and resume an address by hand, and only with the key', async ({
  request,
}) => {
  const email = uniqEmail();
  expect((await request.post('/api/admin/unsubscribed', { data: { email } })).status()).toBe(403);

  const on = await request.post(`/api/admin/unsubscribed?key=${KEY}`, { data: { email } });
  expect(on.ok()).toBeTruthy();
  expect(await isListed(request, email)).toBe(true);

  const off = await request.post(`/api/admin/unsubscribed?key=${KEY}`, {
    data: { email, unsubscribed: false },
  });
  expect(off.ok()).toBeTruthy();
  expect(await isListed(request, email)).toBe(false);
});

// The owner has to be able to SEE it, or a buyer who gets no receipt looks like
// broken email rather than a choice the buyer made.
test('the orders table flags a buyer who has stopped her mail', async ({ page, request }) => {
  const email = uniqEmail();
  const name = 'שקטה-' + Math.random().toString(36).slice(2, 8);
  const create = await request.post('/api/collections', {
    data: { honoree_name: name, email },
  });
  expect(create.ok()).toBeTruthy();

  await page.goto(`/admin.html?key=${KEY}`);
  const row = page.locator('tbody tr').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('unsubscribed-flag')).toHaveCount(0);

  await request.post(`/api/admin/unsubscribed?key=${KEY}`, { data: { email } });
  await page.reload();
  await expect(row.getByTestId('unsubscribed-flag')).toBeVisible();
  await expect(row.getByTestId('unsubscribed-flag')).toContainText('ביטלה');
});
