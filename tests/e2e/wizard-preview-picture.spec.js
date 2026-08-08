import { test, expect } from '@playwright/test';

// THE RULE (owner, absolute): pressing a design in the wizard's picker shows THAT
// design's own picture, enlarged, in the big preview area — and nothing else. The
// big preview is the small picture the buyer just tapped, shown large. There is no
// second source of artwork.
//
// It was not so. The preview inlined a static `assets/designs/<id>/front.svg`
// committed in the repo and never refreshed when a template was replaced, so on
// production `kids` / ברוקלין previewed a blue-green birthday deck ("יום ההולדת של
// רון") while the tile beside it — and the live template — were a basketball
// design. The buyer was being shown a product we no longer make.
//
// So the assertions here are about IDENTITY, not about pixels: the tile stamps the
// full-size URL of the picture it is showing onto `data-picture`, and the preview
// must be showing exactly that. Any future change that gives the preview its own
// source fails this file, which is the whole point of it.

const DECK_FRONTS = '/content-uploads/00000000000000b1.webp';
const DECK_BACKS = '/content-uploads/00000000000000b2.webp';

// A real, decodable 64x64 PNG. A 1x1 would "load" and tell us nothing, and an
// undecodable body fires `error` — a path under test here, so it must not fire by
// accident.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfbJGYyliH8OITBAtzmrP11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB2OhhtC3NOZwAAAAASUVORK5CYII=',
  'base64'
);

const tile = (page, id) => page.locator(`.design[data-design-id="${id}"]`);
const activeArt = (page) => page.locator('.preview-panel[data-active="true"] img');

test.beforeEach(async ({ page }) => {
  // Keep the catalog to the bundled designs so tile indices and counts are stable.
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

test.describe('the big preview IS the picture the buyer tapped', () => {
  // Every bundled design, not just one: the drift that started this was on a
  // single design, and a per-design regression is exactly what a one-design test
  // would miss.
  const DESIGNS = ['bachelorette', 'marriage', 'birthday', 'japanese', 'posttrip', 'kids'];

  for (const id of DESIGNS) {
    test(`${id}: the preview shows that tile's own picture`, async ({ page }) => {
      await page.goto(`/options.html?design=${id}&step=1`);
      const t = tile(page, id);
      await expect(t).toHaveAttribute('aria-pressed', 'true');

      // The tile publishes the full-size URL of the picture it is displaying.
      const picture = await t.getAttribute('data-picture');
      expect(picture, `${id} resolved no picture at all`).toBeTruthy();

      // EQUALITY, not resemblance: the preview is showing that exact picture.
      await expect(activeArt(page)).toHaveAttribute('src', picture);
      // …and it really decoded — an identical-but-broken src would pass the line
      // above and show the buyer nothing.
      await expect
        .poll(() => activeArt(page).evaluate((i) => i.complete && i.naturalWidth > 0))
        .toBe(true);
    });
  }

  test('switching design swaps the picture, tile and preview together', async ({ page }) => {
    await page.goto('/options.html?step=1');
    await expect(activeArt(page)).toBeVisible();

    for (const id of ['japanese', 'kids', 'bachelorette']) {
      await tile(page, id).click();
      const picture = await tile(page, id).getAttribute('data-picture');
      expect(picture).toBeTruthy();
      await expect(activeArt(page)).toHaveAttribute('src', picture);
    }
  });

  // renderEpoch's reason for existing. A picture can take a while to arrive, and
  // design A's late one must never land on top of design B.
  test('a slow picture for design A never lands while B is selected', async ({ page }) => {
    let release;
    const held = new Promise((r) => (release = r));
    await page.route('**/assets/designs/marriage/gallery-front.webp', async (route) => {
      await held;
      await route.fallback();
    });

    await page.goto('/options.html?step=1');
    await expect(activeArt(page)).toBeVisible();

    await tile(page, 'marriage').click(); // A — its picture is stuck
    await tile(page, 'birthday').click(); // B — resolves at once
    await expect(activeArt(page)).toHaveAttribute(
      'src',
      'assets/designs/birthday/gallery-front.webp'
    );

    // Now let A's picture arrive, long after the buyer moved on.
    release();
    await page.waitForTimeout(400);
    await expect(activeArt(page)).toHaveAttribute(
      'src',
      'assets/designs/birthday/gallery-front.webp'
    );
    await expect(tile(page, 'birthday')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('the tabs show that design’s three faces', () => {
  test('קלף / גב / לוח each show their own picture', async ({ page }) => {
    await page.goto('/options.html?design=bachelorette&step=1');
    for (const [tab, panel, view] of [
      ['tab-front', 'preview-front', 'front'],
      ['tab-back', 'preview-back', 'back'],
      ['tab-board', 'preview-board', 'board'],
    ]) {
      await page.getByTestId(tab).click();
      await expect(page.getByTestId(panel)).toHaveAttribute('data-active', 'true');
      await expect(page.getByTestId(panel).locator('img')).toHaveAttribute(
        'src',
        `assets/designs/bachelorette/gallery-${view}.webp`
      );
    }
  });

  // kids ships no board. The tab is HIDDEN rather than shown over an empty stage —
  // the existing rule, now driven by "is there a picture" rather than by a
  // products entry.
  test('a tab with no picture is hidden, not empty', async ({ page }) => {
    await page.goto('/options.html?design=kids&step=1');
    await expect(page.getByTestId('tab-front')).toBeVisible();
    await expect(page.getByTestId('tab-back')).toBeVisible();
    await expect(page.getByTestId('tab-board')).toBeHidden();
    await expect(page.getByTestId('preview-board').locator('img')).toHaveCount(0);
  });

  // Fail-soft, mirroring how the deck row drops a thumb that errors: a 404 costs
  // the buyer that face, never a torn image or a dead stage.
  test('a picture that 404s drops its tab instead of showing a broken image', async ({ page }) => {
    await page.route('**/assets/designs/bachelorette/gallery-board.webp', (route) =>
      route.fulfill({ status: 404, body: '' })
    );
    await page.goto('/options.html?design=bachelorette&step=1');
    await page.getByTestId('tab-board').click();

    // The board leaves the wizard and the buyer is moved to a face that works.
    await expect(page.getByTestId('tab-board')).toBeHidden();
    await expect(page.getByTestId('preview-front')).toHaveAttribute('data-active', 'true');
    await expect(activeArt(page)).toHaveAttribute(
      'src',
      'assets/designs/bachelorette/gallery-front.webp'
    );
  });
});

test.describe('the owner’s deck photograph wins, on both surfaces at once', () => {
  function stubGallery(page, base) {
    return Promise.all([
      page.route('**/api/design-images*', (route) =>
        route.fulfill({ json: { images: { bachelorette: { base } } } })
      ),
      page.route('**/design-thumb/*', (route) =>
        route.fulfill({ contentType: 'image/png', body: PNG })
      ),
      page.route('**/content-uploads/*', (route) =>
        route.fulfill({ contentType: 'image/png', body: PNG })
      ),
    ]);
  }

  test('her photo replaces the shipped render in the preview and on the tile', async ({ page }) => {
    await stubGallery(page, {
      deckFronts: { img: DECK_FRONTS },
      deckBacks: { img: DECK_BACKS },
    });
    await page.goto('/options.html?design=bachelorette&step=1');

    // The tile shows the small derivative of her photo…
    await expect(tile(page, 'bachelorette').locator('img')).toHaveAttribute(
      'src',
      '/design-thumb/00000000000000b1.webp'
    );
    // …and the preview the SAME picture, full size — which is what data-picture
    // says it is.
    await expect(tile(page, 'bachelorette')).toHaveAttribute('data-picture', DECK_FRONTS);
    await expect(activeArt(page)).toHaveAttribute('src', DECK_FRONTS);

    // Each face keeps its own photograph.
    await page.getByTestId('tab-back').click();
    await expect(page.getByTestId('preview-back').locator('img')).toHaveAttribute(
      'src',
      DECK_BACKS
    );
    // She photographed no board, so that tab falls back to the shipped render.
    await page.getByTestId('tab-board').click();
    await expect(page.getByTestId('preview-board').locator('img')).toHaveAttribute(
      'src',
      'assets/designs/bachelorette/gallery-board.webp'
    );
  });

  test('a photo that 404s falls back to the shipped render, not a broken image', async ({
    page,
  }) => {
    await page.route('**/api/design-images*', (route) =>
      route.fulfill({
        json: { images: { bachelorette: { base: { deckFronts: { img: DECK_FRONTS } } } } },
      })
    );
    await page.route('**/design-thumb/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG })
    );
    await page.route('**/content-uploads/*', (route) => route.fulfill({ status: 404, body: '' }));

    await page.goto('/options.html?design=bachelorette&step=1');
    await expect(activeArt(page)).toHaveAttribute(
      'src',
      'assets/designs/bachelorette/gallery-front.webp'
    );
    await expect
      .poll(() => activeArt(page).evaluate((i) => i.complete && i.naturalWidth > 0))
      .toBe(true);
    // The card face is still offered — the fallback rescued it.
    await expect(page.getByTestId('tab-front')).toBeVisible();
  });
});

test.describe('the fullscreen viewer opens the same picture', () => {
  test('enlarging shows exactly what the panel is showing', async ({ page }) => {
    await page.goto('/options.html?design=bachelorette&step=1');
    const shown = await activeArt(page).getAttribute('src');
    expect(shown).toBeTruthy();

    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    await expect(page.locator('#zoomContent img')).toHaveAttribute('src', shown);

    // …and switching face inside the overlay follows the panel, still one picture.
    await page.getByTestId('zoom-tab-board').click();
    await expect(page.locator('#zoomContent img')).toHaveAttribute(
      'src',
      'assets/designs/bachelorette/gallery-board.webp'
    );
  });
});
