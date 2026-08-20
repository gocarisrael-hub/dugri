// TWO WhatsApp numbers, and which one a link carries is a decision, not an
// accident.
//
//   • SUPPORT (0552441334) — every general "דברו איתנו": the footer icon, the
//     wizard's help button, the word-collection page, the confirmation page.
//     This is where a customer with a question lands.
//   • THE OWNER'S OWN (0546577715) — business enquiries only. She takes those
//     herself, and a quantity enquiry routed to support is a sale nobody answers.
//
// The number is written into each page by hand (there is no build step), so this
// file is what stops the two drifting into each other.
import { test, expect } from '@playwright/test';

const SUPPORT = /wa\.me\/972552441334/;
const OWNER = /wa\.me\/972546577715/;

test('the home footer WhatsApp goes to support', async ({ page }) => {
  await page.goto('/index.html');
  // The footer icon's href is written by the page's own config (js/configurator).
  await expect(page.locator('#waLink')).toHaveAttribute('href', SUPPORT);
});

test('the shop’s business line still goes to the owner herself', async ({ page }) => {
  await page.goto('/products.html');
  const b2b = page.getByTestId('store-b2b').locator('a');
  await expect(b2b).toHaveAttribute('href', OWNER);
});

test('the product page’s WhatsApp goes to support', async ({ page }) => {
  await page.goto('/product.html');
  const wa = page.locator('footer a[href*="wa.me"]').first();
  await expect(wa).toHaveAttribute('href', SUPPORT);
});

test('no page still carries the owner’s number on a general contact link', async ({ page }) => {
  for (const path of ['/index.html', '/how.html', '/collect.html', '/options.html']) {
    await page.goto(path);
    const hrefs = await page
      .locator('a[href*="wa.me"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    // Any link to the owner's number on these pages must be a business one; none
    // of these four pages has one, so the owner's number must not appear at all.
    expect(hrefs.filter((h) => OWNER.test(h))).toEqual([]);
  }
});
