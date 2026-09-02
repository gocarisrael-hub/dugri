import { test, expect } from '@playwright/test';

// THE PUBLIC WORD-LIST PAGE.
//
// The wizard names the filler lists and nothing more, so a buyer picks "רווקות"
// over "משפחתי" on a label alone — a label that decides ~300 of the 412 words
// printed on her cards. This page is the label made good on.
//
// Every test here STUBS /api/wordlist-preview rather than building a real menu.
// That menu is one global setting, and tests that write it race each other
// across workers (see the note at the top of wordlist-menu.spec.js). The page's
// behaviour is what is under test here, and a stub pins it exactly — including
// the two shapes a real menu can't be made to hold on demand: empty, and broken.
const LISTS = {
  lists: [
    { id: 'a', label: 'רווקות', count: 3, words: ['כלה', 'שושבינה', 'ריקוד'] },
    { id: 'b', label: 'ילדים', count: 2, words: ['כדורגל', 'ריקוד'] },
  ],
};

const stub = (page, body) =>
  page.route('**/api/wordlist-preview', (route) => route.fulfill({ json: body }));

test('every word of every list is on the page, under its own heading', async ({ page }) => {
  await stub(page, LISTS);
  await page.goto('/wordlists.html');

  const sections = page.locator('main section');
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).toContainText('רווקות');
  await expect(sections.nth(0)).toContainText('3 מילים');

  // The words themselves — the whole reason the page exists.
  for (const w of ['כלה', 'שושבינה', 'ריקוד', 'כדורגל']) {
    await expect(page.locator('main .words span', { hasText: w }).first()).toBeVisible();
  }
});

test('the list names link to their own section', async ({ page }) => {
  await stub(page, LISTS);
  await page.goto('/wordlists.html');
  const toc = page.locator('#toc');
  await expect(toc).toBeVisible();
  await expect(toc.getByRole('link', { name: /רווקות/ })).toHaveAttribute('href', '#list-0');
  await expect(toc.getByRole('link', { name: /ילדים/ })).toHaveAttribute('href', '#list-1');
});

test('search filters every list at once and says how many matched', async ({ page }) => {
  await stub(page, LISTS);
  await page.goto('/wordlists.html');

  // A word in BOTH lists: the count is across the page, not per section.
  await page.locator('#q').fill('ריקוד');
  await expect(page.locator('#found')).toHaveText('2 מילים תואמות');
  await expect(page.locator('main .words span', { hasText: 'כלה' })).toBeHidden();
  await expect(page.locator('main .words span.hit')).toHaveCount(2);
  // …and each section reports its own share of the match.
  await expect(page.locator('main section').nth(0)).toContainText('1 מתוך 3');

  // A word in only one list collapses the other entirely, rather than leaving a
  // heading standing over nothing.
  await page.locator('#q').fill('כלה');
  await expect(page.locator('main section').nth(0)).toBeVisible();
  await expect(page.locator('main section').nth(1)).toBeHidden();

  // Clearing it puts the whole page back, counts included.
  await page.locator('#q').fill('');
  await expect(page.locator('main section').nth(1)).toBeVisible();
  await expect(page.locator('main section').nth(0)).toContainText('3 מילים');
  await expect(page.locator('#found')).toHaveText('');
});

test('a search that matches nothing says so, instead of an empty page', async ({ page }) => {
  await stub(page, LISTS);
  await page.goto('/wordlists.html');
  await page.locator('#q').fill('זזזזז');
  await expect(page.locator('#found')).toContainText('לא נמצאה מילה כזו');
});

test('before the owner publishes a menu the page says so, not an error', async ({ page }) => {
  // No menu means the wizard shows no chooser either, so there is genuinely
  // nothing to pick between — that is a state to explain, not a failure.
  await stub(page, { lists: [] });
  await page.goto('/wordlists.html');
  await expect(page.locator('#msg')).toContainText('עדיין לא פורסמו');
  await expect(page.locator('#toc')).toBeHidden();
});

test('a failed load is admitted, not left as a spinner', async ({ page }) => {
  await page.route('**/api/wordlist-preview', (route) => route.fulfill({ status: 500, json: {} }));
  await page.goto('/wordlists.html');
  await expect(page.locator('#msg')).toContainText('לא הצלחנו לטעון');
});

test('the page is reachable from the footer, beside the terms', async ({ page }) => {
  // Where the owner asked for it. Checked on the home page and the shop, because
  // the two footers are separate copies of the same block.
  for (const from of ['/index.html', '/products.html']) {
    await page.goto(from);
    const link = page.getByTestId('footer-wordlists');
    await expect(link, from).toHaveAttribute('href', 'wordlists.html');
    await expect(page.getByTestId('footer-terms'), from).toBeVisible();
  }
  await page.getByTestId('footer-wordlists').click();
  await expect(page).toHaveURL(/wordlists\.html/);
  await expect(page.locator('h1')).toContainText('רשימות המילים');
});

test('the real endpoint answers the real page, with no key', async ({ page }) => {
  // One test with nothing stubbed: the page and the route actually fit together.
  // It asserts only the shape, so it holds whether or not this install has a
  // menu built — the states themselves are covered above.
  const res = await page.request.get('/api/wordlist-preview');
  expect(res.status()).toBe(200);
  expect(Array.isArray((await res.json()).lists)).toBe(true);

  await page.goto('/wordlists.html');
  await expect(page.locator('h1')).toContainText('רשימות המילים');
  // By COUNT, not by text: on the success path #msg is REMOVED, and a `not
  // .toContainText` against a detached node fails rather than passes. This holds
  // for all three real states — lists shown, no menu built, or an error — and
  // fails only on the one that matters.
  await expect(page.locator('#msg', { hasText: 'לא הצלחנו לטעון' })).toHaveCount(0);
});
