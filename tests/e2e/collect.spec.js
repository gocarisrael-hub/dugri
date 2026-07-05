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

test('owner deleting a word asks for confirmation: cancel/Esc keep it, confirm removes just that one', async ({
  page,
}) => {
  await createCollection(page, 'שירה');

  // Seed TWO words as the owner, so each row's delete control must be uniquely
  // selectable (a shared testid alone would collide under Playwright strict mode).
  await page.fill('#wordInput', 'הדייט מטבריה');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1'); // let the first add settle
  await page.fill('#wordInput', 'סוכר באמא');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('2');

  // The delete control for a specific word, scoped to its row (no collision).
  const delFor = (word) => page.locator('.word', { hasText: word }).getByTestId('word-del');

  // Clicking delete does NOT remove immediately — a confirmation popup appears,
  // naming the word, and both words are still present at that point.
  await delFor('הדייט מטבריה').click();
  await expect(page.getByTestId('msg-modal')).toBeVisible();
  await expect(page.locator('#msgModalText')).toContainText('הדייט מטבריה');
  await expect(page.locator('#count')).toHaveText('2');

  // Safety: focus is on cancel (not the destructive confirm), so pressing Enter
  // right after opening dismisses without deleting.
  await expect(page.getByTestId('msg-modal-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('msg-modal')).toBeHidden();
  await expect(page.locator('#count')).toHaveText('2');
  await expect(page.locator('#wordsWrap')).toContainText('הדייט מטבריה');

  // Cancel button → popup closes, the word stays.
  await delFor('הדייט מטבריה').click();
  await page.getByTestId('msg-modal-cancel').click();
  await expect(page.getByTestId('msg-modal')).toBeHidden();
  await expect(page.locator('#count')).toHaveText('2');

  // Esc also dismisses without deleting (shared modal-dismiss behavior).
  await delFor('הדייט מטבריה').click();
  await expect(page.getByTestId('msg-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('msg-modal')).toBeHidden();
  await expect(page.locator('#count')).toHaveText('2');

  // Confirm → only that word is removed; the other stays.
  await delFor('הדייט מטבריה').click();
  await page.getByTestId('msg-modal-ok').click();
  await expect(page.getByTestId('msg-modal')).toBeHidden();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#wordsWrap')).not.toContainText('הדייט מטבריה');
  await expect(page.locator('#wordsWrap')).toContainText('סוכר באמא');
});

test('submitting a word that already exists shows a non-blocking duplicate toast and does not add a row', async ({
  page,
}) => {
  await createCollection(page, 'שירה');

  // Add a word once — succeeds.
  await page.fill('#wordInput', 'הדייט מטבריה');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');

  // Submit the SAME word again (case/space-insensitive dupe on the server).
  await page.fill('#wordInput', '  הדייט   מטבריה ');
  await page.click('#addBtn');

  // A non-blocking toast appears, naming the word (normalized). It fades in via
  // the .show class rather than opening the blocking modal.
  await expect(page.locator('#toast')).toHaveClass(/show/);
  await expect(page.locator('#toast')).toContainText('כבר קיימת ברשימה');
  await expect(page.locator('#toast')).toContainText('הדייט מטבריה');

  // The blocking dialog stays hidden — the notice never steals focus.
  await expect(page.getByTestId('msg-modal')).toBeHidden();
  // No new row was added — still exactly one word.
  await expect(page.locator('#count')).toHaveText('1');
  // The input keeps focus so the user can keep typing without a click.
  await expect(page.locator('#wordInput')).toBeFocused();

  // The toast auto-dismisses: it drops the .show class after its timer.
  await expect(page.locator('#toast')).not.toHaveClass(/show/, { timeout: 4000 });
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

// Seed a discount coupon via the admin API (dev/E2E key falls back to
// dugri-admin). Coupons are global, so a duplicate from a prior run/project is
// fine — the coupon just needs to exist and be active.
async function seedCoupon(page, code, discount_pct) {
  const res = await page.request.post(`/api/admin/coupons?key=dugri-admin`, {
    data: { code, discount_pct, valid_until: null },
  });
  // 201 = created, 400 = already exists from an earlier test/project — both OK.
  expect([201, 400]).toContain(res.status());
}

// The E2E server runs with card payment DISABLED (no PeleCard creds), so
// #cardPayBtn is hidden. Inject card_enabled into the base collection GET so the
// pay button shows and the pay/init branches can be exercised. Returns a control
// object; set ctl.paid=true to make the paid UI transition on the next poll.
// (The `**/api/collections/*` glob's `*` never spans `/`, so this matches only
// the base GET — never /words, /coupon/validate, /pay/init, etc.)
async function enableCardButton(page) {
  const ctl = { paid: false };
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const body = await resp.json();
    body.card_enabled = true;
    if (ctl.paid) body.paid = true;
    return route.fulfill({ json: body });
  });
  return ctl;
}

test('owner applies a valid coupon → discounted total with the struck full price', async ({
  page,
}) => {
  await seedCoupon(page, 'TEST25', 25);
  await createCollection(page, 'רבקה');

  // Open the (collapsed) pay panel — a pdf order starts at ₪79.
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#payTotal')).toHaveText('79');
  await expect(page.locator('#payWas')).toBeHidden();

  // Apply the coupon.
  await page.fill('#couponInput', 'TEST25');
  await page.click('#couponApplyBtn');

  // Discount is confirmed and the total drops 79 → 59 (round(79 * 0.75)).
  await expect(page.locator('#couponMsg')).toContainText('25% הנחה');
  await expect(page.locator('#payTotal')).toHaveText('59');
  // The full price shows struck-through with the ₪ sign, like other prices.
  const was = page.locator('#payWas');
  await expect(was).toBeVisible();
  await expect(was).toHaveText('₪79');
  // Apply is swapped for a remove control; the input is locked while applied.
  await expect(page.locator('#couponApplyBtn')).toBeHidden();
  await expect(page.locator('#couponRemoveBtn')).toBeVisible();
  await expect(page.locator('#couponInput')).toBeDisabled();

  // Removing the coupon reverts to the full price.
  await page.click('#couponRemoveBtn');
  await expect(page.locator('#payTotal')).toHaveText('79');
  await expect(page.locator('#payWas')).toBeHidden();
  await expect(page.locator('#couponApplyBtn')).toBeVisible();
});

test('unknown coupon code shows a not-found message and leaves the total full', async ({
  page,
}) => {
  await createCollection(page, 'נטע');
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#payTotal')).toHaveText('79');

  await page.fill('#couponInput', 'NOPE999');
  await page.click('#couponApplyBtn');

  await expect(page.locator('#couponMsg')).toHaveText('קוד לא קיים');
  // No discount applied — total stays full and no struck price appears.
  await expect(page.locator('#payTotal')).toHaveText('79');
  await expect(page.locator('#payWas')).toBeHidden();
  await expect(page.locator('#couponRemoveBtn')).toBeHidden();
});

test('free coupon: pay/init free:true skips the iframe, shows paid UI, clears the stale error', async ({
  page,
}) => {
  const ctl = await enableCardButton(page);
  // First pay attempt is rate-limited (leaves a red error); the second returns a
  // free/paid order (100%-off coupon) — no iframe, order already paid.
  let payMode = 'error';
  await page.route('**/api/collections/*/pay/init', (route) => {
    if (payMode === 'error') {
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'too many attempts' }),
      });
    }
    ctl.paid = true; // the free order is now paid server-side
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ free: true, paid: true, total: 0 }),
    });
  });

  await createCollection(page, 'לירון');
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#cardPayBtn')).toBeVisible();

  // Attempt 1 → 429 → a stale red error is shown in the pay panel.
  await page.click('#cardPayBtn');
  await expect(page.locator('#payErr')).toBeVisible();
  await expect(page.locator('#payErr')).toContainText('יותר מדי ניסיונות');

  // Attempt 2 → the free path succeeds.
  payMode = 'free';
  await page.click('#cardPayBtn');

  // No iframe modal opens; the paid state takes over the panel...
  await expect(page.locator('#paidCard')).toBeVisible();
  await expect(page.locator('#payPanel')).toBeHidden();
  await expect(page.locator('#payModal')).toBeHidden();
  // ...and the stale error from attempt 1 is cleared (finding 1).
  await expect(page.locator('#payErr')).toBeHidden();
});

test('pay/init coupon errors: 400 clears the coupon, 409 and 429 show their messages', async ({
  page,
}) => {
  await seedCoupon(page, 'TEST25', 25);
  await enableCardButton(page);
  let payMode = '400';
  await page.route('**/api/collections/*/pay/init', (route) => {
    const map = {
      400: { status: 400, body: { error: 'invalid coupon' } },
      409: { status: 409, body: { error: 'יש תשלום פתוח — סגרו את חלון התשלום לפני החלת קופון' } },
      429: { status: 429, body: { error: 'too many attempts' } },
    };
    const m = map[payMode];
    return route.fulfill({
      status: m.status,
      contentType: 'application/json',
      body: JSON.stringify(m.body),
    });
  });

  await createCollection(page, 'שני');
  await page.locator('#payPanel summary').click();

  // Apply a real coupon (79 → 59), then pay/init rejects it → the coupon-invalid
  // message shows AND the coupon is cleared (total back to full, input freed).
  await page.fill('#couponInput', 'TEST25');
  await page.click('#couponApplyBtn');
  await expect(page.locator('#payTotal')).toHaveText('59');
  await page.click('#cardPayBtn');
  await expect(page.locator('#payErr')).toContainText('הקופון אינו תקף יותר');
  await expect(page.locator('#payTotal')).toHaveText('79');
  await expect(page.locator('#couponRemoveBtn')).toBeHidden();
  await expect(page.locator('#couponApplyBtn')).toBeVisible();
  await expect(page.locator('#couponInput')).toBeEnabled();

  // 409 (in-flight / already paid) → the server's Hebrew message is shown as-is.
  payMode = '409';
  await page.click('#cardPayBtn');
  await expect(page.locator('#payErr')).toContainText('יש תשלום פתוח');

  // 429 → a friendly retry message.
  payMode = '429';
  await page.click('#cardPayBtn');
  await expect(page.locator('#payErr')).toContainText('יותר מדי ניסיונות');
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

test('home link (→ index.html) and a tailored order CTA (→ options.html) are present', async ({
  page,
  context,
}) => {
  await createCollection(page, 'הדר');

  // Home affordance at the top links back to the main site.
  const home = page.getByTestId('home-link');
  await expect(home).toBeVisible();
  await expect(home).toHaveAttribute('href', /index\.html$/);

  // Bottom order CTA links to the order flow. The MANAGER (owner token) is
  // nudged to order ANOTHER game.
  const cta = page.getByTestId('order-cta');
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute('href', /options\.html$/);
  await expect(cta).toContainText('רוצים עוד משחק');

  // A plain CONTRIBUTOR (no owner key) is a warm lead → invited to order their OWN.
  const friendsUrl = page.url().replace(/&k=.*/, '');
  const friend = await context.newPage();
  await friend.goto(friendsUrl);
  await expect(friend.getByTestId('home-link')).toBeVisible();
  const friendCta = friend.getByTestId('order-cta');
  await expect(friendCta).toBeVisible();
  await expect(friendCta).toHaveAttribute('href', /options\.html$/);
  await expect(friendCta).toContainText('לאירוע שלכם');
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
