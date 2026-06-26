import { test, expect } from '@playwright/test';

async function createCollection(page, name) {
  await page.goto('/thankyou.html');
  await page.fill('#honoreeInput', name);
  await page.fill('#ownerEmail', 'test@example.com'); // contact now required
  await page.click('#createBtn');
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
}

test('create → add words (one-by-one + paste, deduped) → idea generator → close', async ({
  page,
}) => {
  await createCollection(page, 'שירה');
  await expect(page.locator('#title')).toContainText('שירה');

  // one-by-one
  await page.fill('#wordInput', 'הדייט מטבריה');
  await page.click('#addBtn');
  await expect(page.locator('#wordsWrap')).toContainText('הדייט מטבריה');
  await expect(page.locator('#count')).toHaveText('1');
  // a "word added" toast pops up
  await expect(page.locator('#toast')).toContainText('נוספה מילה');

  // idea generator (single tab) shows a personalized prompt
  await page.click('#ideaBtn');
  await expect(page.locator('#ideaBox')).toBeVisible();
  await expect(page.locator('#ideaBox')).toContainText('שירה');

  // switch to the list tab; third item is a duplicate → only 2 new, total 3
  await page.click('#tab-list');
  await page.fill('#pasteBox', 'סוכר באמא\nאולי נקסט\nהדייט מטבריה');
  await page.click('#pasteAdd');
  await expect(page.locator('#count')).toHaveText('3');
  // toast reflects the 2 newly-added (1 duplicate skipped)
  await expect(page.locator('#toast')).toContainText('2 מילים');

  // owner closes the collection
  page.once('dialog', (d) => d.accept());
  await page.click('#closeBtn');
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#addCard')).toBeHidden();
});

test('owner pay panel: select delivery → address + total 197 → Bit opens, stays on collect', async ({
  page,
}) => {
  await createCollection(page, 'דנה');

  // Owner sees the pay panel; PDF default total is 79.
  await expect(page.locator('#payPanel')).toBeVisible();
  await expect(page.locator('#payTotal')).toHaveText('79');
  await expect(page.locator('#addressForm')).toBeHidden();

  // Select delivery → address fields appear, total becomes 197.
  await page.check('input[name="payVersion"][value="delivery"]');
  await expect(page.locator('#addressForm')).toBeVisible();
  await expect(page.locator('#payTotal')).toHaveText('197');

  // Missing address blocks Bit and shows an inline error.
  await page.locator('#bitPayLink').click();
  await expect(page.locator('#payErr')).toBeVisible();

  // Fill the required address fields.
  await page.fill('#addrStreet', 'הרצל 10');
  await page.fill('#addrCity', 'תל אביב');
  await page.fill('#addrPostal', '6100000');

  // Clicking שלם בביט opens Bit in a new tab; the page stays on collect.html.
  const collectUrl = page.url();
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('#bitPayLink').click(),
  ]);
  await expect(popup).toHaveURL(
    /bitpay\.co\.il\/app\/me\/4BE8AF50-DD1F-8868-1FF0-2DE96FEB9B6A4F38/
  );
  await popup.close();
  expect(page.url()).toBe(collectUrl);
  expect(page.url()).toContain('collect.html');
  await expect(page.locator('#payConfirm')).toContainText('197');
});

test('contributor (no owner key) does NOT see the pay panel', async ({ page, context }) => {
  await createCollection(page, 'מאיה');
  const friendsUrl = page.url().replace(/&k=.*/, '');
  const friend = await context.newPage();
  await friend.goto(friendsUrl);
  await expect(friend.locator('#payPanel')).toBeHidden();
});

test('contributor (no owner key) sees words but cannot add after close', async ({
  page,
  context,
}) => {
  await createCollection(page, 'נועה');
  const ownerUrl = page.url();
  const friendsUrl = ownerUrl.replace(/&k=.*/, '');

  await page.fill('#wordInput', 'בדיחה פנימית');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');
  page.once('dialog', (d) => d.accept());
  await page.click('#closeBtn');

  const friend = await context.newPage();
  await friend.goto(friendsUrl);
  await expect(friend.locator('#wordsWrap')).toContainText('בדיחה פנימית');
  await expect(friend.locator('#addCard')).toBeHidden();
  await expect(friend.locator('#banner')).toBeVisible();
});
