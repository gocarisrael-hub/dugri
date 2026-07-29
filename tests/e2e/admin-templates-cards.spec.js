import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_SENTINEL, readThemes, templateDirFor } from './tpl-fixture.js';

// The PORTRAIT SINGLE-CARD layout in the admin templates page: the upload form's
// nine-file pickers, and the calibration panel's shared word slots + per-front
// title position. Mirrors admin-templates.spec.js — read-only checks run on every
// device project, mutating ones on a single project against the throwaway
// TEMPLATE_ROOT fixture, and only after the fixture sentinel proves the server is
// the test-owned one.
const KEY = 'dugri-admin';
const ONLY = 'Desktop Chrome';

// One template on the new layout, stubbed into the list so the panel can be
// exercised without a fixture. Only the fields the page reads.
function cardsTemplate(over = {}) {
  return {
    key: 'cards-x',
    slug: 'cards-x',
    display_he: 'קלף בודד',
    visibility: 'public',
    calibrated: false,
    language: 'hebrew',
    name_form: 'hebrew',
    extra_fields: [],
    assets: [],
    title_style: { fill: '#000000', outline: '#ffffff' },
    board: null,
    back: null,
    word_size: null,
    card_structure: 'cards',
    card_viewbox: { w: 223.92, h: 312 },
    card_slots: null,
    ...over,
  };
}

test.describe('admin templates — single-card layout (read-only)', () => {
  test('the upload form offers the layout choice and swaps its file inputs', async ({ page }) => {
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const sel = page.locator('#form select[name="card_structure"]');
    await expect(sel).toHaveValue('cards'); // the new layout is the default

    // Single-card mode: the two nine-file pickers are on screen and required,
    // and the legacy fronts/backs inputs are hidden AND disabled — a disabled
    // input is left out of the FormData, so it can neither block submit on a
    // hidden required field nor post an empty part over a real file.
    const cleanCards = page.locator('#form input[name="clean_cards"]');
    await expect(cleanCards).toBeVisible();
    await expect(cleanCards).toHaveAttribute('multiple', '');
    expect(await cleanCards.evaluate((el) => el.required)).toBe(true);
    const cleanFronts = page.locator('#form input[name="clean_fronts"]');
    await expect(cleanFronts).toBeHidden();
    expect(await cleanFronts.evaluate((el) => el.disabled)).toBe(true);
    // The board is shared by both layouts and OPTIONAL here — a single-card
    // template can be registered deck-first.
    expect(
      await page.locator('#form input[name="clean_board"]').evaluate((el) => el.required)
    ).toBe(false);

    // Switch to the legacy sheet layout: the mirror image, and the board becomes
    // required again.
    await sel.selectOption('sheet');
    await expect(cleanFronts).toBeVisible();
    expect(await cleanFronts.evaluate((el) => el.disabled)).toBe(false);
    await expect(cleanCards).toBeHidden();
    expect(await cleanCards.evaluate((el) => el.disabled)).toBe(true);
    expect(
      await page.locator('#form input[name="clean_board"]').evaluate((el) => el.required)
    ).toBe(true);
  });

  test('the calibration panel shows one card: shared word slots + a title per front', async ({
    page,
  }) => {
    await page.route('**/api/admin/templates?key=*', (route) =>
      route.fulfill({ json: { templates: [cardsTemplate()] } })
    );
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const cal = page.locator('.tpl-card[data-key="cards-x"] .tpl-cal');
    await expect(cal.locator('.cal-card-group')).toHaveCount(1);

    // ONE card at the locked viewBox — not eight cells on a sheet.
    await expect(cal.locator('.cal-card-map')).toHaveAttribute('viewBox', '0 0 223.92 312');

    // Four word slots, shared across every front (there is exactly one set).
    for (const i of [1, 2, 3, 4]) {
      await expect(cal.locator(`[data-cal="card.word.${i}.x0"]`)).toHaveCount(1);
      await expect(cal.locator(`[data-cal="card.word.${i}.y1"]`)).toHaveCount(1);
    }
    await expect(cal.locator('[data-cal="card.word.5.x0"]')).toHaveCount(0);

    // A title position per front (2-9) — eight of them, one visible at a time.
    await expect(cal.locator('.cal-front-btn')).toHaveCount(8);
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) {
      await expect(cal.locator(`[data-cal="card.title.${n}.x0"]`)).toHaveCount(1);
    }
    await expect(cal.locator('.cal-title-row[data-front="2"]')).toBeVisible();
    await expect(cal.locator('.cal-title-row[data-front="5"]')).toBeHidden();
    await cal.locator('.cal-front-btn[data-front="5"]').click();
    await expect(cal.locator('.cal-title-row[data-front="5"]')).toBeVisible();
    await expect(cal.locator('.cal-title-row[data-front="2"]')).toBeHidden();

    // The board is NOT part of the per-card calibration — it keeps its own
    // honoree-name slot group, because it is a separate output file.
    await expect(cal.locator('.cal-card-group [data-cal^="board."]')).toHaveCount(0);
    await expect(cal.locator('[data-cal="board.enabled"]')).toHaveCount(1);

    // The map draws the slots live: four word boxes + the active front's title.
    await expect(cal.locator('.cal-card-map rect')).toHaveCount(5);
    await cal.locator('[data-cal="card.word.1.x1"]').fill('');
    await expect(cal.locator('.cal-card-map rect')).toHaveCount(4);
  });

  // A 1x1 PNG, enough for an <img> to have a real src.
  const SHOT = 'data:image/png;base64,iVBORw0KGgo=';

  // The preview response an OWNER calibration gets: every front, keyed by front
  // number, because the title position is calibrated per front.
  function allFronts(over = {}) {
    const cards = {};
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) cards[String(n)] = SHOT;
    return { cards, card: SHOT, board: SHOT, ...over };
  }

  test('the preview shows EVERY front as a labelled thumbnail', async ({ page }) => {
    await page.route('**/api/admin/templates?key=*', (route) =>
      route.fulfill({ json: { templates: [cardsTemplate()] } })
    );
    await page.route('**/api/preview*', (route) => route.fulfill({ json: allFronts() }));
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const cal = page.locator('.tpl-card[data-key="cards-x"] .tpl-cal');
    await cal.locator('.cal-preview-btn').click();

    // Eight fronts, in front order, labelled the SAME way as the picker buttons
    // ('פנים 1'..'פנים 8' for 2.svg..9.svg) — they are two views of one choice.
    const thumbs = cal.locator('.cal-card-thumb');
    await expect(thumbs).toHaveCount(8);
    await expect(thumbs.first()).toHaveAttribute('data-front', '2');
    await expect(thumbs.first()).toContainText('פנים 1');
    await expect(thumbs.last()).toHaveAttribute('data-front', '9');
    await expect(thumbs.last()).toContainText('פנים 8');
    await expect(thumbs.nth(3)).toHaveAttribute('title', '5.svg');

    // The single "קלף" figure is REPLACED by the strip, not shown alongside it —
    // it is just front 2 again, and a duplicate reads as a ninth front.
    await expect(cal.locator('.cal-preview figure figcaption', { hasText: 'קלף' })).toHaveCount(0);
    // The board still renders as its own figure below the strip.
    await expect(cal.locator('.cal-preview figure figcaption', { hasText: 'לוח' })).toHaveCount(1);

    // The active front is marked, so it is clear which one the open title box edits.
    await expect(cal.locator('.cal-card-thumb.active')).toHaveCount(1);
    await expect(cal.locator('.cal-card-thumb.active')).toHaveAttribute('data-front', '2');
  });

  test('a thumbnail and the front picker are two views of one choice', async ({ page }) => {
    await page.route('**/api/admin/templates?key=*', (route) =>
      route.fulfill({ json: { templates: [cardsTemplate()] } })
    );
    await page.route('**/api/preview*', (route) => route.fulfill({ json: allFronts() }));
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const cal = page.locator('.tpl-card[data-key="cards-x"] .tpl-cal');
    await cal.locator('.cal-preview-btn').click();

    // Clicking a THUMBNAIL selects that front for editing: its title row opens
    // and the picker button follows. "That one is wrong" and "let me fix that
    // one" are the same gesture.
    await cal.locator('.cal-card-thumb[data-front="6"]').click();
    await expect(cal.locator('.cal-title-row[data-front="6"]')).toBeVisible();
    await expect(cal.locator('.cal-title-row[data-front="2"]')).toBeHidden();
    await expect(cal.locator('.cal-front-btn[data-front="6"]')).toHaveClass(/active/);
    await expect(cal.locator('.cal-card-thumb[data-front="6"]')).toHaveClass(/active/);

    // ...and the other direction: picking a front highlights its thumbnail.
    await cal.locator('.cal-front-btn[data-front="9"]').click();
    await expect(cal.locator('.cal-card-thumb[data-front="9"]')).toHaveClass(/active/);
    await expect(cal.locator('.cal-card-thumb[data-front="6"]')).not.toHaveClass(/active/);
    await expect(cal.locator('.cal-card-thumb.active')).toHaveCount(1);
  });

  test('a preview WITHOUT a cards map still shows the single card', async ({ page }) => {
    // An older generator, or a buyer preview, returns only `card`. The panel must
    // keep working exactly as it did rather than rendering an empty strip.
    await page.route('**/api/admin/templates?key=*', (route) =>
      route.fulfill({ json: { templates: [cardsTemplate()] } })
    );
    await page.route('**/api/preview*', (route) =>
      route.fulfill({ json: { card: SHOT, board: SHOT } })
    );
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const cal = page.locator('.tpl-card[data-key="cards-x"] .tpl-cal');
    await cal.locator('.cal-preview-btn').click();

    await expect(cal.locator('.cal-card-thumb')).toHaveCount(0);
    await expect(cal.locator('.cal-preview figure figcaption', { hasText: 'קלף' })).toHaveCount(1);
    await expect(cal.locator('.cal-preview img')).toHaveCount(2); // card + board
  });

  test('a LEGACY sheet template gets no card group at all', async ({ page }) => {
    await page.route('**/api/admin/templates?key=*', (route) =>
      route.fulfill({
        json: {
          templates: [cardsTemplate({ key: 'sheet-x', slug: 'sheet-x', card_structure: 'sheet' })],
        },
      })
    );
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const cal = page.locator('.tpl-card[data-key="sheet-x"] .tpl-cal');
    await expect(cal.locator('.cal-card-group')).toHaveCount(0);
    // ...and its knobs are untouched.
    await expect(cal.locator('[data-cal="ts.fill"]')).toHaveCount(1);
    await expect(cal.locator('[data-cal="word_size"]')).toHaveCount(1);
  });

  test('saved card_slots pre-fill the form, and preview/save carry them', async ({ page }) => {
    const box = (y0) => ({ x0: 0.11, y0, x1: 0.89, y1: y0 + 0.1 });
    const titles = {};
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) titles[String(n)] = { ...box(0.06), x1: 0.93 };
    const card_slots = { words: [box(0.31), box(0.46), box(0.61), box(0.76)], titles };
    await page.route('**/api/admin/templates?key=*', (route) =>
      route.fulfill({ json: { templates: [cardsTemplate({ card_slots, calibrated: true })] } })
    );
    let previewBody = null;
    await page.route('**/api/preview*', (route) => {
      previewBody = route.request().postDataJSON();
      return route.fulfill({ json: { card: 'data:image/png;base64,iVBORw0KGgo=' } });
    });
    let savedBody = null;
    await page.route('**/api/admin/templates/cards-x/settings*', (route) => {
      savedBody = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true } });
    });
    page.on('dialog', (d) => d.accept()); // the save confirm

    await page.goto(`/admin-templates.html?key=${KEY}`);
    const cal = page.locator('.tpl-card[data-key="cards-x"] .tpl-cal');
    await cal.locator('summary').click(); // calibrated → panel starts collapsed
    await expect(cal.locator('[data-cal="card.word.1.y0"]')).toHaveValue('0.31');
    await expect(cal.locator('[data-cal="card.title.9.x1"]')).toHaveValue('0.93');

    await cal.locator('[data-cal="card.word.2.y0"]').fill('0.5');
    await cal.locator('.cal-preview-btn').click();
    await expect(cal.locator('.cal-preview img')).toHaveCount(1);
    expect(previewBody.calibration.card_slots.words[1].y0).toBe(0.5);
    expect(Object.keys(previewBody.calibration.card_slots.titles)).toHaveLength(8);

    await cal.locator('.cal-save-btn').click();
    await expect.poll(() => savedBody && savedBody.calibrated).toBe(true);
    expect(savedBody.card_slots.words[1].y0).toBe(0.5);
    expect(savedBody.card_slots.titles['9'].x1).toBe(0.93);
  });
});

test.describe('admin templates — single-card mutations (fixture only, single project)', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'mutating test runs on one project only');
    const r = await request.get(`/api/admin/templates?key=${KEY}`);
    const body = await r.json().catch(() => ({}));
    const usingFixture = (body.templates || []).some((t) => t.key === FIXTURE_SENTINEL);
    test.skip(
      !usingFixture,
      'server is not the throwaway-fixture server (reused dev server?) — refusing to touch real config'
    );
  });

  test('uploads the nine numbered cards in one pick and lists them as its assets', async ({
    page,
  }) => {
    const slug = 'e2e-cards';
    const files = (layer) =>
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
        name: `${n}.svg`,
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${layer}-${n}</svg>`),
      }));
    const font = (name) => ({
      name,
      mimeType: 'font/ttf',
      buffer: Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from(name)]),
    });

    await page.goto(`/admin-templates.html?key=${KEY}`);
    await page.fill('#form input[name="slug"]', slug);
    await page.fill('#form input[name="display_he"]', 'קלפים E2E');
    await page.fill('#form input[name="title_text"]', '{NAME}');
    await page.setInputFiles('#form input[name="clean_cards"]', files('clean'));
    await page.setInputFiles('#form input[name="filled_cards"]', files('filled'));
    await page.setInputFiles('#form input[name="title_font"]', font('Title.ttf'));
    await page.setInputFiles('#form input[name="word_font"]', font('Word.ttf'));
    await page.click('#submit');

    await expect(page.locator('#msg')).toContainText(slug);
    const card = page.locator(`.tpl-card[data-key="${slug}"]`);
    await expect(card).toBeVisible();
    // The checklist is the numbered one: nine per layer, plus the SEPARATE board
    // (missing — this was a deck-first upload) and no fronts/backs rows.
    await expect(card.locator('.asset[data-role="clean-1"]')).toHaveClass(/on/);
    await expect(card.locator('.asset[data-role="filled-9"]')).toHaveClass(/on/);
    await expect(card.locator('.asset[data-role="clean-fronts"]')).toHaveCount(0);
    await expect(card.locator('.asset[data-role="clean-board"]')).toHaveClass(/off/);

    const themes = readThemes();
    expect(themes[slug].card_structure).toBe('cards');
    expect(themes[slug].calibrated).toBe(false);
    const dir = templateDirFor(slug);
    for (const n of [1, 5, 9]) {
      expect(fs.existsSync(path.join(dir, 'clean', `${n}.svg`))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'filled', `${n}.svg`))).toBe(true);
    }
  });

  test('a short pick is refused with the missing file names, and registers nothing', async ({
    page,
  }) => {
    const slug = 'e2e-cards-short';
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await page.fill('#form input[name="slug"]', slug);
    await page.fill('#form input[name="display_he"]', 'חסר E2E');
    await page.fill('#form input[name="title_text"]', '{NAME}');
    await page.setInputFiles(
      '#form input[name="clean_cards"]',
      [1, 2].map((n) => ({
        name: `${n}.svg`,
        mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">c</svg>'),
      }))
    );
    await page.setInputFiles('#form input[name="filled_cards"]', [
      { name: 'front (1).svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg></svg>') },
    ]);
    const font = {
      name: 'F.ttf',
      mimeType: 'font/ttf',
      buffer: Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from('f')]),
    };
    await page.setInputFiles('#form input[name="title_font"]', font);
    await page.setInputFiles('#form input[name="word_font"]', font);
    await page.click('#submit');

    // The error names the files, not just "invalid upload".
    const msg = page.locator('#msg');
    await expect(msg).toHaveClass(/err/);
    await expect(msg).toContainText('3.svg');
    await expect(msg).toContainText('9.svg');
    await expect(msg).toContainText('front (1).svg');
    await expect(page.locator(`.tpl-card[data-key="${slug}"]`)).toHaveCount(0);
    expect(readThemes()[slug]).toBeUndefined();
  });
});
