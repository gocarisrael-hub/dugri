import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// THE FRIEND COUPON, as the people involved meet it: a friend adds a word on a
// shared collect link and is offered a personal code; the email's link lands a
// future buyer with the code active; checkout applies it with no typing.
//
// The e2e server has no Resend credentials, so a real issue answers
// emailed:false — which is exactly the "the mail did not go out, show the code
// anyway" path. The approved "on its way" confirmation is driven by answering
// the issue call as a configured server would.

const uniq = (p) => `${p}${Math.random().toString(36).slice(2, 8)}`;

async function makeParty(request, name = 'Shira') {
  const r = await request.post('/api/collections', { data: { honoree_name: name } });
  expect(r.ok()).toBeTruthy();
  const { id, owner_token: k } = await r.json();
  return { id, k };
}

// Every GA call is pushed onto dataLayer by the page's own gtag stub (GA itself
// never loads on localhost), so the queue is what the events look like.
const gaEvents = (page) =>
  page.evaluate(() =>
    (window.dataLayer || [])
      .map((a) => Array.from(a))
      .filter((a) => a[0] === 'event')
      .map((a) => ({ name: a[1], params: a[2] || {} }))
  );

async function addWord(page, word) {
  await page.locator('#wordInput').fill(word);
  await page.locator('#addBtn').click();
  await expect(page.locator('#wordInput')).toHaveValue('');
}

const bar = (page) => page.getByTestId('friend-bar');

// A 1x1 PNG, so the wizard's name step opens without the Python render.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// The word-list menu is shared server state another spec fills while it runs;
// answer it per page so the wizard walk here never meets it.
const noPoolMenu = (page) =>
  page.route('**/api/wordlist-options', (route) => route.fulfill({ json: { options: [] } }));

test.describe('the bar on a friend’s collect link', () => {
  test('appears only after the first word, with the approved copy, clear of the input', async ({
    page,
    request,
  }) => {
    const { id } = await makeParty(request);
    await page.goto(`/collect.html?c=${id}`);
    await expect(page.locator('#wordInput')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);

    await addWord(page, uniq('word'));
    await expect(bar(page)).toHaveCount(1);
    await expect(bar(page)).toContainText('אהבתם?');
    await expect(bar(page)).toContainText('יש לנו מתנה קטנה בשבילכם');
    await expect(page.getByTestId('friend-bar-go')).toHaveText('תראו לי');
    await expect(page.getByTestId('friend-bar-x')).toHaveAttribute('aria-label', 'סגירה');
    // The percent is revealed only in the sheet, never on the bar.
    await expect(bar(page)).not.toContainText('%');

    // Up, in view, and not over the word box once she has scrolled to it.
    await expect(bar(page)).toBeInViewport();
    await page.locator('#wordInput').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const inputBox = await page.locator('#wordInput').boundingBox();
    const barBox = await bar(page).boundingBox();
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(barBox.y);
    // The page grows by the bar's height, so nothing is ever stuck under it.
    const pad = await page.evaluate(() => ({
      body: parseFloat(getComputedStyle(document.body).paddingBottom),
      bar: document.getElementById('friendBar').offsetHeight,
    }));
    expect(pad.body).toBeGreaterThanOrEqual(60 + pad.bar);

    const events = await gaEvents(page);
    const shown = events.filter((e) => e.name === 'friend_bar_shown');
    expect(shown).toHaveLength(1);
    expect(shown[0].params).toEqual({ collection_id: id });
  });

  test('× hides it for good on this browser', async ({ page, request }) => {
    const { id } = await makeParty(request);
    await page.goto(`/collect.html?c=${id}`);
    await addWord(page, uniq('word'));
    await page.getByTestId('friend-bar-x').click();
    await expect(bar(page)).toHaveCount(0);
    expect((await gaEvents(page)).some((e) => e.name === 'friend_bar_dismiss')).toBe(true);

    await page.reload();
    await addWord(page, uniq('again'));
    // Give a would-be bar time to come up before saying it did not.
    await page.waitForTimeout(600);
    await expect(bar(page)).toHaveCount(0);
  });

  // THE LINK FRIENDS REALLY GET. There is one share link and it is the managing
  // one (collect.html friendsUrl): the WhatsApp invite and the copy box both
  // carry ?k=. The first version hid the bar from anyone on a ?k= link, so on
  // production it reached nobody, while every test here opened the bare ?c=.
  test('a friend on the shared link, which carries the owner key, gets it', async ({
    browser,
    request,
  }) => {
    const { id, k } = await makeParty(request);
    const owner = await browser.newPage();
    await owner.goto(`/collect.html?c=${id}&k=${k}`);
    const shared = await owner.locator('#friendsLink').inputValue();
    expect(shared).toContain(`k=${k}`);
    const waHref = decodeURIComponent(
      await owner.getByTestId('share-whatsapp').getAttribute('href')
    );
    expect(waHref).toContain(shared);
    await owner.close();

    // A friend: her own phone, a fresh profile, the link exactly as sent.
    const ctx = await browser.newContext();
    const friend = await ctx.newPage();
    await friend.goto(new URL(shared).pathname + new URL(shared).search);
    await addWord(friend, uniq('word'));
    await expect(bar(friend)).toHaveCount(1);
    await expect(bar(friend)).toContainText('אהבתם?');
    await ctx.close();
  });

  test('is never offered on the browser that made the order, whatever link it opens', async ({
    page,
  }) => {
    // The wizard steps this walks are behind flags the e2e server keeps off.
    await stubFeatures(page, ALL_ON);
    await noPoolMenu(page);
    await page.route('**/api/preview', (route) =>
      route.fulfill({
        json: {
          card: PNG,
          back: PNG,
          board: PNG,
          warning: null,
          word_font: null,
          word_font_options: [],
        },
      })
    );
    await page.goto('/options.html');
    await page.getByTestId('next-btn').click();
    await page.getByTestId('next-btn').click();
    await page.fill('#customTitleInput', 'Shira');
    await page.getByTestId('next-btn').click();
    await page.getByTestId('next-btn').click();
    await page.fill('#ownerEmail', 'test@example.com');
    await page.fill('#ownerPhone', '0521234567');
    await page.fill('#buyerNameInput', 'דנה כהן');
    await page.getByTestId('next-btn').click();
    await page.waitForURL(/collect\.html\?c=.+&k=.+/);
    const id = new URL(page.url()).searchParams.get('c');

    await addWord(page, uniq('mine'));
    await page.waitForTimeout(600);
    await expect(bar(page)).toHaveCount(0);

    // The plain link, opened on her own phone.
    await page.goto(`/collect.html?c=${id}`);
    await addWord(page, uniq('mine2'));
    await page.waitForTimeout(600);
    await expect(bar(page)).toHaveCount(0);
  });
});

test.describe('the sheet', () => {
  test('send stays off until the email is valid; a real issue shows the code', async ({
    page,
    request,
  }) => {
    const { id } = await makeParty(request);
    await page.goto(`/collect.html?c=${id}`);
    await addWord(page, uniq('word'));
    await page.getByTestId('friend-bar-go').click();

    const sheet = page.getByTestId('friend-sheet');
    await expect(sheet.locator('h2')).toHaveText('5% הנחה, רק לכם');
    await expect(sheet).toContainText('השאירו מייל ונשלח לכם קופון אישי לשימוש אחד.');
    await expect(sheet.locator('label[for="friendEmail"]')).toHaveText('מייל');
    await expect(sheet).toContainText('אשמח לקבל מדי פעם עדכונים ומבצעים מדוגרי');
    await expect(page.getByTestId('friend-consent')).not.toBeChecked();
    const send = page.getByTestId('friend-send');
    await expect(send).toHaveText('שלחו לי את הקופון');
    await expect(send).toBeDisabled();

    const email = page.getByTestId('friend-email');
    await expect(email).toHaveAttribute('type', 'email');
    await email.fill('noa@');
    await expect(send).toBeDisabled();
    await email.blur();
    await expect(page.getByTestId('friend-err')).toHaveText('נראה שחסר משהו במייל. בדקו שוב');

    const address = uniq('noa.') + '@example.com';
    await email.fill(address);
    await expect(send).toBeEnabled();
    await send.click();

    // No mail server here, so the code itself is the confirmation.
    const confirm = page.getByTestId('friend-confirm');
    await expect(confirm).toBeVisible();
    await expect(page.getByTestId('friend-code')).toHaveText(
      /^NOA5-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/
    );
    await expect(confirm.getByRole('button', { name: 'חזרה להוספת מילים' })).toBeVisible();
    // The bar is gone, and stays gone.
    await expect(bar(page)).toHaveCount(0);
    const events = await gaEvents(page);
    const sent = events.filter((e) => e.name === 'friend_coupon_sent');
    expect(sent).toHaveLength(1);
    // Analytics gets the party, never the address.
    expect(sent[0].params).toEqual({ collection_id: id });
    expect(JSON.stringify(events)).not.toContain(address);
    expect(events.some((e) => e.name === 'friend_bar_click')).toBe(true);

    await confirm.getByRole('button', { name: 'חזרה להוספת מילים' }).click();
    await expect(page.getByTestId('friend-sheet')).toHaveCount(0);
    await page.reload();
    await addWord(page, uniq('later'));
    await page.waitForTimeout(600);
    await expect(bar(page)).toHaveCount(0);
  });

  test('when the mail goes out, the confirmation is the approved one', async ({
    page,
    request,
  }) => {
    const { id } = await makeParty(request);
    await page.route('**/api/friend-coupon', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        json: { ok: true, created: true, emailed: true, code: 'DANA5-K7Q2', percent: 5 },
      });
    });
    await page.goto(`/collect.html?c=${id}`);
    await addWord(page, uniq('word'));
    await page.getByTestId('friend-bar-go').click();
    await page.getByTestId('friend-email').fill('dana@example.com');
    await page.getByTestId('friend-send').click();
    const confirm = page.getByTestId('friend-confirm');
    await expect(confirm.locator('h2')).toHaveText('הקופון בדרך');
    await expect(confirm).toContainText('שלחנו קוד אישי אל dana@example.com. 5% הנחה, לשימוש אחד.');
    await expect(page.getByTestId('friend-code')).toHaveText('DANA5-K7Q2');
    // The address is isolated so its LTR run can't move the period in RTL.
    await expect(confirm.locator('bdi')).toHaveText('dana@example.com');
  });

  test('a repeat email whose resend fails is told so, not "on its way"', async ({
    page,
    request,
  }) => {
    const { id } = await makeParty(request);
    await page.route('**/api/friend-coupon', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      // The server's answer for an address that already has a code: no code
      // in the body (it is that person's), and the resend did not go out.
      return route.fulfill({ json: { ok: true, created: false, emailed: false, percent: 5 } });
    });
    await page.goto(`/collect.html?c=${id}`);
    await addWord(page, uniq('word'));
    await page.getByTestId('friend-bar-go').click();
    await page.getByTestId('friend-email').fill('dana@example.com');
    await page.getByTestId('friend-send').click();
    const confirm = page.getByTestId('friend-confirm');
    await expect(confirm.locator('h2')).toHaveText('המייל לא נשלח');
    await expect(confirm).not.toContainText('הקופון בדרך');
    await expect(confirm).not.toContainText('שלחנו');
    await expect(page.getByTestId('friend-code')).toHaveCount(0);
  });
});

test.describe('the email link', () => {
  test('lands with the coupon active, carries it to checkout and applies it', async ({
    page,
    request,
  }) => {
    // A code issued the real way, from a real party.
    const party = await makeParty(request, 'Noa');
    const issued = await request.post('/api/friend-coupon', {
      data: { email: uniq('buyer') + '@example.com', collection_id: party.id },
    });
    const { code } = await issued.json();
    expect(code).toMatch(/^BUYER/);

    await page.goto(
      `/?coupon=${code.toLowerCase()}&utm_source=coupon&utm_medium=email&utm_campaign=friend_coupon`
    );
    await expect(page.getByTestId('coupon-landing')).toHaveText(/הקופון שלכם פעיל: 5% הנחה/);
    const landing = (await gaEvents(page)).filter((e) => e.name === 'coupon_landing');
    expect(landing).toHaveLength(1);
    expect(landing[0].params).toEqual({ coupon_type: 'friend' });

    // Later in the same visit she has an order of her own, and opens checkout.
    const mine = await makeParty(request, 'Dana');
    await page.goto(`/collect.html?c=${mine.id}&k=${mine.k}`);
    const tab = page.getByTestId('tab-pay');
    await tab.waitFor({ state: 'visible' });
    await tab.click();
    await page.locator('#payPanel > summary').click();
    await expect(page.locator('#couponInput')).toHaveValue(code);
    await expect(page.locator('#couponMsg')).toContainText('5% הנחה');
    // Pickup at 199, minus 5% of the game: round(199 × 0.95) = 189.
    await expect(page.locator('#payTotal')).toHaveText('189');
  });

  test('a code that is already used says so, and the order goes on without it', async ({
    page,
    request,
  }) => {
    const mine = await makeParty(request, 'Dana');
    await page.route('**/coupon/validate', (route) =>
      route.fulfill({ json: { valid: false, reason: 'used' } })
    );
    await page.goto('/?coupon=NOA5-K7Q2');
    await page.goto(`/collect.html?c=${mine.id}&k=${mine.k}`);
    const tab = page.getByTestId('tab-pay');
    await tab.waitFor({ state: 'visible' });
    await tab.click();
    await page.locator('#payPanel > summary').click();
    await expect(page.locator('#couponMsg')).toHaveText('הקופון הזה כבר נוצל');
    await expect(page.locator('#payTotal')).toHaveText('199');
    // Dropped, so it is not tried again on the next visit.
    expect(await page.evaluate(() => sessionStorage.getItem('dugri:coupon'))).toBe(null);
  });

  test('the purchase event carries the friend code in GA’s coupon parameter', async ({ page }) => {
    await page.route('**/api/collections/**/summary**', (route) =>
      route.fulfill({
        json: {
          order_no: 'DG-2001',
          honoree_name: 'דנה',
          design: 'bachelorette',
          order: {
            version: 'pickup',
            version_label: 'איסוף',
            total: 199,
            quantity: 1,
            unit_price: 199,
            delivery_fee: 0,
            charged: 189,
            coupon: 'NOA5-K7Q2',
            paid: true,
          },
          preview: null,
        },
      })
    );
    await page.goto('/pay-success.html?c=friend-coupon-order&k=tok');
    await expect(page.locator('#orderNoVal')).toHaveText('DG-2001');
    const purchase = (await gaEvents(page)).find((e) => e.name === 'purchase');
    expect(purchase.params).toMatchObject({ coupon: 'NOA5-K7Q2', value: 189 });
  });
});

test.describe('the coupons page', () => {
  test('one summary row, which opens the list, searchable by email or code', async ({
    page,
    request,
  }) => {
    const party = await makeParty(request, 'Noa');
    const email = uniq('admin') + '@example.com';
    const issued = await request.post('/api/friend-coupon', {
      data: { email, collection_id: party.id, marketing_consent: true },
    });
    const { code } = await issued.json();

    await page.goto('/coupons.html?key=dugri-admin');
    const panel = page.getByTestId('friend-panel');
    await expect(panel).toBeVisible();
    const summary = page.getByTestId('friend-summary-row');
    await expect(summary).toContainText('קופוני חברים, 5%');
    const issuedCount = Number(await page.locator('#fcIssued').innerText());
    expect(issuedCount).toBeGreaterThanOrEqual(1);
    // The list is behind the row, not on the page.
    await expect(page.getByTestId('friend-search')).toBeHidden();

    await summary.click();
    await page.getByTestId('friend-search').fill(code.toLowerCase());
    const rows = panel.locator('[data-testid="friend-row"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(email);
    await expect(rows.first()).toContainText(code);
    await expect(rows.first()).toContainText('כן');

    await page.getByTestId('friend-search').fill(email);
    await expect(rows).toHaveCount(1);
  });
});
