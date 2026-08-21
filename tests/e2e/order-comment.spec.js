import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// THE NOTE BOX IS GONE FROM THE WIZARD — the owner asked for it removed, so a
// customer is no longer offered a free-text box on the details step.
//
// What is left of the feature is the OWNER's side: `comment` is still stored on
// an order, still shown and editable in the admin dialog, and still reaches her
// order email. That is how she records what a customer told her on WhatsApp, and
// it is covered in tests/unit/order-comment.test.js. Existing orders keep the
// notes their buyers already left.
//
// So this file is a GUARD, not a feature spec: it holds the wizard to not asking
// for one, and holds the step that used to end with it to still working without
// it. Written as tests rather than deleted, because "there is no box" is exactly
// the kind of thing a later change re-adds by accident.

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

// On from the name step to the DETAILS step, where the note lives. It fills every
// REQUIRED box on the step — the mail, the number and the orderer's name — because
// nothing in this file is about them: an order that cannot be created holds the
// note tests hostage to a gate they are not testing. (The name became required
// when the owner asked for it; see order-buyer-details.spec.js.)
async function toDetailsStep(page) {
  await page.getByTestId('custom-title-input').fill('Shira'); // this design asks for a Latin name
  await page.getByTestId('next-btn').click(); // -> pawn photos
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await page.getByTestId('next-btn').click(); // -> details
  await expect(page.getByTestId('step-4')).toBeVisible();
  await page.getByTestId('owner-email').fill('a@b.com');
  await page.getByTestId('owner-phone').fill('0521234567');
  await page.getByTestId('buyer-name-input').fill('דנה כהן');
}

test.describe('the wizard no longer asks the customer for a note', () => {
  test('the details step carries no note box at all', async ({ page }) => {
    await toNameStep(page);
    await toDetailsStep(page);
    // Neither the input nor the label that framed it ("לא מודפסת על הקלפים").
    await expect(page.getByTestId('order-comment-input')).toHaveCount(0);
    await expect(page.getByTestId('order-comment-field')).toHaveCount(0);
  });

  test('and the order it creates carries no comment', async ({ page }) => {
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
    await expect.poll(() => posted !== null).toBe(true);
    // Absent, not an empty string: the field is gone, so there is nothing to
    // send. (The route still ACCEPTS a comment — that is what the admin edit
    // path writes — it simply is not offered to a buyer any more.)
    expect(posted.comment).toBeUndefined();
    // The two short answers that shared the step with it are untouched.
    expect(posted.buyer_name).toBe('דנה כהן');
  });

  test('the step still completes on a phone, with the box removed', async ({ page }) => {
    // The note box was the tallest thing on this step and the last control on
    // it. Removing it must not have left the step in a state where the end of
    // the form is unreachable under the sticky bar.
    await page.setViewportSize({ width: 390, height: 844 });
    await toNameStep(page);
    await toDetailsStep(page);
    const last = page.getByTestId('event-type-input');
    await last.scrollIntoViewIfNeeded();
    const clear = await page.evaluate(() => {
      const bar = document.querySelector('.wiz-bar').getBoundingClientRect();
      const el = document.querySelector('[data-testid="event-type-input"]').getBoundingClientRect();
      return Math.round(el.bottom - bar.top);
    });
    expect(clear).toBeLessThanOrEqual(0);
    await last.fill('יום הולדת 40');
    await expect(last).toHaveValue('יום הולדת 40');
  });

  test('nothing it left behind breaks a refresh of the step', async ({ page }) => {
    // The note was persisted into localStorage with the rest of the selection.
    // A buyer mid-wizard when this shipped still has that key, so the restore
    // must ignore what it no longer knows about rather than throwing on it.
    await toNameStep(page);
    await toDetailsStep(page);
    await page.evaluate(() => {
      const sel = JSON.parse(localStorage.getItem('dugri_selection') || '{}');
      sel.orderComment = 'הערה משמורה ישנה';
      localStorage.setItem('dugri_selection', JSON.stringify(sel));
    });
    await page.reload();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await expect(page.getByTestId('order-comment-input')).toHaveCount(0);
    // …and the fields that ARE still restored came back.
    await expect(page.getByTestId('buyer-name-input')).toHaveValue('דנה כהן');
  });
});
