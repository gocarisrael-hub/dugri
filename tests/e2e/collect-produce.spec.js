import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// SHE PRESSES סיום AND THE CARDS COME UP.
//
// What used to happen when the word list closed was a banner on the page she was
// already on. Now the deck is rendered while she waits, and she lands on the
// proof with every card of it. This spec is about that minute: what she is
// looking at while it renders, where she is sent when it works, and — the part
// that matters more — what she is told when it does not, which must never be an
// error and must never be a dead end.
//
// NOTHING IS RENDERED HERE. A real run is one headless Chrome pass over her
// whole deck; the routes are intercepted, and whether the pages come out right
// is settled in tests/unit/produce-on-close.test.js and the generator's own
// tests. This is the screen.

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await noPoolMenu(page);
});

// THE WORD-POOL MENU IS A GLOBAL SETTING, and closing an order now requires a
// pick from it whenever one is offered (see wordlist-menu.spec.js for that
// gate's own tests). Its default is empty, but tests/e2e/wordlist-menu.spec.js
// fills it while it runs, and spec FILES run in parallel workers against one
// server — so a test here that closes a collection would pass or fail on
// whichever file happened to be mid-flight. Answering the menu request per page
// makes these tests say what they are about: the sign-off tick, not the pool.
async function noPoolMenu(page) {
  await page.route('**/api/wordlist-options', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"options":[]}' })
  );
}

async function createCollection(page) {
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
  await page.goto('/options.html?step=3');
  await expect(page.getByTestId('step-3')).toBeVisible();
  await page.fill('#customTitleInput', 'Shira');
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-4')).toBeVisible();
  await page.fill('#ownerEmail', 'test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.fill('#buyerNameInput', 'דנה כהן');
  await page.getByTestId('next-btn').click();
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
  const url = new URL(page.url());
  return { id: url.searchParams.get('c'), k: url.searchParams.get('k') };
}

// The CLOSE is left real — it is the one thing here that must actually happen,
// and a stubbed one would hide it if it stopped. Only the render varies:
// `produce` receives ('POST'|'GET', callIndex) and returns what the server
// should answer.
async function stubProduce(page, produce) {
  let n = 0;
  await page.route('**/api/collections/*/produce*', (route) => {
    const method = route.request().method();
    const answer = produce(method, method === 'GET' ? n++ : 0);
    route.fulfill({
      status: answer.status || 200,
      contentType: 'application/json',
      body: JSON.stringify(answer.body),
    });
  });
}

// The close itself is REAL, and a real close freezes the word bank — which
// spawns python. Under a full parallel run that is seconds, not milliseconds, so
// everything waiting on what comes AFTER the close gets a generous window. The
// default 5s is a load flake waiting to happen, not a bug worth catching.
const AFTER_CLOSE = 15000;

// Through the sign-off tick, the way she does it.
//
// WAIT for the strip, never just look at it: the tabs appear when the owner's
// state lands, so a point-in-time isVisible() is a race that wins on a warm
// local server and loses on a loaded one — and losing means never opening the
// tab, then clicking a #closeBtn that is on a display:none panel.
async function pressFinish(page) {
  const tab = page.getByTestId('tab-finish');
  await tab.waitFor({ state: 'visible', timeout: AFTER_CLOSE });
  await tab.click();
  const ack = page.getByTestId('finish-ack');
  await ack.waitFor({ state: 'visible', timeout: AFTER_CLOSE });
  await ack.check();
  await page.click('#closeBtn');
  await page.getByTestId('close-ask-yes').click();
}

test('the wait says what is being made, then the proof opens on her own order', async ({
  page,
}) => {
  const { id, k } = await createCollection(page);
  const token = 'proof-token-abc';
  // The proof page itself is not this spec's subject — answer it "not produced"
  // so the landing is instant and nothing tries to fetch 104 webps.
  await page.route('**/api/collections/*/proof?*', (route) =>
    route.fulfill({ status: 404, json: { error: 'no pdf' } })
  );
  await stubProduce(page, (method, i) => {
    if (method === 'POST') return { status: 202, body: { state: 'running', cards: 104 } };
    // Still rendering on the first poll, done on the second — so the waiting
    // screen has to be a real state and not a flash between two requests.
    return i === 0
      ? { body: { state: 'running' } }
      : { body: { state: 'ready', proof_url: `/proof.html?c=${id}&t=${token}` } };
  });

  await pressFinish(page);

  // WHAT SHE READS WHILE IT RENDERS: the number of cards and how long, on a
  // screen with nothing to press.
  await expect(page.getByTestId('produce-wait')).toBeVisible({ timeout: AFTER_CLOSE });
  await expect(page.getByTestId('produce-wait-title')).toContainText('מכינים את 104 הקלפים שלך');
  await expect(page.getByTestId('produce-wait-title')).toContainText('פחות מדקה');
  await expect(page.getByTestId('produce-wait-ok')).toBeHidden();

  // …and then her cards, on a link that carries BOTH the order and the
  // capability token — a proof page reached with either one missing is blank.
  await page.waitForURL(/proof\.html/, { timeout: AFTER_CLOSE });
  const landed = new URL(page.url());
  expect(landed.searchParams.get('c')).toBe(id);
  expect(landed.searchParams.get('t')).toBe(token);
  expect(k).toBeTruthy();
});

// WHEN THE OWNER HAS SWITCHED THE BUYER'S PROOF OFF.
//
// The deck is still produced — 'ready' says so — but the server hands back no
// proof_url, because there is no page to send her to. The wait must END on that,
// and end calmly: a client that only navigates when a link is present would sit
// on the spinner for four minutes and then say the same thing anyway.
test('ready with no proof link ends the wait calmly instead of hanging on it', async ({ page }) => {
  await createCollection(page);
  await stubProduce(page, (method) => {
    if (method === 'POST') return { status: 202, body: { state: 'running', cards: 40 } };
    return { body: { state: 'ready' } }; // ready, no proof_url — the switch is off
  });

  await pressFinish(page);

  const wait = page.getByTestId('produce-wait');
  await expect(wait).toBeVisible({ timeout: AFTER_CLOSE });
  await expect(page.getByTestId('produce-wait-title')).toHaveText('קיבלנו! המשחק בהפקה', {
    timeout: AFTER_CLOSE,
  });
  // …and NOT the line that promises an הדמיה by WhatsApp: with the proof off,
  // nobody is going to send her one.
  await expect(page.getByTestId('produce-wait-sub')).not.toContainText('ההדמיה');
  // A way out, which means the spinner is done rather than still turning.
  await expect(page.getByTestId('produce-wait-ok')).toBeVisible();
  await expect(page).toHaveURL(/collect\.html/);
});

// The same, on the path where the deck was ALREADY produced (a second tap, or a
// reload after it finished): POST answers 'ready' straight away.
test('an already-produced deck with no proof link ends the same way', async ({ page }) => {
  await createCollection(page);
  await stubProduce(page, () => ({ body: { state: 'ready' } }));

  await pressFinish(page);

  await expect(page.getByTestId('produce-wait-title')).toHaveText('קיבלנו! המשחק בהפקה', {
    timeout: AFTER_CLOSE,
  });
  await expect(page.getByTestId('produce-wait-ok')).toBeVisible();
  await expect(page).toHaveURL(/collect\.html/);
});

test('a render that fails says we are on it, and never leaves her on a dead end', async ({
  page,
}) => {
  await createCollection(page);
  await stubProduce(page, (method) =>
    method === 'POST'
      ? { status: 202, body: { state: 'running', cards: 104 } }
      : { body: { state: 'error' } }
  );

  await pressFinish(page);
  await expect(page.getByTestId('produce-wait')).toBeVisible({ timeout: AFTER_CLOSE });

  // No stack trace, no "failed", no retry she cannot action: her list is in, the
  // proof follows on WhatsApp.
  const title = page.getByTestId('produce-wait-title');
  await expect(title).toContainText('המשחק בהפקה', { timeout: AFTER_CLOSE });
  await expect(page.getByTestId('produce-wait-sub')).toContainText('וואטסאפ');
  // And a way back to the page she was on, rather than a screen she is stuck to.
  await expect(page.getByTestId('produce-wait-ok')).toBeVisible();
  expect(page.url()).toContain('collect.html');

  await page.getByTestId('produce-wait-ok').click();
  await expect(page.getByTestId('produce-wait')).toBeHidden();
  // The close itself went through — that is the thing that must not be lost.
  await expect(page.locator('#banner')).toBeVisible({ timeout: AFTER_CLOSE });
  await expect(page.locator('#addCard')).toBeHidden();
});

test('when the box is at its render cap she is told so, and stays put', async ({ page }) => {
  await createCollection(page);
  await stubProduce(page, (method) =>
    method === 'POST' ? { status: 503, body: { state: 'busy' } } : { body: { state: 'idle' } }
  );

  await pressFinish(page);
  await expect(page.getByTestId('produce-wait-title')).toContainText('המשחק בהפקה', {
    timeout: AFTER_CLOSE,
  });
  await expect(page.getByTestId('produce-wait-ok')).toBeVisible();
  expect(page.url()).toContain('collect.html');
});

// An order the server refuses to produce (not paid, or reopened) must look
// exactly like the page did before any of this existed: closed, banner, no
// screen in the way explaining a rule she never broke.
test('an order the server will not produce closes the way it always did', async ({ page }) => {
  await createCollection(page);
  await stubProduce(page, (method) =>
    method === 'POST' ? { status: 409, body: { error: 'unpaid' } } : { body: { state: 'idle' } }
  );

  await pressFinish(page);
  await expect(page.locator('#banner')).toBeVisible({ timeout: AFTER_CLOSE });
  await expect(page.getByTestId('produce-wait')).toBeHidden();
  expect(page.url()).toContain('collect.html');
});
