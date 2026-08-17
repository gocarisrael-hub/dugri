import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// THE LAST TAB, AND THE PAWNS SHE CAN FINALLY MOVE.
//
// Three complaints from the owner, looking at her own collection page:
//
//   1. the card preview sat against the edge of its panel instead of in the
//      middle of it, and the title box still offered "leave blank for the
//      default" — a sentence about a field, on a page about a game;
//   2. the photo card showed her people with their backgrounds still on, with no
//      way to say where in the circle each face should sit, and nothing saying
//      that the picture above them IS the printed card;
//   3. there was nowhere to stand at the end and say "yes, print this" — the
//      title, the pawns and the word-pool were three tabs apart, and the button
//      that starts production was filed under "ניהול האיסוף".
//
// This file covers what came out of that: a fifth tab that reads the game back
// to her and sends it, and a pawn row she can drag, zoom and un-background.
//
// The COLLECTION-PAGE tabs generally live in game-tabs.spec.js; the wizard's own
// pawn step in pawn-photos.spec.js. This is the sign-off and the editing.

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PNG_BYTES = Buffer.from(PNG.split(',')[1], 'base64');

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

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
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-4')).toBeVisible();
  await page.fill('#ownerEmail', 'test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.getByTestId('next-btn').click();
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
  const url = new URL(page.url());
  return { url: page.url(), id: url.searchParams.get('c'), k: url.searchParams.get('k') };
}

// Attach `n` photos through the upload route itself, so the test starts from a
// state a real order can be in.
async function attachPhotos(page, id, k, n) {
  const boundary = '----dugriFinishPawns';
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="pawn${i}"; filename="p${i}.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      Buffer.concat([PNG_BYTES, Buffer.from(`finish${i}`)]),
      Buffer.from('\r\n')
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const res = await page.request.post(`/api/collections/${id}/pawns?k=${encodeURIComponent(k)}`, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    data: Buffer.concat(chunks),
  });
  expect(res.status()).toBe(200);
  return (await res.json()).pawn_images;
}

// A background-removed cutout for a photo already on the order — the route the
// page itself posts to when she asks for "בלי רקע" on an uncut photo. Here it
// stands in for the MediaPipe run, which is 18MB of model and not something to
// download inside a test.
async function attachCutout(page, id, k, photoPath, tag) {
  const boundary = '----dugriFinishCut';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${photoPath}\r\n`
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="cut"; filename="cut.png"\r\nContent-Type: image/png\r\n\r\n`
    ),
    Buffer.concat([PNG_BYTES, Buffer.from(tag)]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await page.request.post(
    `/api/collections/${id}/pawn-cut?k=${encodeURIComponent(k)}`,
    {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      data: body,
    }
  );
  expect(res.status()).toBe(200);
  return (await res.json()).pawn_cutouts[photoPath];
}

const owned = (page, id, k) =>
  page.request.get(`/api/collections/${id}?k=${encodeURIComponent(k)}`).then((r) => r.json());

test('the last tab reads the game back to her, and it is where production starts', async ({
  page,
}) => {
  const { url, id, k } = await createCollection(page, 'החגיגה של שירה');
  await attachPhotos(page, id, k, 2);
  await page.goto(url);

  await page.getByTestId('tab-finish').click();
  const panel = page.locator('#finishPanel');
  await expect(panel).toBeVisible();
  // One section at a time, like every other tab: the words are not underneath it.
  await expect(page.locator('#addCard')).toBeHidden();

  // What it says is what will be PRINTED — the title she typed, and how many of
  // the four pawns are her own people.
  await expect(page.getByTestId('finish-title-val')).toContainText('החגיגה של שירה');
  await expect(page.getByTestId('finish-pawns-val')).toContainText('2');

  // The button that actually starts production lives here now, not filed under
  // the collection-management card on the words tab.
  await expect(page.locator('#closeBtn')).toBeVisible();

  // Neither review row edits anything — each one hands her to the tab that owns
  // the thing, so there is exactly one place per decision.
  await page.getByTestId('finish-go-design').click();
  await expect(page.locator('#designPanel')).toBeVisible();
  await expect(panel).toBeHidden();
  await page.getByTestId('tab-finish').click();
  await page.getByTestId('finish-go-pawns').click();
  await expect(page.locator('#pawnsPanel')).toBeVisible();
});

// THE STRIP HAS TO BE SEEN, WHICH IS NOT THE SAME AS BEING PRESENT.
//
// The owner opened her own collection page and missed the tabs entirely. They
// were the lightest thing on a screen whose heading is 25px and whose pay bar is
// a solid black slab: 14px of #6b6b6b under a 2px hairline. Everything asserted
// here is the volume, not the layout — a future tidy-up that quietly returns the
// strip to a row of grey words is the regression this exists to catch.
test('the tabs are loud enough to be found without looking for them', async ({ page }) => {
  const { url } = await createCollection(page);
  await page.goto(url);
  await expect(page.getByTestId('tabs')).toBeVisible();

  const read = (testid) =>
    page.getByTestId(testid).evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        size: parseFloat(s.fontSize),
        weight: Number(s.fontWeight),
        color: s.color,
        fill: s.backgroundColor,
        rule: parseFloat(s.borderBottomWidth),
      };
    });

  const live = await read('tab-words');
  const sleeping = await read('tab-design');

  // Big enough to read at arm's length, on both.
  expect(live.size).toBeGreaterThanOrEqual(15);
  expect(sleeping.size).toBeGreaterThanOrEqual(15);

  // The live tab is heavy, filled, and underscored — three signals, not one, so
  // it survives a glance rather than needing a read.
  expect(live.weight).toBeGreaterThanOrEqual(700);
  expect(live.rule).toBeGreaterThanOrEqual(3);
  expect(live.fill).not.toBe('rgba(0, 0, 0, 0)');

  // A sleeping tab is quieter than the live one but is no longer --muted
  // (#6b6b6b), which is the colour of things the page means you to skim past.
  expect(sleeping.weight).toBeLessThan(live.weight);
  expect(sleeping.color).not.toBe('rgb(107, 107, 107)');
  const lum = (c) =>
    c
      .match(/\d+/g)
      .slice(0, 3)
      .reduce((a, n) => a + Number(n), 0) / 3;
  expect(lum(sleeping.color)).toBeLessThan(lum('rgb(107, 107, 107)'));

  // …and the strip still fits without wrapping into a second row, which would
  // stop it reading as one control.
  const rows = await page
    .getByTestId('tabs')
    .evaluate((el) => new Set([...el.children].map((b) => b.getBoundingClientRect().top)).size);
  expect(rows).toBe(1);
});

// ONE ROW, AND NOTHING TO DRAG TO.
//
// The strip used to scroll, and the fifth tab sat off the edge with nothing on
// screen saying it was there. Measured: the old labels wanted 382px and an
// iPhone 14 gives 358. This is the assertion that the five fit — at every phone
// width, with the payment tab present, which is the case that overflowed.
//
// It measures the SCROLL WIDTH rather than counting pixels of label, so it keeps
// holding whatever a future edit does to the words or the padding.
test('all five tabs fit one row on every phone, with nothing to scroll to', async ({ page }) => {
  const { url } = await createCollection(page);
  await page.goto(url);
  await expect(page.getByTestId('tabs')).toBeVisible();
  // The payment tab is the one that pushed it over, and it is only present
  // before payment — which is where this collection is.
  await expect(page.getByTestId('tab-pay')).toBeVisible();

  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 800 });
    const fit = await page.getByTestId('tabs').evaluate((el) => ({
      need: el.scrollWidth,
      have: el.clientWidth,
      rows: new Set([...el.children].map((b) => Math.round(b.getBoundingClientRect().top))).size,
      shown: [...el.children].filter((b) => !b.hidden).length,
    }));
    expect(fit.shown, `${width}px: all five tabs present`).toBe(5);
    expect(fit.rows, `${width}px: one row`).toBe(1);
    // 1px of tolerance for sub-pixel rounding, and not a pixel more: anything
    // above that is a tab you have to drag to.
    expect(fit.need, `${width}px: nothing to scroll to`).toBeLessThanOrEqual(fit.have + 1);
  }
});

test('with no title of her own, the sign-off says which title WILL print', async ({ page }) => {
  const { url, id, k } = await createCollection(page, 'זמני');
  // Clear it: an empty custom title means the design's own title is printed, and
  // "" would read as "your game has no name".
  const res = await page.request.put(`/api/collections/${id}/title?k=${encodeURIComponent(k)}`, {
    data: { custom_title: '' },
  });
  expect(res.status()).toBe(200);
  await page.goto(url);
  await page.getByTestId('tab-finish').click();
  await expect(page.getByTestId('finish-title-val')).toContainText('ברירת המחדל');
});

test('the design tab centres the card and no longer explains the empty-title trick', async ({
  page,
}) => {
  const { url } = await createCollection(page);
  await page.goto(url);
  await page.getByTestId('tab-design').click();

  // CENTRED. The box is sized from its height, so it is narrower than the panel
  // — and it used to sit flush against the inline start, which in RTL is the
  // right-hand edge.
  const gaps = await page.locator('#prevBox').evaluate((box) => {
    const outer = box.parentElement.getBoundingClientRect();
    const inner = box.getBoundingClientRect();
    return { start: inner.left - outer.left, end: outer.right - inner.right };
  });
  expect(Math.abs(gaps.start - gaps.end)).toBeLessThanOrEqual(2);

  // The hint is about her title, not about our default.
  const hint = page.locator('#titleHint');
  await expect(hint).toContainText('עד 63 תווים');
  await expect(hint).not.toContainText('השאירו ריק');
});

test('the photo tab says the card above is the finished thing', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 1);
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();
  await expect(page.getByTestId('pawn-final-note')).toContainText('הסופית');
  // …and that card is centred in its panel too — same box, same fix.
  const gaps = await page.locator('#pawnPrevBox').evaluate((box) => {
    const outer = box.parentElement.getBoundingClientRect();
    const inner = box.getBoundingClientRect();
    return { start: inner.left - outer.left, end: outer.right - inner.right };
  });
  expect(Math.abs(gaps.start - gaps.end)).toBeLessThanOrEqual(2);
});

test('she sizes a face inside its circle, and the order keeps the number', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  const [photo] = await attachPhotos(page, id, k, 1);
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();

  const zoom = page.getByTestId('pawn-zoom');
  await expect(zoom).toBeVisible();
  await zoom.fill('1.8');

  await expect.poll(async () => (await owned(page, id, k)).pawn_view[photo]?.zoom).toBe(1.8);

  // …and the picture on screen moved with it, rather than the number being
  // filed away somewhere she cannot see.
  const width = await page
    .getByTestId('pawn-thumb')
    .first()
    .evaluate((img) => img.style.width);
  expect(parseFloat(width)).toBeGreaterThan(120);

  // It survives a reload — the slider is showing the order, not this tab.
  await page.reload();
  await page.getByTestId('tab-pawns').click();
  await expect(page.getByTestId('pawn-zoom')).toHaveValue('1.8');
});

test('she chooses whether the photo keeps its background', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  const [photo] = await attachPhotos(page, id, k, 1);
  const cut = await attachCutout(page, id, k, photo, 'cutout-a');
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();

  // With a cutout in hand, the die-cut sticker is what the card prints, so it is
  // what the circle shows.
  const thumb = page.getByTestId('pawn-thumb').first();
  await expect(thumb).toHaveAttribute('src', cut);

  await page.getByTestId('pawn-bg-on').click();
  await expect(thumb).toHaveAttribute('src', photo);
  await expect.poll(async () => (await owned(page, id, k)).pawn_view[photo]?.bg).toBe(true);

  // …and back again, without re-cutting anything: the cutout was never thrown
  // away, which is the point of keeping both files.
  await page.getByTestId('pawn-bg-off').click();
  await expect(thumb).toHaveAttribute('src', cut);
  await expect.poll(async () => (await owned(page, id, k)).pawn_view[photo]?.bg).toBe(false);
});

test('once the deck is in production the pawns are frozen — visible, not editable', async ({
  page,
}) => {
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 1);
  await page.request.post(`/api/collections/${id}/close`, { data: { owner_token: k } });
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();

  await expect(page.getByTestId('pawn-thumb')).toHaveCount(1);
  await expect(page.getByTestId('pawn-zoom')).toBeDisabled();
  await expect(page.getByTestId('pawn-bg-on')).toBeDisabled();
  await expect(page.getByTestId('pawn-remove')).toHaveCount(0);

  // …and the API says no too, so the freeze is a rule and not a disabled slider.
  const refused = await page.request.put(
    `/api/collections/${id}/pawn-view?k=${encodeURIComponent(k)}`,
    { data: { path: '/content-uploads/whatever.png', zoom: 2 } }
  );
  expect(refused.status()).toBe(409);
});

test('a contributor sees none of it', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 1);
  await page.goto(url.replace(/&k=[^&]*/, ''));
  // No tabs at all: three of the five are not hers, and a strip advertising them
  // would be three dead ends.
  await expect(page.getByTestId('tabs')).toBeHidden();
  await expect(page.locator('#finishPanel')).toBeHidden();
  const guest = await page.request.get(`/api/collections/${id}`).then((r) => r.json());
  expect(guest.pawn_view).toBeUndefined();
  expect(guest.pawn_cutouts).toBeUndefined();
  expect(k).toBeTruthy();
});

// ---- delivery, bought after the order was already paid ----------------------
//
// There is no admin "mark as paid" route (an order goes paid only on a real money
// event) and the e2e server runs without card credentials, so the SERVER's answer
// about whether the upgrade is on offer is injected into the collection GET. What
// is under test here is the page: which card it shows, what it sends, and where
// it sends the buyer next. The offer's own rules — paid, not already delivery,
// not closed, a fee to charge — are held by tests/unit/shipping-upgrade.test.js
// against the real store.
async function stubUpgrade(page, upgrade) {
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const body = await resp.json();
    body.card_enabled = true;
    body.shipping_upgrade = upgrade;
    return route.fulfill({ json: body });
  });
}

const OFFERED = { offered: true, reason: null, fee: 39, paid: false, address: null };

test('she adds delivery to an order she has already paid for', async ({ page }) => {
  await stubUpgrade(page, OFFERED);
  // The gateway is not reachable from a test, so the init answer is stubbed —
  // the page's job is to send the address and open the payment window on the URL
  // it is handed back.
  let sent = null;
  // The URL is deliberately inert. Handing back the REAL pay-done.html would be
  // a race, not a test: that page posts its result to the parent the moment it
  // loads, which closes the modal and navigates away — so whether the assertion
  // below saw the frame at all would depend on how fast the machine is.
  await page.route('**/shipping/init**', async (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ json: { url: 'about:blank#dugri-stub', charged: 39 } });
  });

  const { url } = await createCollection(page);
  await page.goto(url);
  await page.getByTestId('tab-finish').click();

  const card = page.locator('#shipAddCard');
  await expect(card).toBeVisible();
  // The price is the server's, not a number the page decided — and it is in the
  // SUMMARY, so the offer states itself without being opened.
  await expect(page.getByTestId('ship-add-summary')).toContainText('39');
  await expect(page.locator('#shipDoneCard')).toBeHidden();

  // FOLDED SHUT on arrival: most buyers here are collecting the game themselves,
  // and an open address form would be a block of fields answering a question
  // they never asked, directly above the button they came to press.
  await expect(card).not.toHaveAttribute('open', '');
  await expect(page.getByTestId('ship-street')).toBeHidden();
  await page.getByTestId('ship-add-summary').click();
  await expect(page.getByTestId('ship-street')).toBeVisible();

  // The three fields the server insists on are insisted on here too, so the
  // person who can fix it is the one who hears about it.
  await page.getByTestId('ship-add-btn').click();
  await expect(page.getByTestId('ship-add-err')).toContainText('רחוב');
  expect(sent).toBeNull();

  await page.getByTestId('ship-street').fill('הרצל 12');
  await page.getByTestId('ship-city').fill('תל אביב');
  await page.getByTestId('ship-postal').fill('6100000');
  await page.getByTestId('ship-add-btn').click();

  // The address goes with it, and the payment window opens on what came back.
  await expect.poll(() => sent && sent.address && sent.address.city).toBe('תל אביב');
  expect(sent.address.street).toBe('הרצל 12');
  expect(sent.address.postal).toBe('6100000');
  await expect(page.locator('#payModal')).toBeVisible();
  await expect(page.locator('#payFrame')).toHaveAttribute('src', 'about:blank#dugri-stub');
});

test('once it is bought the card is replaced by the address it ships to', async ({ page }) => {
  await stubUpgrade(page, {
    offered: false,
    reason: 'paid',
    fee: 39,
    paid: true,
    address: { street: 'הרצל 12', city: 'תל אביב', postal: '6100000', apartment: '4' },
  });
  const { url } = await createCollection(page);
  await page.goto(url);
  await page.getByTestId('tab-finish').click();

  await expect(page.locator('#shipAddCard')).toBeHidden();
  const done = page.locator('#shipDoneCard');
  await expect(done).toBeVisible();
  // The answer to "did it go through?" is her own address, which is the one
  // thing she would check.
  await expect(page.getByTestId('ship-done-addr')).toContainText('הרצל 12');
  await expect(page.getByTestId('ship-done-addr')).toContainText('תל אביב');
  await expect(page.getByTestId('ship-done-addr')).toContainText('דירה 4');
});

test('an order with nothing to upgrade is offered nothing', async ({ page }) => {
  // The commonest case by far: an unpaid order, whose own checkout is where
  // delivery is a tick. Neither card appears — no dead offer, no empty box.
  await stubUpgrade(page, { offered: false, reason: 'no paid order', fee: 39, paid: false });
  const { url } = await createCollection(page);
  await page.goto(url);
  await page.getByTestId('tab-finish').click();
  await expect(page.locator('#finishPanel')).toBeVisible();
  await expect(page.locator('#shipAddCard')).toBeHidden();
  await expect(page.locator('#shipDoneCard')).toBeHidden();
});

// THE CARD KEEPS UP. It used to be a server render: every adjustment queued a
// Chrome page and the picture on screen was the move before last, which is how
// the owner found it — "it moves so slow, and the card and the circles are not
// synced". The empty card and its four disc positions come from the generator
// ONCE; the photos are laid into them here, so a drag is a CSS change.
// A pointer DRAG that works on both device profiles. page.mouse fires nothing a
// touch context listens to, and Playwright's touchscreen only taps — so the
// three pointer events our own handler reads are dispatched directly, which is
// also the honest scope: this is a test of the handler, not of the browser.
async function dragBy(locator, dx, dy) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const opts = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true };
  await locator.dispatchEvent('pointerdown', { ...opts, clientX: x, clientY: y });
  for (const step of [0.4, 0.75, 1]) {
    await locator.dispatchEvent('pointermove', {
      ...opts,
      clientX: x + dx * step,
      clientY: y + dy * step,
    });
  }
  await locator.dispatchEvent('pointerup', { ...opts, clientX: x + dx, clientY: y + dy });
}

// The pawn card is a Chrome render on the server, and the CI node job has no
// Python imaging — so the picture is stubbed here. What these tests are about is
// what the PAGE does with it; that the generator draws it correctly has its own
// pytest (generator/test_preview_pawn_card.py).
const CARD_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const CARD_SLOTS = [
  { n: 1, x: 0.178, y: 0.279, w: 0.295, h: 0.212 },
  { n: 2, x: 0.527, y: 0.279, w: 0.295, h: 0.212 },
  { n: 3, x: 0.178, y: 0.529, w: 0.295, h: 0.212 },
  { n: 4, x: 0.527, y: 0.529, w: 0.295, h: 0.212 },
];
async function stubPawnCard(page, asked) {
  await page.route('**/pawn-card**', (route) => {
    if (asked) asked.push(route.request().url());
    return route.fulfill({ json: { card: CARD_PNG, slots: CARD_SLOTS } });
  });
}

test('the card is drawn here, so it moves with the photo instead of behind it', async ({
  page,
}) => {
  const asked = [];
  await stubPawnCard(page, asked);
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 1);
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();
  await expect(page.locator('.pawn-live-slot')).toHaveCount(1);

  // ONE request, and it asks for the EMPTY card — the picture that depends on
  // the design alone and can therefore be fetched once and reused.
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain('live=1');

  const slotImg = page.locator('.pawn-live-slot img').first();
  const before = await slotImg.evaluate((el) => el.style.left);
  await dragBy(page.locator('.pawn-disc').first(), 20, 12);

  // The card moved WITH the circle — the same number, because it is the same
  // maths on the same in-flight view — and nothing was asked of the server.
  await expect.poll(async () => slotImg.evaluate((el) => el.style.left)).not.toBe(before);
  expect(
    await page
      .getByTestId('pawn-thumb')
      .first()
      .evaluate((el) => el.style.left)
  ).toBe(await slotImg.evaluate((el) => el.style.left));
  await page.waitForTimeout(900); // past the save debounce
  expect(asked).toHaveLength(1);
});

// A slider with no label is a mystery, and a 4px thumb is a mystery you cannot
// grab on a trackpad. Both were the owner's words.
test('the size control says what it is and can be stepped', async ({ page }) => {
  await stubPawnCard(page);
  const { url, id, k } = await createCollection(page);
  const [photo] = await attachPhotos(page, id, k, 1);
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();

  await expect(page.locator('.pawn-zoom-row')).toHaveCount(1);
  await expect(page.locator('.pawn-zoom-lab')).toHaveText('גודל');

  const zoom = page.getByTestId('pawn-zoom');
  await zoom.fill('1.2');
  await page.getByTestId('pawn-zoom-in').click();
  await expect(zoom).toHaveValue('1.3');
  await page.getByTestId('pawn-zoom-out').click();
  await page.getByTestId('pawn-zoom-out').click();
  await expect(zoom).toHaveValue('1.1');
  // …and the steps reach the order, exactly as the slider does.
  await expect
    .poll(async () => (await owned(page, id, k)).pawn_view[photo]?.zoom)
    .toBeCloseTo(1.1, 5);
});

// Nothing on screen said the photo could be moved at all.
test('the circle says it can be dragged, until it has been', async ({ page }) => {
  await stubPawnCard(page);
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 1);
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();

  const badge = page.locator('.pawn-grab');
  await expect(badge).toBeVisible();
  await dragBy(page.locator('.pawn-disc').first(), 15, 0);
  // An instruction that stays after it has been followed is noise.
  await expect(badge).toBeHidden();
});
