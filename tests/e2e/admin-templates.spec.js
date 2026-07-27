import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_ROOT, FIXTURE_SENTINEL } from './tpl-fixture.js';

// The template status/edit center is behind the admin key. The e2e server points
// TEMPLATE_ROOT at a THROWAWAY fixture (.e2e-tpl-root, built fresh by
// global-setup.js from a copy of themes.json + the 'anniversary' and
// 'bachelorette' template dirs), so rename/replace here never touch the
// checked-in generator/themes.json or resources/. Read-only checks run on every
// device project; MUTATING checks run on ONE project (skipped before the browser
// page is created on the others) and target 'bachelorette'; read-only assertions
// target 'anniversary' so the two never overlap across concurrent projects.
const KEY = 'dugri-admin';
const ONLY = 'Desktop Chrome';
const THEMES = path.join(FIXTURE_ROOT, 'generator', 'themes.json');
const TPL_DIR = path.join(FIXTURE_ROOT, 'resources', 'canva', 'templates');

test.describe('admin templates — status view (read-only)', () => {
  test('list / rename / replace endpoints reject a missing or wrong key', async ({ request }) => {
    expect((await request.get('/api/admin/templates')).status()).toBe(403);
    expect((await request.get('/api/admin/templates?key=nope')).status()).toBe(403);
    const rn = await request.post('/api/admin/templates/bachelorette/rename', {
      data: { display_he: 'x' },
    });
    expect(rn.status()).toBe(403);
    const rp = await request.post('/api/admin/templates/bachelorette/assets/clean-board-chasers', {
      multipart: {
        file: { name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg></svg>') },
      },
    });
    expect(rp.status()).toBe(403);
  });

  test('GET lists every template with an OPTIONAL chasers-board asset entry', async ({
    request,
  }) => {
    const r = await request.get(`/api/admin/templates?key=${KEY}`);
    expect(r.ok()).toBeTruthy();
    const { templates } = await r.json();
    expect(templates.length).toBeGreaterThanOrEqual(7);
    // Every template exposes a chasers-board checklist row, always marked optional.
    for (const t of templates) {
      const cb = t.assets.find((a) => a.role === 'clean-board-chasers');
      expect(cb).toBeTruthy();
      expect(cb.optional).toBe(true);
    }
    // anniversary (never mutated, copied into the fixture) ships without a chasers
    // board and with its core assets present.
    const anniv = templates.find((t) => t.key === 'anniversary');
    expect(anniv).toBeTruthy();
    expect(anniv.chasersBoard).toBe(false);
    expect(anniv.assets.find((a) => a.role === 'clean-fronts').present).toBe(true);
    expect(anniv.assets.find((a) => a.role === 'title-font').present).toBe(true);
  });

  test('the status page renders a card per template with checklist + edit affordances', async ({
    page,
  }) => {
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const cards = page.locator('.tpl-card');
    await expect(async () => {
      expect(await cards.count()).toBeGreaterThanOrEqual(7);
    }).toPass();

    const card = page.locator('.tpl-card[data-key="anniversary"]');
    await expect(card).toBeVisible();
    // a present asset shows a ✓
    await expect(card.locator('.asset[data-role="clean-fronts"]')).toHaveClass(/on/);
    // the chasers board row is present in the checklist, missing (✗), and optional
    const ch = card.locator('.asset[data-role="clean-board-chasers"]');
    await expect(ch).toHaveClass(/off/);
    await expect(ch).toHaveClass(/opt/);
    await expect(ch.locator('.mark')).toHaveText('✗');
    // rename + per-asset replace affordances are rendered
    await expect(card.locator('.tpl-rename-btn')).toBeVisible();
    await expect(ch.locator('.repl-input')).toHaveCount(1);
    // NEW: a delete button + a settings editor (visibility/language/name_form/extra_fields).
    await expect(card.locator('.tpl-delete-btn')).toBeVisible();
    await expect(card.locator('.tpl-settings select[data-field="visibility"]')).toHaveCount(1);
    await expect(card.locator('.tpl-settings select[data-field="language"]')).toHaveCount(1);
    await expect(card.locator('.tpl-settings input[data-field="extra_fields"]')).toHaveCount(1);
    // The upload form offers a visibility choice (public default).
    await expect(page.locator('#form select[name="visibility"]')).toHaveCount(1);
    await expect(page.locator('#form select[name="visibility"]')).toHaveValue('public');
  });

  test('without a key the page shows the access-key notice', async ({ page }) => {
    await page.goto('/admin-templates.html');
    await expect(page.locator('#tpl-list')).toContainText('מפתח גישה');
  });

  test('auto-calibration hints: partial pre-fill renders, low-confidence fields flagged, notes shown', async ({
    page,
  }) => {
    // Simulate what the upcoming auto-calibration produces: a PARTIAL title_style
    // (only what it could measure), plus per-field `confidence` and `notes`. The
    // form must pre-fill without assuming every key is present and surface the
    // low-confidence fields. Stub the list so no real template/fixture is needed.
    await page.route('**/api/admin/templates?key=*', (route) =>
      route.fulfill({
        json: {
          templates: [
            {
              key: 'auto-x',
              slug: 'auto-x',
              display_he: 'כיול אוטומטי',
              visibility: 'public',
              calibrated: false,
              language: 'hebrew',
              name_form: 'hebrew',
              extra_fields: [],
              assets: [],
              // Only fill + size were measured — outline_w/arch/board/back absent.
              title_style: { fill: '#ff0000', size: 20 },
              board: null,
              back: null,
              word_size: null,
              confidence: {
                'title_style.fill': 'high',
                'title_style.outline_w': 'none',
                'board.frac': 'low',
              },
              notes: ['לא זוהה עובי מתאר', 'תיבת השם על הלוח לא ודאית'],
            },
          ],
        },
      })
    );
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const card = page.locator('.tpl-card[data-key="auto-x"]');
    await expect(card).toBeVisible();
    const cal = card.locator('.tpl-cal');

    // Partial pre-fill: the measured fill is set; an ABSENT field falls back to its
    // default (outline_w → 0) rather than crashing or blanking the form.
    await expect(cal.locator('[data-cal="ts.fill"]')).toHaveValue('#ff0000');
    await expect(cal.locator('[data-cal="ts.outline_w"]')).toHaveValue('0');

    // Notes are listed.
    await expect(cal.locator('.cal-notes')).toContainText('לא זוהה עובי מתאר');

    // A 'none' field is flagged "fill it in"; a 'low' frac field is flagged "check".
    const owField = cal.locator('.cal-field:has([data-cal="ts.outline_w"])');
    await expect(owField).toHaveClass(/cal-check/);
    await expect(owField.locator('.cal-flag')).toHaveText('לא זוהה — מלאו');
    const fracField = cal.locator('.cal-field:has([data-cal="board.frac.x0"])');
    await expect(fracField.locator('.cal-flag')).toHaveText('בדקו');

    // A HIGH-confidence field carries no flag.
    await expect(cal.locator('.cal-field:has([data-cal="ts.fill"]) .cal-flag')).toHaveCount(0);
  });

  test('calibration preview takes a value for each extra field the theme declares', async ({
    page,
  }) => {
    // A theme whose title carries placeholders beyond {NAME} had nowhere to enter
    // them, so the preview rendered the title with them BLANK: japanese
    // ("{NAME}'S {AGE}S") came out as "DANIEL'S S", which reads as a broken
    // template rather than a missing input. The inputs are driven off the theme's
    // own extra_fields, and their values must reach /api/preview.
    await page.route('**/api/admin/templates?key=*', (route) =>
      route.fulfill({
        json: {
          templates: [
            {
              key: 'ex-age',
              slug: 'ex-age',
              display_he: 'עם גיל',
              visibility: 'public',
              // Uncalibrated so the panel opens by default — which is also when
              // the owner actually needs these inputs.
              calibrated: false,
              language: 'english',
              name_form: 'english-caps',
              extra_fields: ['AGE'],
              assets: [],
              title_style: { fill: '#000000', outline: '#ffffff' },
              board: null,
              back: null,
            },
            {
              key: 'ex-none',
              slug: 'ex-none',
              display_he: 'בלי שדות',
              visibility: 'public',
              calibrated: true,
              language: 'hebrew',
              name_form: 'hebrew',
              extra_fields: [],
              assets: [],
              title_style: { fill: '#000000', outline: '#ffffff' },
              board: null,
              back: null,
            },
          ],
        },
      })
    );
    let previewBody = null;
    await page.route('**/api/preview*', async (route) => {
      previewBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({ json: { card: 'data:image/png;base64,iVBORw0KGgo=' } });
    });

    await page.goto(`/admin-templates.html?key=${KEY}`);
    const cal = page.locator('.tpl-card[data-key="ex-age"] .tpl-cal');
    const ageInput = cal.locator('.cal-extra[data-field="AGE"]');
    await expect(ageInput).toHaveCount(1);

    // A theme with NO extra fields gets no extra inputs — that panel is unchanged.
    await expect(page.locator('.tpl-card[data-key="ex-none"] .tpl-cal .cal-extra')).toHaveCount(0);

    await ageInput.fill('40');
    await cal.locator('.cal-preview-btn').click();
    await expect(cal.locator('.cal-preview img')).toHaveCount(1);
    expect(previewBody.extra_fields).toEqual({ AGE: '40' });

    // Cleared to blank, the field is DROPPED rather than sent as "" — so a theme
    // that declares none posts the same body it always did.
    previewBody = null;
    await ageInput.fill('');
    await cal.locator('.cal-preview-btn').click();
    await expect.poll(() => previewBody && previewBody.extra_fields).toEqual({});
  });

  test('a rendered preview can be closed without saving, keeping the knobs', async ({ page }) => {
    // A preview is a look, not a commitment. Without a way out, the only exits
    // from a rendered preview are "save and mark calibrated" or leaving the page,
    // which makes just checking feel like it needs a decision.
    await page.route('**/api/admin/templates?key=*', (route) =>
      route.fulfill({
        json: {
          templates: [
            {
              key: 'close-x',
              slug: 'close-x',
              display_he: 'סגירה',
              visibility: 'public',
              calibrated: false,
              language: 'hebrew',
              name_form: 'hebrew',
              extra_fields: [],
              assets: [],
              title_style: { fill: '#000000', outline: '#ffffff' },
              board: null,
              back: null,
            },
          ],
        },
      })
    );
    let saveCalls = 0;
    await page.route('**/api/admin/templates/**', async (route) => {
      saveCalls += 1;
      await route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/preview*', (route) =>
      route.fulfill({ json: { card: 'data:image/png;base64,iVBORw0KGgo=' } })
    );

    await page.goto(`/admin-templates.html?key=${KEY}`);
    const cal = page.locator('.tpl-card[data-key="close-x"] .tpl-cal');
    await cal.locator('[data-cal="ts.outline_w"]').fill('0.07');
    await cal.locator('.cal-preview-btn').click();
    await expect(cal.locator('.cal-preview img')).toHaveCount(1);

    await cal.locator('.cal-preview-close').click();
    await expect(cal.locator('.cal-preview img')).toHaveCount(0);
    // Closing is not saving.
    expect(saveCalls).toBe(0);
    // ...and it discards nothing: the knob keeps its value, so the owner can
    // close, tweak and preview again.
    await expect(cal.locator('[data-cal="ts.outline_w"]')).toHaveValue('0.07');
    // The status bar is hidden, not left as an empty coloured bar.
    await expect(page.locator('.tpl-card[data-key="close-x"] .tpl-msg')).toBeHidden();
  });

  test('every card exposes a calibration panel (title look-knobs + board/back + preview/save)', async ({
    page,
  }) => {
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const card = page.locator('.tpl-card[data-key="anniversary"]');
    await expect(card).toBeVisible();
    const cal = card.locator('.tpl-cal');
    await expect(cal).toHaveCount(1);
    // title_style knobs (elements exist even when the <details> is collapsed).
    await expect(cal.locator('[data-cal="ts.fill"]')).toHaveCount(1);
    await expect(cal.locator('[data-cal="ts.outline"]')).toHaveCount(1);
    await expect(cal.locator('[data-cal="ts.outline_w"]')).toHaveCount(1);
    await expect(cal.locator('[data-cal="ts.arch"]')).toHaveCount(1);
    await expect(cal.locator('[data-cal="ts.align"]')).toHaveCount(1);
    await expect(cal.locator('[data-cal="ts.shadow"]')).toHaveCount(1);
    await expect(cal.locator('[data-cal="ts.italic"]')).toHaveCount(1);
    // board + back honoree-name slots + word_size.
    await expect(cal.locator('[data-cal="board.enabled"]')).toHaveCount(1);
    await expect(cal.locator('[data-cal="board.frac.x0"]')).toHaveCount(1);
    await expect(cal.locator('[data-cal="back.frac.y1"]')).toHaveCount(1);
    await expect(cal.locator('[data-cal="word_size"]')).toHaveCount(1);
    // preview + save actions.
    await expect(cal.locator('.cal-preview-btn')).toHaveCount(1);
    await expect(cal.locator('.cal-save-btn')).toHaveCount(1);
  });
});

test.describe('admin templates — mutations (fixture only, single project)', () => {
  test.describe.configure({ mode: 'serial' });
  // Run the mutating tests on ONE project only — skipped BEFORE the browser page
  // fixture is created on the others, so the device matrix never launches
  // concurrent browsers here (and only one project ever writes the file).
  // THEN refuse to run at all unless the live server lists the fixture-only
  // sentinel theme — proof it is the test-owned server honoring the throwaway
  // TEMPLATE_ROOT. If a dev already had `node server/index.js` on :4321 (which
  // Playwright reuses locally, reuseExistingServer:!CI), the sentinel is absent
  // and we skip rather than write to the REAL generator/themes.json + resources/.
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

  test('rename works through the UI and keeps the slug stable', async ({ page }) => {
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const card = page.locator('.tpl-card[data-key="bachelorette"]');
    await expect(card).toBeVisible();
    const slugBefore = (await card.locator('.tpl-slug').textContent()).trim();

    await card.locator('.tpl-rename-btn').click();
    await card.locator('.tpl-name-input').fill('שם מבחן E2E');
    await card.locator('.tpl-save-btn').click();

    // The list reloads: the card shows the new label, the slug is unchanged.
    const renamed = page.locator('.tpl-card[data-key="bachelorette"] .tpl-name');
    await expect(renamed).toHaveText('שם מבחן E2E');
    expect(
      (await page.locator('.tpl-card[data-key="bachelorette"] .tpl-slug').textContent()).trim()
    ).toBe(slugBefore);

    // Persisted to the FIXTURE themes.json; the slug/identity is untouched.
    const themes = JSON.parse(fs.readFileSync(THEMES, 'utf8'));
    expect(themes.bachelorette.display_he).toBe('שם מבחן E2E');
    expect(themes.bachelorette.slug).toBe('bachelorette');
  });

  test('replacing an SVG on a CALIBRATED template requires confirm; cancel aborts', async ({
    page,
  }) => {
    // bachelorette ships calibrated, so ANY svg-role replace must be confirmed.
    // Dismiss the confirm → nothing is written and the abort is reported.
    let dialogText = '';
    page.on('dialog', (d) => {
      dialogText = d.message();
      d.dismiss();
    });
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const card = page.locator('.tpl-card[data-key="bachelorette"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.asset[data-role="clean-fronts"]')).toHaveClass(/on/);

    await card.locator('.asset[data-role="clean-fronts"] .repl-input').setInputFiles({
      name: 'front.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>'),
    });

    await expect(card.locator('.tpl-msg.err')).toContainText('בוטלה');
    expect(dialogText).toMatch(/מכוילת|proof|כויל/);
    // clean-fronts is unchanged (still present) — the swap was not written.
    await expect(card.locator('.asset[data-role="clean-fronts"]')).toHaveClass(/on/);
  });

  test('a network error during asset replace clears the file input so the same file can be retried', async ({
    page,
  }) => {
    // Abort the upload request to simulate a dropped network. The catch must show a
    // network error AND reset the file input's value — otherwise re-selecting the
    // exact same file fires no 'change' event and the retry is impossible.
    await page.route('**/api/admin/templates/**/assets/**', (route) => route.abort());
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const card = page.locator('.tpl-card[data-key="bachelorette"]');
    await expect(card).toBeVisible();
    const input = card.locator('.asset[data-role="clean-fronts"] .repl-input');
    await input.setInputFiles({
      name: 'front.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>'),
    });
    await expect(card.locator('.tpl-msg.err')).toContainText('רשת');
    await expect(input).toHaveValue(''); // cleared → same file can be re-picked
  });

  test('confirming a calibrated SVG replace adds the missing chasers board', async ({ page }) => {
    const created = path.join(TPL_DIR, 'bachelorette', 'clean', 'board-chasers.svg');
    // Accept the calibration confirm → the UI re-submits with force and the file
    // lands at the exact path the generator reads.
    page.on('dialog', (d) => d.accept());
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const card = page.locator('.tpl-card[data-key="bachelorette"]');
    await expect(card).toBeVisible();
    const ch = card.locator('.asset[data-role="clean-board-chasers"]');
    await expect(ch).toHaveClass(/off/);

    await ch.locator('.repl-input').setInputFiles({
      name: 'board-chasers.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">e2e-chasers</svg>'),
    });

    const now = page.locator(
      '.tpl-card[data-key="bachelorette"] .asset[data-role="clean-board-chasers"]'
    );
    await expect(now).toHaveClass(/on/);
    await expect(now.locator('.mark')).toHaveText('✓');
    expect(fs.existsSync(created)).toBe(true);
  });

  test('editing settings (visibility → private) persists and shows the private badge', async ({
    page,
  }) => {
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const card = page.locator('.tpl-card[data-key="bachelorette"]');
    await expect(card).toBeVisible();

    await card.locator('.tpl-settings summary').click();
    await card.locator('select[data-field="visibility"]').selectOption('private');
    await card.locator('.tpl-settings-save').click();

    // Reloads: the fixture themes.json now has bachelorette private, and the card
    // shows the "פרטית" badge.
    await expect(page.locator('.tpl-card[data-key="bachelorette"] .tpl-badge.priv')).toBeVisible();
    const themes = JSON.parse(fs.readFileSync(THEMES, 'utf8'));
    expect(themes.bachelorette.visibility).toBe('private');
    // identity untouched
    expect(themes.bachelorette.slug).toBe('bachelorette');
  });

  test('deleting an IN-USE template is refused (guard) — the template survives', async ({
    page,
  }) => {
    // bachelorette backs a live orderable design (THEME_BY_DESIGN), so the server
    // refuses to delete it (409). The UI surfaces the error and the card stays.
    page.on('dialog', (d) => d.accept()); // confirm the delete prompt
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const card = page.locator('.tpl-card[data-key="bachelorette"]');
    await expect(card).toBeVisible();

    await card.locator('.tpl-delete-btn').click();

    await expect(card.locator('.tpl-msg.err')).toContainText('in use');
    // Still present, still in themes.json.
    await expect(page.locator('.tpl-card[data-key="bachelorette"]')).toBeVisible();
    const themes = JSON.parse(fs.readFileSync(THEMES, 'utf8'));
    expect(themes.bachelorette).toBeDefined();
  });

  test('create an EMPTY template shell, then upload one asset separately', async ({ page }) => {
    const slug = 'e2e-shell';
    await page.goto(`/admin-templates.html?key=${KEY}`);
    // Fill metadata only, then "create empty" (no files) — the way a heavy template
    // is added: register the shell, then upload each asset one at a time.
    await page.fill('#form input[name="slug"]', slug);
    await page.fill('#form input[name="display_he"]', 'ריק E2E');
    await page.fill('#form input[name="title_text"]', '{NAME}');
    await page.click('#createShell');

    // The shell appears in the list with its required assets MISSING.
    const card = page.locator(`.tpl-card[data-key="${slug}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('.asset[data-role="clean-fronts"]')).toHaveClass(/off/);

    // Upload ONE asset separately via the per-asset input — it lands (uncalibrated,
    // first-time add → no confirm needed).
    await card.locator('.asset[data-role="clean-fronts"] .repl-input').setInputFiles({
      name: 'fronts.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">e2e-shell</svg>'),
    });
    await expect(
      page.locator(`.tpl-card[data-key="${slug}"] .asset[data-role="clean-fronts"]`)
    ).toHaveClass(/on/);

    // Persisted to the FIXTURE themes.json (public, uncalibrated), files on disk.
    const themes = JSON.parse(fs.readFileSync(THEMES, 'utf8'));
    expect(themes[slug]).toBeDefined();
    expect(themes[slug].visibility).toBe('public');
    expect(themes[slug].calibrated).toBe(false);
    expect(fs.existsSync(path.join(TPL_DIR, slug, 'clean', 'fronts.svg'))).toBe(true);
  });

  test('calibrate a fresh shell: preview renders from the UNSAVED knobs, save flips calibrated:true', async ({
    page,
  }) => {
    const slug = 'e2e-cal';
    // Intercept the preview render (Chrome/Python heavy) — capture the request so
    // we can prove it carries the UNSAVED knobs, and return a fake image so the
    // panel displays something.
    const PNG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    let previewBody = null;
    await page.route('**/api/preview**', async (route) => {
      previewBody = route.request().postDataJSON();
      await route.fulfill({ json: { card: PNG, board: PNG } });
    });
    page.on('dialog', (d) => d.accept()); // the save confirm

    await page.goto(`/admin-templates.html?key=${KEY}`);
    // Register an uncalibrated shell.
    await page.fill('#form input[name="slug"]', slug);
    await page.fill('#form input[name="display_he"]', 'כיול E2E');
    await page.fill('#form input[name="title_text"]', '{NAME}');
    await page.click('#createShell');

    const card = page.locator(`.tpl-card[data-key="${slug}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('.tpl-badge.uncal')).toBeVisible(); // not yet calibrated
    const cal = card.locator('.tpl-cal');

    // Tweak title knobs + enable the board name slot with a position box.
    await cal.locator('[data-cal="ts.outline_w"]').fill('0.05');
    await cal.locator('[data-cal="ts.arch"]').fill('0.1');
    await cal.locator('[data-cal="board.enabled"]').check();
    await cal.locator('[data-cal="board.frac.x0"]').fill('0.02');
    await cal.locator('[data-cal="board.frac.y0"]').fill('0.88');
    await cal.locator('[data-cal="board.frac.x1"]').fill('0.14');
    await cal.locator('[data-cal="board.frac.y1"]').fill('0.98');

    // PREVIEW: renders with the unsaved knobs; the request body carries them.
    await cal.locator('.cal-preview-btn').click();
    await expect(cal.locator('.cal-preview img')).toHaveCount(2); // card + board
    expect(previewBody.theme).toBe(slug);
    expect(previewBody.name).toBeTruthy();
    expect(previewBody.calibration.title_style.outline_w).toBe(0.05);
    expect(previewBody.calibration.board.frac.x0).toBe(0.02);

    // SAVE + calibrate.
    await cal.locator('.cal-save-btn').click();

    // The list reloads: the "not calibrated" badge is gone and themes.json now
    // carries the title_style/board and calibrated:true.
    await expect(page.locator(`.tpl-card[data-key="${slug}"] .tpl-badge.uncal`)).toHaveCount(0);
    const themes = JSON.parse(fs.readFileSync(THEMES, 'utf8'));
    expect(themes[slug].calibrated).toBe(true);
    expect(themes[slug].title_style.outline_w).toBe(0.05);
    expect(themes[slug].title_style.arch).toBe(0.1);
    expect(themes[slug].board.frac.x0).toBe(0.02);
    expect(themes[slug].board.frac.y1).toBe(0.98);
  });
});
