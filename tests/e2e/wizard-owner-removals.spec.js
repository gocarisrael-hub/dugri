import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';
import { previewRedesign } from './helpers/redesign.js';

// The owner's removals from the order wizard (feedback on the redesign, 2026-10-18). They are made in redesign mode
// only (css/rd/options.css), so the live site keeps every one of them until the mode ships:
// - the price pill at the top of each step ("החל מ- 199 ₪") and the details step's order recap;
// - the collapsed design box on the later steps ("עיצוב פריז · צבע מקורי");
// - the title step's line under the heading and the preview's "כך זה ייראה עם השם:";
// - the pawns step's two background-removal lines (the ChatGPT tip stays).

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

// Walks to each step and reports which of the removed pieces are on the screen there.
async function walk(page) {
  const seen = {};
  const vis = (sel) => page.locator(sel).first().isVisible();
  const next = page.getByTestId('next-btn');
  await page.goto('/options.html');
  await expect(page.getByTestId('step-1')).toBeVisible();
  seen.price = await vis('[data-testid="plan-pill"]');
  await next.click();
  await expect(page.getByTestId('step-2')).toBeVisible();
  await next.click();
  await expect(page.getByTestId('step-3')).toBeVisible();
  await page.fill('#customTitleInput', 'שירה חוגגת 40');
  await expect(page.getByTestId('name-preview')).toBeVisible();
  seen.titleSub = await vis('#nameStepSub');
  seen.previewLabel = await vis('.name-preview-lbl');
  seen.designBox = await vis('[data-testid="continue-summary"]');
  await next.click();
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  seen.pawnHint = await vis('[data-testid="pawn-hint"]');
  seen.pawnShop = await vis('[data-edit="options-photos-tip-shop"]');
  seen.pawnChatgpt = await vis('[data-edit="options-photos-tip-fix"]');
  await next.click();
  await expect(page.getByTestId('step-4')).toBeVisible();
  seen.detailsPrice = await vis('[data-testid="plan-pill"]');
  seen.detailsDesignBox = await vis('[data-testid="continue-summary"]');
  seen.orderRecap = await vis('[data-testid="order-summary"]');
  return seen;
}

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await mockPreview(page);
});

test('in redesign mode the wizard drops the price, the design box and the helper lines', async ({
  page,
}) => {
  await previewRedesign(page);
  expect(await walk(page)).toEqual({
    price: false,
    titleSub: false,
    previewLabel: false,
    designBox: false,
    pawnHint: false,
    pawnShop: false,
    pawnChatgpt: true,
    detailsPrice: false,
    detailsDesignBox: false,
    orderRecap: false,
  });
});

test('the live site keeps all of them until the mode ships', async ({ page }) => {
  expect(await walk(page)).toEqual({
    price: true,
    titleSub: true,
    previewLabel: true,
    designBox: true,
    pawnHint: true,
    pawnShop: true,
    pawnChatgpt: true,
    detailsPrice: true,
    detailsDesignBox: true,
    orderRecap: true,
  });
});
