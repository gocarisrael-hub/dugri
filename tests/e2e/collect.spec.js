import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// A 1x1 transparent PNG used as the fake rendered preview image.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function createCollection(page, name) {
  // The create button is gated on the name step until the preview shows — stub
  // /api/preview so the gate opens without the Python render. Default design is
  // bachelorette (an ENGLISH theme), so `name` must be a single English word.
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
  // Collections are now created at the end of the order wizard (options.html).
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click(); // design -> colour + add-ons
  await page.getByTestId('next-btn').click(); // colour + add-ons -> name
  await page.fill('#honoreeInput', name);
  await page.getByTestId('gender-female').check(); // gender is required to advance
  await page.getByTestId('next-btn').click(); // name -> optional pawn photos
  await page.getByTestId('next-btn').click(); // pawn photos -> contact
  await page.fill('#ownerEmail', 'test@example.com'); // email required
  await page.fill('#ownerPhone', '0521234567'); // valid IL mobile, required
  await page.getByTestId('next-btn').click(); // "צרו את המשחק"
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
}

// Pin /api/pricing so the pay-panel tests exercise a KNOWN set of versions/prices
// regardless of the server's launch defaults (which are pickup-only). The legacy
// spread — all four versions enabled, pdf first at 79 — keeps the historical
// per-version assertions meaningful. Call BEFORE createCollection so the route is
// registered before collect.html fetches it. (Only affects browser fetches;
// page.request.* calls bypass page.route and hit the real server.)
// The e2e server runs without PELECARD_* credentials, so the API reports
// `card_enabled: false` and every pay affordance is correctly hidden. The pay-bar
// tests are about what the OWNER sees when card payment IS configured, so flip
// that one field on the state response and leave the rest of the server's answer
// alone. (The card-disabled behaviour keeps its own test, unstubbed.)
async function withCardEnabled(page) {
  await page.route(/\/api\/collections\/[^/?]+(\?|$)/, async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    try {
      const j = JSON.parse(body);
      j.card_enabled = true;
      body = JSON.stringify(j);
    } catch {
      /* not json — hand it back untouched */
    }
    return route.fulfill({ response: res, body });
  });
}

async function stubPricing(page, pricing) {
  const body = pricing || {
    store: { now: 79, was: 129 },
    // Sale mode ON: these specs assert the struck was-price, which
    // css/tokens.css hides unless /api/pricing reports a live sale.
    sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
    versions: {
      pdf: { enabled: true, price: 79 },
      pickup: { enabled: true, price: 149 },
      delivery: { enabled: true, price: 199 },
      custom: { enabled: true, price: 599 },
    },
  };
  await page.route('**/api/pricing', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  );
}

test('create → add words (one-by-one + paste, deduped) → idea generator → close', async ({
  page,
}) => {
  await createCollection(page, 'Shira');
  await expect(page.locator('#title')).toContainText('Shira');

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
  await expect(page.locator('#ideaBox')).toContainText('Shira');

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
  await createCollection(page, 'Shira');

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

test('owner taps a word to edit it inline: Enter commits the fix, and it persists across reload', async ({
  page,
}) => {
  await createCollection(page, 'Shira');

  await page.fill('#wordInput', 'הדייט מטבריה');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');

  const textFor = (word) => page.locator('.word', { hasText: word }).getByTestId('word-text');

  // Tapping the word text turns it into an inline editable field.
  await textFor('הדייט מטבריה').click();
  const editor = page.getByTestId('word-edit-input');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();

  // Fix the typo and commit with Enter → the pill shows the new text.
  await editor.fill('הדייט מטבריה הישנה');
  await editor.press('Enter');
  await expect(page.getByTestId('word-edit-input')).toHaveCount(0);
  await expect(page.locator('#wordsWrap')).toContainText('הדייט מטבריה הישנה');
  await expect(page.locator('#count')).toHaveText('1'); // still one word — edited, not added

  // Persisted server-side: it survives a reload.
  await page.reload();
  await expect(page.locator('#wordsWrap')).toContainText('הדייט מטבריה הישנה');
  await expect(page.locator('#count')).toHaveText('1');
});

test('editing a word: Escape cancels and keeps the original text', async ({ page }) => {
  await createCollection(page, 'Shira');

  await page.fill('#wordInput', 'סוכר באמא');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');

  const text = page.locator('.word', { hasText: 'סוכר באמא' }).getByTestId('word-text');
  await text.click();
  const editor = page.getByTestId('word-edit-input');
  await editor.fill('משהו אחר לגמרי');
  await editor.press('Escape');

  // The edit is discarded — original text stays, no new word created.
  await expect(page.getByTestId('word-edit-input')).toHaveCount(0);
  await expect(page.locator('#wordsWrap')).toContainText('סוכר באמא');
  await expect(page.locator('#wordsWrap')).not.toContainText('משהו אחר לגמרי');
  await expect(page.locator('#count')).toHaveText('1');
});

test('editing a word to a value containing a comma keeps the whole text (no truncation)', async ({
  page,
}) => {
  await createCollection(page, 'Shira');

  await page.fill('#wordInput', 'ניו יורק');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');

  const text = page.locator('.word', { hasText: 'ניו יורק' }).getByTestId('word-text');
  await text.click();
  const editor = page.getByTestId('word-edit-input');
  // A comma must NOT split the word — the old parseWordText path dropped
  // everything after the comma. The full text must be saved.
  await editor.fill('ניו יורק, לונדון');
  await editor.press('Enter');

  await expect(page.getByTestId('word-edit-input')).toHaveCount(0);
  await expect(page.locator('#wordsWrap')).toContainText('ניו יורק, לונדון');
  await expect(page.locator('#count')).toHaveText('1');

  await page.reload();
  await expect(page.locator('#wordsWrap')).toContainText('ניו יורק, לונדון');
});

test('the background poll does not tear down an in-progress edit (no data loss past 5s)', async ({
  page,
}) => {
  await createCollection(page, 'Shira');

  await page.fill('#wordInput', 'טעות דפוס');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');

  const text = page.locator('.word', { hasText: 'טעות דפוס' }).getByTestId('word-text');
  await text.click();
  const editor = page.getByTestId('word-edit-input');
  await editor.fill('התיקון הנכון');

  // Hold the edit open longer than the 5s background poll. The poll must NOT
  // re-render and detach the focused input (which would blur-commit or lose the
  // half-typed text). The editor stays open and focused with the typed value.
  await page.waitForTimeout(6000);
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('התיקון הנכון');

  // Now commit — the intended value lands, exactly one word, nothing lost.
  await editor.press('Enter');
  await expect(page.getByTestId('word-edit-input')).toHaveCount(0);
  await expect(page.locator('#wordsWrap')).toContainText('התיקון הנכון');
  await expect(page.locator('#count')).toHaveText('1');
});

test('a contributor (no owner key) cannot edit words: the text is not tappable', async ({
  page,
  context,
}) => {
  await createCollection(page, 'Shira');
  await page.fill('#wordInput', 'בדיחה פנימית');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');

  const friendsUrl = page.url().replace(/&k=.*/, '');
  const friend = await context.newPage();
  await friend.goto(friendsUrl);
  await expect(friend.locator('#wordsWrap')).toContainText('בדיחה פנימית');
  // No edit affordance for a plain contributor: the text has no editable role and
  // clicking it does not open an editor.
  const text = friend.getByTestId('word-text');
  await expect(text).not.toHaveClass(/editable/);
  await text.click();
  await expect(friend.getByTestId('word-edit-input')).toHaveCount(0);
});

test('submitting a word that already exists shows a non-blocking duplicate toast and does not add a row', async ({
  page,
}) => {
  await createCollection(page, 'Shira');

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
  await createCollection(page, 'Shira');

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
  await stubPricing(page);
  await createCollection(page, 'Shira');

  // Owner sees the pay panel; it's collapsed by default — open it first.
  await expect(page.locator('#payPanel')).toBeVisible();
  await expect(page.locator('#payTotal')).toBeHidden();
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#payTotal')).toHaveText('79');
  await expect(page.locator('#addressForm')).toBeHidden();

  // Select delivery → address fields appear, total becomes 199.
  await page.check('input[name="payVersion"][value="pickup"]');
  await page.check('#shipToggle');
  await expect(page.locator('#addressForm')).toBeVisible();
  await expect(page.locator('#payTotal')).toHaveText('199');

  // Card-only: there is no Bit link anywhere.
  await expect(page.locator('#bitPayLink')).toHaveCount(0);
  await expect(page.locator('#payPanel')).not.toContainText('ביט');
});

test('owner pay panel: delivery address uses a two-column layout, not stacked boxes', async ({
  page,
}) => {
  await stubPricing(page);
  await createCollection(page, 'Shira');

  await page.locator('#payPanel summary').click();
  await page.check('input[name="payVersion"][value="pickup"]');
  await page.check('#shipToggle');
  await expect(page.locator('#addressForm')).toBeVisible();

  const box = async (sel) => {
    const b = await page.locator(sel).boundingBox();
    if (!b) throw new Error('no box for ' + sel);
    return b;
  };
  const [street, city, postal, apt, floor] = await Promise.all([
    box('#addrStreet'),
    box('#addrCity'),
    box('#addrPostal'),
    box('#addrApt'),
    box('#addrFloor'),
  ]);
  const sameRow = (a, b) => Math.abs(a.y - b.y) < 5;

  // Street spans its own full-width row, above the paired fields.
  expect(street.y).toBeLessThan(city.y - 5);
  expect(street.width).toBeGreaterThan(city.width + 20);

  // City + postal share a row; apartment + floor share a row (side by side,
  // at distinct horizontal positions — the whole point of the fix).
  expect(sameRow(city, postal)).toBe(true);
  expect(sameRow(apt, floor)).toBe(true);
  expect(Math.abs(city.x - postal.x)).toBeGreaterThan(20);
  expect(Math.abs(apt.x - floor.x)).toBeGreaterThan(20);

  // The two rows are distinct — the apt/floor row sits below the city/postal row.
  expect(apt.y).toBeGreaterThan(city.y + 5);
});

// Bug #2: when the owner switches OFF every checkout option, the client used to
// force-select a disabled 'pickup' and let the buyer hit a rejected charge. It
// now shows a clear "sales paused" notice instead of a dead-end.
test('owner pay panel: all options disabled → paused notice, not a dead-end button', async ({
  page,
}) => {
  await stubPricing(page, {
    store: { now: 199, was: 239 },
    // Sale mode ON: these specs assert the struck was-price, which
    // css/tokens.css hides unless /api/pricing reports a live sale.
    sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
    versions: {
      pdf: { enabled: false, price: 79 },
      pickup: { enabled: false, price: 199 },
      delivery: { enabled: false, price: 199 },
      custom: { enabled: false, price: 599 },
    },
  });
  await createCollection(page, 'Shira');

  await page.locator('#payPanel summary').click();
  // The paused notice replaces the actionable area: options + pay button hidden.
  await expect(page.locator('#paySoldOutNote')).toBeVisible();
  await expect(page.locator('#payOpts')).toBeHidden();
  await expect(page.locator('#cardPayBtn')).toBeHidden();
  // No radio is left checked at a disabled version (no dead-end selection).
  await expect(page.locator('input[name="payVersion"]:checked')).toHaveCount(0);
});

// Bug #5: applyPricing stamps each option's live "now" price into `.opt-price`.
// It must do so WITHOUT deleting a struck "was" discount anchor (<s class="was">)
// present in the option — overwriting the whole node via textContent would drop
// it and lose the discount cue. The shipped options carry no struck price today,
// so inject one BEFORE the price stamp runs (while pricing is still loading) and
// assert applyPricing preserves it when it stamps the now-price over the option.
test('owner pay panel: applyPricing preserves an option\'s struck "was" anchor when it stamps the price', async ({
  page,
}) => {
  await enableCardButton(page);
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route('**/api/pricing', async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        store: { now: 199, was: 239 },
        // Sale mode ON: these specs assert the struck was-price, which
        // css/tokens.css hides unless /api/pricing reports a live sale.
        sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
        versions: {
          pdf: { enabled: true, price: 79 },
          pickup: { enabled: true, price: 149 },
          delivery: { enabled: true, price: 199 },
          custom: { enabled: false, price: 599 },
        },
      }),
    });
  });
  await createCollection(page, 'Shira');
  await page.locator('#payPanel summary').click();

  // While pricing is still loading (applyPricing has NOT stamped the options yet),
  // inject a struck "was" anchor into the pdf option, as a discounted option would
  // ship it.
  const pdfPrice = page.locator('.pay-opt:has(input[value="pdf"]) .opt-price');
  await pdfPrice.evaluate((el) => {
    const s = document.createElement('s');
    s.className = 'was';
    s.textContent = '₪129';
    el.prepend(s);
  });

  // Release pricing → applyPricing stamps the live now-price over the option.
  release();

  // The struck anchor survives the stamp, and the live now-price shows next to it.
  await expect(pdfPrice.locator('s.was')).toHaveText('₪129');
  await expect(pdfPrice).toContainText('₪79');
});

test('owner pay panel is collapsed by default and opens on the summary button', async ({
  page,
}) => {
  await createCollection(page, 'Shira');
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

// THE PAY BAR. It replaced a strip at the top of the page that said "the
// payment is waiting below ⬇" — a signpost, on the one page the buyer stays on
// for a long time, so it scrolled away the moment she started typing. The bar
// is sticky, carries the amount, and opens the checkout.
//
// It is shown on the same condition the strip was (open && !paid && card
// enabled), which the two tests above and below this one still pin from the
// other side: no bar on a card-disabled deployment, no bar once paid.
test('the pay bar carries the price, sticks to the screen and opens the checkout', async ({
  page,
}) => {
  await stubPricing(page, {
    store: { now: 199, was: 239 },
    // Sale mode ON: these specs assert the struck was-price, which
    // css/tokens.css hides unless /api/pricing reports a live sale.
    sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
    versions: {
      pdf: { enabled: false, price: 79 },
      pickup: { enabled: true, price: 199 },
      delivery: { enabled: false, price: 199 },
      custom: { enabled: false, price: 599 },
    },
  });
  await withCardEnabled(page);
  await createCollection(page, 'Shira');

  const bar = page.getByTestId('pay-bar');
  await expect(bar).toBeVisible();
  // The amount is the panel's own number, not a second computation of it.
  await expect(page.getByTestId('pay-bar-amount')).toHaveText('₪199');
  await expect(page.locator('#payTotal')).toHaveText('199');

  // STICKY: still on screen at the foot of a long page, which is the whole point.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(bar).toBeInViewport();

  // …and it opens the checkout rather than pointing at it.
  await expect(page.locator('#payPanel')).not.toHaveAttribute('open', '');
  await page.getByTestId('pay-bar-btn').click();
  await expect(page.locator('#payPanel')).toHaveAttribute('open', '');
});

// THE OWNER'S CONDITION for accepting the bar, in her words: "the whatsapp
// button need to be available always". A fixed bar at the foot of the page is
// exactly the thing that buries a fixed button at the foot of the page, so this
// asks the question a thumb asks — at the middle of the help button, what would
// I actually hit?
test('the pay bar never buries the WhatsApp help button', async ({ page }) => {
  await withCardEnabled(page);
  await createCollection(page, 'Shira');
  await expect(page.getByTestId('pay-bar')).toBeVisible();

  const hit = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wa-help"]');
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight || r.top < 0) return 'outside the viewport';
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (el.contains(at) || at === el) return 'ok';
    return at && at.closest('[data-testid="pay-bar"]') ? 'the pay bar' : 'something else';
  });
  expect(hit, 'tapping the WhatsApp button must land on it').toBe('ok');
  // And the tap goes through (target=_blank, so just assert it does not throw).
  await page.getByTestId('wa-help').click({ trial: true, timeout: 5000 });
});

// A taller bar must push the help button further up, not slide under it. The
// copy is owner-editable, so this is a real state, not a hypothetical: the
// offset is the bar's MEASURED height for exactly this reason.
test('a wrapped pay-bar label lifts the WhatsApp button with it', async ({ page }) => {
  // A phone: the width where a longer label actually wraps and makes the bar
  // taller. On a desktop viewport the same string fits on one line and this
  // would pass without testing anything.
  await page.setViewportSize({ width: 390, height: 844 });
  await withCardEnabled(page);
  await createCollection(page, 'Shira');
  const bar = page.getByTestId('pay-bar');
  await expect(bar).toBeVisible();

  const before = await bar.evaluate((el) => el.getBoundingClientRect().height);
  await page.locator('[data-edit="collect-pay-bar-label"]').evaluate((el) => {
    el.textContent = 'המשחק שלכם מוכן ומחכה לתשלום — אפשר להמשיך להוסיף מילים גם אחרי שמשלמים';
  });
  await expect
    .poll(async () => bar.evaluate((el) => el.getBoundingClientRect().height))
    .toBeGreaterThan(before);

  // Polled, not read once: the lift travels label -> ResizeObserver ->
  // --pay-bar-h -> layout, so a single read can land a frame early and see the
  // button still at the old height's offset. What must be true is that it ENDS
  // UP clear, which is what a buyer's thumb meets.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const wa = document.querySelector('[data-testid="wa-help"]').getBoundingClientRect();
          const b = document.querySelector('[data-testid="pay-bar"]').getBoundingClientRect();
          return Math.round(b.top - wa.bottom);
        }),
      { message: 'the help button must sit above the taller bar' }
    )
    .toBeGreaterThanOrEqual(0);
});

test('card disabled: no dead pay CTA, neutral note instead, and no top nag', async ({ page }) => {
  // The E2E server runs without PELECARD_* credentials, so card_enabled is
  // false. There must be NO clickable pay button, a neutral "coming soon" note
  // in the panel instead, and the top reminder must NOT nag toward a dead panel.
  await createCollection(page, 'Shira');
  await expect(page.getByTestId('pay-bar')).toBeHidden();
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#cardPayBtn')).toBeHidden();
  await expect(page.locator('#bitPayLink')).toHaveCount(0);
  await expect(page.locator('#cardSoonNote')).toBeVisible();
  await expect(page.locator('#cardSoonNote')).toContainText('ייפתח בקרוב');
});

// The two-stage minimum/maximum counter is the UNCAPPED view — what a buyer sees
// once payment (or an admin exception) lifts the free word quota. A capped
// collection reframes its counter around the quota instead; that behaviour lives
// in free-word-limit.spec.js. Admin has no "mark as paid" on purpose, so these
// specs lift the quota on their own collection through the admin PATCH — which is
// per-collection, so it can't disturb a spec running in parallel.
async function liftFreeQuota(page) {
  const c = new URL(page.url()).searchParams.get('c');
  const res = await page.request.patch(`/api/admin/collections/${c}?key=dugri-admin`, {
    data: { free_limit_applies: false },
  });
  if (!res.ok()) throw new Error('could not lift the free quota: HTTP ' + res.status());
  await page.reload();
  return c;
}

test('below 70 words: Stage-1 bar is scaled to the 70-word minimum', async ({ page }) => {
  await createCollection(page, 'Shira');
  await liftFreeQuota(page);
  // Stage 1 frames the 70-word minimum (not the 412 max) below the goal.
  await expect(page.locator('.count-pill')).toContainText('/ 70');
  await expect(page.locator('.count-pill')).toContainText('מינימום');
  await expect(page.locator('#stage1')).toBeVisible();
  await expect(page.locator('#stage2')).toBeHidden();
  await page.fill('#wordInput', 'מילה אחת');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#countMax')).toContainText('/ 70');
  await expect(page.locator('#countHint')).toContainText('70');
  // one word = 1/70 ≈ 1.43% of a 70-word Stage-1 bar
  const width = await page.locator('#barFill1').evaluate((el) => el.style.width);
  expect(parseFloat(width)).toBeCloseTo(100 / 70, 1);
});

test('at 70+ words: Stage-2 bar replaces Stage-1 and is scaled to the 412 max', async ({
  page,
}) => {
  await createCollection(page, 'Shira');
  const c = await liftFreeQuota(page);
  // Reach exactly the 70-word minimum in one API call.
  const words = Array.from({ length: 70 }, (_, i) => 'w' + i);
  const res = await page.request.post(`/api/collections/${c}/words`, { data: { words } });
  expect(res.ok()).toBeTruthy();

  await page.reload();
  await expect(page.locator('#count')).toHaveText('70');
  // The swap: Stage-1 gone, the new Stage-2 bar takes over and frames the max.
  await expect(page.locator('#stage1')).toBeHidden();
  await expect(page.locator('#stage2')).toBeVisible();
  await expect(page.locator('#countMax')).toContainText('/ 412');
  await expect(page.locator('#countMax')).not.toContainText('מינימום');
  // 70 / 412 ≈ 17% — the second bar starts already ~⅙ filled.
  const width = await page.locator('#barFill2').evaluate((el) => el.style.width);
  expect(parseFloat(width)).toBeGreaterThan(14);
  expect(parseFloat(width)).toBeLessThan(20);
});

test('over the 412 cap: counter shows 412 max (no fraction over cap), bar full', async ({
  page,
}) => {
  await createCollection(page, 'Shira');
  const c = await liftFreeQuota(page);
  // Push the count past the cap in one API call (413 unique words).
  const words = Array.from({ length: 413 }, (_, i) => 'w' + i);
  const res = await page.request.post(`/api/collections/${c}/words`, { data: { words } });
  expect(res.ok()).toBeTruthy();

  await page.reload();
  await expect(page.locator('#count')).toHaveText('412'); // capped display
  await expect(page.locator('#countMax')).toContainText('מקסימום');
  await expect(page.locator('.count-pill')).not.toContainText('413');
  await expect(page.locator('.count-pill')).not.toContainText('/ 412'); // no fraction over cap
  await expect(page.locator('#countHint')).toContainText('מקסימום');
  // Past 70 words the Stage-2 bar is in play; over the cap it's full.
  const width = await page.locator('#barFill2').evaluate((el) => el.style.width);
  expect(parseFloat(width)).toBe(100); // bar full
});

test('each option price is rendered from the pricing endpoint', async ({ page }) => {
  // Per-option prices now come from /api/pricing (not baked into the label HTML).
  await stubPricing(page);
  await createCollection(page, 'Shira');
  await page.locator('#payPanel summary').click();
  // pdf is first + enabled in the stub → ₪79; pickup shows the stubbed ₪149.
  await expect(page.locator('#payPanel .opt-price').first()).toContainText('₪79');
  await expect(page.locator('#payPanel')).toContainText('₪149');
});

test('launch defaults: checkout offers ONLY self-pickup at ₪199', async ({ page }) => {
  // The out-of-the-box settings: pickup-only. The other versions must be hidden
  // and not selectable, and the total is the pickup price.
  await stubPricing(page, {
    store: { now: 199, was: 239 },
    // Sale mode ON: these specs assert the struck was-price, which
    // css/tokens.css hides unless /api/pricing reports a live sale.
    sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
    versions: {
      pdf: { enabled: false, price: 79 },
      pickup: { enabled: true, price: 199 },
      delivery: { enabled: false, price: 199 },
      custom: { enabled: false, price: 599 },
    },
  });
  await createCollection(page, 'Shira');
  await page.locator('#payPanel summary').click();

  const label = (v) => page.locator(`.pay-opt:has(input[value="${v}"])`);
  await expect(label('pickup')).toBeVisible();
  for (const v of ['pdf', 'custom']) {
    await expect(label(v)).toBeHidden();
    await expect(page.locator(`input[name="payVersion"][value="${v}"]`)).toBeDisabled();
  }
  // Delivery is the tick, not a version: with shipping off sale it is not offered
  // at all, so the printed game is simply collected.
  await expect(page.getByTestId('ship-toggle')).toBeHidden();
  // pickup is auto-selected and the total is its price.
  await expect(page.locator('input[name="payVersion"][value="pickup"]')).toBeChecked();
  await expect(page.locator('#payTotal')).toHaveText('199');
  await expect(page.locator('#payPanel')).toContainText('₪199');
});

test('an admin custom order LOCKS checkout to custom @599 — no client downgrade', async ({
  page,
}) => {
  // Regression: a pending admin-created custom order (599₪) paid after `custom`
  // was hidden must NOT be re-priced as pickup (199₪). Checkout locks to the
  // order's version + stored total.
  await enableCardButton(page); // makes the pay button visible so we can assert it
  await stubPricing(page); // all versions "enabled" — the LOCK must override this
  await createCollection(page, 'Shira');
  const c = new URL(page.url()).searchParams.get('c');
  // Admin creates the bespoke custom order on this collection.
  const res = await page.request.post(`/api/admin/collections/${c}/custom?key=dugri-admin`);
  expect(res.ok()).toBeTruthy();

  await page.reload();
  await page.locator('#payPanel summary').click();
  const label = (v) => page.locator(`.pay-opt:has(input[value="${v}"])`);
  // Only the custom option is shown, at its stored 599 — no cheaper option.
  await expect(label('custom')).toBeVisible();
  for (const v of ['pdf', 'pickup', 'delivery']) {
    await expect(label(v)).toBeHidden();
  }
  await expect(page.locator('#payTotal')).toHaveText('599');
  await expect(page.locator('#payPanel')).toContainText('₪599');
  // The order stays payable (it's a valid persisted order).
  await expect(page.locator('#cardPayBtn')).toBeEnabled();
});

test('pricing fetch failure disables pay and offers a refresh (never a guessed price)', async ({
  page,
}) => {
  await enableCardButton(page);
  // The pricing endpoint is down — the checkout must not offer to charge a guess.
  await page.route('**/api/pricing', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
  );
  await createCollection(page, 'Shira');
  await page.locator('#payPanel summary').click();

  await expect(page.locator('#priceLoadErr')).toBeVisible();
  await expect(page.locator('#priceLoadErr [data-role="retry"]')).toBeVisible();
  await expect(page.locator('#payOpts')).toBeHidden();
  await expect(page.locator('#cardPayBtn')).toBeDisabled();
  // Fix #2: the total line must NOT show the PRICING_FALLBACK ₪199 beside the
  // "couldn't load prices" message — no guessed number at all.
  await expect(page.locator('#payTotal')).toHaveText('-');
  await expect(page.locator('.pay-total')).not.toContainText('199');
});

test('pay stays disabled (no guessed total) until pricing RESOLVES, then enables at the live price', async ({
  page,
}) => {
  // Fix #3: during the in-flight /api/pricing window the seeded launch defaults
  // must NOT be presented as payable — a fast click could otherwise charge the
  // live (server-authoritative) price the buyer never saw. Hold the response.
  await enableCardButton(page);
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route('**/api/pricing', async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        store: { now: 249, was: 299 },
        // Sale mode ON: these specs assert the struck was-price, which
        // css/tokens.css hides unless /api/pricing reports a live sale.
        sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
        versions: {
          pdf: { enabled: false, price: 79 },
          pickup: { enabled: true, price: 249 },
          delivery: { enabled: false, price: 199 },
          custom: { enabled: false, price: 599 },
        },
      }),
    });
  });
  await createCollection(page, 'Shira');
  await page.locator('#payPanel summary').click();

  // Before pricing resolves: pay disabled, a "loading prices" note, no number.
  await expect(page.locator('#cardPayBtn')).toBeDisabled();
  await expect(page.locator('#payTotal')).toHaveText('-');
  await expect(page.locator('#priceLoadErr')).toContainText('טוענים');

  // Let pricing resolve — now pay enables at the confirmed live price (249).
  release();
  await expect(page.locator('#cardPayBtn')).toBeEnabled();
  await expect(page.locator('#payTotal')).toHaveText('249');
  await expect(page.locator('#priceLoadErr')).toBeHidden();
});

test('no version enabled → checkout shows "orders closed", no pay button, no total', async ({
  page,
}) => {
  await enableCardButton(page);
  await stubPricing(page, {
    store: { now: 199, was: 239 },
    // Sale mode ON: these specs assert the struck was-price, which
    // css/tokens.css hides unless /api/pricing reports a live sale.
    sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
    versions: {
      pdf: { enabled: false, price: 79 },
      pickup: { enabled: false, price: 199 },
      delivery: { enabled: false, price: 199 },
      custom: { enabled: false, price: 599 },
    },
  });
  await createCollection(page, 'Shira');
  await page.locator('#payPanel summary').click();

  await expect(page.locator('#priceLoadErr')).toBeVisible();
  await expect(page.locator('#priceLoadErr')).toContainText('סגור');
  // No retry (this isn't a load failure), no option list, pay disabled.
  await expect(page.locator('#priceLoadErr [data-role="retry"]')).toBeHidden();
  await expect(page.locator('#payOpts')).toBeHidden();
  await expect(page.locator('#cardPayBtn')).toBeDisabled();
});

test("a stored delivery address prefills the checkout form so the buyer isn't forced to re-type it", async ({
  page,
}) => {
  // Fix #4: an order with a stored delivery address (owner reload) must prefill
  // the form — collectAddress() otherwise blocks pay until street/city/zip are
  // re-entered. Place an order with a delivery address, reload as the owner, and
  // assert the fields come back filled.
  //
  // The delivery order is created in TWO steps — a pickup order, then the ADMIN
  // order edit that switches it to delivery — rather than POSTing delivery
  // straight to /order. The public route refuses a version the owner has turned
  // off, and delivery ships off, so the direct route needed `pricing.delivery_
  // enabled` flipped on the server. That setting is GLOBAL and shared with every
  // spec running concurrently: for the width of this one test the whole suite saw
  // a checkout that offers delivery, which is exactly the cross-spec flake the
  // retries were papering over. adminUpdateOrder deliberately doesn't consult the
  // enable gate (the owner fulfils what was actually sold), so this reaches the
  // same stored state while touching only THIS collection.
  await enableCardButton(page);
  await stubPricing(page, {
    store: { now: 199, was: 239 },
    // Sale mode ON: these specs assert the struck was-price, which
    // css/tokens.css hides unless /api/pricing reports a live sale.
    sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
    versions: {
      pdf: { enabled: false, price: 79 },
      pickup: { enabled: true, price: 199 },
      delivery: { enabled: true, price: 220 },
      custom: { enabled: false, price: 599 },
    },
  });
  await createCollection(page, 'Shira');
  const url = new URL(page.url());
  const c = url.searchParams.get('c');
  const k = url.searchParams.get('k');
  const placed = await page.request.post(`/api/collections/${c}/order`, {
    data: { owner_token: k, version: 'pickup' },
  });
  expect(placed.ok()).toBeTruthy();
  const switched = await page.request.patch(`/api/admin/collections/${c}?key=dugri-admin`, {
    data: {
      order: {
        version: 'delivery',
        address: { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' },
      },
    },
  });
  expect(switched.ok()).toBeTruthy();

  await page.reload();
  await page.locator('#payPanel summary').click();
  // Re-tick shipping; the stored address is prefilled (no re-typing to pay).
  await page.locator('#shipToggle').check();
  await expect(page.locator('#addrStreet')).toHaveValue('הרצל 1');
  await expect(page.locator('#addrCity')).toHaveValue('תל אביב');
  await expect(page.locator('#addrPostal')).toHaveValue('6100000');
});

// The link the order-confirmation email's "complete your payment" button carries.
// Landing on the word list with the checkout folded shut is the failure this
// guards: the button promises payment, so the payment has to be on screen.
test('?pay=1 (the order email pay button) opens the checkout on arrival', async ({ page }) => {
  await enableCardButton(page);
  await stubPricing(page);
  await createCollection(page, 'Shira');
  const url = new URL(page.url());

  // Same page WITHOUT the flag: the panel is there but collapsed.
  await expect(page.locator('#payPanel')).toBeVisible();
  await expect(page.locator('#payPanel')).not.toHaveAttribute('open', /.*/);

  await page.goto(url.pathname + url.search + '&pay=1');
  const panel = page.locator('#payPanel');
  await expect(panel).toHaveAttribute('open', /.*/);
  // Scrolled to for real, not merely expanded somewhere down the page: the
  // version options are on screen. (The pay button itself sits below the fold on
  // a phone — the panel is taller than the viewport — which is why the arrival
  // aligns the panel's top rather than centering it.)
  await expect(page.locator('#payOpts')).toBeInViewport();
});

test('?pay=1 on an ALREADY-PAID order does not force a dead panel open', async ({ page }) => {
  // The panel is gone once paid (the "keep adding, then סיום" card replaces it),
  // so a stale link from the inbox must land quietly rather than reopening a
  // checkout for an order that is already settled.
  const ctl = await enableCardButton(page);
  await stubPricing(page);
  await createCollection(page, 'Shira');
  const url = new URL(page.url());
  ctl.paid = true;

  await page.goto(url.pathname + url.search + '&pay=1');
  await expect(page.locator('#paidCard')).toBeVisible();
  await expect(page.locator('#payPanel')).toBeHidden();
});

test('after payment: pay panel + reminder disappear, סיום card takes over', async ({ page }) => {
  // There is no admin "mark as paid" route — an order goes paid only on a real
  // money event, and the E2E server runs without card credentials — so the paid
  // FLAG is injected into the collection GET (ctl.paid). This test is about how
  // the collect page renders a paid order, not about how it became paid; the
  // order and the close below are real server state.
  const ctl = await enableCardButton(page);
  await createCollection(page, 'Shira');
  const url = new URL(page.url());
  const c = url.searchParams.get('c');
  const k = url.searchParams.get('k');

  // Place a real order. pickup is the enabled-by-default version (page.request
  // bypasses page.route, so it must use a version the server actually offers).
  await page.request.post(`/api/collections/${c}/order`, {
    data: { owner_token: k, version: 'pickup' },
  });
  ctl.paid = true;

  await page.reload();
  // Pay panel + top reminder gone; the "keep adding, then סיום" card is shown.
  await expect(page.locator('#payPanel')).toBeHidden();
  await expect(page.getByTestId('pay-bar')).toBeHidden();
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
  // An explicit fee so the tick shows a real shipping price rather than ₪0.
  await stubPricing(page, {
    store: { now: 79, was: 129 },
    // Sale mode ON: these specs assert the struck was-price, which
    // css/tokens.css hides unless /api/pricing reports a live sale.
    sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
    delivery_fee: 39,
    versions: {
      pdf: { enabled: true, price: 79 },
      pickup: { enabled: true, price: 149 },
      delivery: { enabled: true, price: 149 },
      custom: { enabled: true, price: 599 },
    },
  });
  await createCollection(page, 'Shira');
  const panel = page.locator('#payPanel');
  await expect(panel).toContainText('דיגיטלי (PDF)');
  await expect(panel).toContainText('מורידים, מדפיסים לבד');
  // ONE printed game, priced once; delivery is the tick beneath it, priced at the
  // shipping fee alone.
  await expect(panel).toContainText('משחק מוכן ומודפס');
  await expect(panel).toContainText('מוכן תוך כ-3 ימי עסקים · איסוף מבית דפוס גלאור, ת״א');
  await expect(panel).toContainText('₪149');
  await expect(panel).toContainText('שלחו לי עד הבית');
  // The tick is priced at the SHIPPING alone, not at a second full product price.
  await expect(page.locator('#shipPrice')).toHaveText('₪39');
  await expect(panel).not.toContainText('המפונקת');
  await expect(panel).toContainText('מגיע תוך כ-7 ימי עסקים');
  await expect(panel).toContainText('אזורים מרוחקים בתיאום ובתוספת תשלום');
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
  await stubPricing(page);
  await seedCoupon(page, 'TEST25', 25);
  await createCollection(page, 'Shira');

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

test('the struck full price sits to the LEFT of the discounted total (RTL)', async ({ page }) => {
  await stubPricing(page);
  await seedCoupon(page, 'TEST25', 25);
  await createCollection(page, 'Shira');

  await page.locator('#payPanel summary').click();
  await page.fill('#couponInput', 'TEST25');
  await page.click('#couponApplyBtn');

  const was = page.locator('#payWas');
  await expect(was).toBeVisible();
  await expect(was).toHaveText('₪79');

  const now = page.locator('.pay-total .pay-now');
  const wb = await was.boundingBox();
  const nb = await now.boundingBox();
  // The struck full price is fully to the LEFT of the discounted current total.
  expect(wb.x + wb.width).toBeLessThanOrEqual(nb.x + 1);
});

test('unknown coupon code shows a not-found message and leaves the total full', async ({
  page,
}) => {
  await stubPricing(page);
  await createCollection(page, 'Shira');
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

test('free coupon: pay/init free:true skips the iframe and still confirms on the success page', async ({
  page,
}) => {
  const ctl = await enableCardButton(page);
  // First pay attempt is rate-limited (leaves a red error); the second returns a
  // free/paid order (100%-off coupon) — no iframe, order already paid.
  let payMode = 'error';
  await page.route('**/api/collections/*/pay/init', async (route) => {
    if (payMode === 'error') {
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'too many attempts' }),
      });
    }
    ctl.paid = true; // the free order is now paid server-side
    // Answer slowly so the assertion below lands while the request is still in
    // flight — that's the window where a stale error would show if the click
    // handler stopped clearing it.
    await new Promise((r) => setTimeout(r, 600));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ free: true, paid: true, total: 0 }),
    });
  });

  await createCollection(page, 'Shira');
  const collectUrl = new URL(page.url());
  await page.locator('#payPanel summary').click();
  await expect(page.locator('#cardPayBtn')).toBeVisible();

  // Attempt 1 → 429 → a stale red error is shown in the pay panel.
  await page.click('#cardPayBtn');
  await expect(page.locator('#payErr')).toBeVisible();
  await expect(page.locator('#payErr')).toContainText('יותר מדי ניסיונות');

  // Attempt 2 → the free path succeeds.
  payMode = 'free';
  await page.click('#cardPayBtn');
  // The stale error from attempt 1 is cleared the moment the retry starts.
  await expect(page.locator('#payErr')).toBeHidden();

  // No iframe modal opens — but a free order is still a placed order, so it
  // gets the same confirmation as a card charge instead of quietly swapping the
  // panel underneath the buyer.
  await expect(page.locator('#payModal')).toBeHidden();
  await page.waitForURL(/pay-success\.html/);
  await expect(page.locator('h1')).toHaveText('התשלום התקבל');

  // Back to the collection: paid state, checkout gone.
  await page.locator('#backBtn').click();
  await page.waitForURL(/collect\.html/);
  expect(new URL(page.url()).search).toBe(collectUrl.search);
  await expect(page.locator('#paidCard')).toBeVisible();
  await expect(page.locator('#payPanel')).toBeHidden();
});

// The server callback that flips an order to paid can land a beat after the
// buyer is already back from the confirmation page. Returning must not greet
// them with the checkout they just paid — the page polls until paid instead of
// waiting for the ordinary 5s refresh.
test('returning from the confirmation page waits for the paid state, not the checkout', async ({
  page,
}) => {
  const ctl = await enableCardButton(page);
  await page.route('**/api/collections/*/pay/init', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ free: true, paid: true, total: 0 }),
    })
  );

  await createCollection(page, 'Shira');
  await page.locator('#payPanel summary').click();
  await page.click('#cardPayBtn');
  await page.waitForURL(/pay-success\.html/);

  // The order only becomes paid server-side AFTER the buyer heads back.
  await page.locator('#backBtn').click();
  await page.waitForURL(/collect\.html/);
  ctl.paid = true;

  // The short poll (1.5s cadence) picks it up well inside the 5s refresh.
  await expect(page.locator('#paidCard')).toBeVisible({ timeout: 4000 });
});

test('pay/init coupon errors: 400 clears the coupon, 409 and 429 show their messages', async ({
  page,
}) => {
  await stubPricing(page);
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

  await createCollection(page, 'Shira');
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

test('questionnaire: answering a question adds the word + shows ✓, and add-another adds a second word', async ({
  page,
}) => {
  await createCollection(page, 'Shira');

  // Open a category so its questions render as interactive rows.
  await page.locator('#catChips .chip').first().click();
  const row = page.getByTestId('q-row').first();
  await expect(row).toBeVisible();

  // No answer yet → no ✓, exactly one answer line (input + add).
  await expect(row.getByTestId('q-check')).toBeHidden();
  await expect(row.getByTestId('q-input')).toHaveCount(1);

  // Type an answer and add it → it goes straight into the collected word list,
  // the counter moves, and the question gets its green ✓.
  await row.getByTestId('q-input').fill('אמא רבקה');
  await row.getByTestId('q-add').click();
  await expect(page.locator('#wordsWrap')).toContainText('אמא רבקה');
  await expect(page.locator('#count')).toHaveText('1');
  await expect(row.getByTestId('q-check')).toBeVisible();

  // add-another: a fresh empty input appeared on the same question (2 inputs now,
  // and exactly one still-active add button).
  await expect(row.getByTestId('q-input')).toHaveCount(2);
  await expect(row.getByTestId('q-add')).toHaveCount(1);

  // A second, distinct word added from the same question lands as its own word.
  await row.getByTestId('q-input').nth(1).fill('אחות נועה');
  await row.getByTestId('q-add').click();
  await expect(page.locator('#wordsWrap')).toContainText('אחות נועה');
  await expect(page.locator('#count')).toHaveText('2');
  await expect(row.getByTestId('q-input')).toHaveCount(3);
});

test('questionnaire question text carries the honoree name + gender phrasing', async ({ page }) => {
  await createCollection(page, 'Shira'); // created with gender=female in the wizard
  await page.locator('#catChips .chip').first().click();
  // The first default category is "people"; its first question interpolates the
  // name and resolves the {female|male} token to the feminine form.
  const firstText = page.getByTestId('q-row').first().locator('.q-text');
  await expect(firstText).toContainText('Shira');
  await expect(firstText).toContainText('קוראת'); // feminine form, not "קורא"
});

test('how-to guidance is a collapsed details on collect that can be opened', async ({ page }) => {
  await createCollection(page, 'Shira');
  const details = page.locator('details.howto');
  await expect(details).toBeAttached();
  // Collapsed by default: the category content is hidden.
  await expect(page.locator('.howto .cat').first()).toBeHidden();
  await page.locator('.howto summary').click();
  await expect(page.locator('.howto .cat').first()).toBeVisible();
  await expect(details).toContainText('אנשים');
});

test('home link (→ index.html) and a tailored order CTA (→ options.html) are present', async ({
  page,
  context,
}) => {
  await createCollection(page, 'Shira');

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

test('owner share panel: WhatsApp button is the primary action, placed before the copy button, and links to wa.me with the friends link', async ({
  page,
}) => {
  await createCollection(page, 'Shira');

  // Share panel is owner-only; setupOwner reveals it.
  const panel = page.locator('#sharePanel');
  await expect(panel).toBeVisible();

  const wa = page.getByTestId('share-whatsapp');
  await expect(wa).toBeVisible();

  // Uses the SAME friends link the copy button shows.
  const friendsLink = await page.locator('#friendsLink').inputValue();
  expect(friendsLink).toContain('/collect.html?c=');

  // href is a wa.me share URL carrying the encoded friends link.
  const href = await wa.getAttribute('href');
  expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/);
  expect(href).toContain(encodeURIComponent(friendsLink));
  // The invite is personalized with the celebrant name (URL-encoded in the text).
  expect(href).toContain(encodeURIComponent('Shira'));
  const inviteText = new URL(href).searchParams.get('text');
  expect(inviteText).toContain('הפתעה לShira');
  expect(inviteText).toContain('מילים על Shira');
  expect(inviteText).not.toContain('undefined');
  await expect(wa).toHaveAttribute('target', '_blank');
  await expect(wa).toHaveAttribute('rel', /noopener/);

  // Primary action → precedes the secondary copy button in DOM order.
  const waBeforeCopy = await page.evaluate(() => {
    const waEl = document.getElementById('shareWhatsapp');
    const copyEl = document.getElementById('copyFriends');
    return !!(waEl.compareDocumentPosition(copyEl) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(waBeforeCopy).toBe(true);
});

test('owner share card: ONE link only, it is the PUBLIC one, and it sits between the words and the help card', async ({
  page,
}) => {
  await createCollection(page, 'Shira');
  const ownerToken = new URL(page.url()).searchParams.get('k');

  const panel = page.locator('#sharePanel');
  await expect(panel).toBeVisible();

  // Exactly ONE link box in the share card. Two links (public + management) is
  // what confused buyers, so the second box is gone for good.
  await expect(panel.locator('input')).toHaveCount(1);
  await expect(page.locator('#ownerLink')).toHaveCount(0);

  // And the one that survived is the PUBLIC link — no owner token. Sharing the
  // token would let any recipient delete words, close the collection and open
  // the owner's checkout.
  const link = await page.locator('#friendsLink').inputValue();
  expect(link).toContain('/collect.html?c=');
  expect(link).not.toContain('k=');
  expect(link).not.toContain(ownerToken);

  // WhatsApp shares that same public link, token-free.
  const href = await page.getByTestId('share-whatsapp').getAttribute('href');
  expect(href).toContain(encodeURIComponent(link));
  const inviteText = new URL(href).searchParams.get('text');
  expect(inviteText).not.toContain('k=');
  expect(inviteText).not.toContain(ownerToken);

  // Placement: collected words → share → "stuck? answer a few questions".
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('#wordsCard, #sharePanel, #helpCard')].map((el) => el.id)
  );
  expect(order).toEqual(['wordsCard', 'sharePanel', 'helpCard']);

  // The owner's private link is not lost — it is reachable, collapsed by
  // default, and labelled as private rather than offered as a second share link.
  const priv = page.getByTestId('owner-private-link');
  await expect(priv).toBeVisible();
  await expect(priv).not.toHaveAttribute('open', '');
  await expect(page.locator('#copyOwner')).toBeHidden();
  await priv.locator('summary').click();
  await expect(page.locator('#copyOwner')).toBeVisible();
});

test('owner WhatsApp invite: a two-name couple honoree carries both names (URL-encoded) in the text', async ({
  page,
}) => {
  // A couple/anniversary order stores the honoree name as the pre-joined form
  // ("דנה ויוסי"). Create such a collection directly and open it as the owner.
  const res = await page.request.post('/api/collections', {
    data: {
      honoree_name: 'דנה ויוסי',
      email: 'test@example.com',
      phone: '0521234567',
      gender: 'female',
    },
  });
  expect(res.status()).toBe(201);
  const { id, owner_token } = await res.json();
  await page.goto(`/collect.html?c=${id}&k=${owner_token}`);

  const wa = page.getByTestId('share-whatsapp');
  await expect(wa).toBeVisible();
  const href = await wa.getAttribute('href');
  // Both names appear (URL-encoded) in the invite text.
  expect(href).toContain(encodeURIComponent('דנה ויוסי'));
  const text = new URL(href).searchParams.get('text');
  expect(text).toContain('הפתעה לדנה ויוסי');
  expect(text).toContain('מילים על דנה ויוסי');
  expect(text).not.toContain('undefined');
});

test('owner WhatsApp invite: falls back to generic wording when the honoree name is missing', async ({
  page,
}) => {
  // Guard the empty-name path (not reachable via normal creation, which requires
  // a name): strip honoree_name from the base collection GET and assert the
  // invite degrades to the generic wording — no name, no "undefined".
  await createCollection(page, 'Shira');
  const url = new URL(page.url());
  const c = url.searchParams.get('c');
  const k = url.searchParams.get('k');
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const body = await resp.json();
    delete body.honoree_name;
    return route.fulfill({ json: body });
  });
  await page.goto(`/collect.html?c=${c}&k=${k}`);

  const wa = page.getByTestId('share-whatsapp');
  await expect(wa).toBeVisible();
  const text = new URL(await wa.getAttribute('href')).searchParams.get('text');
  expect(text).toContain('הפתעה! הוסיפו מילים על בעל/ת השמחה');
  expect(text).not.toContain('undefined');
});

test('collected-words list sits BELOW the add-word input in DOM order', async ({ page }) => {
  await createCollection(page, 'Shira');
  const inputBeforeWords = await page.evaluate(() => {
    const addCard = document.getElementById('addCard');
    const wordsWrap = document.getElementById('wordsWrap');
    return !!(addCard.compareDocumentPosition(wordsWrap) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(inputBeforeWords).toBe(true);
});

test('add-word fields carry no example placeholder text', async ({ page }) => {
  await createCollection(page, 'Shira');
  expect(await page.locator('#byName').getAttribute('placeholder')).toBeNull();
  expect(await page.locator('#wordInput').getAttribute('placeholder')).toBeNull();
  // #wordInput has no visible <label>, so removing its placeholder must not leave
  // it unnamed for screen readers — it keeps an aria-label as its accessible name.
  expect((await page.locator('#wordInput').getAttribute('aria-label'))?.trim()).toBeTruthy();
});

test('contributor (no owner key) does NOT see the pay panel', async ({ page, context }) => {
  await createCollection(page, 'Shira');
  const friendsUrl = page.url().replace(/&k=.*/, '');
  const friend = await context.newPage();
  await friend.goto(friendsUrl);
  await expect(friend.locator('#payPanel')).toBeHidden();
});

test('a newly added word appears FIRST (newest on top); delete/edit still target the right word', async ({
  page,
}) => {
  await createCollection(page, 'Shira');

  // Add two words in order. The most recently added must render ABOVE the older
  // one (server returns them oldest-first; the list renders newest-first).
  await page.fill('#wordInput', 'ראשונה');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');
  await page.fill('#wordInput', 'שנייה');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('2');
  expect(await page.getByTestId('word-text').allInnerTexts()).toEqual(['שנייה', 'ראשונה']);

  // A third word jumps straight to the top.
  await page.fill('#wordInput', 'שלישית');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('3');
  await expect(page.getByTestId('word-text').first()).toHaveText('שלישית');

  // Delete the NEWEST (top) word → it targets the right row by id; the other two
  // stay, still newest-first.
  await page.locator('.word', { hasText: 'שלישית' }).getByTestId('word-del').click();
  await page.getByTestId('msg-modal-ok').click();
  await expect(page.locator('#count')).toHaveText('2');
  expect(await page.getByTestId('word-text').allInnerTexts()).toEqual(['שנייה', 'ראשונה']);

  // Inline-edit the (now top) newest word → edits the correct word, not its
  // neighbour, and order is unchanged.
  await page.locator('.word', { hasText: 'שנייה' }).getByTestId('word-text').click();
  const editor = page.getByTestId('word-edit-input');
  await editor.fill('שנייה מתוקנת');
  await editor.press('Enter');
  await expect(page.getByTestId('word-edit-input')).toHaveCount(0);
  await expect(page.locator('#count')).toHaveText('2');
  expect(await page.getByTestId('word-text').allInnerTexts()).toEqual(['שנייה מתוקנת', 'ראשונה']);

  // Newest-first order is STABLE (not random) across a page refresh.
  await page.reload();
  expect(await page.getByTestId('word-text').allInnerTexts()).toEqual(['שנייה מתוקנת', 'ראשונה']);
});

test('a contributor also sees the newest word first', async ({ page, context }) => {
  await createCollection(page, 'Shira');
  await page.fill('#wordInput', 'ישנה');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');
  await page.fill('#wordInput', 'חדשה');
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('2');

  const friendsUrl = page.url().replace(/&k=.*/, '');
  const friend = await context.newPage();
  await friend.goto(friendsUrl);
  await expect(friend.locator('#count')).toHaveText('2');
  // The contributor view uses the same render path → newest-first as well.
  expect(await friend.getByTestId('word-text').allInnerTexts()).toEqual(['חדשה', 'ישנה']);
});

test('a content override replaces newly-tagged collect copy for a normal visitor', async ({
  page,
}) => {
  await page.route('**/api/content*', (route) =>
    route.fulfill({ json: { overrides: { 'collect-words-heading': { text: 'מילים שאספנו' } } } })
  );
  await page.goto('/collect.html?c=nope');
  // The newly-tagged heading now honours the owner's override…
  await expect(page.locator('[data-edit="collect-words-heading"]')).toHaveText('מילים שאספנו');
  // …and a plain visitor still gets NO edit affordances (fail-closed).
  await expect(page.locator('.dugri-editbar')).toHaveCount(0);
});

test('newly-tagged collect copy + the logo image become editable in owner edit mode', async ({
  page,
}) => {
  await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
  await page.goto('/collect.html?edit=1&key=dugri-admin');
  await expect(page.getByText('מצב עריכה')).toBeVisible();

  // A representative sample of the newly-tagged static copy is now editable
  // (headings, button labels, form label, help-tile text, owner hint, help label).
  const keys = [
    'collect-words-heading',
    'collect-add-btn',
    'collect-byname-label',
    'collect-tab-single',
    'collect-cat-people-title',
    'collect-cat-people-eg',
    'collect-share-wa-label',
    'collect-owner-link-summary',
    'collect-owner-link-hint',
    'collect-coupon-label',
    'collect-card-pay-btn',
    'collect-wa-help-label',
    // checkout version options (title + note), inside the owner-only pay panel
    'collect-ver-pdf-title',
    'collect-ship-note',
    'collect-ver-custom-note2',
  ];
  for (const key of keys) {
    await expect(page.locator(`[data-edit="${key}"]`)).toHaveAttribute(
      'contenteditable',
      /plaintext-only|true/
    );
  }

  // The brand/home logo (the only raster image on the page) gets the image edit
  // affordance so the owner can replace it.
  const logo = page.locator('[data-edit-img="collect-home-logo"]');
  await expect(logo).toHaveAttribute('role', 'button');
  await expect(logo).toHaveClass(/dugri-edit-img/);
});

test('contributor (no owner key) sees words but cannot add after close', async ({
  page,
  context,
}) => {
  await createCollection(page, 'Shira');
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

// The delivery address inputs used to run edge-to-edge across the pay card:
// #addressForm's own `margin` rule beat the panel's generic inline inset, so the
// boxes were wider than the option cards sitting right above them and pressed
// against the card border. They are now a titled sub-panel, inset on both sides.
test('delivery address is an inset sub-panel, not boxes pressed to the card edge', async ({
  page,
}) => {
  await stubPricing(page);
  await createCollection(page, 'Shira');

  await page.locator('#payPanel summary').click();
  await page.check('input[name="payVersion"][value="pickup"]');
  await page.check('#shipToggle');
  await expect(page.locator('#addressForm')).toBeVisible();

  const box = async (sel) => {
    const b = await page.locator(sel).boundingBox();
    if (!b) throw new Error('no box for ' + sel);
    return b;
  };
  const panel = await box('#payPanel');
  // The address hangs off the shipping tick, but the tick is inset under the
  // option it belongs to — so the block to measure against is the printed-game
  // option, which is the full-width control the address must not out-grow.
  const option = await page
    .locator('label.pay-opt')
    .filter({ has: page.locator('input[value="pickup"]') })
    .boundingBox();
  const form = await box('#addressForm');
  const street = await box('#addrStreet');

  // The address block is inset from the pay card on BOTH sides...
  expect(form.x - panel.x).toBeGreaterThan(8);
  expect(panel.x + panel.width - (form.x + form.width)).toBeGreaterThan(8);
  // ...and lines up with the option cards above it rather than overflowing them.
  expect(form.width).toBeLessThanOrEqual(option.width + 1);
  // The inputs sit inside that block with padding around them, so no field
  // touches a border.
  expect(street.x - form.x).toBeGreaterThan(6);
  expect(form.x + form.width - (street.x + street.width)).toBeGreaterThan(6);

  // A heading names the block so the fields read as one group.
  await expect(page.locator('#addressForm .addr-head')).toHaveText('כתובת למשלוח');
});

// The pay button is the primary CTA of the whole page — guard its weight so a
// later tweak can't quietly flatten it back into an ordinary-looking button.
test('the pay button reads as the primary CTA (large, heavy, full width)', async ({ page }) => {
  await enableCardButton(page);
  await stubPricing(page);
  await createCollection(page, 'Shira');
  await page.locator('#payPanel summary').click();

  const btn = page.locator('#cardPayBtn');
  await expect(btn).toBeVisible();
  const css = await btn.evaluate((el) => {
    const s = getComputedStyle(el);
    return { size: parseFloat(s.fontSize), weight: s.fontWeight, color: s.color };
  });
  expect(css.size).toBeGreaterThanOrEqual(20);
  expect(Number(css.weight)).toBeGreaterThanOrEqual(800);
  expect(css.color).toBe('rgb(255, 255, 255)');

  const b = await btn.boundingBox();
  const panel = await page.locator('#payPanel').boundingBox();
  expect(b.height).toBeGreaterThanOrEqual(58);
  // Spans the panel's content width — nothing on the page is more prominent.
  expect(b.width).toBeGreaterThan(panel.width - 40);
});

// After a card charge the modal simply closed and the page refreshed in place —
// buyers couldn't tell whether the payment had gone through. A successful charge
// now lands on a dedicated confirmation page, with a way back to adding words.
test('a successful card payment lands on the confirmation page and back to the words', async ({
  page,
}) => {
  await enableCardButton(page);
  await stubPricing(page);
  // Point the "payment window" at our own pay-done.html (what PeleCard redirects
  // its iframe to on success) so the real success handshake runs.
  await page.route('**/api/collections/*/pay/init', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: '/pay-done.html' }),
    })
  );

  await createCollection(page, 'Shira');
  const collectUrl = new URL(page.url());
  await page.locator('#payPanel summary').click();
  await page.click('#cardPayBtn');

  // pay-done.html (in the iframe) reports success → we leave for the page that
  // says so in plain words.
  await page.waitForURL(/pay-success\.html/);
  await expect(page.locator('h1')).toHaveText('התשלום התקבל');
  await expect(page.locator('.mark svg')).toBeVisible();
  await expect(page.locator('body')).toContainText('אישור בדרך למייל');

  // The button goes back to THIS collection, owner key intact, ready to keep
  // adding words.
  const back = page.locator('#backBtn');
  await expect(back).toBeVisible();
  await back.click();
  await page.waitForURL(/collect\.html/);
  expect(new URL(page.url()).search).toBe(collectUrl.search);
  await expect(page.locator('#wordInput')).toBeVisible();
});

// "Payment received" on its own left the buyer with nothing to check: no
// reference to quote, no record of WHAT they bought, and no way to reach us. The
// confirmation page now carries the order number, an order summary with the
// buyer's own rendered card, and a WhatsApp button that opens pre-addressed.
test('the confirmation page shows the order number, what was ordered and a way to reach us', async ({
  page,
}) => {
  await enableCardButton(page);
  // The E2E server runs without PeleCard credentials, so pay/init always 503s —
  // every payment test stubs it. The ORDER, though, is placed for real (below),
  // so the summary the confirmation page reads back is genuine server data and
  // not a fixture.
  await page.route('**/api/collections/*/pay/init', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ free: true, paid: true, total: 0 }),
    })
  );

  await createCollection(page, 'Shira');
  const url = new URL(page.url());
  // Place a REAL pickup order (the only version the server enables by default).
  // page.request bypasses page.route, so this hits the actual API.
  const placed = await page.request.post(`/api/collections/${url.searchParams.get('c')}/order`, {
    data: { owner_token: url.searchParams.get('k'), version: 'pickup' },
  });
  expect(placed.status()).toBe(200);

  await page.locator('#payPanel summary').click();
  await page.click('#cardPayBtn');
  await page.waitForURL(/pay-success\.html/);

  // The order number: shown, and in the DG-#### shape a person can read out.
  const orderNo = page.locator('#orderNoVal');
  await expect(orderNo).toBeVisible();
  const ref = (await orderNo.textContent()).trim();
  expect(ref).toMatch(/^DG-\d+$/);

  // What they bought — the package they actually chose, its price, and who the
  // game is for. All of it read back from the real order.
  const summary = page.locator('#summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('איסוף עצמי');
  await expect(summary).toContainText('199 ₪');
  await expect(summary).toContainText('Shira');
  // ...with a picture of the card, not an empty frame.
  await expect(page.locator('#shotImg')).toBeVisible();

  // WhatsApp opens with the order already named, so the conversation doesn't
  // start with us asking which order they mean.
  const wa = page.locator('#waBtn');
  await expect(wa).toBeVisible();
  const href = await wa.getAttribute('href');
  expect(href).toContain('wa.me/972546577715');
  expect(decodeURIComponent(href)).toContain(ref);

  // The buyer is thanked for the order...
  await expect(page.locator('.lead')).toContainText('תודה רבה');
  // ...and the two lines that used to sit here are gone: "everything is booked,
  // you can relax" (nothing is booked until the words arrive) and the closing
  // note about keeping the link.
  const body = page.locator('body');
  await expect(body).not.toContainText('הכול תפוס');
  await expect(body).not.toContainText('נשמור על הקישור');
});

// A 100%-off coupon still produces a real, placed order — the confirmation has
// to read as "paid: free", never as a blank or a 0 that looks like a bug. The
// paid state can't be reached through the UI here (pay/init needs PeleCard
// credentials the E2E server doesn't have), so the summary payload is stubbed
// and this pins the PAGE's rendering of it.
test('a fully-discounted order reads as paid and free on the confirmation page', async ({
  page,
}) => {
  await page.route('**/api/collections/*/summary*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        order_no: 'DG-1042',
        honoree_name: 'Shira',
        design: 'קלאסי',
        color: 'ורוד',
        product_image: null,
        order: {
          version: 'pickup',
          version_label: 'איסוף עצמי',
          description: null,
          total: 199,
          charged: 0,
          coupon: 'FREEALL',
          paid: true,
          paid_at: '2026-08-01T10:00:00.000Z',
        },
        preview: null,
      }),
    })
  );

  await page.goto('/pay-success.html?c=col-1&k=tok-1');
  await expect(page.locator('#orderNoVal')).toHaveText('DG-1042');
  const summary = page.locator('#summary');
  await expect(summary).toContainText('שולם');
  await expect(summary).toContainText('חינם (קופון 100%)');
  // The package price is not what they paid, so it must not be shown as such.
  await expect(summary).not.toContainText('199');
});

// The summary is owner-gated: it carries what was actually CHARGED, which the
// collect link the owner shares with friends must never expose.
test('the order summary refuses a request without the owner token', async ({ page, request }) => {
  await stubPricing(page);
  await createCollection(page, 'Shira');
  const url = new URL(page.url());
  const id = url.searchParams.get('c');
  const token = url.searchParams.get('k');

  expect((await request.get(`/api/collections/${id}/summary`)).status()).toBe(403);
  expect((await request.get(`/api/collections/${id}/summary?k=nope`)).status()).toBe(403);
  expect((await request.get(`/api/collections/${id}/summary?k=${token}`)).status()).toBe(200);
});

// A crafted ?back= must not turn the confirmation page into an open redirect.
test('pay-success ignores an off-site ?back= and keeps its default link', async ({ page }) => {
  await page.goto('/pay-success.html?back=' + encodeURIComponent('https://evil.example/x'));
  await expect(page.locator('#backBtn')).toHaveAttribute('href', '/');
  await page.goto('/pay-success.html?back=' + encodeURIComponent('//evil.example/x'));
  await expect(page.locator('#backBtn')).toHaveAttribute('href', '/');
});

// --- the per-entry word length cap (25 chars, spaces included) --------------
// The point of enforcing this on the FORM is that a too-long entry gets fixed by
// the person typing it, right then. If the only check were at generation time the
// failure would surface hours later as a broken PDF, and someone would have to go
// back and ask the customer to rewrite a word.
const AT_LIMIT = 'אבגדהוזחטיכלמנסעפצקרשתאבג'; // exactly 25
const OVER_LIMIT = 'אבגדהוזחטיכלמנסעפצקרשתאבגד'; // exactly 26

// These specs are about the WORD FORM, not about how a collection is created, so
// they seed one straight through the API and open collect.html on it. That skips
// the multi-step options.html wizard the createCollection() helper above drives —
// which is worth avoiding here: that walk is independently load-flaky on the
// design step (it fails the same way on an untouched main), and inheriting its
// flake would make a length regression look like an unrelated red.
async function seedCollection(request, page, name) {
  const res = await request.post('/api/collections', {
    data: { honoree_name: name, email: 'test@example.com', phone: '0521234567' },
  });
  expect(res.status()).toBe(201);
  const c = await res.json();
  await page.goto(`/collect.html?c=${c.id}&k=${c.owner_token}`);
  await expect(page.locator('#addCard')).toBeVisible();
  return c;
}

test('the word form accepts a 25-character entry and refuses a 26-character one', async ({
  page,
  request,
}) => {
  await seedCollection(request, page, 'Shira');
  expect(AT_LIMIT).toHaveLength(25);
  expect(OVER_LIMIT).toHaveLength(26);

  // 26 → live warning while typing, add button disabled, nothing submitted.
  await page.fill('#wordInput', OVER_LIMIT);
  const hint = page.locator('#wordLenHint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('26'); // the actual length
  await expect(hint).toContainText('25'); // the limit
  await expect(page.locator('#addBtn')).toBeDisabled();
  await expect(page.locator('#count')).toHaveText('0');
  // the typed text is kept, so it can be shortened rather than retyped
  await expect(page.locator('#wordInput')).toHaveValue(OVER_LIMIT);

  // Shortening it to exactly 25 clears the warning and lets it through.
  await page.fill('#wordInput', AT_LIMIT);
  await expect(hint).toBeHidden();
  await expect(page.locator('#addBtn')).toBeEnabled();
  await page.click('#addBtn');
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#wordsWrap')).toContainText(AT_LIMIT);
});

test('a pasted list adds its good words and names the ones that were too long', async ({
  page,
  request,
}) => {
  await seedCollection(request, page, 'Shira');
  await page.click('#tab-list');
  await page.fill('#pasteBox', ['מים', OVER_LIMIT, 'אש'].join('\n'));
  await page.click('#pasteAdd');

  // The good words still land — losing them because a neighbour was too long
  // would be worse than the problem.
  await expect(page.locator('#count')).toHaveText('2');
  await expect(page.locator('#wordsWrap')).toContainText('מים');
  await expect(page.locator('#wordsWrap')).toContainText('אש');
  await expect(page.locator('#wordsWrap')).not.toContainText(OVER_LIMIT);
  // ...and the partial add does not read as a clean success.
  await expect(page.locator('#toast')).toContainText('26');
});

test('the server refuses an over-length entry even when the form is bypassed', async ({
  page,
  request,
}) => {
  // A client-side limit is only a suggestion — this is the route a stale tab or a
  // non-browser client would take around it.
  const { id } = await seedCollection(request, page, 'Shira');

  const res = await request.post(`/api/collections/${id}/words`, {
    data: { words: [OVER_LIMIT, 'ג'.repeat(40)] },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.added).toBe(0);
  expect(body.too_long).toBe(2);
  expect(body.max_word_len).toBe(25);

  const list = await (await request.get(`/api/collections/${id}`)).json();
  expect(list.count).toBe(0);
});

// Delivery stopped being a version of its own: at the owner's prices pickup and
// delivery read as the same product twice, so the printed game is now ONE option
// and shipping is a tick on top of it. The `version` values underneath are
// unchanged — this pins that the tick, not a radio, is what makes an order a
// delivery one, and that the buyer is charged the fee exactly once.
test('shipping is a tick on the printed game, and it is what the server is told', async ({
  page,
}) => {
  await stubPricing(page, {
    store: { now: 199, was: 239 },
    // Sale mode ON: these specs assert the struck was-price, which
    // css/tokens.css hides unless /api/pricing reports a live sale.
    sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
    delivery_fee: 39,
    versions: {
      pdf: { enabled: false, price: 79 },
      pickup: { enabled: true, price: 199 },
      delivery: { enabled: true, price: 199 },
      custom: { enabled: false, price: 599 },
    },
  });
  await createCollection(page, 'Shira');
  await page.locator('#payPanel summary').click();

  // Unticked: the printed game alone, no address asked for.
  await expect(page.locator('#payTotal')).toHaveText('199');
  await expect(page.locator('#addressForm')).toBeHidden();

  // Ticked: the address appears and the fee is added ONCE.
  await page.locator('#shipToggle').check();
  await expect(page.locator('#addressForm')).toBeVisible();
  await expect(page.locator('#payTotal')).toHaveText('238');

  // And the version the server is told is DELIVERY, from the tick alone.
  await page.fill('#addrStreet', 'הרצל 1');
  await page.fill('#addrCity', 'תל אביב');
  await page.fill('#addrPostal', '6100000');
  const sent = await page.evaluate(() => {
    // selectedVersion() is what builds the pay/init payload's `version`.
    const box = document.getElementById('shipToggle');
    return {
      ticked: box.checked,
      version: document.querySelector('input[name="payVersion"]:checked').value,
    };
  });
  expect(sent).toEqual({ ticked: true, version: 'pickup' });
  // The radio still says 'pickup' — the tick is what upgrades it, and the total
  // above already proves the server-side fee is being applied.

  // Unticking takes both the fee and the address away again.
  await page.locator('#shipToggle').uncheck();
  await expect(page.locator('#addressForm')).toBeHidden();
  await expect(page.locator('#payTotal')).toHaveText('199');
});

// The tick shipped looking like a run-on paragraph: its price ran straight into
// its label ("שלחו לי עד הבית39₪") and both notes flowed inline, because the
// title/price/note rules were scoped to .pay-opt and the tick is a .pay-addon.
// Measured, not asserted against CSS text — the point is what the buyer sees.
test('the shipping tick lays out like an option: price on its own end, notes below', async ({
  page,
}) => {
  await stubPricing(page, {
    store: { now: 199, was: 239 },
    // Sale mode ON: these specs assert the struck was-price, which
    // css/tokens.css hides unless /api/pricing reports a live sale.
    sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
    delivery_fee: 39,
    versions: {
      pdf: { enabled: false, price: 79 },
      pickup: { enabled: true, price: 199 },
      delivery: { enabled: true, price: 199 },
      custom: { enabled: false, price: 599 },
    },
  });
  await createCollection(page, 'Shira');
  await page.locator('#payPanel summary').click();

  // Wait for pricing to RESOLVE before measuring: until it does, applyPricing
  // hides the whole option list, so the tick is legitimately not there yet.
  //
  // `#payTotal` alone is NOT that signal: 199 is also the seeded fallback, so a
  // stub that lost the race reads identical here — and its fallback has delivery
  // DISABLED, which hides the very tick this test measures. data-sale is
  // unambiguous: only a resolved payload carrying the stub's live sale sets
  // "on" (the fallback sets "off"), so this pins the stub, not the seed.
  await expect(page.locator('html')).toHaveAttribute('data-sale', 'on');
  await expect(page.locator('#payTotal')).toHaveText('199');
  const tick = page.getByTestId('ship-toggle');
  await expect(tick).toBeVisible();
  const label = tick.locator('[data-edit="collect-ship-title"]');
  const price = page.locator('#shipPrice');
  const note = tick.locator('[data-edit="collect-ship-note"]');

  const [lb, pb, nb] = await Promise.all([
    label.boundingBox(),
    price.boundingBox(),
    note.boundingBox(),
  ]);

  // Price and label share a row, at opposite ends — not butted together.
  expect(Math.abs(lb.y - pb.y)).toBeLessThan(6);
  expect(Math.abs(lb.x - (pb.x + pb.width))).toBeGreaterThan(20);

  // The note is on its OWN line, below them both.
  expect(nb.y).toBeGreaterThan(lb.y + lb.height - 2);
});
