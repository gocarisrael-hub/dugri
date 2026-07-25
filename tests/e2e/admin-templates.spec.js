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
});
