import { test, expect } from '@playwright/test';

// Order wizard e2e: a single page with five stepped screens (design -> color ->
// add-ons -> name -> contact). Steps show/hide via JS; Back/Next + ?step=N drive
// navigation. Runs on every configured project (desktop + mobile).

test.describe('order wizard', () => {
  test('preview + design + color recolor work across the first steps', async ({ page }) => {
    await page.goto('/options.html?plan=base');

    // Step 1 is the design step: preview visible, plan price reflects base.
    await expect(page.getByTestId('preview')).toBeVisible();
    await expect(page.getByTestId('plan-price')).toHaveText('79');
    await expect(page.getByTestId('step-1')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('1');
    // On the first step Back is hidden and Next reads "הבא".
    await expect(page.getByTestId('back-btn')).toHaveClass(/is-hidden/);
    await expect(page.getByTestId('next-btn')).toHaveText('הבא');

    const designs = page.getByTestId('design-list').locator('.design');
    await expect(designs.nth(1)).toBeVisible();
    const frontPanel = page.getByTestId('preview-front');
    await expect(frontPanel.locator('svg')).toBeVisible();

    // Helper: read --c0 of the front preview's svg (or its computed fill).
    const readC0 = async () =>
      frontPanel
        .locator('svg')
        .first()
        .evaluate((svg) => {
          const v = getComputedStyle(svg).getPropertyValue('--c0').trim();
          return v || getComputedStyle(svg).fill;
        });
    const before = await readC0();

    // Pick the second design on step 1.
    await page.getByTestId('design-1').click();
    await expect(page.getByTestId('design-1')).toHaveAttribute('aria-pressed', 'true');

    // Advance to the color step; Back is now available.
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('back-btn')).not.toHaveClass(/is-hidden/);

    const colors = page.getByTestId('color-list').locator('.swatch');
    await expect(colors.first()).toBeVisible();
    const swatchCount = await colors.count();
    const colorIdx = swatchCount > 1 ? 1 : 0;
    await page.getByTestId('color-' + colorIdx).click();
    await expect(page.getByTestId('color-' + colorIdx)).toHaveAttribute('aria-pressed', 'true');

    // The front preview's --c0 (or fill) changed from its initial value.
    await expect.poll(async () => readC0()).not.toBe(before);

    // The board tab recolors too (the preview is live on steps 1-3).
    await page.getByTestId('tab-board').click();
    const boardPanel = page.getByTestId('preview-board');
    await expect(boardPanel).toHaveAttribute('data-active', 'true');
    const boardC0 = await boardPanel
      .locator('svg')
      .first()
      .evaluate((svg) => getComputedStyle(svg).getPropertyValue('--c0').trim());
    expect(boardC0.length).toBeGreaterThan(0);

    // Selection + step are persisted to the URL.
    expect(page.url()).toContain('plan=base');
    expect(page.url()).toContain('step=2');
  });

  test('front and back previews paint their original background (never transparent/black)', async ({
    page,
  }) => {
    await page.goto('/options.html');

    // Computed fill of the largest painted element in a panel's SVG — the card's
    // designed background. (Elements inside <defs>/<clipPath> are not rendered.)
    const bgFill = async (panel) =>
      page
        .getByTestId('preview-' + panel)
        .locator('svg')
        .first()
        .evaluate((svg) => {
          let best = null;
          let bestArea = -1;
          for (const el of svg.querySelectorAll('path,rect,circle,polygon')) {
            if (el.closest('defs') || el.closest('clipPath') || el.closest('mask')) continue;
            const cs = getComputedStyle(el);
            if (cs.fill === 'none') continue;
            let area = 0;
            try {
              const b = el.getBBox();
              area = b.width * b.height;
            } catch {
              /* not measurable */
            }
            if (area > bestArea) {
              bestArea = area;
              best = cs.fill;
            }
          }
          return best;
        });

    // A real, visible paint: not missing, not fully transparent, and not the
    // black/unpainted state you get when a var() background fails to resolve.
    const isPainted = (fill) =>
      typeof fill === 'string' &&
      fill !== '' &&
      fill !== 'none' &&
      !/rgba\([^)]*,\s*0\s*\)/.test(fill) &&
      fill !== 'rgb(0, 0, 0)' &&
      fill !== 'transparent';

    await expect(page.getByTestId('preview-front').locator('svg')).toBeVisible();
    const frontOrig = await bgFill('front');
    expect(isPainted(frontOrig), `front original background fill: ${frontOrig}`).toBe(true);

    await page.getByTestId('tab-back').click();
    await expect(page.getByTestId('preview-back')).toHaveAttribute('data-active', 'true');
    const backOrig = await bgFill('back');
    expect(isPainted(backOrig), `back original background fill: ${backOrig}`).toBe(true);

    // Regression guard for the fix: the background is driven via a CSS `fill`
    // rule whose var() carries the design's ORIGINAL anchor as a fallback, so
    // even if the live --cN palette is missing (e.g. an engine that can't resolve
    // var() in SVG presentation attributes) the original background still paints.
    await page.getByTestId('tab-front').click();
    const frontFallback = await page
      .getByTestId('preview-front')
      .locator('svg')
      .first()
      .evaluate((svg) => {
        // Strip the live palette vars from every ancestor -> var(--cN) is unset.
        for (let n = svg; n; n = n.parentElement) {
          if (n.style) for (let i = 0; i < 8; i++) n.style.removeProperty('--c' + i);
        }
        let best = null;
        let bestArea = -1;
        for (const el of svg.querySelectorAll('path,rect,circle,polygon')) {
          if (el.closest('defs') || el.closest('clipPath') || el.closest('mask')) continue;
          const cs = getComputedStyle(el);
          if (cs.fill === 'none') continue;
          let area = 0;
          try {
            const b = el.getBBox();
            area = b.width * b.height;
          } catch {
            /* not measurable */
          }
          if (area > bestArea) {
            bestArea = area;
            best = cs.fill;
          }
        }
        return best;
      });
    expect(isPainted(frontFallback), `front fallback background fill: ${frontFallback}`).toBe(true);
  });

  test('defaults advance through design, color and add-ons', async ({ page }) => {
    await page.goto('/options.html');
    for (const s of [1, 2, 3]) {
      await expect(page.getByTestId('step-' + s)).toBeVisible();
      await expect(page.getByTestId('next-btn')).toBeEnabled();
      await page.getByTestId('next-btn').click();
    }
    // Lands on the name step.
    await expect(page.getByTestId('step-4')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('4');
  });

  test('step 4 blocks Next until a name is entered', async ({ page }) => {
    await page.goto('/options.html?step=4'); // deep-link straight to the name step
    await expect(page.getByTestId('step-4')).toBeVisible();
    await expect(page.getByTestId('next-btn')).toBeDisabled();
    await expect(page.getByTestId('step-4')).toContainText('יופיע על הקלפים');
    await page.fill('#honoreeInput', 'שירה');
    await expect(page.getByTestId('next-btn')).toBeEnabled();
  });

  test('step 5 validates email + phone, then creates the collection', async ({ page }) => {
    await page.goto('/options.html?step=4');
    await page.fill('#honoreeInput', 'שירה');
    await page.getByTestId('gender-female').check(); // gender is required to advance
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-5')).toBeVisible();

    // The preview collapses to a summary chip on the contact step.
    await expect(page.getByTestId('continue-summary')).toBeVisible();
    await expect(page.getByTestId('continue-summary')).toContainText('עיצוב');

    // Final button is "צרו את המשחק" and starts disabled (no contact yet).
    const create = page.getByTestId('next-btn');
    await expect(create).toHaveText('צרו את המשחק');
    await expect(create).toBeDisabled();

    // Bad email -> inline email error, still disabled.
    await page.fill('#ownerEmail', 'not-an-email');
    await expect(page.getByTestId('email-err')).toBeVisible();
    await expect(create).toBeDisabled();

    // Valid email, bad phone -> phone error.
    await page.fill('#ownerEmail', 'owner@example.com');
    await expect(page.getByTestId('email-err')).toBeHidden();
    await page.fill('#ownerPhone', '12345');
    await expect(page.getByTestId('phone-err')).toBeVisible();
    await expect(create).toBeDisabled();

    // Valid email + valid IL mobile -> enabled, creates the collection, redirects.
    await page.fill('#ownerPhone', '0521234567');
    await expect(page.getByTestId('phone-err')).toBeHidden();
    await expect(create).toBeEnabled();
    await create.click();
    await page.waitForURL(/collect\.html\?c=.+&k=.+/);
    await expect(page.locator('#title')).toContainText('שירה');
  });

  test('Back returns to a prior step and progress reflects position', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.getByTestId('step-now')).toHaveText('1');
    await page.getByTestId('next-btn').click();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('3');

    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('2');
  });

  test('browser Back/Forward walks the wizard via history', async ({ page }) => {
    await page.goto('/options.html');
    await page.getByTestId('next-btn').click(); // -> 2
    await page.getByTestId('next-btn').click(); // -> 3
    await expect(page.getByTestId('step-3')).toBeVisible();

    await page.goBack();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page).toHaveURL(/step=2/);

    await page.goBack();
    await expect(page.getByTestId('step-1')).toBeVisible();

    await page.goForward();
    await expect(page.getByTestId('step-2')).toBeVisible();
  });

  test('chasers add-on toggles in step 3, persists to the URL and survives reload', async ({
    page,
  }) => {
    await page.goto('/options.html');
    await page.getByTestId('next-btn').click(); // -> 2
    await page.getByTestId('next-btn').click(); // -> 3

    const toggle = page.getByTestId('chasers-toggle');
    const card = page.getByTestId('chasers-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText("הוסיפו צ'ייסרים למשחק");
    await expect(card).toContainText('נכלל בחינם');

    // default OFF
    await expect(toggle).not.toBeChecked();
    expect(page.url()).not.toContain('chasers=');

    // turn it on -> &chasers=1 lands in the URL and the card highlights
    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect.poll(() => page.url()).toContain('chasers=1');
    await expect(card).toHaveClass(/is-on/);

    // survives a reload: restored to step 3 with the add-on on
    await page.reload();
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('chasers-toggle')).toBeChecked();

    // turning it off removes the param again
    await page.getByTestId('chasers-toggle').uncheck();
    await expect.poll(() => page.url()).not.toContain('chasers=1');
  });

  test('a slider theme keeps the colour picker and notes that photos stay fixed', async ({
    page,
  }) => {
    await page.goto('/options.html');
    // the default design (bachelorette) is a slider whose board embeds a photo.
    await page.getByTestId('next-btn').click(); // -> colour step
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('color-list')).toBeVisible();
    const note = page.getByTestId('raster-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('קבוע');
  });

  test('neon is FIXED: the colour picker is hidden and its colours never change', async ({
    page,
  }) => {
    await page.goto('/options.html');
    const neonTile = page.locator('.design[data-design-id="neon"]');
    await expect(neonTile).toBeVisible();
    await neonTile.click();

    const frontSvg = page.getByTestId('preview-front').locator('svg').first();
    await expect(frontSvg).toBeVisible();
    const readC0 = () =>
      frontSvg.evaluate((svg) => getComputedStyle(svg).getPropertyValue('--c0').trim());
    const before = await readC0();

    // Its SVG carries NO var(--cN) recolor tokens — it's baked at original colours.
    const hasTokens = await frontSvg.evaluate((svg) => svg.outerHTML.includes('var(--c'));
    expect(hasTokens).toBe(false);

    // On the colour step the swatch picker is hidden and a fixed-colour note shows.
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('color-list')).toBeHidden();
    await expect(page.getByTestId('raster-note')).toBeVisible();
    await expect(page.getByTestId('raster-note')).toContainText('קבוע');

    // There is no picker to change the colours, so they stay put.
    expect(await readC0()).toBe(before);
  });

  test('selecting neon after a slider switches the page accent to neon (not stale)', async ({
    page,
  }) => {
    await page.goto('/options.html');
    const accent = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      );
    const bg = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--cfg-bg').trim()
      );

    // Pick a slider design + a vivid main colour so the page turns that colour.
    await page.locator('.design[data-design-id="bachelorette"]').click();
    await page.getByTestId('next-btn').click(); // colour step
    await page.getByTestId('color-1').click(); // some slider colour
    const sliderAccent = await accent();
    const sliderBg = await bg();
    expect(sliderAccent).toMatch(/^#|rgb/);

    // Now switch to neon (fixed). Its OWN accent/bg must take over — not the stale
    // slider tint (the regression: empty anchors made recolor() bail before the
    // page theme was set).
    await page.getByTestId('back-btn').click();
    await page.locator('.design[data-design-id="neon"]').click();
    await expect.poll(accent).not.toBe(sliderAccent);
    await expect.poll(bg).not.toBe(sliderBg);
    // and it matches neon's manifest accent (#ff00db)
    expect((await accent()).toLowerCase()).toBe('#ff00db');
  });

  test('design tiles use lightweight <img> thumbnails, not inlined full-page SVGs', async ({
    page,
  }) => {
    await page.goto('/options.html?step=1');
    await expect(page.locator('.design').first()).toBeVisible();
    const c = await page.evaluate(() => ({
      tiles: document.querySelectorAll('.design').length,
      imgs: document.querySelectorAll('.design .thumb img').length,
      svgs: document.querySelectorAll('.design .thumb svg').length,
    }));
    expect(c.tiles).toBeGreaterThan(0);
    // every tile is a small raster thumbnail; none inline a heavy full-page SVG.
    expect(c.imgs).toBe(c.tiles);
    expect(c.svgs).toBe(0);
    await expect(page.locator('.design .thumb img').first()).toHaveAttribute('src', /thumb\.webp$/);
  });

  test('a fast design A→B switch never lets A stale-write into the shared preview', async ({
    page,
  }) => {
    // Serve sentinel front SVGs so we can tell designs apart, and DELAY design A
    // (marriage) so its multi-MB-style fetch resolves AFTER we've switched to B.
    await page.route('**/assets/designs/*/front.svg', async (route) => {
      const id = route
        .request()
        .url()
        .match(/designs\/([^/]+)\/front/)[1];
      if (id === 'marriage') await new Promise((r) => setTimeout(r, 700));
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 841.92 595.5" data-design="${id}"><rect width="100%" height="100%" fill="#eee"/></svg>`,
      });
    });
    await page.goto('/options.html?step=1');
    await expect(page.getByTestId('preview-front').locator('svg')).toBeVisible();

    // Click A (marriage, slow) then immediately B (birthday, fast).
    await page.locator('.design[data-design-id="marriage"]').click();
    await page.locator('.design[data-design-id="birthday"]').click();

    // Wait well past A's delay so its late resolve has fired.
    await page.waitForTimeout(1100);

    // The panel must show B (birthday), NOT A's late artwork.
    const shown = await page.locator('[data-panel="front"] svg').getAttribute('data-design');
    expect(shown).toBe('birthday');
    await expect(page.locator('.design[data-design-id="birthday"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});
