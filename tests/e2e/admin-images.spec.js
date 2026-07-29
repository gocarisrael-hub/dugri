import { test, expect } from '@playwright/test';

// The per-design GALLERY admin page (admin-images.html) is behind the admin key.
// To keep the parallel device projects race-free against the shared server, the
// gallery API is MOCKED at the network layer — this spec verifies the admin UI
// wiring (gate, base + photo items, replace/reset, per-surface checkboxes, add
// photo, reorder), not real writes.
const KEY = 'dugri-admin';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const UPLOADED = '/content-uploads/0123456789abcdef.png';

function stubGet(page, images = {}) {
  return page.route('**/api/design-images*', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { images } });
    return route.continue();
  });
}
function stubUploads(page) {
  return page.route('**/content-uploads/*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG })
  );
}
// The MERGED design catalog the page renders from (GET /api/admin/designs —
// built-in designs AND owner-uploaded templates, one list). Stubbed where a test
// needs an exact, server-independent list; the "real merge" test below hits the
// live endpoint on purpose.
function stubCatalog(page, designs) {
  return page.route('**/api/admin/designs*', (route) => route.fulfill({ json: { designs } }));
}
// One catalog entry, shaped like the server's: `slots` carries each base slot's
// SHIPPED render (null when the design ships none — an uploadable empty slot).
function entry(id, name, slots) {
  const empty = { store: null, front: null, back: null, photo: null, board: null };
  return { id, name, slots: { ...empty, ...slots } };
}

test.describe('admin gallery page', () => {
  test('without a key the page reveals nothing and asks for ?key=', async ({ page }) => {
    let hitAdmin = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/design-images')) hitAdmin = true;
    });
    await page.goto('/admin-images.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    expect(hitAdmin).toBe(false);
  });

  test('offers all five base items for EVERY design (unshipped slots are empty, uploadable) + default flags', async ({
    page,
  }) => {
    await stubGet(page, {});
    await page.goto(`/admin-images.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    // Every design in the merged catalog gets a section — the 7 built-ins plus every
    // uploaded template (asserted by id below, not by a count, so registering a new
    // template doesn't fail this test).
    for (const id of [
      'bachelorette',
      'marriage',
      'birthday',
      'japanese',
      'posttrip',
      'neon',
      'kids',
    ])
      await expect(page.locator(`.design[data-design="${id}"]`)).toHaveCount(1);

    // Five base slots: store/front/back/photo/board. posttrip ships a board.
    const posttripBase = page.locator('.item[data-design="posttrip"][data-type="base"]');
    await expect(posttripBase).toHaveCount(5);
    await expect(page.locator('.item[data-design="posttrip"][data-key="board"]')).toHaveCount(1);

    // kids ships NO board, but the board slot is STILL offered so the owner can
    // upload one (#159). It starts as an empty "upload a board" placeholder.
    await expect(page.locator('.item[data-design="kids"][data-type="base"]')).toHaveCount(5);
    const kidsBoard = page.locator('.item[data-design="kids"][data-key="board"]');
    await expect(kidsBoard).toHaveCount(1);
    await expect(kidsBoard.locator('.preview-empty')).toBeVisible();
    await expect(kidsBoard.locator('button[data-act="upload"]')).toBeVisible();
    await expect(kidsBoard.locator('button[data-act="reset"]')).toBeDisabled();

    // The PHOTO CARD slot behaves the same way. No design ships one yet (it needs
    // the portrait card artwork plus the generic Dugri fallback art), so it starts
    // empty for every design — and the owner can still upload a picture for it.
    const photo = page.locator('.item[data-design="posttrip"][data-key="photo"]');
    await expect(photo).toHaveCount(1);
    await expect(photo.locator('.preview-empty')).toBeVisible();
    await expect(photo.locator('button[data-act="reset"]')).toBeDisabled();

    // Default flags: the store cover shows on the grid but NOT the product page;
    // the card front shows on both.
    const store = page.locator('.item[data-design="posttrip"][data-key="store"]');
    await expect(store.locator('input[data-flag="onProducts"]')).toBeChecked();
    await expect(store.locator('input[data-flag="onProduct"]')).not.toBeChecked();
    const front = page.locator('.item[data-design="posttrip"][data-key="front"]');
    await expect(front.locator('input[data-flag="onProduct"]')).toBeChecked();

    await expect(page.locator('.nav a.active[data-page="admin-images.html"]')).toHaveCount(1);
  });

  // The bug this page had: it read the bundled built-in catalog, so an uploaded
  // template was sellable on the storefront and yet had no gallery to curate here.
  // There is no built-in/uploaded distinction on this page any more.
  test('an UPLOADED TEMPLATE gets a gallery section, its pictures being the template SVGs', async ({
    page,
  }) => {
    await stubGet(page, {});
    await stubCatalog(page, [
      entry('posttrip', 'חזרה מטיול', {
        store: 'assets/designs/posttrip/store.webp',
        front: 'assets/designs/posttrip/gallery-front.webp',
        back: 'assets/designs/posttrip/gallery-back.webp',
        board: 'assets/designs/posttrip/gallery-board.webp',
      }),
      entry('grapefruit', 'אשכוליות', {
        front: '/api/template-image/grapefruit/front',
        back: '/api/template-image/grapefruit/back',
        board: '/api/template-image/grapefruit/board',
      }),
    ]);
    await page.route('**/api/template-image/**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>',
      })
    );

    await page.goto(`/admin-images.html?key=${KEY}`);
    const tpl = page.locator('.design[data-design="grapefruit"]');
    await expect(tpl).toHaveCount(1);
    // The same five slots every design offers.
    await expect(tpl.locator('.item[data-type="base"]')).toHaveCount(5);
    // Its card pictures default to the template's own SVGs.
    await expect(
      page.locator('.item[data-design="grapefruit"][data-key="front"] img.preview')
    ).toHaveAttribute('src', '/api/template-image/grapefruit/front');
    // A template ships no store cover: the slot starts EMPTY and uploadable, exactly
    // like a boardless built-in design's board slot.
    const store = page.locator('.item[data-design="grapefruit"][data-key="store"]');
    await expect(store.locator('.preview-empty')).toBeVisible();
    await expect(store.locator('button[data-act="upload"]')).toBeVisible();
    await expect(store.locator('button[data-act="reset"]')).toBeDisabled();
  });

  test('the REAL merged catalog lists the built-ins and the uploaded templates together', async ({
    page,
  }) => {
    await stubGet(page, {});
    await page.goto(`/admin-images.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();
    // No stub: whatever the server merges is what renders. `grapefruit` is a real
    // in-store template — it must have a gallery section beside the built-ins.
    await expect(page.locator('.design[data-design="bachelorette"]')).toHaveCount(1);
    await expect(page.locator('.design[data-design="grapefruit"]')).toHaveCount(1);
    expect(await page.locator('.design').count()).toBeGreaterThan(7);
  });

  test('uploading a picture for a TEMPLATE posts its themes.json key as the design id', async ({
    page,
  }) => {
    await stubGet(page, {});
    await stubUploads(page);
    await stubCatalog(page, [entry('grapefruit', 'אשכוליות', {})]);
    let posted = null;
    await page.route('**/api/admin/design-images/base/image*', (route) => {
      posted = route.request().postData() || '';
      route.fulfill({
        json: { ok: true, img: UPLOADED, gallery: { base: { store: { img: UPLOADED } } } },
      });
    });

    await page.goto(`/admin-images.html?key=${KEY}`);
    const store = page.locator('.item[data-design="grapefruit"][data-key="store"]');
    await store.locator('input[type=file]').setInputFiles({
      name: 'cover.png',
      mimeType: 'image/png',
      buffer: PNG,
    });

    await expect.poll(() => posted).not.toBeNull();
    expect(posted).toContain('grapefruit');
    // The store accepted the template id: the slot now shows the owner's picture.
    const after = page.locator('.item[data-design="grapefruit"][data-key="store"]');
    await expect(after.locator('.badge.custom')).toBeVisible();
    await expect(after.locator('img.preview')).toHaveAttribute('src', UPLOADED);
  });

  test('replacing a base render flips it to "custom" and enables reset', async ({ page }) => {
    await stubGet(page, {});
    await stubUploads(page);
    await page.route('**/api/admin/design-images/base/image*', (route) =>
      route.fulfill({
        json: { ok: true, img: UPLOADED, gallery: { base: { board: { img: UPLOADED } } } },
      })
    );

    await page.goto(`/admin-images.html?key=${KEY}`);
    const board = page.locator('.item[data-design="posttrip"][data-key="board"]');
    await expect(board.locator('.badge.default')).toBeVisible();
    await expect(board.locator('button[data-act="reset"]')).toBeDisabled();

    await board.locator('input[type=file]').setInputFiles({
      name: 'board.png',
      mimeType: 'image/png',
      buffer: PNG,
    });

    const after = page.locator('.item[data-design="posttrip"][data-key="board"]');
    await expect(after.locator('.badge.custom')).toBeVisible();
    await expect(after.locator('img.preview')).toHaveAttribute('src', UPLOADED);
    await expect(after.locator('button[data-act="reset"]')).toBeEnabled();
  });

  test('#159: uploads a board to a BOARDLESS design (kids) — empty slot flips to custom', async ({
    page,
  }) => {
    await stubGet(page, {});
    await stubUploads(page);
    await page.route('**/api/admin/design-images/base/image*', (route) =>
      route.fulfill({
        json: { ok: true, img: UPLOADED, gallery: { base: { board: { img: UPLOADED } } } },
      })
    );

    await page.goto(`/admin-images.html?key=${KEY}`);
    const board = page.locator('.item[data-design="kids"][data-key="board"]');
    // Boardless: starts empty (no shipped render), reset disabled.
    await expect(board.locator('.preview-empty')).toBeVisible();
    await expect(board.locator('button[data-act="reset"]')).toBeDisabled();

    await board.locator('input[type=file]').setInputFiles({
      name: 'board.png',
      mimeType: 'image/png',
      buffer: PNG,
    });

    // After upload: the boardless board now carries the owner's picture.
    const after = page.locator('.item[data-design="kids"][data-key="board"]');
    await expect(after.locator('.badge.custom')).toBeVisible();
    await expect(after.locator('img.preview')).toHaveAttribute('src', UPLOADED);
    await expect(after.locator('button[data-act="reset"]')).toBeEnabled();
  });

  test('toggling a base checkbox posts the per-surface flag', async ({ page }) => {
    await stubGet(page, {});
    let flagBody = null;
    await page.route('**/api/admin/design-images/base/flags*', (route) => {
      flagBody = JSON.parse(route.request().postData() || '{}');
      route.fulfill({ json: { ok: true, gallery: { base: { store: { onProduct: true } } } } });
    });

    await page.goto(`/admin-images.html?key=${KEY}`);
    // Opt the store cover INTO the product page.
    await page
      .locator('.item[data-design="posttrip"][data-key="store"] input[data-flag="onProduct"]')
      .check();
    await expect.poll(() => flagBody).not.toBeNull();
    expect(flagBody).toMatchObject({ designId: 'posttrip', slot: 'store', onProduct: true });
  });

  test('adding a named photo appends a photo item to the gallery', async ({ page }) => {
    await stubGet(page, {});
    await stubUploads(page);
    await page.route('**/api/admin/design-images/photo*', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      route.fulfill({
        json: {
          ok: true,
          photo: { id: 'p1', img: UPLOADED, name: 'סטודיו', onProducts: true, onProduct: true },
          gallery: {
            photos: [
              { id: 'p1', img: UPLOADED, name: 'סטודיו', onProducts: true, onProduct: true },
            ],
          },
        },
      });
    });

    await page.goto(`/admin-images.html?key=${KEY}`);
    const section = page.locator('.design[data-design="birthday"]');
    await section.locator('.add-name').fill('סטודיו');
    await section.locator('.add-file').setInputFiles({
      name: 'x.png',
      mimeType: 'image/png',
      buffer: PNG,
    });

    const photo = page.locator('.item[data-design="birthday"][data-type="photo"]');
    await expect(photo).toHaveCount(1);
    await expect(photo.locator('.name-input')).toHaveValue('סטודיו');
    await expect(photo.locator('img.preview')).toHaveAttribute('src', UPLOADED);
  });

  // ---- Photo-card fallback pawns -------------------------------------------
  // One shared set of four, NOT per design: the pawns fill the photo card when an
  // order arrives with no customer photos.
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';

  // Stubs the pawn API. `slots` maps slot -> override path (absent = shipped).
  function stubPawns(page, slots = {}, onCall) {
    return page.route('**/api/admin/photo-fallback*', (route) => {
      const req = route.request();
      const url = req.url();
      if (url.includes('/photo-fallback/default/')) {
        return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
      }
      if (req.method() === 'GET') {
        return route.fulfill({
          json: {
            slots: ['1', '2', '3', '4'].map((slot) => ({
              slot,
              img: slots[slot] || null,
              overridden: !!slots[slot],
              shipped: '/api/admin/photo-fallback/default/' + slot,
              shippedExists: true,
            })),
          },
        });
      }
      if (onCall) onCall(req);
      return route.fulfill({ json: { ok: true, slot: '1' } });
    });
  }

  test('the pawn panel lists four slots, each on its shipped pawn', async ({ page }) => {
    await stubGet(page, {});
    await stubPawns(page);
    await page.goto(`/admin-images.html?key=${KEY}`);

    const pawns = page.locator('#pawnsList .item[data-pawn]');
    await expect(pawns).toHaveCount(4);
    await expect(page.locator('#pawns')).toBeVisible();
    // Every slot reports the shipped default, and reset is meaningless there.
    await expect(page.locator('#pawnsList .badge.default')).toHaveCount(4);
    await expect(page.locator('#pawnsList button[data-act="pawn-reset"][disabled]')).toHaveCount(4);
    // The thumbnail shows what the slot falls back to, via the admin route.
    await expect(pawns.first().locator('img.preview')).toHaveAttribute(
      'src',
      /photo-fallback\/default\/1/
    );
  });

  test('an overridden slot is marked custom and can be reset', async ({ page }) => {
    await stubGet(page, {});
    await stubUploads(page);
    let deleted = null;
    await stubPawns(page, { 2: UPLOADED }, (req) => {
      if (req.method() === 'DELETE') deleted = JSON.parse(req.postData() || '{}');
    });
    await page.goto(`/admin-images.html?key=${KEY}`);

    const two = page.locator('#pawnsList .item[data-pawn="2"]');
    await expect(two.locator('.badge.custom')).toBeVisible();
    // The thumbnail is the OVERRIDE, not the shipped pawn — it is what the
    // generator will actually print.
    await expect(two.locator('img.preview')).toHaveAttribute('src', UPLOADED);
    await expect(two.locator('button[data-act="pawn-reset"]')).toBeEnabled();

    await two.locator('button[data-act="pawn-reset"]').click();
    await expect.poll(() => deleted).not.toBeNull();
    expect(deleted).toEqual({ slot: '2' });
  });

  test('uploading a pawn posts the slot with the file', async ({ page }) => {
    await stubGet(page, {});
    let posted = null;
    await stubPawns(page, {}, (req) => {
      if (req.method() === 'POST') posted = req.postData() || '';
    });
    await page.goto(`/admin-images.html?key=${KEY}`);

    const three = page.locator('#pawnsList .item[data-pawn="3"]');
    await three.locator('input[type="file"]').setInputFiles({
      name: 'pawn.png',
      mimeType: 'image/png',
      buffer: PNG,
    });

    await expect.poll(() => posted).not.toBeNull();
    // Multipart carrying the slot and the file part.
    expect(posted).toContain('name="slot"');
    expect(posted).toContain('3');
    expect(posted).toContain('name="file"');
  });

  test('without a key the pawn panel is not requested either', async ({ page }) => {
    let hitPawns = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/photo-fallback')) hitPawns = true;
    });
    await page.goto('/admin-images.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#pawns')).toBeHidden();
    expect(hitPawns).toBe(false);
  });

  test('reorder posts the full new key order', async ({ page }) => {
    await stubGet(page, {});
    let orderBody = null;
    await page.route('**/api/admin/design-images/order*', (route) => {
      orderBody = JSON.parse(route.request().postData() || '{}');
      route.fulfill({ json: { ok: true, gallery: { order: orderBody.order } } });
    });

    await page.goto(`/admin-images.html?key=${KEY}`);
    // Move the first item (store) one step later.
    await page
      .locator('.item[data-design="posttrip"][data-key="store"] button[data-act="down"]')
      .click();
    await expect.poll(() => orderBody).not.toBeNull();
    expect(orderBody.designId).toBe('posttrip');
    expect(orderBody.order.slice(0, 2)).toEqual(['front', 'store']);
  });
});
