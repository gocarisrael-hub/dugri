import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The wizard hands the collection it creates the way this browser ARRIVED, so the
// sale can be credited to the ad even when the buyer pays later from the email on
// another device (server: db.setArrival + /api/track). This spec holds the
// browser half: the create request carries the campaign — and nothing else from
// the address, which on an order page can include the owner token.

// A 1x1 transparent PNG standing in for the rendered preview.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function mockPreview(page) {
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      }),
    })
  );
}

test('the order it creates carries the campaign the buyer arrived on', async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await mockPreview(page);
  let posted = null;
  await page.route('**/api/collections', async (route) => {
    posted = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'c-test', owner_token: 't-test' }),
    });
  });

  await page.goto(
    '/options.html?plan=base&utm_source=instagram&utm_medium=story&utm_campaign=story_alma'
  );
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId('next-btn').click(); // -> step 2
  await page.getByTestId('next-btn').click(); // -> step 3
  await expect(page.getByTestId('step-3')).toBeVisible();
  await page.getByTestId('custom-title-input').fill('Shira');
  await page.getByTestId('next-btn').click(); // -> pawn photos
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await page.getByTestId('next-btn').click(); // -> details
  await expect(page.getByTestId('step-4')).toBeVisible();
  await page.getByTestId('owner-email').fill('a@b.com');
  await page.getByTestId('owner-phone').fill('0521234567');
  await page.getByTestId('buyer-name-input').fill('דנה כהן');
  await page.getByTestId('next-btn').click(); // create

  await expect.poll(() => posted !== null).toBe(true);
  expect(posted.arrival).toBeTruthy();
  expect(posted.arrival.landing).toContain('utm_campaign=story_alma');
  expect(posted.arrival.landing).toContain('/options.html');
  // Only campaign parameters survive: not the wizard's own step/plan state.
  expect(posted.arrival.landing).not.toContain('plan=');
  expect(posted.arrival.landing).not.toContain('step=');
  expect(typeof posted.arrival.referrer).toBe('string');
});
