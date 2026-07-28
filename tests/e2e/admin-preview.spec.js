import { test, expect } from '@playwright/test';

const KEY = 'dugri-admin';

test('preview page lists messages and renders a branded mail in an iframe', async ({ page }) => {
  await page.goto(`/admin-preview.html?key=${KEY}`);

  // The catalog groups buyer mails, owner mails and WhatsApp triggers.
  await expect(page.locator('.group-label', { hasText: 'מיילים ללקוח/ה' })).toBeVisible();
  await expect(page.locator('.group-label', { hasText: 'וואטסאפ' })).toBeVisible();

  await page.getByRole('button', { name: 'אישור הזמנה ללקוח/ה' }).click();

  // The mail renders for real, inside a sandboxed iframe — logo and CTA included.
  const frame = page.locator('#panel iframe');
  await expect(frame).toBeVisible();
  // The branded shell renders for real. The hosted logo <img> only appears when
  // the server has a public origin to load it from (renderEmailHtml falls back to
  // the wordmark otherwise), and the E2E server has none — so assert the shell and
  // the interpolated order, and leave the logo/hero image to the unit test that
  // can set a baseUrl.
  const doc = page.frameLocator('#panel iframe');
  await expect(doc.locator('body')).toContainText('צוות דוגרי');
  await expect(doc.locator('body')).toContainText('שירה');
  // Sample order by default, so the page is useful with zero real orders.
  await expect(page.locator('.pill.sample')).toBeVisible();
});

test('a WhatsApp trigger renders as a chat bubble', async ({ page }) => {
  await page.goto(`/admin-preview.html?key=${KEY}`);
  await page.locator('.list button[data-id^="whatsapp/"]').first().click();
  await expect(page.locator('#panel .bubble')).toBeVisible();
  await expect(page.locator('#panel iframe')).toHaveCount(0);
});

test('without a key the page refuses instead of rendering an empty catalog', async ({ page }) => {
  await page.goto('/admin-preview.html');
  await expect(page.locator('#panel')).toContainText('חסר מפתח גישה');
});
