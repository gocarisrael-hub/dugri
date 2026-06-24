import { test, expect } from '@playwright/test';

async function createCollection(page, name) {
  await page.goto('/thankyou.html');
  await page.fill('#honoreeInput', name);
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

  // paste list (third item is a duplicate → only 2 new, total 3)
  await page.click('#pasteToggle');
  await page.fill('#pasteBox', 'סוכר באמא\nאולי נקסט\nהדייט מטבריה');
  await page.click('#pasteAdd');
  await expect(page.locator('#count')).toHaveText('3');

  // idea generator shows a personalized prompt
  await page.click('#ideaBtn');
  await expect(page.locator('#ideaBox')).toBeVisible();
  await expect(page.locator('#ideaBox')).toContainText('שירה');

  // owner closes the collection
  page.once('dialog', (d) => d.accept());
  await page.click('#closeBtn');
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#addCard')).toBeHidden();
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
