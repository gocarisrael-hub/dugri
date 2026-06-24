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
    expect(text).toContain('בסיס'); // base
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
    expect(text).toContain('בסיס'); // base
    expect(text).not.toContain('original');
  });
});
