// pay-done.html after a failed payment. Inside the payment window it only hands the result to the checkout behind it.
// At the top level there is no checkout behind it, and the page used to be a red line and nothing else: no logo, no
// link, a dead end unless a way back had been stored. Now it always carries the logo, home and WhatsApp, and the way
// back to the collection first when there is one.
import { test, expect } from '@playwright/test';

test('a failure at the top level is never a dead end: the logo, home and WhatsApp', async ({
  page,
}) => {
  await page.goto('/pay-done.html?error=1');
  await expect(page.locator('#msg')).toHaveText('התשלום לא הושלם');
  await expect(page.locator('#logo')).toBeVisible();
  await expect(page.locator('#logo')).toHaveAttribute('href', '/');
  await expect(page.locator('#homeLink')).toBeVisible();
  await expect(page.locator('#homeLink')).toHaveAttribute('href', '/');
  await expect(page.locator('#waLink')).toBeVisible();
  await expect(page.locator('#waLink')).toHaveAttribute(
    'href',
    /^https:\/\/wa\.me\/972552441334\?text=/
  );
  // No collection was stored, so there is no way back to one.
  await expect(page.locator('#back')).toBeHidden();

  await page.evaluate(() => sessionStorage.setItem('dugri:payReturn', '/collect.html?c=x'));
  await page.reload();
  await expect(page.locator('#back')).toBeVisible();
  await expect(page.locator('#back')).toHaveAttribute('href', '/collect.html?c=x');
  await expect(page.locator('#homeLink')).toBeVisible();
});

test('inside the payment window the page shows no logo and no links: it hands off', async ({
  page,
}) => {
  // Inert parent: the frame's message goes nowhere, and the frame stays on screen to be looked at.
  await page.goto('/terms.html');
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.id = 'pf';
    f.src = '/pay-done.html?error=1';
    document.body.appendChild(f);
  });
  const frame = page.frameLocator('#pf');
  await expect(frame.locator('#msg')).toHaveText('התשלום לא הושלם');
  await expect(frame.locator('#logo')).toBeHidden();
  await expect(frame.locator('#away')).toBeHidden();
});
