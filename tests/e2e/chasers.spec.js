import { test, expect } from '@playwright/test';

// Full flow for the optional "צ'ייסרים" drinking-game add-on:
// toggle it in step 3 of the order wizard -> finish the wizard (name + contact)
// -> the owner sees the 🥃 badge in the admin orders table.
test('chasers add-on flows from the wizard into the order and admin', async ({ page }) => {
  await page.goto('/options.html?plan=base');

  // Step 1 -> 2 -> 3, then turn the add-on on (carries ?chasers=1).
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  // The chasers add-on icon is the owner-provided photo, not the old svg.
  const chasersIco = page.locator('#chasersCard img.addon-ico');
  await expect(chasersIco).toHaveAttribute('src', 'assets/ico-chasers.png');
  await expect(page.locator('#chasersCard svg.addon-ico')).toHaveCount(0);
  await page.getByTestId('chasers-toggle').check();
  await expect(page.getByTestId('chasers-toggle')).toBeChecked();
  expect(page.url()).toContain('chasers=1');

  // the toggle's "on" state paints the warm-sand accent (--accent #b7a389),
  // not the old near-black ink (poll past the 0.2s background transition).
  await expect
    .poll(() =>
      page
        .locator('#chasersCard .switch input:checked + .track')
        .evaluate((el) => getComputedStyle(el).backgroundColor)
    )
    .toBe('rgb(183, 163, 137)');

  // Step 3 -> 4 (name) -> 5 (contact) -> create the shared collection.
  // The default design (bachelorette) is an ENGLISH theme, so the honoree must
  // be a single English word; digits are rejected in a name, so the unique
  // suffix is letters-only (a → j digit encoding) rather than Date.now().
  const honoree = 'Chaser' + String(Date.now()).replace(/[0-9]/g, (d) => 'abcdefghij'[+d]);
  await page.getByTestId('next-btn').click();
  await page.fill('#honoreeInput', honoree);
  await page.getByTestId('gender-female').check(); // gender is required to advance
  await page.getByTestId('next-btn').click();
  await page.fill('#ownerEmail', 'chasers-test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.getByTestId('next-btn').click();
  await page.waitForURL(/collect\.html/);

  // The owner's admin view shows a ✓ in the chasers column for this order.
  await page.goto('/admin.html?key=dugri-admin');
  const row = page.locator('tr', { hasText: honoree }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('✓');
});
