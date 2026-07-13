import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The template status/edit center is behind the admin key. The e2e server runs
// against the REAL repo (TEMPLATE_ROOT defaults to the repo root) with
// ADMIN_KEY=dugri-admin. Read-only checks run on every device project; the
// MUTATING checks (rename + replace) run on a SINGLE project and restore the
// touched files in a finally block, so the real themes.json / resources are left
// exactly as they were. Mutations target 'bachelorette'; read-only assertions
// target 'anniversary' so the two never overlap across concurrent projects.
const KEY = 'dugri-admin';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const THEMES = path.join(REPO, 'generator', 'themes.json');
const TPL_DIR = path.join(REPO, 'resources', 'canva', 'templates');
const ONLY = 'Desktop Chrome'; // the one project that performs mutations

// Restore a file atomically (temp + rename) so the live server — which reads
// themes.json fresh on each request — never observes a half-written file.
function restoreAtomic(file, bytes) {
  const tmp = file + '.e2e-restore-' + process.pid;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

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
    // anniversary (never mutated) ships without a chasers board and with its core
    // assets present.
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
  });

  test('without a key the page shows the access-key notice', async ({ page }) => {
    await page.goto('/admin-templates.html');
    await expect(page.locator('#tpl-list')).toContainText('מפתח גישה');
  });
});

test.describe('admin templates — mutations (single project, restores state)', () => {
  test.describe.configure({ mode: 'serial' });
  // Run the mutating tests on ONE project only — skipped BEFORE the browser page
  // fixture is created on the others, so the full 3-device matrix never launches
  // three concurrent browsers here (and only one project ever writes the file).
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'mutating test runs on one project only');
  });

  test('rename works through the UI and keeps the slug stable', async ({ page }) => {
    const original = fs.readFileSync(THEMES);
    try {
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

      // Persisted to themes.json; the slug/identity is untouched.
      const themes = JSON.parse(fs.readFileSync(THEMES, 'utf8'));
      expect(themes.bachelorette.display_he).toBe('שם מבחן E2E');
      expect(themes.bachelorette.slug).toBe('bachelorette');
    } finally {
      restoreAtomic(THEMES, original);
    }
  });

  test('replacing the missing chasers board through the UI marks it present', async ({ page }) => {
    const created = path.join(TPL_DIR, 'bachelorette', 'clean', 'board-chasers.svg');
    try {
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

      // The list reloads: the chasers-board row is now present (✓) and the file
      // landed at the exact path the generator reads.
      const now = page.locator(
        '.tpl-card[data-key="bachelorette"] .asset[data-role="clean-board-chasers"]'
      );
      await expect(now).toHaveClass(/on/);
      await expect(now.locator('.mark')).toHaveText('✓');
      expect(fs.existsSync(created)).toBe(true);
    } finally {
      if (fs.existsSync(created)) fs.rmSync(created);
    }
  });
});
