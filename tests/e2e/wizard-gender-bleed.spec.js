import { test, expect } from '@playwright/test';

// Covers two order-wizard additions:
//  1. a REQUIRED gender choice on the honoree-name step, sent as `gender` in the
//     POST /api/collections payload (exactly 'female' | 'male' — no default:
//     nothing is pre-selected and a choice is required to advance);
//  2. the card preview showing a real printed-background "bleed" around the card.

async function toNameStep(page) {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  // steps 1-3 have safe defaults -> Next straight through to the name step.
  await page.getByTestId('next-btn').click(); // -> step 2
  await page.getByTestId('next-btn').click(); // -> step 3
  await page.getByTestId('next-btn').click(); // -> step 4 (name)
  await expect(page.getByTestId('step-4')).toBeVisible();
}

// Intercept the create call so no real collection is written; return the
// captured request body.
function captureCollectionPost(page) {
  const captured = {};
  return page
    .route('**/api/collections', async (route) => {
      captured.body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'test-col', owner_token: 'test-tok' }),
      });
    })
    .then(() => captured);
}

test.describe('honoree gender', () => {
  test('gender control exists with nothing pre-selected', async ({ page }) => {
    await toNameStep(page);
    await expect(page.getByTestId('gender-group')).toBeVisible();
    // no default: neither option is checked until the user actively picks one
    await expect(page.getByTestId('gender-female')).not.toBeChecked();
    await expect(page.getByTestId('gender-male')).not.toBeChecked();
  });

  test('advancing without a gender is blocked and prompts a choice', async ({ page }) => {
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('שירה');
    // name is set but no gender picked -> Next must not advance...
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await expect(page.getByTestId('step-5')).not.toBeVisible();
    // ...and a prompt tells the user to choose.
    await expect(page.getByTestId('gender-modal')).toBeVisible();

    // dismissing then picking a gender lets the wizard advance.
    await page.getByTestId('gender-modal-ok').click();
    await expect(page.getByTestId('gender-modal')).toBeHidden();
    await page.getByTestId('gender-female').check();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-5')).toBeVisible();
  });

  test('choosing female is sent in the create payload', async ({ page }) => {
    const captured = await captureCollectionPost(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('שירה');
    await page.getByTestId('gender-female').check();
    await expect(page.getByTestId('gender-female')).toBeChecked();
    await page.getByTestId('next-btn').click(); // -> step 5 (contact)
    await page.getByTestId('owner-email').fill('a@b.com');
    await page.getByTestId('owner-phone').fill('0521234567');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => captured.body && captured.body.gender).toBe('female');
    expect(captured.body.honoree_name).toBe('שירה');
  });

  test('choosing male is sent in the create payload', async ({ page }) => {
    const captured = await captureCollectionPost(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('דני');
    await page.getByTestId('gender-male').check();
    await expect(page.getByTestId('gender-male')).toBeChecked();
    await page.getByTestId('next-btn').click(); // -> step 5
    await page.getByTestId('owner-email').fill('a@b.com');
    await page.getByTestId('owner-phone').fill('0521234567');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => captured.body && captured.body.gender).toBe('male');
  });
});

test.describe('card preview bleed', () => {
  test('active preview shows a background bleed margin around the card', async ({ page }) => {
    await page.goto('/options.html?plan=base');
    const front = page.getByTestId('preview-front');
    await expect(front.locator('svg')).toBeVisible();
    const style = await front.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        bleed: cs.getPropertyValue('--bleed').trim(),
        padTop: parseFloat(cs.paddingTop),
        bg: cs.backgroundColor,
      };
    });
    // a real colour is exposed as the printed bleed...
    expect(style.bleed).toMatch(/^#[0-9a-f]{6}$/i);
    // ...and it paints a visible margin around the card.
    expect(style.padTop).toBeGreaterThan(10);
    expect(style.bg).not.toBe('rgba(0, 0, 0, 0)');
  });
});
