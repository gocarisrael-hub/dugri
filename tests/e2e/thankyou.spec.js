import { test, expect } from '@playwright/test';

// thankyou.html echoes the configurator selection. When localStorage is empty
// (other device / private window) it falls back to the URL params, which carry
// raw English ids (design=<id>, color=<id>|original, plan=<id>). The page must
// translate those to Hebrew names and never leak the raw ids.

test.describe('thankyou selection echo', () => {
  test('URL-fallback ids are shown as Hebrew names, not raw English', async ({ page }) => {
    // Arrive with only URL params and an empty localStorage (fresh context).
    await page.goto('/thankyou.html?design=birthday&color=violet&plan=base');

    const line = page.getByTestId('selection-line');
    await expect(line).toBeVisible();

    const text = await line.innerText();
    // Hebrew names appear.
    expect(text).toContain('יום הולדת'); // birthday
    expect(text).toContain('סגול'); // violet
    expect(text).toContain('החבילה המלאה'); // base
    // Raw English ids must NOT leak.
    expect(text).not.toContain('birthday');
    expect(text).not.toContain('violet');
    expect(text).not.toContain('base');
  });

  test('color=original is shown as מקורי', async ({ page }) => {
    await page.goto('/thankyou.html?design=kids&color=original&plan=base');
    const line = page.getByTestId('selection-line');
    await expect(line).toBeVisible();
    const text = await line.innerText();
    expect(text).toContain('יום הולדת לילדים'); // kids
    expect(text).toContain('מקורי'); // original
    expect(text).toContain('החבילה המלאה'); // base
    expect(text).not.toContain('original');
  });
});

// Pay-first flow: email AND a valid Israeli mobile are both required, and are
// validated before a collection is created.
test.describe('thankyou create-collection validation', () => {
  test('email + phone are both required and validated; valid input creates the collection', async ({
    page,
  }) => {
    await page.goto('/thankyou.html');
    await page.fill('#honoreeInput', 'שירה');

    // No contact at all → blocked with an email error.
    await page.click('#createBtn');
    await expect(page.locator('#createErr')).toBeVisible();
    await expect(page.locator('#createErr')).toContainText('מייל');

    // Valid email but no phone → blocked with a phone error.
    await page.fill('#ownerEmail', 'owner@example.com');
    await page.click('#createBtn');
    await expect(page.locator('#createErr')).toBeVisible();
    await expect(page.locator('#createErr')).toContainText('טלפון');

    // Invalid phone → still blocked.
    await page.fill('#ownerPhone', '12345');
    await page.click('#createBtn');
    await expect(page.locator('#createErr')).toBeVisible();
    await expect(page.locator('#createErr')).toContainText('טלפון');

    // Valid email + valid IL mobile → creates the collection and redirects.
    await page.fill('#ownerPhone', '0521234567');
    await page.click('#createBtn');
    await page.waitForURL(/collect\.html\?c=.+&k=.+/);
  });

  test('name hint about the cards is shown; old how-to category card is gone', async ({ page }) => {
    await page.goto('/thankyou.html');
    await expect(page.locator('.collab')).toContainText('יופיע על הקלפים');
    // The big always-open how-to card moved to collect.html.
    await expect(page.locator('body')).not.toContainText('איך אוספים מילים טובות');
  });
});
