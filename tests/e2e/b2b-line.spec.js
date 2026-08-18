import { test, expect } from '@playwright/test';

// The "are you a business?" contact line. It exists in three places, and each
// one is a different KIND of promise:
//   • the footer of every public page — a third contact row, phone-only;
//   • the shop heading — the same offer with a WhatsApp link, for a visitor who
//     lands on products.html from an ad and never sees the home page;
//   • the FAQ — a shipped question, covered by admin-faq.spec.js.
//
// What these tests defend is the QUIET part. The line converts nothing if it
// shouts: it must stay the size and colour of the contact block it joins, and
// it must never grow into a button competing with the buy CTA. A regression
// here is somebody "improving" it into a banner, so the assertions are about
// weight and size, not just presence.

const PUBLIC_PAGES = [
  ['/index.html', 'index'],
  ['/products.html', 'products'],
  ['/product.html', 'product'],
];

test.describe('B2B line — the footer row', () => {
  for (const [url, prefix] of PUBLIC_PAGES) {
    test(`${url} carries it under the phone/mail row`, async ({ page }) => {
      await page.goto(url);
      const row = page.locator('[data-testid="footer-b2b"]');
      await expect(row).toBeVisible();
      // A reachable number, in the line itself: the enquiry has to be actionable
      // where it is read, without hunting back up the footer.
      await expect(row).toContainText('0546577715');
      // Both halves are owner-editable, and they are SEPARATE nodes on purpose:
      // the inline editor rewrites a bound node with textContent, so a label
      // nested inside the sentence would be wiped on her first edit.
      await expect(row.locator(`[data-edit="${prefix}-footer-b2b-label"]`)).toHaveText('לעסקים:');
      await expect(row.locator(`[data-edit="${prefix}-footer-b2b"]`)).toBeVisible();
    });

    test(`${url} keeps it as quiet as the contact row above it`, async ({ page }) => {
      await page.goto(url);
      const row = page.locator('[data-testid="footer-b2b"]');
      const contact = page.locator('footer .foot-contact').first();
      const sizeOf = (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(await sizeOf(row)).toBeLessThanOrEqual(await sizeOf(contact));
      // It sits BELOW the contact block — the phone/mail a buyer came for is
      // never pushed down by an offer aimed at somebody else.
      const rowBox = await row.boundingBox();
      const contactBox = await contact.boundingBox();
      expect(rowBox.y).toBeGreaterThan(contactBox.y);
      // And no button ever grew here.
      await expect(row.locator('button, .btn')).toHaveCount(0);
    });
  }
});

test.describe('B2B line — the shop heading', () => {
  test('sits under the subtitle and reaches WhatsApp', async ({ page }) => {
    await page.goto('/products.html');
    const line = page.locator('[data-testid="store-b2b"]');
    await expect(line).toBeVisible();

    const cta = line.locator('.store-b2b-cta');
    await expect(cta).toHaveAttribute('href', /wa\.me\/972546577715/);
    await expect(cta).toHaveAttribute('target', '_blank');
    await expect(cta).toHaveAttribute('rel', /noopener/);
    // Tagged so the owner can tell a business enquiry from a general one.
    await expect(cta).toHaveAttribute('data-ga-where', 'store-b2b');

    const sub = page.locator('[data-testid="store-sub"]');
    const [lineBox, subBox] = [await line.boundingBox(), await sub.boundingBox()];
    expect(lineBox.y).toBeGreaterThan(subBox.y);
  });

  test('never outweighs the store subtitle it follows', async ({ page }) => {
    await page.goto('/products.html');
    const px = (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const line = page.locator('[data-testid="store-b2b"]');
    const sub = page.locator('[data-testid="store-sub"]');
    // `.store-head p` sets colour/size/weight for everything in this block, so a
    // bare `.store-b2b` rule would lose to it on specificity and the line would
    // silently render at subtitle size. This is that regression's tripwire.
    expect(await px(line)).toBeLessThan(await px(sub));
    // It must not steal the eye from the design grid below it.
    await expect(line.locator('button, .btn')).toHaveCount(0);
  });

  test('does not push the design grid off the first screen', async ({ page }) => {
    await page.goto('/products.html');
    const grid = page.locator('[data-testid="store-grid"]');
    const box = await grid.boundingBox();
    const vh = page.viewportSize().height;
    // The pictures are what sells this page; the line is one row of 14.5px text
    // and must not cost the grid its place near the fold.
    expect(box.y).toBeLessThan(vh);
  });
});
