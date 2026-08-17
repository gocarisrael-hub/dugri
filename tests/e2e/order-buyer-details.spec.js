import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// WHO IS ORDERING AND WHAT THE PARTY IS, from her side of the screen. The owner's
// ask, in full: "add for the mail+phone stage also: 1. full name (free text -
// short) 2. type event (free text - short) 3. comments (free text - possible
// long)." The note (3) is covered in order-comment.spec.js; these are 1 and 2.
//
// THE NAME IS REQUIRED NOW and the event type is not. Both were optional when
// they shipped, on the argument that a gate on the last screen before the money
// costs orders; the owner overruled that for the name — "replace name with name
// of the person who order and make it must to write" — because an order that
// arrives as a mail address and a phone number is one she cannot even greet. So
// this file has two jobs it did not have before: that the wizard will not create
// an order without a name, and that it says so on screen rather than presenting a
// dead button. The event type is still skippable, and "she skipped it and checked
// out" is still a first-class case.
//
// THE NAME IS THE ORDERER'S, NOT THE HONOREE'S. Step 3 already asked for the name
// that gets printed on the cards; this is the person paying, and in almost every
// order those are two different people. Half of this file exists to prove the
// wizard keeps them apart — a page that quietly reused the honoree box would look
// perfect until the owner greeted the wrong person.
//
// The server side (sanitizing, the cap, the owner's email) is covered in
// tests/unit/order-buyer-details.test.js; the reachability of the two new fields
// on a phone is covered in wizard-noscroll.spec.js, which is the spec this
// feature's height budget has to answer to. This is the part only a browser can
// answer.

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

// On from the name step to the DETAILS step. 'Shira' is the HONOREE — the name
// that gets printed — and it is deliberately different from every buyer name
// typed below, so a test that passed by confusing the two would fail here.
//
// It fills the mail and the number ONLY, leaving the orderer's name empty: that
// is now the state the required-name tests need to observe, and every test that
// goes on to create an order fills the name itself.
async function toDetailsStep(page) {
  await page.getByTestId('custom-title-input').fill('Shira'); // this design asks for a Latin name
  await page.getByTestId('next-btn').click(); // -> pawn photos
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await page.getByTestId('next-btn').click(); // -> details
  await expect(page.getByTestId('step-4')).toBeVisible();
  await page.getByTestId('owner-email').fill('a@b.com');
  await page.getByTestId('owner-phone').fill('0521234567');
}

// Intercepts the order the wizard creates, so a test can read exactly what was
// posted without a real collection being made.
async function captureOrder(page) {
  const state = { posted: null };
  await page.route('**/api/collections', async (route) => {
    state.posted = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'c-test', owner_token: 't-test' }),
    });
  });
  return state;
}

test.describe('the buyer’s name and the event type, on the details step', () => {
  test('both are there, beside the email and the phone', async ({ page }) => {
    await toNameStep(page);
    await toDetailsStep(page);
    await expect(page.getByTestId('buyer-name-input')).toBeVisible();
    await expect(page.getByTestId('event-type-input')).toBeVisible();
  });

  test('the name field says whose name it wants', async ({ page }) => {
    // The one thing a buyer can get wrong here, and she would never find out: she
    // has just typed the honoree's name two steps ago, so a bare "שם מלא" invites
    // her to type it again. The label names the ORDERER outright and the hint
    // rules the other one out in as many words.
    await toNameStep(page);
    await toDetailsStep(page);
    const field = page.getByTestId('buyer-name-field');
    await expect(field).toContainText('המזמין');
    await expect(field).toContainText('לא של החוגג');
  });

  test('the name is not marked optional, and the event type still is', async ({ page }) => {
    // "(רשות)" is this step's word for optional and it is the ONLY marker on it,
    // so a label carrying it is a promise she can skip the box. The name may not
    // carry it any more; the event type beside it still must, or two blank boxes
    // on the screen where she is about to pay read as work she still owes us.
    await toNameStep(page);
    await toDetailsStep(page);
    await expect(page.getByTestId('buyer-name-field')).not.toContainText('רשות');
    await expect(page.getByTestId('event-type-field')).toContainText('רשות');
  });

  test('with no name there is no order — and the screen says why', async ({ page }) => {
    // The owner's rule, from the buyer's side. The mail and the number are filled
    // and correct, so the ONLY thing holding the button is the empty name — and a
    // held button with nothing on screen to explain it is the failure mode this
    // asserts against, not just the gate itself.
    await toNameStep(page);
    await toDetailsStep(page);
    const create = page.getByTestId('next-btn');
    await expect(create).toBeDisabled();
    await expect(page.getByTestId('buyer-name-err')).toBeVisible();

    // Typing a name releases it on the keystroke, with nothing else touched.
    await page.getByTestId('buyer-name-input').fill('דנה כהן');
    await expect(page.getByTestId('buyer-name-err')).toBeHidden();
    await expect(create).toBeEnabled();

    // …and clearing it again brings both back, so the rule is not a one-way latch
    // that a buyer can escape by typing a character and deleting it.
    await page.getByTestId('buyer-name-input').fill('');
    await expect(create).toBeDisabled();
    await expect(page.getByTestId('buyer-name-err')).toBeVisible();
  });

  test('a name made of spaces is not a name', async ({ page }) => {
    // The way through a required box that costs nothing to try. The server trims
    // this to null (tests/unit/order-buyer-details.test.js), so letting it pass
    // would produce exactly the nameless order the gate exists to prevent.
    await toNameStep(page);
    await toDetailsStep(page);
    await page.getByTestId('buyer-name-input').fill('   ');
    await expect(page.getByTestId('next-btn')).toBeDisabled();
    await expect(page.getByTestId('buyer-name-err')).toBeVisible();
  });

  test('what she typed in each survives a refresh of the step', async ({ page }) => {
    // A refresh on the last screen before paying is common — a bank app, a
    // WhatsApp check, a dead tab. Losing what she typed there is its own small
    // insult, and it is why these ride in the saved selection with the note.
    await toNameStep(page);
    await toDetailsStep(page);
    await page.getByTestId('buyer-name-input').fill('דנה כהן');
    await page.getByTestId('event-type-input').fill('בת מצווה של אחותי');
    await page.reload();
    await expect(page.getByTestId('buyer-name-input')).toHaveValue('דנה כהן');
    await expect(page.getByTestId('event-type-input')).toHaveValue('בת מצווה של אחותי');
  });

  test('both travel with the order she creates', async ({ page }) => {
    await toNameStep(page);
    const state = await captureOrder(page);
    await toDetailsStep(page);
    await page.getByTestId('buyer-name-input').fill('דנה כהן');
    await page.getByTestId('event-type-input').fill('פרישה');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => state.posted && state.posted.buyer_name).toBe('דנה כהן');
    expect(state.posted.event_type).toBe('פרישה');
  });

  test('the buyer’s name is posted BESIDE the honoree name, never instead of it', async ({
    page,
  }) => {
    // The regression that would matter most and show least: the game is about
    // Shira, and דנה is paying for it. If these two ever share a box, the cards
    // get printed with the wrong name on them.
    await toNameStep(page);
    const state = await captureOrder(page);
    await toDetailsStep(page);
    await page.getByTestId('buyer-name-input').fill('דנה כהן');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => state.posted && state.posted.buyer_name).toBe('דנה כהן');
    expect(state.posted.honoree_name).toBe('Shira');
  });

  test('an order that skips the event type still goes through', async ({ page }) => {
    // The half of the old "she answered neither" case that survives: only the
    // NAME became mandatory, and making the pair required would turn one line of
    // typing into a wall on the screen where she is about to pay.
    await toNameStep(page);
    const state = await captureOrder(page);
    await toDetailsStep(page);
    await page.getByTestId('buyer-name-input').fill('דנה כהן');
    await page.getByTestId('next-btn').click(); // create, event type untouched
    await expect.poll(() => state.posted && state.posted.event_type).toBe('');
    expect(state.posted.buyer_name).toBe('דנה כהן');
    expect(state.posted.honoree_name).toBe('Shira');
  });
});

// THE OWNER'S SIDE. She never opens the wizard, so as far as she is concerned
// these two fields do not exist until they show up on the order — in the edit
// dialog, in the same boxes she can correct after a phone call.
test.describe('the owner sees both on the order, and can fix them', () => {
  const KEY = 'dugri-admin';
  // Unique per call so the parallel device projects (one shared server + JSON
  // store) never collide on a honoree name.
  const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

  test('the order card shows what she typed, and the owner can correct it', async ({
    page,
    request,
  }) => {
    const honoree = uniq('חוגגת');
    const create = await request.post('/api/collections', {
      data: {
        honoree_name: honoree,
        email: 'details-test@example.com',
        phone: '0521234567',
        buyer_name: 'דנה כהן',
        event_type: 'בת מצווה של אחותי',
      },
    });
    const { id } = await create.json();

    await page.goto(`/admin.html?key=${KEY}`);
    await page.locator('tr', { hasText: honoree }).getByRole('button', { name: 'ערוך' }).click();
    await expect(page.locator('#edit')).toBeVisible();

    // What she typed is here, and it is here as ITSELF — the honoree name is in
    // its own box, untouched.
    await expect(page.locator('#e-buyer-name')).toHaveValue('דנה כהן');
    await expect(page.locator('#e-event-type')).toHaveValue('בת מצווה של אחותי');
    await expect(page.locator('#e-name')).toHaveValue(honoree);

    // The correction an owner actually makes: the buyer said something different
    // on the phone. It saves, and it sticks.
    await page.fill('#e-buyer-name', 'דנה כהן-לוי');
    await page.fill('#e-event-type', 'יום נישואין 25');
    await page.click('#e-save');
    await expect(page.locator('#edit')).toBeHidden();

    const after = await request.get(`/api/admin/collections?key=${KEY}`);
    const row = (await after.json()).collections.find((c) => c.id === id);
    expect(row.buyer_name).toBe('דנה כהן-לוי');
    expect(row.event_type).toBe('יום נישואין 25');
    expect(row.honoree_name).toBe(honoree);
  });
});
