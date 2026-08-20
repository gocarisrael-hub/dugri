import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The free word quota on collect.html: a fresh collection may gather
// pricing.free_word_limit words (20 by default), after which the add controls
// lock and the pay panel becomes the next step. Drives the REAL server — no
// stubbed collection state — so the page and the API agree.
const FREE_LIMIT = 20; // the server-side cap — never shown to the buyer
const WORD_GOAL = 70; // the counter keeps its ordinary minimum framing throughout

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function createCollection(page, name) {
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
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#customTitleInput', name);
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#ownerEmail', 'quota@example.com');
  await page.fill('#ownerPhone', '0521234567');
  // The orderer's name is required on this step now ("make it must to write") —
  // without it the create button never enables. The rule itself is tested in
  // order-buyer-details.spec.js; here it is just part of getting to an order.
  await page.fill('#buyerNameInput', 'דנה כהן');
  await page.getByTestId('next-btn').click();
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
}

// Paste `n` distinct words in one go through the list tab, and WAIT for the add
// to finish before returning.
//
// The wait is load-bearing, not politeness. The submit handler clears the box
// only after its POST and the follow-up refresh have both resolved, so a caller
// that fires and returns can type the next paste into a box that is about to be
// cleared out from under it — the second batch then submits as an empty string
// and silently never happens. Two terminal states are possible: the box is empty
// (everything landed) or the dialog is up (something did not).
async function pasteWords(page, n, prefix = 'word') {
  const list = Array.from({ length: n }, (_, i) => prefix + (i + 1)).join('\n');
  await page.click('#tab-list');
  await page.fill('#pasteBox', list);
  await page.click('#pasteAdd');
  await expect
    .poll(async () => {
      if (await page.locator('#msgModal').isVisible()) return true;
      return (await page.locator('#pasteBox').inputValue()) === '';
    })
    .toBe(true);
}

test('quota: nothing hints at the cap, then the add box locks at the limit', async ({ page }) => {
  await createCollection(page, 'Quota');

  // Below the quota the page gives NOTHING away: the counter keeps its ordinary
  // minimum framing, no "free" wording anywhere, and the add box works. The lock
  // is meant to be a surprise.
  await pasteWords(page, 5);
  await expect(page.locator('#count')).toHaveText('5');
  await expect(page.locator('#countMax')).toContainText(String(WORD_GOAL));
  await expect(page.locator('#countMax')).not.toContainText(String(FREE_LIMIT));
  await expect(page.locator('.count-pill')).not.toContainText('חינם');
  await expect(page.locator('#countHint')).not.toContainText('חינם');
  await expect(page.getByTestId('free-limit-lock')).toBeHidden();
  await expect(page.locator('#wordInput')).toBeEnabled();

  // …and the limit isn't sitting in the API payload either, where a curious
  // buyer (or a scraper) would find it in the Network tab BEFORE reaching it.
  const id = new URL(page.url()).searchParams.get('c');
  const view = await (await page.request.get('/api/collections/' + id)).json();
  expect(view).not.toHaveProperty('free_word_limit');

  // Overshoot the quota in one paste: the server takes only what fits, so the
  // count stops exactly at the limit and the lock engages.
  await pasteWords(page, 40, 'extra');
  // Overshooting now raises a dialog naming what did not fit (see the partial-paste
  // spec). Dismiss it — it is modal, so it would swallow every click below.
  await page.locator('#msgModalOk').click();
  await expect(page.locator('#count')).toHaveText(String(FREE_LIMIT));
  await expect(page.getByTestId('free-limit-lock')).toBeVisible();
  await expect(page.locator('#wordInput')).toBeDisabled();
  await expect(page.locator('#addBtn')).toBeDisabled();

  // The owner gets a way out: a pay CTA that opens the checkout panel.
  const payBtn = page.getByTestId('lock-pay-btn');
  await expect(payBtn).toBeVisible();
  await payBtn.click();
  await expect(page.locator('#payPanel')).toHaveAttribute('open', '');
  // …and it took her there: the checkout is the תשלום tab, and a CTA that opened
  // a panel she cannot see would be a CTA that does nothing.
  await expect(page.getByTestId('tab-pay')).toHaveClass(/\bon\b/);

  // Back on her words — one tap, and nothing was taken away.
  await page.getByTestId('tab-words').click();

  // Words already collected stay on the page — nothing is taken away.
  await expect(page.locator('[data-testid="word-text"]').first()).toBeVisible();

  // The sharing card is still there while locked: inviting friends is the whole
  // point of the collection and must not depend on payment. Still the single
  // managing link here too — the lock must not change which link is offered.
  await expect(page.getByTestId('share-whatsapp')).toBeVisible();
  await expect(page.locator('#sharePanel input')).toHaveCount(1);
  const shared = await page.locator('#friendsLink').inputValue();
  expect(shared).toContain('/collect.html?c=');
  expect(shared).toContain('k=');

  // The LOCKED screen is where the number would most easily creep back in — the
  // chip, the note and the counter hint all render fresh here.
  await expect(page.getByTestId('free-limit-lock')).not.toContainText(String(FREE_LIMIT));
  await expect(page.locator('.count-pill')).not.toContainText('חינם');
  await expect(page.locator('#countHint')).not.toContainText(String(FREE_LIMIT));

  // And the locked screen must not still be urging them to add more through a
  // disabled box — that reads as broken rather than as a paywall.
  await expect(page.locator('#countHint')).toContainText('מושהה');
  await expect(page.getByTestId('free-limit-lock')).toContainText('תשלום');
});

test('quota: a partial paste says what did NOT make it, in a dialog that cannot be missed', async ({
  page,
}) => {
  await createCollection(page, 'Partial');
  // 15 words in, 5 slots left, then paste 40: the server stores 5 and holds 35.
  await pasteWords(page, FREE_LIMIT - 5);
  await pasteWords(page, 40, 'late');

  await expect(page.locator('#count')).toHaveText(String(FREE_LIMIT));
  // The buyer is TOLD what happened, and told it in a dialog she has to dismiss.
  // A toast that fades in 1.8s is exactly how someone walks to the payment page
  // believing all 40 words landed.
  const dialog = page.locator('#msgModal');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('35');
  await page.click('#msgModalOk');

  // …and their typing is still on screen, not wiped by a "success" clear.
  await expect(page.locator('#pasteBox')).toHaveValue(/late40/);
});

test('quota: the words that did not fit are SHOWN, and survive leaving the page', async ({
  page,
}) => {
  await createCollection(page, 'Held');
  await pasteWords(page, FREE_LIMIT + 12);
  await page.locator('#msgModalOk').click();

  // The 12 that did not fit are on the page as themselves — not summarised, not
  // described, not promised. The buyer reads her own words back.
  const held = page.getByTestId('held-words');
  await expect(held).toBeVisible();
  await expect(held.locator('[data-testid="held-word-text"]')).toHaveCount(12);
  await expect(held).toContainText('word' + (FREE_LIMIT + 12));

  // They are NOT counted as collected — the counter, the bar and the deck must
  // only ever see words that have been paid for.
  await expect(page.locator('#count')).toHaveText(String(FREE_LIMIT));

  // THE regression. This is the exact journey that lost 135 words: the buyer
  // leaves for the payment page and comes back to a reloaded tab. The textarea
  // is empty by then — everything now rests on the server having kept them.
  await page.goto('/');
  await page.goBack();
  await expect(page.getByTestId('held-words')).toBeVisible();
  await expect(
    page.getByTestId('held-words').locator('[data-testid="held-word-text"]')
  ).toHaveCount(12);

  // And the lock no longer tells her everything is safe. It used to end
  // "כל המילים שאספתם שמורות" while the overflow was being dropped on the floor.
  await expect(page.getByTestId('free-limit-lock')).not.toContainText('שמורות');
});

test('quota: a contributor on the public link sees the lock without a pay button', async ({
  page,
}) => {
  await createCollection(page, 'Contributor');
  await pasteWords(page, FREE_LIMIT + 3);
  await expect(page.getByTestId('free-limit-lock')).toBeVisible();

  // Same collection, friends link (no owner token).
  const id = new URL(page.url()).searchParams.get('c');
  await page.goto('/collect.html?c=' + id);
  await expect(page.getByTestId('free-limit-lock')).toBeVisible();
  // A contributor can't pay for someone else's order, so no CTA is offered.
  await expect(page.getByTestId('lock-pay-btn')).toBeHidden();
  await expect(page.locator('#wordInput')).toBeDisabled();
});
