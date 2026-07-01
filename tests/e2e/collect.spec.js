import { test, expect } from '@playwright/test';

async function createCollection(page, name) {
  // Collections are now created at the end of the order wizard (options.html).
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click(); // design -> color
  await page.getByTestId('next-btn').click(); // color -> add-ons
  await page.getByTestId('next-btn').click(); // add-ons -> name
  await page.fill('#honoreeInput', name);
  await page.getByTestId('gender-female').check(); // gender is required to advance
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

test('submitting a word that already exists pops a duplicate dialog and does not add a row', async ({
  page,
}) => {
  await createCollection(page, 'שירה');

  // Add a word once — succeeds.
  await page.fill('#wordInput', 'הדייט מטבריה');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');
  // The duplicate popup is not shown for a fresh add.
  await expect(page.locator('#dupModal')).toBeHidden();

  // Submit the SAME word again (case/space-insensitive dupe on the server).
  await page.fill('#wordInput', '  הדייט   מטבריה ');
  await page.click('#addBtn');

  // A clear duplicate popup appears, naming the word.
  await expect(page.locator('#dupModal')).toBeVisible();
  await expect(page.locator('#dupModalText')).toContainText('כבר קיימת ברשימה');
  await expect(page.locator('#dupModalText')).toContainText('הדייט מטבריה');
  // No new row was added — still exactly one word.
  await expect(page.locator('#count')).toHaveText('1');

  // Dismissing the popup ("הבנתי") closes it and leaves the page usable.
  await page.click('#dupModalOk');
  await expect(page.locator('#dupModal')).toBeHidden();

  // Escape also closes the dialog (shared modal-dismiss behavior).
  await page.fill('#wordInput', 'הדייט מטבריה');
  await page.click('#addBtn');
  await expect(page.locator('#dupModal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#dupModal')).toBeHidden();
});

test('add-word failure surfaces an error and keeps the typed word', async ({ page }) => {
  await createCollection(page, 'שקד');

  // Force the save request to fail (HTTP 500) — a dropped/errored add. Only the
  // POST /words call is intercepted; GET refreshes still hit the real server.
  await page.route('**/api/collections/*/words', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"boom"}',
      });
    }
    return route.continue();
  });

  await page.fill('#wordInput', 'מילה שנכשלת');
  await page.click('#addBtn');

  // A clear error is shown (not swallowed like the old 409-only handling).
  await expect(page.locator('#toast')).toContainText('לא הצלחנו לשמור');
  // The typed word is NOT lost — the user can retry.
  await expect(page.locator('#wordInput')).toHaveValue('מילה שנכשלת');
  // Nothing was added.
  await expect(page.locator('#count')).toHaveText('0');
});

test('owner pay panel: select delivery → address fields appear + total 199', async ({ page }) => {
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

  // Card-only: there is no Bit link anywhere.
  await expect(page.locator('#bitPayLink')).toHaveCount(0);
  await expect(page.locator('#payPanel')).not.toContainText('ביט');
});

test('owner pay panel is collapsed by default and opens on the summary button', async ({
  page,
}) => {
  await createCollection(page, 'אורי');
  const panel = page.locator('#payPanel');
  await expect(panel).toBeVisible();
  // Collapsed by default: the inner options are hidden behind one button.
  await expect(page.locator('#payOpts')).toBeHidden();
  await expect(page.locator('#payPanel summary')).toContainText('שלמו וקבלו את המשחק');
  // Click the summary → options reveal; click again → collapse.
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#payOpts')).toBeVisible();
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#payOpts')).toBeHidden();
});

test('card disabled: no dead pay CTA, neutral note instead, and no top nag', async ({ page }) => {
  // The E2E server runs without PELECARD_* credentials, so card_enabled is
  // false. There must be NO clickable pay button, a neutral "coming soon" note
  // in the panel instead, and the top reminder must NOT nag toward a dead panel.
  await createCollection(page, 'נועה');
  await expect(page.locator('#payReminder')).toBeHidden();
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#cardPayBtn')).toBeHidden();
  await expect(page.locator('#bitPayLink')).toHaveCount(0);
  await expect(page.locator('#cardSoonNote')).toBeVisible();
  await expect(page.locator('#cardSoonNote')).toContainText('ייפתח בקרוב');
});

test('below 100 words: Stage-1 bar is scaled to the 100-word minimum', async ({ page }) => {
  await createCollection(page, 'ליהיא');
  // Stage 1 frames the 100-word minimum (not the 416 max) below the goal.
  await expect(page.locator('.count-pill')).toContainText('/ 100');
  await expect(page.locator('.count-pill')).toContainText('מינימום');
  await expect(page.locator('#stage1')).toBeVisible();
  await expect(page.locator('#stage2')).toBeHidden();
  await page.fill('#wordInput', 'מילה אחת');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#countMax')).toContainText('/ 100');
  await expect(page.locator('#countHint')).toContainText('100');
  // one word = 1% of a 100-word Stage-1 bar
  const width = await page.locator('#barFill1').evaluate((el) => el.style.width);
  expect(parseFloat(width)).toBe(1);
});

test('at 100+ words: Stage-2 bar replaces Stage-1 and is scaled to the 416 max', async ({
  page,
}) => {
  await createCollection(page, 'רוני');
  const url = new URL(page.url());
  const c = url.searchParams.get('c');
  // Reach exactly the 100-word minimum in one API call.
  const words = Array.from({ length: 100 }, (_, i) => 'w' + i);
  const res = await page.request.post(`/api/collections/${c}/words`, { data: { words } });
  expect(res.ok()).toBeTruthy();

  await page.reload();
  await expect(page.locator('#count')).toHaveText('100');
  // The swap: Stage-1 gone, the new Stage-2 bar takes over and frames the max.
  await expect(page.locator('#stage1')).toBeHidden();
  await expect(page.locator('#stage2')).toBeVisible();
  await expect(page.locator('#countMax')).toContainText('/ 416');
  await expect(page.locator('#countMax')).not.toContainText('מינימום');
  // 100 / 416 ≈ 24% — the second bar starts already ~¼ filled.
  const width = await page.locator('#barFill2').evaluate((el) => el.style.width);
  expect(parseFloat(width)).toBeGreaterThan(20);
  expect(parseFloat(width)).toBeLessThan(30);
});

test('over the 416 cap: counter shows 416 max (no fraction over cap), bar full', async ({
  page,
}) => {
  await createCollection(page, 'אגם');
  const url = new URL(page.url());
  const c = url.searchParams.get('c');
  // Push the count past the cap in one API call (417 unique words).
  const words = Array.from({ length: 417 }, (_, i) => 'w' + i);
  const res = await page.request.post(`/api/collections/${c}/words`, { data: { words } });
  expect(res.ok()).toBeTruthy();

  await page.reload();
  await expect(page.locator('#count')).toHaveText('416'); // capped display
  await expect(page.locator('#countMax')).toContainText('מקסימום');
  await expect(page.locator('.count-pill')).not.toContainText('417');
  await expect(page.locator('.count-pill')).not.toContainText('/ 416'); // no fraction over cap
  await expect(page.locator('#countHint')).toContainText('מקסימום');
  // Past 100 words the Stage-2 bar is in play; over the cap it's full.
  const width = await page.locator('#barFill2').evaluate((el) => el.style.width);
  expect(parseFloat(width)).toBe(100); // bar full
});

test('struck old price carries the ₪ sign alongside the new price', async ({ page }) => {
  await createCollection(page, 'מור');
  await page.locator('#payPanel summary').click();
  const was = page.locator('#payPanel s.was');
  await expect(was).toHaveText('₪129');
  await expect(page.locator('#payPanel .opt-price').first()).toContainText('₪79');
});

test('after payment: pay panel + reminder disappear, סיום card takes over', async ({ page }) => {
  await createCollection(page, 'רותם');
  const url = new URL(page.url());
  const c = url.searchParams.get('c');
  const k = url.searchParams.get('k');

  // Place an order, then mark it paid via the admin endpoint (E2E ADMIN_KEY).
  await page.request.post(`/api/collections/${c}/order`, {
    data: { owner_token: k, version: 'pdf' },
  });
  const paidRes = await page.request.post(`/api/admin/collections/${c}/paid?key=dugri-admin`);
  expect(paidRes.ok()).toBeTruthy();

  await page.reload();
  // Pay panel + top reminder gone; the "keep adding, then סיום" card is shown.
  await expect(page.locator('#payPanel')).toBeHidden();
  await expect(page.locator('#payReminder')).toBeHidden();
  await expect(page.locator('#paidCard')).toBeVisible();
  await expect(page.locator('#paidCard')).toContainText('התשלום התקבל');
  await expect(page.locator('#paidCloseBtn')).toBeVisible();

  // The primary CTA closes the collection (= starts production).
  page.once('dialog', (d) => d.accept());
  await page.locator('#paidCloseBtn').click();
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#addCard')).toBeHidden();
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
  // ready / delivery timing on the physical options
  await expect(panel).toContainText('מוכן לאיסוף תוך כ-48 שעות');
  await expect(panel).toContainText('משלוח עד הבית תוך כ-5 ימים');
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
