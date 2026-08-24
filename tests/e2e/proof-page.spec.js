// The buyer's proof screen, driven through a browser.
//
// The pages are intercepted rather than produced: this spec is about what the
// buyer can DO with her deck — read it, enlarge one card, step through — and
// about the states she can arrive in with a link that has gone stale. Whether
// the pictures match the PDF is settled in generator/test_proof_sheet.py, which
// runs a real ghostscript over a real file.
import { test, expect } from '@playwright/test';

const CID = 'proof-e2e-order';
const T = 'tok-123';
const URL = `/proof.html?c=${CID}&t=${T}`;

// A 1x1 webp, so the grid has something real to lay out.
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

async function serveDeck(page, pages) {
  await page.route('**/api/collections/*/proof?*', (route) =>
    route.fulfill({ json: { pages, width: 320, name: 'הדר בת 30' } })
  );
  await page.route('**/api/collections/*/proof/*', (route) =>
    route.fulfill({ contentType: 'image/webp', body: WEBP })
  );
}

test('every page of the deck is on the screen', async ({ page }) => {
  await serveDeck(page, 12);
  await page.goto(URL);
  await expect(page.locator('#sheet .card')).toHaveCount(12);
  await expect(page.locator('#state')).toBeHidden();
});

test('a card opens large, and steps to its neighbours', async ({ page }) => {
  await serveDeck(page, 6);
  await page.goto(URL);
  await page.locator('#sheet .card').nth(2).click();
  const dlg = page.locator('#big');
  await expect(dlg).toBeVisible();
  // The enlarged card must actually be BIGGER than the thumbnail — a dialog
  // sized to its content once collapsed the stage to nothing, and the "large"
  // view came back smaller than the card it came from.
  const thumb = await page.locator('#sheet .card').nth(2).boundingBox();
  const big = await page.locator('#big .stage').boundingBox();
  expect(big.width).toBeGreaterThan(thumb.width);
  await expect(page.locator('#bigImg')).toHaveAttribute('alt', 'קלף 3');
  await page.locator('#next').click();
  await expect(page.locator('#bigImg')).toHaveAttribute('alt', 'קלף 4');
  await page.locator('#prev').click();
  await page.locator('#prev').click();
  await expect(page.locator('#bigImg')).toHaveAttribute('alt', 'קלף 2');
  await page.locator('#close').click();
  await expect(dlg).toBeHidden();
});

test('the first card does not step off the front of the deck', async ({ page }) => {
  await serveDeck(page, 4);
  await page.goto(URL);
  await page.locator('#sheet .card').first().click();
  await page.locator('#prev').click();
  await expect(page.locator('#bigImg')).toHaveAttribute('alt', 'קלף 1');
});

test('the WhatsApp line carries the order, so we know what she is looking at', async ({ page }) => {
  await serveDeck(page, 3);
  await page.goto(URL);
  const href = await page.locator('#wa').getAttribute('href');
  expect(href).toContain('wa.me/972552441334');
  expect(decodeURIComponent(href)).toContain(CID);
  expect(decodeURIComponent(href)).toContain('הדר בת 30');
});

test('an order that is not produced yet says so, and shows no empty grid', async ({ page }) => {
  await page.route('**/api/collections/*/proof?*', (route) =>
    route.fulfill({ status: 404, json: { error: 'no pdf' } })
  );
  await page.goto(URL);
  await expect(page.locator('#state')).toContainText('עוד לא מוכנה');
  await expect(page.locator('#deck')).toBeHidden();
});

test('a link with a dead token says what to do about it', async ({ page }) => {
  await page.route('**/api/collections/*/proof?*', (route) =>
    route.fulfill({ status: 403, json: { error: 'forbidden' } })
  );
  await page.goto(URL);
  await expect(page.locator('#state')).toContainText('לא תקף');
});

test('a link with no token at all is not sent to the server', async ({ page }) => {
  let asked = false;
  await page.route('**/api/collections/**', (route) => {
    asked = true;
    return route.fulfill({ status: 403, json: {} });
  });
  await page.goto('/proof.html?c=' + CID);
  await expect(page.locator('#state')).toContainText('חסר');
  expect(asked).toBe(false);
});
