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

  test('raster-background note shows only for the kids design (on the color step)', async ({
    page,
  }) => {
    await page.goto('/options.html');
    const note = page.getByTestId('raster-note');
    const kidsTile = page.locator('.design[data-design-id="kids"]');
    const birthdayTile = page.locator('.design[data-design-id="birthday"]');
    await expect(kidsTile).toBeVisible();

    // Selecting kids on step 1 then advancing reveals the fixed-background note.
    await kidsTile.click();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(note).toBeVisible();
    await expect(note).toContainText('הרקע בעיצוב זה קבוע');

    // A vector-only design hides it again.
    await page.getByTestId('back-btn').click();
    await birthdayTile.click();
    await page.getByTestId('next-btn').click();
    await expect(note).toBeHidden();
  });
});
