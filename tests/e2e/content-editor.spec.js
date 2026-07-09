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

  test('an editable <summary>/<details> is reachable, stays open, and accepts spaces', async ({
    page,
  }) => {
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
    await page.route('**/api/admin/content*', (route) => route.fulfill({ json: { ok: true } }));
    await page.goto('/index.html?edit=1&key=dugri-admin');
    await expect(page.getByText('מצב עריכה')).toBeVisible();

    // FAQ answers live inside a normally-CLOSED <details>. In edit mode every
    // <details> is FORCED OPEN so its editable answer is reachable, and it must
    // stay open — clicking the <summary> to edit the question must neither collapse
    // the panel (native toggle) nor swallow spaces (native Space = activate).
    const summary = page.locator('[data-edit="index-faq-q1"]');
    const answer = page.locator('[data-edit="index-faq-a1"]');
    const details = page.locator('details', { has: summary });

    expect(await details.evaluate((d) => d.open)).toBe(true); // forced open
    await expect(answer).toBeVisible(); // reachable → editable
    await expect(answer).toHaveAttribute('contenteditable', /plaintext-only|true/);

    await summary.click(); // does not toggle the <details> shut
    expect(await details.evaluate((d) => d.open)).toBe(true);
    await expect(summary).toBeFocused();

    // Replace the label with text that CONTAINS SPACES; the space must be inserted,
    // not consumed by the native summary activation, and the panel must stay open.
    await summary.evaluate((node) => {
      const r = document.createRange();
      r.selectNodeContents(node);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });
    await page.keyboard.type('שאלה חדשה כאן');
    await expect(summary).toHaveText('שאלה חדשה כאן');
    expect(await details.evaluate((d) => d.open)).toBe(true);
  });

  test('Enter commits an editable text node (saves, no newline) rather than inserting a line break', async ({
    page,
  }) => {
    const posts = [];
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
    await page.route('**/api/admin/content*', (route) => {
      if (route.request().method() === 'POST') posts.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/index.html?edit=1&key=dugri-admin');
    await expect(page.getByText('מצב עריכה')).toBeVisible();

    // Overrides are single-run plain text; a newline would save but collapse to a
    // space on reload, silently dropping the break. Enter must COMMIT (blur→save),
    // and the saved text must carry no '\n'.
    const ans = page.locator('[data-edit="index-faq-a1"]');
    await ans.click();
    await ans.evaluate((n) => {
      const r = document.createRange();
      r.selectNodeContents(n);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });
    await page.keyboard.type('תשובה חדשה');
    await page.keyboard.press('Enter');

    await expect.poll(() => posts.length).toBeGreaterThan(0);
    const saved = posts[posts.length - 1];
    expect(saved.key).toBe('index-faq-a1');
    expect(saved.text).toBe('תשובה חדשה'); // exactly, no trailing newline
    expect(saved.text).not.toContain('\n');
    await expect(ans).not.toBeFocused(); // Enter blurred → committed
  });

  test('Space types into an interactive label even via programmatic focus (caret recovery)', async ({
    page,
  }) => {
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
    await page.route('**/api/admin/content*', (route) => route.fulfill({ json: { ok: true } }));
    await page.goto('/index.html?edit=1&key=dugri-admin');
    await expect(page.getByText('מצב עריכה')).toBeVisible();

    // Focus the CTA link WITHOUT a mouse click, so no caret is placed inside it —
    // ensureCaretIn must recover by dropping a caret at the end before inserting.
    const cta = page.locator('[data-edit="index-hero-cta-1"]');
    const before = await cta.textContent();
    await cta.evaluate((node) => node.focus());
    await page.keyboard.press('Space');
    const after = await cta.textContent();
    // A space was inserted INTO this label (not dropped, not sent elsewhere).
    expect(after.length).toBe(before.length + 1);
    expect(after).toContain(' ');
  });

  test('a newline INTENT (beforeinput) commits instead of inserting a break — robust on mobile/IME', async ({
    page,
  }) => {
    const posts = [];
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
    await page.route('**/api/admin/content*', (route) => {
      if (route.request().method() === 'POST') posts.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/index.html?edit=1&key=dugri-admin');
    await expect(page.getByText('מצב עריכה')).toBeVisible();

    const ans = page.locator('[data-edit="index-faq-a1"]');
    await ans.click();
    await ans.evaluate((n) => {
      n.textContent = 'תוכן ערוך';
      // Dispatch the SAME signal a mobile/IME Return produces (keydown there does
      // not report e.key 'Enter'); the beforeinput guard must catch it and commit.
      n.dispatchEvent(
        new window.InputEvent('beforeinput', {
          inputType: 'insertParagraph',
          bubbles: true,
          cancelable: true,
        })
      );
    });

    await expect.poll(() => posts.length).toBeGreaterThan(0);
    expect(posts[posts.length - 1].text).toBe('תוכן ערוך');
    expect(posts[posts.length - 1].text).not.toContain('\n');
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
