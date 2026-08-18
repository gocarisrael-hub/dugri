import { test, expect } from '@playwright/test';

// THE FOUR PHOTOS ON THE PAWN CARD SIT ON THEIR PRINTED CUT-LINES — measured on
// the real page, in whatever engine this project runs.
//
// WHY THIS FILE EXISTS. The card preview positioned the photo layer with
// `inset: 0` on the frame around the card, which is the card's own rectangle only
// when the frame is exactly the card's shape. The frame gets that shape from
// `aspect-ratio` with `width: auto` and `max-height` — which Chrome honours and
// SAFARI DOES NOT: Safari keeps the frame at its full inline width and centres
// the picture inside it. On an iPhone that left a 36px band down each side of a
// 327px frame, so every pawn came out 27% wider than tall (an ellipse, where the
// card prints a circle) and the left-hand pair sat 22px clear of the dashed line
// the buyer cuts along.
//
// It shipped because every automated check in this repo ran on Chromium — the
// profile named "iPhone 14" is Chromium at a phone's size, not Safari — so the
// measurements were honest and blind at the same time. playwright.config.js now
// carries a WebKit project pointed at this file (see its `testMatch`), and this
// is the check it runs.
//
// It asserts against the CARD PICTURE, never against the frame: the offsets are
// computed from where `object-fit: contain` actually drew the card, so a band on
// any side is caught rather than assumed away.

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// THE CARD IS A FIXTURE, NOT A RENDER, and that is the point of this test rather
// than a shortcut around it. What broke was the PAGE's layout — where the photo
// layer lands on a picture of a card — so the card only has to be a picture of
// the right SIZE. Rendering a real one costs a headless Chrome run on the server
// per test, per engine, and would make a geometry check hostage to the generator.
// 448 x 624 is the pawn card's own pixel size.
const CARD_W = 448;
const CARD_H = 624;
const CARD_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAcAAAAJwCAIAAACRZSbMAAAGW0lEQVR42u3UQREAAAQAQfTPp4IaMvia3Qj3uOzpAOCuJAAwUAADBTBQAAMFwEABDBTAQAEMFMBAATBQAAMFMFAAAwUwUAAMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEMFAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAADBcBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFMBAATBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEMFAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAADBcBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFMBAATBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEwUAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAADBcBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFMBAATBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEwUAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAAMFMBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFMBAATBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEwUAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAAMFMBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFAADBTBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQCQAMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEMFAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAADBcBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFMBAATBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEwUAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAADBcBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFMBAATBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEwUAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAAMFMBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFMBAATBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEwUAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAAMFMBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFAADBTBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEwUAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAAMFMBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFAADBTBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBcBAAQwUwEABDBTAQAEwUAADBTBQAAMFMFAADBTAQAEMFMBAAQxUAgADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAADBcBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFMBAATBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEwUAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwUwUAAMFMBAAQwUwEABDBQAAwUwUAADBTBQAAMFwEABDBTAQAEMFMBAATBQAAMFMFAAAwXAQAEMFMBAAQwUwEABMFAAAwUwUAADBTBQAAwUwEABDBTAQAEwUAADBTBQAAMFMFAADBTAQAEMFMBAAQwUAAMFMFAAAwX4ZgEoSwdzM5VkzQAAAABJRU5ErkJggg==';

// …and its four discs, exactly as GET /pawn-card reports them: fractions of the
// card, each one SQUARE in the card's own pixels (132 x 132 at x = 80 or 236,
// y = 174 or 330). Square in card pixels is what makes "is this circle round?"
// a question about the page and not about the fixture.
const SLOT = 132;
const SLOTS = [80, 236].flatMap((x) =>
  [174, 330].map((y) => ({ x: x / CARD_W, y: y / CARD_H, w: SLOT / CARD_W, h: SLOT / CARD_H }))
);

// An order with four photos, made through the API rather than the wizard: this
// spec is about geometry, and driving eight wizard steps to reach it would make
// the slowest test in the suite out of the cheapest assertion.
async function orderWithPhotos(request, n = 4) {
  const created = await request.post('/api/collections', {
    data: { honoree_name: 'Pawn geometry', custom_title: 'Pawn geometry', buyer_name: 'Tester' },
  });
  expect(created.ok()).toBe(true); // 201 Created
  const { id, owner_token: k } = await created.json();

  const boundary = '----dugriPawnAlignment';
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="pawn${i}"; filename="p${i}.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`
      ),
      // Distinct bytes per photo — the stored paths are content-addressed, so
      // four identical files would de-dupe to one and the card would have a
      // single disc to check.
      Buffer.concat([PNG_BYTES, Buffer.from(`slot${i}`)]),
      Buffer.from('\r\n')
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const up = await request.post(`/api/collections/${id}/pawns?k=${encodeURIComponent(k)}`, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    data: Buffer.concat(chunks),
  });
  expect(up.status()).toBe(200);
  expect((await up.json()).pawn_images).toHaveLength(n);
  return { id, k };
}

// Every circle on the card, measured against the picture it is drawn on.
async function measure(page) {
  return page.evaluate(() => {
    const frame = document.querySelector('#pawnPrevBox');
    const img = document.querySelector('#pawnPrevImg');
    const fr = frame.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    // Where `contain` put the card inside its element — the rectangle every
    // printed cut-line is a fraction of.
    const s = Math.min(ir.width / img.naturalWidth, ir.height / img.naturalHeight);
    const card = {
      x: ir.x + (ir.width - img.naturalWidth * s) / 2,
      y: ir.y + (ir.height - img.naturalHeight * s) / 2,
      w: img.naturalWidth * s,
      h: img.naturalHeight * s,
    };
    const slots = [...document.querySelectorAll('.pawn-live-slot')].map((el) => {
      const r = el.getBoundingClientRect();
      // The element's own percentages say which fraction of the card it claims
      // to be at; the rect says where it really is. Comparing the two is the test.
      const wantX = card.x + (parseFloat(el.style.left) / 100) * card.w;
      const wantY = card.y + (parseFloat(el.style.top) / 100) * card.h;
      return {
        w: r.width,
        h: r.height,
        dx: r.x - wantX,
        dy: r.y - wantY,
        photo: el.querySelector('img').getBoundingClientRect().width,
      };
    });
    return { frame: { w: fr.width, h: fr.height }, card, slots };
  });
}

test('every pawn circle is round and sits on its printed cut-line', async ({ page, request }) => {
  const { id, k } = await orderWithPhotos(request);
  await page.route('**/pawn-card**', (route) =>
    route.fulfill({ json: { card: CARD_PNG, slots: SLOTS } })
  );
  await page.goto(`/collect.html?c=${id}&k=${k}`);
  await page.getByTestId('tab-pawns').click();
  // The layer is empty until the card's own picture has decoded — `attached`,
  // not `visible`, because a slot with no photo in it yet has no size.
  await page.waitForSelector('#pawnLiveSlots .pawn-live-slot', { state: 'attached' });
  await expect
    .poll(async () => page.locator('#pawnPrevImg').evaluate((i) => i.naturalWidth))
    .toBe(CARD_W);
  await expect.poll(async () => (await measure(page)).slots.length).toBe(4);

  const m = await measure(page);

  // 1. THE FRAME HOLDS THE CARD AND NOTHING ELSE. A band down the sides is the
  //    condition that produced both faults, so it is failed on directly — even
  //    though the layer would now survive one.
  expect(Math.abs(m.frame.w - m.card.w)).toBeLessThanOrEqual(3);

  for (const [i, s] of m.slots.entries()) {
    // 2. A CIRCLE, not an oval. Safari drew these 27% wider than tall.
    expect(Math.abs(s.w - s.h) / s.w, `slot ${i} is round`).toBeLessThan(0.02);
    // 3. ON THE CUT-LINE. Off by a fraction of a pixel is rounding; off by a
    //    tenth of the circle is what the owner photographed.
    expect(Math.abs(s.dx), `slot ${i} sits on its ring horizontally`).toBeLessThan(s.w * 0.02);
    expect(Math.abs(s.dy), `slot ${i} sits on its ring vertically`).toBeLessThan(s.h * 0.02);
    // 4. AND THE PHOTO INSIDE IT IS STILL FRAMED THE WAY THE PRINTER FRAMES IT.
    //    The photo is drawn LARGER than its circle and clipped by it — the disc
    //    covers 90% of the square the generator hands over. A stylesheet rule
    //    that reached these images (`.prev-box img { max-width: 100% }` did, for
    //    one commit) clamps them to the circle instead, which silently re-crops
    //    every pawn.
    expect(s.photo, `slot ${i} photo is not clamped to its circle`).toBeGreaterThan(s.w * 1.05);
  }
});
