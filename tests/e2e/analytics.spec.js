import { test, expect } from '@playwright/test';

// GA loadGA() is a no-op on localhost, so these tests never hit the network;
// they assert the dataLayer queue and the consent banner behavior, which run
// on all hosts.

test.describe('funnel events', () => {
  test('order_started event lands in dataLayer with the cta param', async ({ page }) => {
    await page.goto('/index.html');
    await page.locator('#cookieConsent >> text=לא תודה').click();

    // Prevent navigation so we can read dataLayer after the delegated push.
    await page.evaluate(() => {
      document.querySelectorAll('a[data-ga]').forEach((a) => {
        a.addEventListener('click', (e) => e.preventDefault());
      });
    });

    await page.locator('.hero-cta a[data-ga="order_started"]').first().click();

    const dataLayer = await page.evaluate(() => window.dataLayer.map((a) => Array.from(a)));
    const found = dataLayer.some(
      (entry) =>
        entry[0] === 'event' && entry[1] === 'order_started' && entry[2] && entry[2].cta === 'hero'
    );
    expect(found).toBe(true);
  });
});

test.describe('cookie consent banner', () => {
  test('shows on first load; accepting grants consent and the bar disappears on reload', async ({
    page,
  }) => {
    await page.goto('/index.html');

    const bar = page.locator('#cookieConsent');
    await expect(bar).toBeVisible();

    await bar.locator('text=מקובל').click();
    await expect(bar).toBeHidden();

    const stored = await page.evaluate(() => localStorage.getItem('dugri_consent'));
    expect(stored).toBe('granted');

    const dataLayer = await page.evaluate(() => window.dataLayer.map((a) => Array.from(a)));
    const consentUpdate = dataLayer.some(
      (entry) =>
        entry[0] === 'consent' &&
        entry[1] === 'update' &&
        entry[2] &&
        entry[2].analytics_storage === 'granted'
    );
    expect(consentUpdate).toBe(true);

    // Reload: consent is remembered, so no bar this time.
    await page.reload();
    await expect(page.locator('#cookieConsent')).toHaveCount(0);
  });

  test('declining stores denied and removes the bar', async ({ page }) => {
    await page.goto('/index.html');
    const bar = page.locator('#cookieConsent');
    await expect(bar).toBeVisible();

    await bar.locator('text=לא תודה').click();
    await expect(bar).toBeHidden();

    const stored = await page.evaluate(() => localStorage.getItem('dugri_consent'));
    expect(stored).toBe('denied');
  });
});
