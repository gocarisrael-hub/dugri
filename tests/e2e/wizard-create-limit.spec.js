import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The wizard's last step when the server's per-client creation limit refuses
// (POST /api/collections → 429). She is told to wait, not "something went
// wrong, try again", which would send her straight back into the same refusal.

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test('a refused create says to wait a few minutes and leaves her on the step', async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await page.route('**/api/wordlist-options', (route) => route.fulfill({ json: { options: [] } }));
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      json: {
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      },
    })
  );
  await page.route('**/api/collections', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 429, json: { error: 'too many attempts' } })
      : route.continue()
  );
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#customTitleInput', 'Shira');
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#ownerEmail', 'test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.fill('#buyerNameInput', 'דנה כהן');
  await page.getByTestId('next-btn').click();

  await expect(page.locator('#createErr')).toBeVisible();
  await expect(page.locator('#createErr')).toHaveText('יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.');
  await expect(page.getByTestId('next-btn')).toBeEnabled();
  expect(page.url()).toContain('/options.html');
});
