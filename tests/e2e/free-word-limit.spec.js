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
  await page.fill('#honoreeInput', name);
  await page.getByTestId('gender-female').check();
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#ownerEmail', 'quota@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.getByTestId('next-btn').click();
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
}

// Paste `n` distinct words in one go through the list tab.
async function pasteWords(page, n, prefix = 'word') {
  const list = Array.from({ length: n }, (_, i) => prefix + (i + 1)).join('\n');
  await page.click('#tab-list');
  await page.fill('#pasteBox', list);
  await page.click('#pasteAdd');
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
  await expect(page.locator('#count')).toHaveText(String(FREE_LIMIT));
  await expect(page.getByTestId('free-limit-lock')).toBeVisible();
  await expect(page.locator('#wordInput')).toBeDisabled();
  await expect(page.locator('#addBtn')).toBeDisabled();

  // The owner gets a way out: a pay CTA that opens the checkout panel.
  const payBtn = page.getByTestId('lock-pay-btn');
  await expect(payBtn).toBeVisible();
  await payBtn.click();
  await expect(page.locator('#payPanel')).toHaveAttribute('open', '');

  // Words already collected stay on the page — nothing is taken away.
  await expect(page.locator('[data-testid="word-text"]').first()).toBeVisible();

  // The sharing card is still there while locked: inviting friends is the whole
  // point of the collection and must not depend on payment. It is the single
  // PUBLIC link here too — the lock must never push the owner token out.
  await expect(page.getByTestId('share-whatsapp')).toBeVisible();
  await expect(page.locator('#sharePanel input')).toHaveCount(1);
  const shared = await page.locator('#friendsLink').inputValue();
  expect(shared).toContain('/collect.html?c=');
  expect(shared).not.toContain('k=');

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

test('quota: a partial paste says how many words did NOT make it, and keeps them', async ({
  page,
}) => {
  await createCollection(page, 'Partial');
  // 15 words in, 5 slots left, then paste 40: the server stores 5 and refuses 35.
  await pasteWords(page, FREE_LIMIT - 5);
  await page.click('#tab-list');
  const rest = Array.from({ length: 40 }, (_, i) => 'late' + (i + 1)).join('\n');
  await page.fill('#pasteBox', rest);
  await page.click('#pasteAdd');

  await expect(page.locator('#count')).toHaveText(String(FREE_LIMIT));
  // The buyer is TOLD what was lost — silently eating 35 typed words is the
  // failure this guards.
  const toast = page.locator('#toast');
  await expect(toast).toContainText('35');
  await expect(toast).toContainText('לא נוספו');
  // …and their typing is still on screen, not wiped by a "success" clear.
  await expect(page.locator('#pasteBox')).toHaveValue(/late40/);
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
