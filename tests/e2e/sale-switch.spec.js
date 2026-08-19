import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// ENDING THE SALE HAS TO END IT EVERYWHERE.
//
// One owner switch (pricing.sale_on) is supposed to take the whole offer off the
// storefront at once — struck prices, the flag on each picture, the home strip.
// The product page's buy note was the hole in that: "מבצע השקה" was plain copy
// inside one editable line, so turning the sale off left the launch offer
// printed under the buy button. Worse, that line is PER-DESIGN copy, so clearing
// it by hand meant editing it once per design, and every new design shipped the
// phrase again.
//
// The phrase is its own element now and follows the switch. What the rest of the
// line says is unaffected: "מוכן תוך 3 ימי עסקים · ללא הגבלת מילים" is a standing
// fact about the product, not part of the offer.

const VERSIONS = {
  pdf: { enabled: true, price: 79 },
  pickup: { enabled: true, price: 199 },
  delivery: { enabled: false, price: 199 },
  custom: { enabled: false, price: 599 },
};

async function stubPricing(page, sale) {
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      json: { store: { now: 199, was: 239 }, versions: VERSIONS, sale },
    })
  );
}

const SALE_ON = { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' };
const SALE_OFF = { on: false, label: 'מחיר השקה', banner: '' };

const phrase = (page) => page.locator('.pdp-buy-note .buy-note-sale');
const rest = (page) => page.locator('[data-edit-pd="buy-note-rest"]');

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

test('with the sale ON, the buy note carries the launch phrase', async ({ page }) => {
  await stubPricing(page, SALE_ON);
  await page.goto('/product.html?design=bachelorette');
  await expect(page.locator('html')).toHaveAttribute('data-sale', 'on');
  await expect(phrase(page)).toBeVisible();
  await expect(phrase(page)).toHaveText('מבצע השקה');
  // The whole line still reads as one sentence, separator included.
  await expect(page.locator('.pdp-buy-note')).toContainText('מבצע השקה');
  await expect(page.locator('.pdp-buy-note')).toContainText('מוכן תוך 3 ימי עסקים');
});

test('turning the sale OFF takes the phrase away, and leaves the rest', async ({ page }) => {
  await stubPricing(page, SALE_OFF);
  await page.goto('/product.html?design=bachelorette');
  await expect(page.locator('html')).toHaveAttribute('data-sale', 'off');
  await expect(phrase(page)).toBeHidden();
  // The facts that are not part of the offer stay put — this is the failure the
  // split exists to avoid: hiding the whole line would take the delivery time
  // and the word cap with it.
  await expect(rest(page)).toBeVisible();
  await expect(rest(page)).toContainText('מוכן תוך 3 ימי עסקים');
  await expect(rest(page)).toContainText('ללא הגבלת מילים');
  // And nothing anywhere on the page still ADVERTISES the launch offer.
  // useInnerText, deliberately: textContent counts nodes the CSS has hidden, and
  // this rule is about what a shopper can read — the picture flag's markup is
  // always in the DOM and is hidden the same way.
  await expect(page.locator('body')).not.toContainText('מבצע השקה', { useInnerText: true });
  await expect(page.locator('body')).not.toContainText('מחיר השקה', { useInnerText: true });
});

test('the separator leaves with the phrase — no stranded "·"', async ({ page }) => {
  await stubPricing(page, SALE_OFF);
  await page.goto('/product.html?design=bachelorette');
  await expect(page.locator('html')).toHaveAttribute('data-sale', 'off');
  // The separator is the pseudo-element's, so it cannot survive its own element.
  // A line that opens with a bullet is the exact tell that this was done by
  // deleting text instead of hiding a node.
  const text = (await page.locator('.pdp-buy-note').innerText()).trim();
  expect(text.startsWith('·')).toBe(false);
  expect(text).toBe('מוכן תוך 3 ימי עסקים · ללא הגבלת מילים');
});

test('a failed pricing fetch prints no offer either', async ({ page }) => {
  // The fallback reports no sale (js/pricing.js), and an offer we could not
  // confirm is one we must not print — the same rule the flags and the home
  // strip follow.
  await page.route('**/api/pricing', (route) => route.abort('failed'));
  await page.goto('/product.html?design=bachelorette');
  await expect(rest(page)).toBeVisible();
  await expect(phrase(page)).toBeHidden();
});

test('both halves stay owner-editable, as separate fields', async ({ page }) => {
  await stubPricing(page, SALE_ON);
  await page.goto('/product.html?design=bachelorette');
  // Two keys, not one: the editor rewrites a bound node with textContent, so a
  // single key over both halves would wipe the split on the first edit.
  await expect(phrase(page)).toHaveAttribute('data-edit-pd', 'buy-note-sale');
  await expect(rest(page)).toHaveAttribute('data-edit-pd', 'buy-note-rest');
  // Per-design namespacing still applies to both (applyPerDesignFields stamps
  // data-edit from the design id).
  await expect
    .poll(() => phrase(page).getAttribute('data-edit'))
    .toBe('product-bachelorette-buy-note-sale');
  await expect
    .poll(() => rest(page).getAttribute('data-edit'))
    .toBe('product-bachelorette-buy-note-rest');
});
