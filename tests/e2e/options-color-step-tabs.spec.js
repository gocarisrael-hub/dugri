import { test, expect } from '@playwright/test';
import { stubFeatures } from './feature-flags.js';

// The shared preview card above the wizard carries three face tabs
// (קלף / גב / לוח → tab-front / tab-back / tab-board). The COLOUR step (the stable
// data-step id 2) shows its own swipeable colour-carousel preview, which makes
// those tabs redundant THERE — but only when the carousel is actually shown. So
// they are hidden on the colour step when colour picking is on, and stay visible
// on the design step (step 1). Steps 3/4 collapse the preview and hide the tabs
// via the existing .is-collapsed rule, which is out of scope here.
//
// goStep adds body.is-step-color exactly when currentStep === 2 AND
// FEATURES.color_picking is on. That AND matters: when colour is off but chasers
// is on, step 2 is still active yet the carousel is hidden, so the tabs must STAY
// so the buyer can switch faces (covered by the last test here). Detection keys on
// the literal data-step id 2, so renumbering the step means updating goStep too.

// A 1x1 transparent PNG so the (unused) name-preview render never hits the network.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function mockPreview(page) {
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      }),
    })
  );
}

async function expectTabsVisible(page) {
  await expect(page.getByTestId('tab-front')).toBeVisible();
  await expect(page.getByTestId('tab-back')).toBeVisible();
  await expect(page.getByTestId('tab-board')).toBeVisible();
}

async function expectTabsHidden(page) {
  await expect(page.getByTestId('tab-front')).toBeHidden();
  await expect(page.getByTestId('tab-back')).toBeHidden();
  await expect(page.getByTestId('tab-board')).toBeHidden();
}

test.describe('preview tabs hidden on the colour step', () => {
  test('tabs show on design step, hide on colour step, and survive back-nav', async ({ page }) => {
    await stubFeatures(page, { color_picking: true });
    await mockPreview(page);
    await page.goto('/options.html?plan=base');

    // Step 1 (design): the three face tabs are present and visible.
    await expect(page.getByTestId('step-1')).toBeVisible();
    await expectTabsVisible(page);

    // Next -> step 2 (colour): its carousel is the preview, so the tabs hide.
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('color-carousel')).toBeVisible();
    await expectTabsHidden(page);

    // The tab MARKUP stays in the DOM (only hidden) so nothing that references it
    // breaks and the other steps keep working.
    await expect(page.getByTestId('tab-front')).toHaveCount(1);

    // colour -> Next (step 3) -> Back returns to the colour step: still hidden.
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-3')).toBeVisible();
    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expectTabsHidden(page);

    // Back to step 1 (design): the tabs come back exactly as before.
    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('step-1')).toBeVisible();
    await expectTabsVisible(page);
  });

  test('with the colour flag OFF, step 2 is skipped and step 1 keeps its tabs', async ({
    page,
  }) => {
    // color + chasers both off -> step 2 drops out entirely. is-step-color is
    // never set, so the design-step tabs stay visible (no false hide).
    await stubFeatures(page, { color_picking: false, chasers_choice: false });
    await page.goto('/options.html?plan=base');

    await expect(page.getByTestId('step-1')).toBeVisible();
    await expectTabsVisible(page);

    // Next skips the empty step 2 and lands on step 3 (collapsed preview, tabs
    // hidden by the existing collapse rule — not by our colour-step rule).
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('step-2')).toBeHidden();

    // Back returns to step 1 with the tabs restored.
    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('step-1')).toBeVisible();
    await expectTabsVisible(page);
  });

  test('colour OFF + chasers ON: step 2 is active with no carousel, so the tabs STAY', async ({
    page,
  }) => {
    // The gap the review flagged: with colour picking off but chasers on, step 2
    // is still active but its colour-carousel is hidden. If we hid the tabs here
    // the buyer would be stranded on one face with no way to see back/board — so
    // the face tabs MUST stay visible on this step.
    await stubFeatures(page, { color_picking: false, chasers_choice: true });
    await page.goto('/options.html?plan=base');

    // step 2 is present in the flow (chasers keeps it), and step 1 has its tabs.
    await expect(page.getByTestId('step-1')).toBeVisible();
    await expect(page.getByTestId('step-total')).toHaveText('4');
    await expectTabsVisible(page);

    // Next -> step 2: the carousel is hidden, the chasers add-on shows, and the
    // face tabs stay visible (this is the fix — they are NOT hidden here).
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('color-carousel')).toBeHidden();
    await expect(page.getByTestId('chasers-card')).toBeVisible();
    await expectTabsVisible(page);

    // The tabs still work: switching to the board face activates its panel.
    await page.getByTestId('tab-board').click();
    await expect(page.getByTestId('preview-board')).toHaveAttribute('data-active', 'true');
  });
});
