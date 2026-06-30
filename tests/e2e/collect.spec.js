import { test, expect } from '@playwright/test';

async function createCollection(page, name) {
  // Collections are now created at the end of the order wizard (options.html).
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click(); // design -> color
  await page.getByTestId('next-btn').click(); // color -> add-ons
  await page.getByTestId('next-btn').click(); // add-ons -> name
  await page.fill('#honoreeInput', name);
  await page.getByTestId('next-btn').click(); // name -> contact
  await page.fill('#ownerEmail', 'test@example.com'); // email required
  await page.fill('#ownerPhone', '0521234567'); // valid IL mobile, required
  await page.getByTestId('next-btn').click(); // "צרו את המשחק"
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

test('owner pay panel: select delivery → address + total 199 → Bit opens, stays on collect', async ({
  page,
}) => {
  await createCollection(page, 'דנה');

  // Owner sees the pay panel; it's collapsed by default — open it first.
  await expect(page.locator('#payPanel')).toBeVisible();
  await expect(page.locator('#payTotal')).toBeHidden();
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#payTotal')).toHaveText('79');
  await expect(page.locator('#addressForm')).toBeHidden();

  // Select delivery → address fields appear, total becomes 199.
  await page.check('input[name="payVersion"][value="delivery"]');
  await expect(page.locator('#addressForm')).toBeVisible();
  await expect(page.locator('#payTotal')).toHaveText('199');

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
  await expect(page.locator('#payConfirm')).toContainText('199');
});

test('owner pay panel is collapsed by default and opens on the summary button', async ({
  page,
}) => {
  await createCollection(page, 'אורי');
  const panel = page.locator('#payPanel');
  await expect(panel).toBeVisible();
  // Collapsed by default: the inner options/Bit are hidden behind one button.
  await expect(page.locator('#payOpts')).toBeHidden();
  await expect(page.locator('#bitPayLink')).toBeHidden();
  await expect(page.locator('#payPanel summary')).toContainText('שלמו וקבלו את המשחק');
  // Click the summary → options reveal; click again → collapse.
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#payOpts')).toBeVisible();
  await expect(page.locator('#bitPayLink')).toBeVisible();
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#payOpts')).toBeHidden();
});

test('credit-card button stays hidden when card payment is not configured', async ({ page }) => {
  // The E2E server runs without PELECARD_* credentials, so card_enabled is
  // false: the credit-card button must not show, and Bit remains the path.
  await createCollection(page, 'נועה');
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#bitPayLink')).toBeVisible();
  await expect(page.locator('#cardPayBtn')).toBeHidden();
});

test('pay panel shows the new version names and prices', async ({ page }) => {
  await createCollection(page, 'יעל');
  const panel = page.locator('#payPanel');
  await expect(panel).toContainText('דיגיטלי (PDF)');
  await expect(panel).toContainText('מורידים, מדפיסים לבד');
  await expect(panel).toContainText('משחק מוכן · איסוף מבית דפוס גלאור, ת״א');
  await expect(panel).toContainText('₪149');
  await expect(panel).toContainText('המפונקת 👑');
  await expect(panel).toContainText('₪199');
  await expect(panel).toContainText('אזורים מרוחקים בתיאום ובתוספת תשלום');
  // pay-anytime / unlock messaging
  await expect(panel).toContainText('אפשר לשלם מתי שרוצים');
});

test('how-to guidance is a collapsed details on collect that can be opened', async ({ page }) => {
  await createCollection(page, 'רוני');
  const details = page.locator('details.howto');
  await expect(details).toBeAttached();
  // Collapsed by default: the category content is hidden.
  await expect(page.locator('.howto .cat').first()).toBeHidden();
  await page.locator('.howto summary').click();
  await expect(page.locator('.howto .cat').first()).toBeVisible();
  await expect(details).toContainText('אנשים');
});

test('unpaid owner sees the locked teaser, not the unlock badge', async ({ page }) => {
  await createCollection(page, 'טל');
  await expect(page.locator('#lockTeaser')).toBeVisible();
  await expect(page.locator('#lockTeaser')).toContainText('שלמו כדי לפתוח');
  await expect(page.locator('#premiumBadge')).toBeHidden();
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
