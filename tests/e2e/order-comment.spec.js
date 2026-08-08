import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// THE NOTE SHE LEAVES WITH HER ORDER, from her side of the screen: there is
// somewhere to say it, what she types survives a refresh, and it travels with
// the order rather than being quietly dropped.
//
// It lives CLOSED on the name step, behind one line she taps to open. That is
// forced rather than chosen: every step of this wizard is held to "fits a phone
// with no scrolling" (wizard-noscroll), and on an iPhone 14 the roomiest step has
// 2px of slack against a 141px text box. A button costs a line, and only the
// buyers who want the box pay for the box.
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

// Open the note, the way a buyer does.
async function openNote(page) {
  await page.getByTestId('order-comment-toggle').click();
  await expect(page.getByTestId('order-comment-input')).toBeVisible();
}

// On from the name step, for the tests that need to reach the order itself.
async function toDetailsStep(page) {
  await page.getByTestId('honoree-input').fill('Shira'); // this design asks for a Latin name
  await page.getByTestId('gender-female').check();
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
    // Closed, it is one line — and it has to read as a way IN, not as a caption,
    // because a buyer who cannot see a box has no other clue there is one.
    const toggle = page.getByTestId('order-comment-toggle');
    await expect(toggle).toBeVisible();
    await expect(page.getByTestId('order-comment-input')).toBeHidden();
    await openNote(page);
    // The one thing she must be able to trust about this box: what she writes
    // here does NOT end up on the cards.
    await expect(page.getByTestId('order-comment-field')).toContainText('לא מודפסת');
  });

  test('what she typed survives a refresh of the step — and comes back OPEN', async ({ page }) => {
    await toNameStep(page);
    await openNote(page);
    const note = 'זו הפתעה - אל תתקשרו אליה';
    await page.getByTestId('order-comment-input').fill(note);
    await page.reload();
    // Restored shut, it would read as having thrown her note away.
    await expect(page.getByTestId('order-comment-input')).toBeVisible();
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
    await openNote(page);
    await page.getByTestId('order-comment-input').fill('צריך עד יום חמישי');
    await toDetailsStep(page);
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => posted && posted.comment).toBe('צריך עד יום חמישי');
  });

  test('closed, it costs the step no scrolling', async ({ page }) => {
    // The reason it is a button at all. If someone later reopens this as a plain
    // text box, wizard-noscroll fails — but it fails over there, describing a
    // gender control, and nothing points back here. This says it in the place
    // that explains it.
    await page.setViewportSize({ width: 390, height: 844 });
    await toNameStep(page);
    await expect(page.getByTestId('order-comment-toggle')).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
      )
      .toBeLessThanOrEqual(4);
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
