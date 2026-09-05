import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// THE BUYER'S WORD-POOL MENU, both ends of it.
//
// A full deck is 412 words and almost nobody writes 412, so the rest are drawn
// from a seed pool. This feature has two halves that only make sense together:
// the OWNER builds a menu in admin-wordlists (which pools are offered, and what
// each is called in front of a customer), and the BUYER picks from it in the
// "המשחק שלי" sheet on her collection page.
//
// WHY BOTH HALVES LIVE IN ONE FILE, ON ONE PROJECT.
// The menu is a single global setting. Playwright runs spec FILES in parallel
// workers and each test across two device projects, so menu-mutating tests
// spread over two files are four writers racing for one value — which is exactly
// what happened: they broke each other AND a pre-existing admin test that had
// nothing to do with them. One file (tests inside a file run in order) and one
// project (the same rule the destructive tests in admin-wordlists.spec.js
// already follow) removes the race rather than papering over it.
const ONLY = 'Desktop Chrome';
test.describe.configure({ mode: 'serial' });

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== ONLY, 'mutates one global menu: runs once per server');
  await stubFeatures(page, ALL_ON);
});

// Run the wizard to a real collection and return { url, id, k }. Title-only
// (#449/#451): one title box, no name and no gender.
async function createCollection(page, title = 'Shira') {
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
  await page.fill('#customTitleInput', title);
  await page.getByTestId('next-btn').click(); // title -> pawn photos
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await page.getByTestId('next-btn').click(); // pawn photos -> contact
  await expect(page.getByTestId('step-4')).toBeVisible();
  await page.fill('#ownerEmail', 'test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  // The orderer's name is required on this step now ("make it must to write") —
  // without it the create button never enables. The rule itself is tested in
  // order-buyer-details.spec.js; here it is just part of getting to an order.
  await page.fill('#buyerNameInput', 'דנה כהן');
  await page.getByTestId('next-btn').click(); // create
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
  const url = new URL(page.url());
  return { url: page.url(), id: url.searchParams.get('c'), k: url.searchParams.get('k') };
}

// WHICH WORDS WE ADD. A full deck is 412 and almost nobody writes 412, so the
// rest come from a seed pool. This lets her choose what they are about — from a
// menu the OWNER builds in admin-wordlists, under names a customer understands.
//
// Seed the menu through the admin settings API, which is where the admin screen
// writes it too, so these start from a state the product can really be in.
async function setMenu(page, options) {
  const res = await page.request.post('/api/admin/settings?key=dugri-admin', {
    data: { section: 'wordlists', key: 'buyer_options', value: options },
  });
  expect(res.status()).toBe(200);
}
// The LAST ROW of that same menu — "don't fill it at all" — offered by giving it
// a label and withdrawn by clearing it. Set here for the same reason the menu is:
// it is one global setting, and these tests are the file that owns writing it.
const BLANK = '__blank__';
async function setBlank(page, label) {
  const res = await page.request.post('/api/admin/settings?key=dugri-admin', {
    data: { section: 'wordlists', key: 'blank_label', value: label },
  });
  expect(res.status()).toBe(200);
}
async function poolNames(page) {
  const r = await page.request.get('/api/admin/wordlists?key=dugri-admin').then((x) => x.json());
  return r.wordlists.map((w) => w.name);
}

// The chooser lives on the LAST tab now — the one she signs the game off from —
// so every test here opens it first. It used to sit with the collected words,
// which is where she spends the days before the party and not where she decides
// what the finished deck is.
async function openFinishTab(page) {
  await page.getByTestId('tab-finish').click();
  await expect(page.getByTestId('finish-title')).toBeVisible();
}

test('no menu, no chooser — the deck fills by her design as before', async ({ page }) => {
  await setMenu(page, []);
  // The decline rides ALONG with the menu, so an empty menu has no rows at all —
  // but clear its label anyway, so this test says what it is about rather than
  // leaning on that.
  await setBlank(page, '');
  const { url } = await createCollection(page);
  await page.goto(url);
  await openFinishTab(page);
  // The field is absent entirely rather than empty: an empty chooser would
  // advertise a choice that does not exist. The tab around it stays — it has two
  // other things to say.
  await expect(page.getByTestId('pool-field')).toBeHidden();
});

test('she picks which words fill the rest, and it sticks', async ({ page }) => {
  const pools = await poolNames(page);
  await setMenu(page, [
    { id: 'jokes', label: 'בדיחות פנימיות', pool: pools[0], enabled: true },
    { id: 'romantic', label: 'רומנטי', pool: pools[1] || pools[0], enabled: true },
    { id: 'draft', label: 'עוד לא מוכן', pool: pools[0], enabled: false },
  ]);
  const { url, id, k } = await createCollection(page);
  await page.goto(url);
  await openFinishTab(page);

  // It sits on the SIGN-OFF tab, beside the title and the pawns: which words
  // fill the rest of her deck is one of the three things she confirms before the
  // game goes to production, not something to decide while words are landing.
  const fld = page.getByTestId('pool-field');
  await expect(fld).toBeVisible();
  // Only the enabled ones. There is NO "we\'ll choose for you" row: she picks,
  // or nothing is ticked. It used to lead the list and be selected by default,
  // which made the commonest outcome a deck filled by a choice she never made.
  await expect(fld).toContainText('בדיחות פנימיות');
  await expect(fld).toContainText('רומנטי');
  await expect(fld).not.toContainText('עוד לא מוכן');
  await expect(page.getByTestId('pool-opt-default')).toHaveCount(0);
  await expect(page.getByTestId('pool-opt-jokes')).not.toBeChecked();

  await page.getByTestId('pool-opt-jokes').check();
  // The server holds it, and holds it as the OPTION she picked.
  await expect
    .poll(async () =>
      page.request
        .get(`/api/collections/${id}?k=${encodeURIComponent(k)}`)
        .then((r) => r.json())
        .then((s) => s.wordlist_option)
    )
    .toBe('jokes');

  // …and it is still ticked after a reload, not just in this tab.
  await page.reload();
  await openFinishTab(page);
  await expect(page.getByTestId('pool-opt-jokes')).toBeChecked();
});

test('a closed collection shows the pick, frozen', async ({ page }) => {
  const pools = await poolNames(page);
  await setMenu(page, [{ id: 'jokes', label: 'בדיחות פנימיות', pool: pools[0], enabled: true }]);
  const { url, id, k } = await createCollection(page);
  await page.goto(url);
  await openFinishTab(page);
  await page.getByTestId('pool-opt-jokes').check();
  await expect
    .poll(async () =>
      page.request
        .get(`/api/collections/${id}?k=${encodeURIComponent(k)}`)
        .then((r) => r.json())
        .then((s) => s.wordlist_option)
    )
    .toBe('jokes');

  await page.request.post(`/api/collections/${id}/close`, { data: { owner_token: k } });
  await page.goto(url);
  await openFinishTab(page);
  await expect(page.getByTestId('pool-opt-jokes')).toBeChecked();
  await expect(page.getByTestId('pool-opt-jokes')).toBeDisabled();
  // …and it stops ASKING. "בחרו את הרשימה" is an instruction to a radio group
  // that cannot answer any more; what is left is the ticked row, and a line that
  // names it as the choice we filled the deck from.
  await expect(page.locator('#poolLabel')).toBeHidden();
  await expect(page.locator('#poolLabelSent')).toBeVisible();
  await expect(page.locator('#poolHint')).toBeHidden();
  await expect(page.locator('#poolHintSent')).toBeVisible();
  // …and the API refuses too, so the freeze is a rule and not a disabled radio.
  const refused = await page.request.put(
    `/api/collections/${id}/wordlist?k=${encodeURIComponent(k)}`,
    { data: { option_id: '' } }
  );
  expect(refused.status()).toBe(409);
});

// The commonest closed order by far: she never opened the sign-off tab, so no
// option was ever stored and the server filled the deck from her DESIGN. A menu
// with nothing ticked would then be a list of things that did not happen — three
// styles offered, on a deck that is already printed, none of them chosen.
test('a closed collection she never answered shows no menu at all', async ({ page }) => {
  const pools = await poolNames(page);
  await setMenu(page, [{ id: 'jokes', label: 'בדיחות פנימיות', pool: pools[0], enabled: true }]);
  const { url, id, k } = await createCollection(page);
  await page.request.post(`/api/collections/${id}/close`, { data: { owner_token: k } });
  await page.goto(url);
  await openFinishTab(page);
  await expect(page.getByTestId('pool-field')).toBeHidden();
  // The rest of the tab is still there — this hides the chooser, not the record.
  await expect(page.getByTestId('finish-title-val')).toBeVisible();
});

// SHE HAS TO ANSWER IT. The style of the filler words is a decision about the
// printed deck that only she can make, and closing is the last moment it can be
// made — after it the deck is at the printer. It used to be optional: the button
// went live on the sign-off tick alone, so the commonest outcome for the one
// question we put in front of her was no answer at all, and the server quietly
// filled from her design.
test('the deck cannot be sent to production until she picks a style', async ({ page }) => {
  const pools = await poolNames(page);
  await setMenu(page, [
    { id: 'jokes', label: 'בדיחות פנימיות', pool: pools[0], enabled: true },
    { id: 'romantic', label: 'רומנטי', pool: pools[1] || pools[0], enabled: true },
  ]);
  const { url } = await createCollection(page);
  await page.goto(url);
  await openFinishTab(page);

  const close = page.locator('#closeBtn');
  const note = page.getByTestId('close-gate-note');
  await expect(close).toBeDisabled();
  // A disabled button explains itself to a mouse and to nobody on a phone, so
  // the reason is on the page — and it names the pool, which is the FIRST thing
  // outstanding, not the tick further down.
  await expect(note).toBeVisible();
  await expect(note).toContainText('סגנון');

  // The tick alone is no longer enough.
  await page.getByTestId('finish-ack').check();
  await expect(close).toBeDisabled();
  await expect(note).toContainText('סגנון');

  // Picking is what opens it.
  await page.getByTestId('pool-opt-jokes').check();
  await expect(close).toBeEnabled();
  await expect(note).toBeHidden();
});

test('with a style picked, the sign-off tick is still its own gate', async ({ page }) => {
  // The two conditions are independent: this is an ADDITIONAL gate, not a
  // replacement for the attestation.
  const pools = await poolNames(page);
  await setMenu(page, [{ id: 'jokes', label: 'בדיחות פנימיות', pool: pools[0], enabled: true }]);
  const { url } = await createCollection(page);
  await page.goto(url);
  await openFinishTab(page);

  await page.getByTestId('pool-opt-jokes').check();
  const close = page.locator('#closeBtn');
  await expect(close).toBeDisabled();
  await expect(page.getByTestId('close-gate-note')).toContainText('לאשר');
  await page.getByTestId('finish-ack').check();
  await expect(close).toBeEnabled();
});

// …and where there is nothing to pick FROM, there is nothing to demand. A
// requirement to choose from an empty list is a door with no handle, and an
// install that never built a menu is the state every install ships in.
test('no menu, no requirement — the tick alone still closes it', async ({ page }) => {
  await setMenu(page, []);
  const { url } = await createCollection(page);
  await page.goto(url);
  await openFinishTab(page);
  await expect(page.getByTestId('pool-field')).toBeHidden();

  const close = page.locator('#closeBtn');
  await expect(close).toBeDisabled();
  await page.getByTestId('finish-ack').check();
  await expect(close).toBeEnabled();
  await expect(page.getByTestId('close-gate-note')).toBeHidden();
});

// THE MENU THE CUSTOMER SEES, built here.
// The panel above this one decides the pool by DESIGN; this one decides which
// pools a BUYER may pick between on her own collection page, and what each is
// called in front of her. Two different questions about the same files, so they
// are two different panels.
test.describe('the buyer-facing pool menu', () => {
  test('the owner names an option, points it at a list, and the buyer API serves it', async ({
    page,
  }) => {
    // Start from no menu at all — the state every install ships in.
    await page.request.post('/api/admin/settings?key=dugri-admin', {
      data: { section: 'wordlists', key: 'buyer_options', value: [] },
    });
    await page.goto('/admin-wordlists.html?key=dugri-admin');
    const rows = page.getByTestId('buyer-opts');
    await expect(rows.locator('tr')).toHaveCount(0);

    await page.getByTestId('add-opt').click();
    await rows.getByTestId('opt-label').fill('בדיחות פנימיות');
    const pool = await rows.getByTestId('opt-pool').inputValue();
    await page.getByTestId('save-opts').click();
    await expect(page.locator('#optsStatus')).toContainText('נשמר');

    // The public menu now carries her label — and never the file name behind it.
    const menu = await page.request.get('/api/wordlist-options').then((r) => r.json());
    expect(menu.options).toHaveLength(1);
    expect(menu.options[0].label).toBe('בדיחות פנימיות');
    expect(JSON.stringify(menu)).not.toContain(pool);

    // …and it survives a reload of the admin screen, so it is stored not staged.
    await page.reload();
    await expect(rows.getByTestId('opt-label')).toHaveValue('בדיחות פנימיות');
  });

  test('unticking פעיל takes it off the buyer menu without deleting it', async ({ page }) => {
    // Start from a known menu: these tests share one store, and a row left by a
    // neighbour would make "is it still there?" prove nothing.
    await page.request.post('/api/admin/settings?key=dugri-admin', {
      data: { section: 'wordlists', key: 'buyer_options', value: [] },
    });
    await page.goto('/admin-wordlists.html?key=dugri-admin');
    await page.getByTestId('add-opt').click();
    const row = page.getByTestId('buyer-opts').locator('tr').last();
    await row.getByTestId('opt-label').fill('רשימה זמנית');
    await row.getByTestId('opt-on').uncheck();
    await page.getByTestId('save-opts').click();
    await expect(page.locator('#optsStatus')).toContainText('נשמר');

    const menu = await page.request.get('/api/wordlist-options').then((r) => r.json());
    expect(menu.options.map((o) => o.label)).not.toContain('רשימה זמנית');
    // Still on the admin screen, ready to be switched back on. The label lives in
    // an <input>, so its text is a VALUE — read them rather than the row's text.
    //
    // POLLED, not read once: the table is filled by a fetch after load, and
    // `evaluateAll` is the one locator method that does NOT wait for its
    // elements — it answers `[]` the moment there are none. Read straight after
    // a reload that is a few hundred ms behind (a loaded machine, a parallel
    // worker) it therefore reported "the row is gone" for a row that simply had
    // not arrived yet.
    await page.reload();
    await expect
      .poll(() =>
        page
          .getByTestId('buyer-opts')
          .locator('[data-testid="opt-label"]')
          .evaluateAll((els) => els.map((e) => e.value))
      )
      .toContain('רשימה זמנית');
  });

  test('a row with no name is refused before it can reach the customer', async ({ page }) => {
    await page.goto('/admin-wordlists.html?key=dugri-admin');
    await page.getByTestId('add-opt').click();
    await page.getByTestId('save-opts').click();
    await expect(page.locator('#optsStatus')).toContainText('שם');
  });
});

// The menu is ONE global setting shared with every other spec on this server.
// These tests fill it; leaving it filled would hand the next file a state it
// never asked for — and closing an order now waits on a pick whenever a menu
// exists. Put it back the way every install ships.
// ---- the row that says "don't fill it at all" -----------------------------
// Some buyers do not want our words on their cards: they want the rest of the
// deck printed BLANK — numbered 1-4 and otherwise empty — to laminate and write
// on at the table. That is an answer to the question this menu asks, so it is a
// ROW of it: same radio group, same save, and picking a list is how she takes it
// back.

test('the decline is the last row of the menu, and picking it sticks', async ({ page }) => {
  const pools = await poolNames(page);
  await setMenu(page, [{ id: 'jokes', label: 'בדיחות פנימיות', pool: pools[0], enabled: true }]);
  await setBlank(page, 'לא להשלים לי מילים (קלפים ריקים עם למינציה)');
  const { url, id, k } = await createCollection(page);
  await page.goto(url);
  await openFinishTab(page);

  // It is in the group with the lists, under the owner's own wording, and last.
  const rows = page.locator('#poolOpts .pool-opt');
  await expect(rows).toHaveCount(2);
  await expect(rows.last()).toContainText('לא להשלים לי מילים');
  await page.getByTestId('pool-opt-__blank__').check();

  await expect
    .poll(async () =>
      page.request
        .get(`/api/collections/${id}?k=${encodeURIComponent(k)}`)
        .then((r) => r.json())
        .then((sheet) => [sheet.wordlist_option, sheet.no_topup])
    )
    .toEqual([BLANK, true]);

  // ...and it is still the ticked row after a reload, like any other answer here.
  await page.reload();
  await openFinishTab(page);
  await expect(page.getByTestId('pool-opt-__blank__')).toBeChecked();
  await setBlank(page, '');
});

test('the sheet says what that row means, and stops promising 412', async ({ page }) => {
  const pools = await poolNames(page);
  await setMenu(page, [{ id: 'jokes', label: 'בדיחות פנימיות', pool: pools[0], enabled: true }]);
  await setBlank(page, 'לא להשלים לי מילים');
  const { url } = await createCollection(page);
  await page.goto(url);
  await openFinishTab(page);

  await expect(page.locator('#poolBlankHint')).toBeHidden();
  await page.getByTestId('pool-opt-__blank__').check();
  // Nothing is being completed, so the heading and the hint that say we complete
  // to 412 would both be describing a thing that is not going to happen.
  await expect(page.locator('#poolLabel')).toBeHidden();
  await expect(page.locator('#poolLabelBlank')).toBeVisible();
  await expect(page.locator('#poolHint')).toBeHidden();
  await expect(page.locator('#poolBlankHint')).toBeVisible();

  // Picking a list is the way back, and it takes the page back with it.
  await page.getByTestId('pool-opt-jokes').check();
  await expect(page.locator('#poolLabel')).toBeVisible();
  await expect(page.locator('#poolBlankHint')).toBeHidden();
  await setBlank(page, '');
});

test('declining is an answer, so the deck can go to production', async ({ page }) => {
  // The close gate waits for an answer to this menu. The decline is one of them.
  const pools = await poolNames(page);
  await setMenu(page, [{ id: 'jokes', label: 'בדיחות פנימיות', pool: pools[0], enabled: true }]);
  await setBlank(page, 'לא להשלים לי מילים');
  const { url } = await createCollection(page);
  await page.goto(url);
  await openFinishTab(page);

  const close = page.locator('#closeBtn');
  await page.getByTestId('finish-ack').check();
  await expect(close).toBeDisabled();
  await page.getByTestId('pool-opt-__blank__').check();
  await expect(close).toBeEnabled();
  await setBlank(page, '');
});

test('the owner can withdraw the row, and then it is not on the menu', async ({ page }) => {
  const pools = await poolNames(page);
  await setMenu(page, [{ id: 'jokes', label: 'בדיחות פנימיות', pool: pools[0], enabled: true }]);
  await setBlank(page, '');
  const { url } = await createCollection(page);
  await page.goto(url);
  await openFinishTab(page);
  await expect(page.locator('#poolOpts .pool-opt')).toHaveCount(1);
  await expect(page.getByTestId('pool-opt-__blank__')).toHaveCount(0);
});

test('leaves the shared menu empty behind it', async ({ page }) => {
  // LAST in the file on purpose: every test above fills the menu, and this is the
  // one that hands the next file the state every install ships with. The decline
  // row's label goes back with it — it is part of the same menu.
  await setMenu(page, []);
  await setBlank(page, '');
  const menu = await page.request.get('/api/wordlist-options').then((r) => r.json());
  expect(menu.options).toHaveLength(0);
});
