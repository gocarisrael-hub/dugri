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

// --- editing from inside the preview -----------------------------------------
// The draft tests deliberately never save: a draft render is preview-only, which
// also makes them immune to the two device projects sharing one settings store.
test('typing in the editor re-renders the mail from the UNSAVED draft', async ({ page }) => {
  let savedSettings = false;
  page.on('request', (req) => {
    if (req.url().includes('/api/admin/settings') && req.method() === 'POST') savedSettings = true;
  });
  await page.goto(`/admin-preview.html?key=${KEY}`);
  await page.getByRole('button', { name: 'אישור הזמנה ללקוח/ה' }).click();

  // The editor is seeded with the STORED template, brace tokens and all.
  await expect(page.locator('#fSubject')).toHaveValue(/\{honoree\}/);

  const unique = 'נושא טיוטה ' + Date.now();
  await page.locator('#fSubject').fill(unique);
  await expect(page.locator('#panel .subject')).toHaveText(unique);

  // Typing must not write anything — the owner is still deciding.
  expect(savedSettings).toBe(false);
});

test('a drafted WhatsApp text renders in the bubble with its tokens filled in', async ({
  page,
}) => {
  await page.goto(`/admin-preview.html?key=${KEY}`);
  await page.locator('.list button[data-id="whatsapp/group_opened"]').click();
  await page.locator('#fBody').fill('טיוטה על {honoree}');
  // {honoree} resolves against the sample order, exactly as a real send would.
  await expect(page.locator('#panel .bubble')).toHaveText('טיוטה על שירה');
});

test('unchecking the switch marks the preview as not-sent before saving', async ({ page }) => {
  await page.goto(`/admin-preview.html?key=${KEY}`);
  await page.getByRole('button', { name: 'תזכורת להוסיף מילים' }).click();
  await expect(page.locator('.pill.off')).toHaveCount(0);
  await page.locator('#fEnabled').uncheck();
  await expect(page.locator('.pill.off')).toBeVisible();
});

test('saving persists the edit through the settings API', async ({ page, request }) => {
  await page.goto(`/admin-preview.html?key=${KEY}`);
  await page.getByRole('button', { name: 'הזמנה חדשה (לבעלת העסק)' }).click();

  const unique = 'נושא שמור ' + Date.now();
  await page.locator('#fSubject').fill(unique);
  // Read the page's OWN save response: the sibling device project writes the same
  // shared key, so a re-fetch could observe its value instead of ours.
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/admin/settings') && r.request().method() === 'POST'
    ),
    page.locator('#save').click(),
  ]);
  expect(resp.ok()).toBeTruthy();
  expect((await resp.json()).effective.subject).toBe(unique);
  await expect(page.locator('#edStatus')).toHaveText(/נשמר/);

  // The preview page maps this message onto the order_paid template.
  const r = await request.delete(
    `/api/admin/settings?section=email&settingKey=order_paid&key=${KEY}`
  );
  expect(r.ok()).toBeTruthy();
});

test('a message composed in code says so instead of offering an editor', async ({ page }) => {
  await page.goto(`/admin-preview.html?key=${KEY}`);
  await page.getByRole('button', { name: 'התראת מערכת' }).click();
  await expect(page.locator('#panel .note')).toBeVisible();
  await expect(page.locator('#editor')).toHaveCount(0);
  // It still previews — read-only, not blank.
  await expect(page.locator('#panel pre.text')).toBeVisible();
});
