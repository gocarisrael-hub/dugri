import { test, expect } from '@playwright/test';

// GA loadGA() is a no-op on localhost, so these tests never hit the network;
// they assert the dataLayer queue and the passive cookie notice, which run on
// all hosts. Analytics are no longer gated by consent (track-everyone).

test.describe('funnel events', () => {
  test('order_started event lands in dataLayer with the cta param', async ({ page }) => {
    await page.goto('/index.html');

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

test.describe('cookie notice (track-everyone, no gate)', () => {
  test('grants consent on load without a click, and the notice is dismissible', async ({
    page,
  }) => {
    await page.goto('/index.html');

    // Consent is granted immediately on load — no accept click required.
    const dataLayer = await page.evaluate(() => window.dataLayer.map((a) => Array.from(a)));
    const consentGranted = dataLayer.some(
      (entry) =>
        entry[0] === 'consent' &&
        entry[1] === 'update' &&
        entry[2] &&
        entry[2].analytics_storage === 'granted'
    );
    expect(consentGranted).toBe(true);

    // A passive notice shows once, and dismissing it removes it.
    const notice = page.locator('#cookieNotice');
    await expect(notice).toBeVisible();

    // It's stored as 'shown' the moment it renders, so it never appears again.
    const stored = await page.evaluate(() => localStorage.getItem('dugri_cookie_notice'));
    expect(stored).toBe('shown');

    await notice.locator('button').click();
    await expect(page.locator('#cookieNotice')).toHaveCount(0);

    // Reload: it's remembered as shown, so no notice this time.
    await page.reload();
    await expect(page.locator('#cookieNotice')).toHaveCount(0);
  });
});
