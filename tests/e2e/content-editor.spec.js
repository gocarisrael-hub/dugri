import { test, expect } from '@playwright/test';

// E2E for the inline content editor (site/js/editor.js + the server routes).
// Overrides are mocked at the network layer so these tests are isolated from the
// server's on-disk store: we assert the ENGINE renders overrides for every
// visitor, and that edit mode posts the right payloads back.

test.describe('content overrides render for all visitors', () => {
  test('a mocked /api/content override replaces the shipped text on a real page', async ({
    page,
  }) => {
    await page.route('**/api/content*', (route) =>
      route.fulfill({ json: { overrides: { 'index-faq-heading': { text: 'שאלות מהבדיקה' } } } })
    );

    await page.goto('/index.html');

    // The tagged node shows the override, not the shipped default…
    await expect(page.locator('[data-edit="index-faq-heading"]')).toHaveText('שאלות מהבדיקה');
    // …and a normal visitor gets NO edit affordances (fail-closed).
    await expect(page.locator('.dugri-editbar')).toHaveCount(0);
  });
});

test.describe('edit mode (owner: ?edit=1 + admin key)', () => {
  test('editing a text node blurs a POST with the right page/key/text', async ({ page }) => {
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    // Resolve the captured body from INSIDE the route handler so the assertion
    // never races the handler (waitForRequest can fire before it runs).
    let resolveBody;
    const bodyPromise = new Promise((resolve) => (resolveBody = resolve));
    await page.route('**/api/admin/content*', (route) => {
      if (route.request().method() === 'POST') resolveBody(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto('/index.html?edit=1&key=dugri-admin');

    // The floating RTL toolbar appears and the tagged node becomes editable.
    await expect(page.getByText('מצב עריכה')).toBeVisible();
    const heading = page.locator('[data-edit="index-faq-heading"]');
    await expect(heading).toHaveAttribute('contenteditable', /plaintext-only|true/);

    await heading.evaluate((node) => {
      node.focus();
      node.textContent = 'כותרת חדשה מהבדיקה';
      node.dispatchEvent(new Event('blur'));
    });

    expect(await bodyPromise).toEqual({
      page: 'index.html',
      key: 'index-faq-heading',
      text: 'כותרת חדשה מהבדיקה',
    });
    // The toolbar confirms the save.
    await expect(page.locator('.dugri-editbar__status')).toHaveText('נשמר');
  });

  test('clicking an editable link in edit mode edits it instead of navigating away', async ({
    page,
  }) => {
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
    await page.goto('/index.html?edit=1&key=dugri-admin');
    await expect(page.getByText('מצב עריכה')).toBeVisible();

    // The hero CTA is a real <a href="products.html">. In edit mode a click must
    // place the caret to edit its label, NOT follow the link — otherwise the owner
    // can never edit an interactive element's text. (Regression guard: without the
    // capture-phase preventDefault this navigates to products.html.)
    const cta = page.locator('[data-edit="index-hero-cta-1"]');
    await expect(cta).toHaveAttribute('contenteditable', /plaintext-only|true/);
    await cta.evaluate((node) => node.click());

    await expect(page).toHaveURL(/index\.html/); // did not navigate to products.html
    await expect(cta).toBeFocused(); // focused for editing instead
  });

  test("an editable element's OWN page click handler is suppressed in edit mode", async ({
    page,
  }) => {
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    // Register a page-level click handler on a [data-edit] element BEFORE editor.js
    // bootstraps — exactly how collect.html binds #closeBtn.onclick at load. The
    // guard must beat this even though the page handler is registered first (at the
    // target node listeners fire in registration order, so only a document-level
    // capture guard wins). Without the fix, clicking to edit the label re-fires the
    // page handler (on collect.html: finalizes the order).
    await page.addInitScript(() => {
      window.__ownHandlerFired = false;
      document.addEventListener('DOMContentLoaded', () => {
        const el = document.querySelector('[data-edit="index-hero-cta-1"]');
        if (el)
          el.addEventListener('click', () => {
            window.__ownHandlerFired = true;
          });
      });
    });

    await page.goto('/index.html?edit=1&key=dugri-admin');
    await expect(page.getByText('מצב עריכה')).toBeVisible();

    const cta = page.locator('[data-edit="index-hero-cta-1"]');
    await cta.evaluate((node) => node.click());

    expect(await page.evaluate(() => window.__ownHandlerFired)).toBe(false);
    await expect(page).toHaveURL(/index\.html/); // and no navigation
  });

  test('an uploaded .svg name is never served (stored-XSS guard)', async ({ page }) => {
    // SVG is dropped from the upload allowlist AND from the serve-route regex, so a
    // .svg content-uploads URL must 404 regardless of any file on disk.
    const res = await page.request.get('/content-uploads/aaaaaaaaaaaaaaaa.svg');
    expect(res.status()).toBe(404);
  });

  test('replacing a photo posts the image and swaps in the returned src', async ({ page }) => {
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));

    const returnedImg = '/content-uploads/1234567890abcdef.png';
    let imagePosted = false;
    await page.route('**/api/admin/content/image*', (route) => {
      imagePosted = route.request().method() === 'POST';
      return route.fulfill({ json: { ok: true, img: returnedImg } });
    });

    await page.goto('/index.html?edit=1&key=dugri-admin');

    // Target the REAL review photo (the carousel injects aria-hidden clone
    // slides; the clone marker sits on the parent .review figure, not the img).
    const img = page.locator('.review:not([data-carousel-clone]) [data-edit-img="index-review-1"]');
    await expect(img).toHaveAttribute('role', 'button'); // edit affordance applied

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      img.evaluate((node) => node.click()),
    ]);
    await chooser.setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: pngBytes });

    await expect(img).toHaveAttribute('src', returnedImg);
    expect(imagePosted).toBe(true);
  });
});
