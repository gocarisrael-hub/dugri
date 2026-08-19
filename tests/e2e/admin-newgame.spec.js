import { test, expect } from '@playwright/test';

// The owner's "new game" editor (admin-newgame.html) and the home-page section it
// drives. Behind the admin key: the e2e server runs with ADMIN_KEY=dugri-admin and
// DATA_DIR=.e2e-data (throwaway), so writes here never touch real data.
const KEY = 'dugri-admin';

// This spec owns the ONLY writes to the shared `promo` settings key. Like
// admin-faq.spec.js, the tests that read or write that shared state run on ONE
// project — the device profiles run the same file CONCURRENTLY against a single
// server, so a save on the desktop would race a read on the phone. The pure
// client-side tests (the keyless page, the inline validation) run on both, since
// they never touch the server.
const ONLY = 'Desktop Chrome';

// A 1x1 PNG, uploaded through the real file input.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function resetPromo(request) {
  const r = await request.delete(`/api/admin/settings?section=promo&settingKey=block&key=${KEY}`);
  expect(r.ok()).toBeTruthy();
}

// Fill and save a live block from the admin page.
async function publish(page, { title, position = 'before' }) {
  await page.goto(`/admin-newgame.html?key=${KEY}`);
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#pTitle').fill(title);
  await page.locator('#pPosition').selectOption(position);
  await page.locator('#pEnabled').check();
  await page.locator('#savePromo').click();
  await expect(page.locator('#promoStatus')).toHaveClass(/ok/);
}

// Where the promo section sits among the page's <section>s, next to the rail.
async function order(page) {
  return page.evaluate(() => {
    const secs = [...document.querySelectorAll('section')];
    return {
      promo: secs.findIndex((s) => s.dataset.testid === 'home-promo'),
      rail: secs.findIndex((s) => s.id === 'products'),
    };
  });
}

test.describe('admin new-game editor', () => {
  test('without a key the page reveals nothing and asks for ?key=', async ({ page }) => {
    let hitAdmin = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/')) hitAdmin = true;
    });
    await page.goto('/admin-newgame.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    expect(hitAdmin).toBe(false);
  });

  test('the nav links here and carries the key', async ({ page }) => {
    await page.goto(`/admin-faq.html?key=${KEY}`);
    const link = page.locator('#nav a[data-page="admin-newgame.html"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', `admin-newgame.html?key=${KEY}`);
    await link.click();
    await expect(page.locator('#nav a.active[data-page="admin-newgame.html"]')).toHaveCount(1);
  });

  test('it opens switched off, with the form dimmed', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'reads shared promo state — one project only');
    await resetPromo(request);
    await page.goto(`/admin-newgame.html?key=${KEY}`);
    await expect(page.locator('#pEnabled')).not.toBeChecked();
    await expect(page.locator('#fields')).toHaveClass(/off/);
    await expect(page.locator('#pPosition')).toHaveValue('before');
    await expect(page.locator('#pBadge')).toHaveValue('חדש');
  });

  test('switching on without a title is refused before it reaches the server', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared promo state — one project only');
    await page.goto(`/admin-newgame.html?key=${KEY}`);
    await page.locator('#pTitle').fill('');
    await page.locator('#pEnabled').check();
    let posted = false;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/admin/settings')) posted = true;
    });
    await page.locator('#savePromo').click();
    await expect(page.locator('#promoStatus')).toHaveClass(/err/);
    await expect(page.locator('#promoStatus')).toContainText('כותרת');
    expect(posted).toBe(false);
  });

  test('a published section appears on the home page BEFORE the designs rail', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared promo state — one project only');
    await resetPromo(request);
    await publish(page, { title: 'משחק הזוגות' });

    await page.goto('/');
    const promo = page.locator('[data-testid="home-promo"]');
    await expect(promo).toBeVisible();
    await expect(promo.locator('h2')).toHaveText('משחק הזוגות');
    await expect(promo.locator('.promo-badge')).toHaveText('חדש');
    // Ordered before the rail.
    const at = await order(page);
    expect(at.promo).toBeGreaterThan(-1);
    expect(at.promo).toBeLessThan(at.rail);
    await resetPromo(request);
  });

  test('the position dropdown moves it below the rail', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared promo state — one project only');
    await resetPromo(request);
    await publish(page, { title: 'משחק הזוגות', position: 'after' });

    await page.goto('/');
    await expect(page.locator('[data-testid="home-promo"]')).toBeVisible();
    const at = await order(page);
    expect(at.promo).toBeGreaterThan(at.rail);
    await resetPromo(request);
  });

  test('switched off, the section is absent from the page entirely', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared promo state — one project only');
    await resetPromo(request);
    await publish(page, { title: 'משחק סודי' });

    // Turn it back off from the admin page.
    await page.goto(`/admin-newgame.html?key=${KEY}`);
    await expect(page.locator('#pTitle')).toHaveValue('משחק סודי');
    await page.locator('#pEnabled').uncheck();
    await page.locator('#savePromo').click();
    await expect(page.locator('#promoStatus')).toHaveClass(/ok/);

    await page.goto('/');
    await expect(page.locator('[data-testid="home-promo"]')).toHaveCount(0);
    // Off means off the wire, not merely hidden: the title must not be anywhere
    // in what the page received.
    expect(await page.content()).not.toContain('משחק סודי');
    await resetPromo(request);
  });

  test('an uploaded photo is saved with the block and rendered on the home page', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared promo state — one project only');
    await resetPromo(request);
    await page.goto(`/admin-newgame.html?key=${KEY}`);
    await page.locator('#photoFile').setInputFiles({
      name: 'card.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await expect(page.locator('#photos [data-photo]')).toHaveCount(1);
    await page.locator('#photos [data-alt]').fill('קלף לדוגמה');
    await page.locator('#pTitle').fill('משחק עם תמונה');
    await page.locator('#pEnabled').check();
    await page.locator('#savePromo').click();
    await expect(page.locator('#promoStatus')).toHaveClass(/ok/);

    await page.goto('/');
    const img = page.locator('[data-testid="home-promo"] .promo-photos img');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('alt', 'קלף לדוגמה');
    await expect(img).toHaveAttribute('src', /^\/content-uploads\//);
    await expect(page.locator('[data-testid="home-promo"] .promo-photos')).toHaveAttribute(
      'data-count',
      '1'
    );
    await resetPromo(request);
  });
});
