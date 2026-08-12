import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// THE NOTE SHE LEAVES WITH HER ORDER, from her side of the screen: there is
// somewhere to say it, what she types survives a refresh, and it travels with
// the order rather than being quietly dropped.
//
// It is a plain, open box on the details step, beside the email and the phone.
// It was moved once and folded behind a button once, both times to satisfy "fits
// a phone with no scrolling"; the owner then dropped that rule ("forget about
// this"). What the step still owes her — that she can reach every control — is
// asserted in wizard-noscroll.
//
// The server side (sanitizing, admin, the owner's email) is covered in
// tests/unit/order-comment.test.js; this is the part only a browser can answer.

// A 1x1 transparent PNG standing in for the rendered preview.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// The step is gated on the preview arriving, so stub it: nothing here is about
// the picture, and the real render is a Chrome-in-Chrome job.
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

async function toNameStep(page) {
  await stubFeatures(page, ALL_ON);
  await mockPreview(page);
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId('next-btn').click(); // -> step 2 (colour + add-ons)
  await page.getByTestId('next-btn').click(); // -> step 3 (name + options)
  await expect(page.getByTestId('step-3')).toBeVisible();
}

// On from the name step to the DETAILS step, where the note lives.
async function toDetailsStep(page) {
  await page.getByTestId('custom-title-input').fill('Shira'); // this design asks for a Latin name
  await page.getByTestId('next-btn').click(); // -> pawn photos
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await page.getByTestId('next-btn').click(); // -> details
  await expect(page.getByTestId('step-4')).toBeVisible();
  await page.getByTestId('owner-email').fill('a@b.com');
  await page.getByTestId('owner-phone').fill('0521234567');
}

test.describe('the note a buyer leaves with her order', () => {
  test('there is somewhere to say it, and it says it is not printed', async ({ page }) => {
    await toNameStep(page);
    await toDetailsStep(page);
    await expect(page.getByTestId('order-comment-input')).toBeVisible();
    // The one thing she must be able to trust about this box: what she writes
    // here does NOT end up on the cards.
    await expect(page.getByTestId('order-comment-field')).toContainText('לא מודפסת');
  });

  test('what she typed survives a refresh of the step', async ({ page }) => {
    await toNameStep(page);
    await toDetailsStep(page);
    const note = 'זו הפתעה - אל תתקשרו אליה';
    await page.getByTestId('order-comment-input').fill(note);
    await page.reload();
    await expect(page.getByTestId('order-comment-input')).toHaveValue(note);
  });

  test('it travels with the order she creates', async ({ page }) => {
    await toNameStep(page);
    let posted = null;
    await page.route('**/api/collections', async (route) => {
      posted = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'c-test', owner_token: 't-test' }),
      });
    });
    await toDetailsStep(page);
    await page.getByTestId('order-comment-input').fill('צריך עד יום חמישי');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => posted && posted.comment).toBe('צריך עד יום חמישי');
  });

  test('a buyer on a phone can reach it, and the step scrolls to let her', async ({ page }) => {
    // What replaced "the step must not scroll": the box is 141px on a step that
    // had 2px to spare, so the step scrolls now — and scrolling has to actually
    // deliver her to it, clear of the sticky bar rather than under it.
    await page.setViewportSize({ width: 390, height: 844 });
    await toNameStep(page);
    await toDetailsStep(page);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const bar = document.querySelector('.wiz-bar').getBoundingClientRect();
          const el = document
            .querySelector('[data-testid="order-comment-input"]')
            .getBoundingClientRect();
          return Math.round(el.bottom - bar.top);
        })
      )
      .toBeLessThanOrEqual(0);
    await page.getByTestId('order-comment-input').fill('נא לארוז כמתנה');
    await expect(page.getByTestId('order-comment-input')).toHaveValue('נא לארוז כמתנה');
  });

  test('an order with nothing to say still goes through', async ({ page }) => {
    await toNameStep(page);
    let posted = null;
    await page.route('**/api/collections', async (route) => {
      posted = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'c-test', owner_token: 't-test' }),
      });
    });
    await toDetailsStep(page);
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => posted && posted.comment).toBe('');
  });
});
