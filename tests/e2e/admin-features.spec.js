import { test, expect } from '@playwright/test';

// The owner feature-flags editor (admin-features.html) toggles the four buyer-
// wizard flags through the same settings API as the texts editor, behind the
// admin key. The e2e server runs with ADMIN_KEY=dugri-admin and DATA_DIR=.e2e-data
// (throwaway), so overrides written here never touch real data.
const KEY = 'dugri-admin';
const FLAGS = ['color_picking', 'chasers_choice', 'font_choice', 'name_preview'];

// This spec WRITES the shared live features store. The two device projects
// share one server (one DATA_DIR), so running it on all three would race the
// same keys (toggle vs. reload vs. reset). It asserts UI wiring, not device
// layout, so run it once on a single project — no cross-worker interleaving.
test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'Desktop Chrome',
    'writes the shared settings store; run once to avoid cross-worker races'
  );
});

// Restore a flag to its default (off) so the store is left clean for a reused
// dev server (settingKey — the `key` query param is the admin secret).
async function resetFlag(request, k) {
  const r = await request.delete(
    `/api/admin/settings?section=features&settingKey=${encodeURIComponent(k)}&key=${KEY}`
  );
  expect(r.ok()).toBeTruthy();
}

test.describe('admin feature flags editor', () => {
  test.afterEach(async ({ request }) => {
    // Leave every flag at its default (off), whatever the test did.
    for (const k of FLAGS) await resetFlag(request, k);
  });

  test('without a key the page reveals nothing and asks for ?key=', async ({ page }) => {
    let hitAdmin = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/settings')) hitAdmin = true;
    });
    await page.goto('/admin-features.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    expect(hitAdmin).toBe(false);
  });

  test('renders a toggle card for every flag, all off by default', async ({ page }) => {
    await page.goto(`/admin-features.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();
    for (const k of FLAGS) {
      const box = page.getByTestId('flag-' + k);
      await expect(box).toBeVisible();
      await expect(box).not.toBeChecked(); // default OFF
    }
    // font-choice carries the "requires name-preview" note.
    await expect(page.locator('#card-features-font-choice .hint')).toContainText('תצוגה מקדימה');
  });

  test('toggle + Save persists across a reload; Reset restores off', async ({ page }) => {
    page.on('dialog', (d) => d.accept()); // reset asks for confirmation
    await page.goto(`/admin-features.html?key=${KEY}`);
    const card = page.locator('#card-features-color-picking');
    await expect(card).toBeVisible();

    // Turn it on and save.
    await page.getByTestId('flag-color_picking').check();
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/admin/settings') && r.request().method() === 'POST'
      ),
      card.locator('button[data-save]').click(),
    ]);
    expect(resp.ok()).toBeTruthy();
    expect((await resp.json()).effective).toBe(true);
    await expect(card.locator('.status')).toHaveText(/נשמר/);

    // Persists across a reload: the checkbox comes back checked.
    await page.reload();
    await expect(page.getByTestId('flag-color_picking')).toBeChecked();

    // Reset restores the default (off).
    const card2 = page.locator('#card-features-color-picking');
    const [resetResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/admin/settings') && r.request().method() === 'DELETE'
      ),
      card2.locator('button[data-reset]').click(),
    ]);
    expect(resetResp.ok()).toBeTruthy();
    expect((await resetResp.json()).effective).toBe(false);
    await expect(page.getByTestId('flag-color_picking')).not.toBeChecked();
  });

  test('opens from the texts-editor page nav, carrying the key', async ({ page }) => {
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const link = page.locator('#nav a[data-page="admin-features.html"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /admin-features\.html\?key=/);
    await link.click();
    await expect(page).toHaveURL(/admin-features\.html\?key=/);
    await expect(page.locator('#app')).toBeVisible();
  });
});
