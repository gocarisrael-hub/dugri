import { test, expect } from '@playwright/test';

// The fullscreen zoom overlay lets a customer read the 8-card sheet up close.
// It clones the ALREADY-RENDERED active panel, so it always shows the current
// tab in the current colours; +/- buttons and double-tap drive the zoom (never
// pinch alone — the Instagram in-app browser is the primary audience), and
// ×/ESC/back all close it and restore body scroll + focus.

test.describe('fullscreen zoom overlay', () => {
  test('the ⤢ button opens it and it reflects the picked colour', async ({ page }) => {
    await page.goto('/options.html?step=2');
    // pick a non-original colour so we can prove the overlay reflects the live palette
    await page.getByTestId('color-3').click();
    const frontC0 = await page
      .getByTestId('preview-front')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--c0').trim());
    expect(frontC0).toMatch(/^#[0-9a-f]{6}$/i);

    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    await expect(page.locator('#zoomContent svg')).toBeVisible();

    // the overlay carries the SAME live --c0 as the preview it was cloned from
    const zoomC0 = await page
      .getByTestId('zoom-content')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--c0').trim());
    expect(zoomC0).toBe(frontC0);
  });

  test('tapping the sheet opens it; ＋ enlarges the rendered sheet', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();

    // tap the live sheet itself (top-start corner, clear of the ⤢ button)
    await page.getByTestId('preview-stage').click({ position: { x: 12, y: 12 } });
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();

    const widthOf = () =>
      page.locator('#zoomContent svg').evaluate((el) => el.getBoundingClientRect().width);
    const before = await widthOf();
    await page.getByTestId('zoom-in').click();
    await page.waitForTimeout(250); // width transition
    const after = await widthOf();
    expect(after).toBeGreaterThan(before + 5);
  });

  test('double-tap toggles the zoom scale', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();

    const zoomVar = () =>
      page
        .getByTestId('zoom-content')
        .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--zoom') || '1'));
    expect(await zoomVar()).toBe(1);

    // two quick taps (pointerup) on the viewport toggles zoom in
    const vp = page.getByTestId('zoom-viewport');
    await vp.dispatchEvent('pointerup');
    await page.waitForTimeout(80);
    await vp.dispatchEvent('pointerup');
    await expect.poll(async () => await zoomVar()).toBeGreaterThan(1);
  });

  test('× closes it, restoring body scroll and focus', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();

    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    await page.getByTestId('zoom-close').click();
    await expect(page.getByTestId('zoom-overlay')).toBeHidden();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    // focus returns to the opener
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'zoom-open'
    );
  });

  test('ESC closes it and restores body scroll', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('zoom-overlay')).toBeHidden();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  });

  test('the overlay shows the currently selected board tab', async ({ page }) => {
    await page.goto('/options.html');
    await page.getByTestId('tab-board').click();
    await expect(page.getByTestId('preview-board')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('preview-board').locator('svg')).toBeVisible();

    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    // the cloned artwork is present (from the board panel, the active tab)
    await expect(page.locator('#zoomContent svg')).toBeVisible();
  });

  test('tapping the COLLAPSED mini-preview (details step) does NOT open the overlay', async ({
    page,
  }) => {
    await page.goto('/options.html?step=4');
    await expect(page.getByTestId('preview')).toHaveClass(/is-collapsed/);
    // the ⤢ affordance is hidden here, and a stray tap on the reminder thumbnail
    // must be a no-op — not a jarring fullscreen zoom.
    const stage = page.getByTestId('preview-stage');
    await expect(stage).toBeVisible();
    await stage.click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('zoom-overlay')).toBeHidden();
  });

  test('a drag/pan is not misread as a double-tap', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();

    const zoomVar = () =>
      page
        .getByTestId('zoom-content')
        .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--zoom') || '1'));
    expect(await zoomVar()).toBe(1);

    // first a real tap (sets the double-tap timer)…
    const vp = page.getByTestId('zoom-viewport');
    await vp.dispatchEvent('pointerdown', { clientX: 120, clientY: 200 });
    await vp.dispatchEvent('pointerup', { clientX: 120, clientY: 200 });
    // …then, within the double-tap window, a DRAG (moved far). It must NOT toggle.
    await page.waitForTimeout(80);
    await vp.dispatchEvent('pointerdown', { clientX: 120, clientY: 200 });
    await vp.dispatchEvent('pointermove', { clientX: 260, clientY: 200 });
    await vp.dispatchEvent('pointerup', { clientX: 260, clientY: 200 });
    expect(await zoomVar()).toBe(1);
  });

  test('a horizontal swipe moves between views (front → back)', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    // opens on the front view
    await expect(page.getByTestId('zoom-tab-front')).toHaveAttribute('aria-selected', 'true');

    // swipe left (finger right→left) → the next view (back)
    const vp = page.getByTestId('zoom-viewport');
    await vp.dispatchEvent('pointerdown', { clientX: 320, clientY: 300 });
    await vp.dispatchEvent('pointerup', { clientX: 60, clientY: 300 });

    await expect(page.getByTestId('zoom-tab-back')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('zoom-tab-front')).toHaveAttribute('aria-selected', 'false');
    // the artwork for the new view is present
    await expect(page.locator('#zoomContent svg, #zoomContent img')).toBeVisible();
  });

  test('the viewport reserves horizontal for the swipe until zoomed in', async ({ page }) => {
    // On real iOS a viewport that keeps touch-action:pan-x lets the browser eat a
    // sideways drag as native panning, so the finger-swipe between views never
    // fires (Playwright's synthetic pointer events bypass this, so the swipe test
    // above passes even when real touch is broken). Guard the actual mechanism:
    // at rest the viewport must reserve horizontal (pan-y only), and only hand it
    // back to native panning once zoomed in.
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();

    const vp = page.getByTestId('zoom-viewport');
    const touchAction = () => vp.evaluate((el) => getComputedStyle(el).touchAction);
    // at rest (sheet fits, zoom = 1): horizontal is ours → pan-y only
    expect(await touchAction()).toBe('pan-y');
    // zoom in → the overflowing sheet needs native horizontal panning
    await page.getByTestId('zoom-in').click();
    expect(await touchAction()).toBe('pan-x pan-y');
  });
});

// The enlarge affordance is a small ICON-only button pinned in the TOP-LEFT
// corner of the live preview (no text label), and it opens the fullscreen view.
test.describe('enlarge icon (top-left, icon-only)', () => {
  test('is an icon-only button in the top-left corner and opens the overlay', async ({ page }) => {
    await page.goto('/options.html');
    const btn = page.getByTestId('zoom-open');
    await expect(btn).toBeVisible();

    // icon only — no visible text label, but a real accessible name (aria-label)
    await expect(btn).toHaveText('');
    const label = await btn.getAttribute('aria-label');
    expect(label && label.trim().length).toBeTruthy();

    // pinned in the TOP-LEFT corner of the preview stage
    const b = await btn.boundingBox();
    const stage = await page.getByTestId('preview-stage').boundingBox();
    expect(b).not.toBeNull();
    expect(stage).not.toBeNull();
    // near the stage's left edge and top edge (well within the top-left quadrant)
    expect(b.x).toBeLessThan(stage.x + stage.width / 2);
    expect(b.y).toBeLessThan(stage.y + stage.height / 2);
    expect(b.x - stage.x).toBeLessThan(40);
    expect(b.y - stage.y).toBeLessThan(40);

    await btn.click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
  });
});

// The enlarged view is a real swipeable carousel: dots (one per view) + swipe,
// consistent with the inline preview carousels. Dots stay in sync with the tabs
// and the finger-swipe, and tapping a dot changes the view.
test.describe('enlarged view carousel dots', () => {
  test('dots reflect the views and stay in sync with taps + swipe', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();

    // one dot per view (bachelorette ships front + back + board = 3), visible
    const dots = page.getByTestId('zoom-dots');
    await expect(dots).toBeVisible();
    await expect(dots.locator('.zoom-dot')).toHaveCount(3);
    // opens on the front view → front dot is the active one (dots are a
    // visual-only indicator marked with .is-active; #zoomTabs carries the a11y state)
    await expect(page.getByTestId('zoom-dot-front')).toHaveClass(/is-active/);

    // tapping a dot changes the view — the matching tab AND dot light up together
    await page.getByTestId('zoom-dot-board').click();
    await expect(page.getByTestId('zoom-tab-board')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('zoom-dot-board')).toHaveClass(/is-active/);
    await expect(page.getByTestId('zoom-dot-front')).not.toHaveClass(/is-active/);

    // a horizontal finger-swipe also drives the dots (board → back, one step back)
    const vp = page.getByTestId('zoom-viewport');
    await vp.dispatchEvent('pointerdown', { clientX: 60, clientY: 300 });
    await vp.dispatchEvent('pointerup', { clientX: 320, clientY: 300 });
    await expect(page.getByTestId('zoom-dot-back')).toHaveClass(/is-active/);
    await expect(page.getByTestId('zoom-tab-back')).toHaveAttribute('aria-selected', 'true');
  });
});

// The rotate-device hint is only meaningful on a touch device held in portrait.
test.describe('zoom rotate hint', () => {
  test('is not shown on desktop', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop-only check');
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    // fine-pointer / landscape desktop → no nonsense "rotate your device" hint
    await expect(page.getByTestId('zoom-hint')).toBeHidden();
  });
});

// OPTION C (enlarged overlay) — every enlarged view is a full-page LANDSCAPE sheet
// cloned into the same zoom-content box, so the board is ALREADY shown full-width,
// as large as the overlay allows (never a shrunk sliver) and equal to front/back.
// Lock that: the board view fills the zoom-content width and never overflows the
// screen, and switching front → board keeps front full-width (front unchanged).
test.describe('OPTION C — the enlarged board view fills the overlay width', () => {
  async function openZoom(page) {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
  }
  const zoomArt = (page) => page.locator('#zoomContent svg, #zoomContent img').first();

  test('the board view fills the zoom width and never overflows the viewport', async ({ page }) => {
    await openZoom(page);

    await page.getByTestId('zoom-tab-board').click();
    await expect(page.getByTestId('zoom-tab-board')).toHaveAttribute('aria-selected', 'true');
    const art = zoomArt(page);
    await expect(art).toBeVisible();

    const contentBox = await page.getByTestId('zoom-content').boundingBox();
    const artBox = await art.boundingBox();
    // the board art FILLS (≈) the full zoom-content width
    expect(artBox.width).toBeGreaterThanOrEqual(contentBox.width - 4);

    // and never wider than the screen (no horizontal overflow of the overlay)
    const innerW = await page.evaluate(() => window.innerWidth);
    expect(artBox.x).toBeGreaterThanOrEqual(-1);
    expect(artBox.x + artBox.width).toBeLessThanOrEqual(innerW + 1);
  });

  test('switching front → board keeps front full-width too (front unchanged)', async ({ page }) => {
    await openZoom(page);

    // front view (the overlay opens on front) fills the width
    await expect(zoomArt(page)).toBeVisible();
    const frontW = (await zoomArt(page).boundingBox()).width;

    // board view fills the same width — the board is never the small one
    await page.getByTestId('zoom-tab-board').click();
    await expect(page.getByTestId('zoom-tab-board')).toHaveAttribute('aria-selected', 'true');
    await expect(zoomArt(page)).toBeVisible();
    const boardW = (await zoomArt(page).boundingBox()).width;

    expect(boardW).toBeGreaterThanOrEqual(frontW - 4);
  });
});
