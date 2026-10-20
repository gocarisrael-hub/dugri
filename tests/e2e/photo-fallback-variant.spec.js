import { test, expect } from '@playwright/test';

// The fallback pawns' AUTO-CENTRE switch on admin-images.html ("חיילים לקלף
// התמונות"). An upload is centred by the server and both files are kept; the
// pawn card says which one prints and offers the other. The API is MOCKED (like
// admin-images.spec.js) so the parallel device projects never race on the shared
// server: this verifies the card's wiring, the route tests verify the store.
const KEY = 'dugri-admin';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ORIGINAL = '/content-uploads/aaaaaaaaaaaaaaaa.png';
const CENTRED = '/content-uploads/cccccccccccccccc.png';

function slots(using) {
  const base = (slot) => ({
    slot,
    img: null,
    overridden: false,
    original: null,
    centred: null,
    using: null,
    shipped: '/api/admin/photo-fallback/default/' + slot,
    shippedExists: true,
  });
  const three = using
    ? {
        ...base('3'),
        img: using === 'centred' ? CENTRED : ORIGINAL,
        overridden: true,
        original: ORIGINAL,
        centred: CENTRED,
        using,
      }
    : base('3');
  return { slots: [base('1'), base('2'), three, base('4')] };
}

async function stub(page, state) {
  const posted = [];
  await page.route('**/content-uploads/*', (r) =>
    r.fulfill({ contentType: 'image/png', body: PNG })
  );
  await page.route('**/api/admin/designs*', (r) => r.fulfill({ json: { designs: [] } }));
  await page.route('**/api/design-images*', (r) => r.fulfill({ json: { images: {} } }));
  await page.route('**/api/admin/photo-fallback/variant*', async (r) => {
    const body = r.request().postDataJSON();
    posted.push(body);
    state.using = body.use;
    await r.fulfill({
      json: { ok: true, slot: body.slot, img: body.use === 'centred' ? CENTRED : ORIGINAL },
    });
  });
  await page.route(/\/api\/admin\/photo-fallback(\?|$)/, (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json: slots(state.using) }) : r.continue()
  );
  return posted;
}

test('an auto-centred pawn prints its centred copy and can switch to the original and back', async ({
  page,
}) => {
  const state = { using: 'centred' };
  const posted = await stub(page, state);
  await page.goto(`/admin-images.html?key=${KEY}`);

  const card = page.locator('.item[data-pawn="3"]');
  await expect(card.locator('img.preview')).toHaveAttribute('src', CENTRED);
  await expect(card.locator('.note')).toContainText('מורכז אוטומטית');

  await card.locator('button[data-act="pawn-variant"]').click();
  await expect(card.locator('img.preview')).toHaveAttribute('src', ORIGINAL);
  await expect(card.locator('.note')).toContainText('המקורית');
  expect(posted).toEqual([{ slot: '3', use: 'original' }]);

  await card.locator('button[data-act="pawn-variant"]').click();
  await expect(card.locator('img.preview')).toHaveAttribute('src', CENTRED);
  expect(posted[1]).toEqual({ slot: '3', use: 'centred' });
});

test('a pawn with no centred copy offers no switch', async ({ page }) => {
  await stub(page, { using: null });
  await page.goto(`/admin-images.html?key=${KEY}`);
  await expect(page.locator('.item[data-pawn]')).toHaveCount(4);
  await expect(page.locator('button[data-act="pawn-variant"]')).toHaveCount(0);
});
