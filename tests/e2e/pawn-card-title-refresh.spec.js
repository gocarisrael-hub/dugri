import { test, expect } from '@playwright/test';

// THE PAWN CARD ON SCREEN CARRIES THE TITLE THAT IS SAVED — not the one that was
// saved when she first opened the tab.
//
// The pawn card prints the order title in the band under the pawns, and the panel
// it is shown in says, in so many words, "זו התוצאה הסופית - בדיוק ככה הקלף
// יודפס". The card is rendered ONCE per page load, the first time she opens the
// photos tab, because each render is a headless Chrome run on the server — so
// saving a new title on the design tab left the promise standing over a picture of
// a card that will never be printed, for the rest of the session.
//
// What is asserted here is the REQUEST, not the picture: the card itself is the
// generator's job (generator/test_photo_card_title.py pins that the title lands in
// the band) and rendering a real one would make this hostage to it. What can break
// on this side is whether the page asks again at all.

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// The four discs GET /pawn-card reports, as fractions of the card. Any plausible
// set does: nothing here measures them (that is pawn-card-alignment.spec.js).
const SLOTS = [80, 236].flatMap((x) =>
  [174, 330].map((y) => ({ x: x / 448, y: y / 624, w: 132 / 448, h: 132 / 624 }))
);

// An order made through the API: this spec is about one tab remembering too much,
// and driving the wizard to reach it would make the slowest test in the suite out
// of the cheapest assertion.
async function order(request) {
  const created = await request.post('/api/collections', {
    data: { honoree_name: 'שירה', custom_title: 'לשירה באהבה', buyer_name: 'דנה כהן' },
  });
  expect(created.ok()).toBe(true);
  const { id, owner_token: k } = await created.json();
  return { id, k, url: `/collect.html?c=${id}&k=${encodeURIComponent(k)}` };
}

// Count every pawn-card render the page asks for, and keep the URLs: `n` (how
// many discs the page will cover) rides in the query, so the calls are readable.
function countPawnCards(page) {
  const calls = [];
  page.route('**/pawn-card**', (route) => {
    calls.push(route.request().url());
    return route.fulfill({ json: { card: PNG, slots: SLOTS } });
  });
  return calls;
}

test('a saved title makes the photos tab render its card again', async ({ page, request }) => {
  const { url } = await order(request);
  const calls = countPawnCards(page);
  // The design tab's own preview is a render too. Stubbed so this test never waits
  // on the generator for a picture it does not look at.
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
  await page.goto(url);

  // 1. The tab draws the card once.
  await page.getByTestId('tab-pawns').click();
  await expect.poll(() => calls.length).toBe(1);

  // 2. Re-entering it does NOT — that is the whole reason the render is cached on
  //    the page, and the behaviour this fix must not undo.
  await page.getByTestId('tab-design').click();
  await expect(page.getByTestId('title-input')).toBeEnabled();
  await page.getByTestId('tab-pawns').click();
  await expect.poll(() => calls.length).toBe(1);

  // 3. Save a DIFFERENT title.
  await page.getByTestId('tab-design').click();
  await page.getByTestId('title-input').fill('שירה חוגגת 40');
  await page.locator('#titleSaveBtn').click();
  await expect(page.locator('#titleErr')).toBeHidden();
  // The save landed: the field reads back the STORED title, and the button it was
  // disabled for is live again.
  await expect(page.locator('#titleSaveBtn')).toBeEnabled();
  await expect(page.getByTestId('title-input')).toHaveValue('שירה חוגגת 40');

  // 4. …and the photos tab draws a new card, for the new title.
  await page.getByTestId('tab-pawns').click();
  await expect.poll(() => calls.length).toBe(2);
});
