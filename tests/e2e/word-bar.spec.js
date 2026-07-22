import { test, expect } from '@playwright/test';

// These tests exercise the two-stage progress bar on collect.html independently
// of the order wizard: the collection is created directly via the HTTP API
// (POST /api/collections, POST /api/collections/:id/words) so the test doesn't
// depend on options.html (which is changing under a separate PR).

const WORD_GOAL = 70; // stage-1 target (the minimum)
const MAX_WORDS = 416; // stage-2 target (the cap)

// Create a collection and return { id, k } (owner token). Optionally seed it
// with `count` distinct words in one API call.
async function makeCollection(request, name, count = 0) {
  const created = await request.post('/api/collections', { data: { honoree_name: name } });
  expect(created.ok()).toBeTruthy();
  const { id, owner_token: k } = await created.json();
  if (count > 0) {
    const words = Array.from({ length: count }, (_, i) => 'w' + i);
    const res = await request.post(`/api/collections/${id}/words`, { data: { words } });
    expect(res.ok()).toBeTruthy();
  }
  return { id, k };
}

function openCollect(page, id, k) {
  return page.goto(`/collect.html?c=${id}&k=${k}`);
}

async function barWidth(locator) {
  return parseFloat(await locator.evaluate((el) => el.style.width));
}

test('stage 1 (<70 words): bar is scaled to the 70-word minimum', async ({ page, request }) => {
  const { id, k } = await makeCollection(request, 'שירה', 40);
  await openCollect(page, id, k);

  await expect(page.locator('#count')).toHaveText('40');
  // Stage-1 bar shown, stage-2 hidden.
  await expect(page.locator('#stage1')).toBeVisible();
  await expect(page.locator('#stage2')).toBeHidden();
  // Pill frames the 70-word minimum, not the max.
  await expect(page.locator('#countMax')).toContainText('/ ' + WORD_GOAL);
  await expect(page.locator('#countMax')).toContainText('מינימום');
  await expect(page.locator('.count-pill')).not.toContainText(String(MAX_WORDS));
  // 40 / 70 ≈ 57% on the stage-1 bar.
  const w = await barWidth(page.locator('#barFill1'));
  expect(w).toBeGreaterThan(55);
  expect(w).toBeLessThan(59);
});

test('crossing to exactly 70 words: stage-2 bar replaces stage-1, ~⅙ full', async ({
  page,
  request,
}) => {
  const { id, k } = await makeCollection(request, 'דנה', WORD_GOAL);
  await openCollect(page, id, k);

  await expect(page.locator('#count')).toHaveText(String(WORD_GOAL));
  // The swap happened: stage-1 gone, the new stage-2 bar is shown.
  await expect(page.locator('#stage1')).toBeHidden();
  await expect(page.locator('#stage2')).toBeVisible();
  // Label is render-driven and true across the whole 70→416 range.
  await expect(page.locator('#stage2Label')).toContainText('ממשיכים למקסימום');
  await expect(page.locator('#stage2Label')).toContainText(String(MAX_WORDS));
  // Pill now frames the max.
  await expect(page.locator('#countMax')).toContainText('/ ' + MAX_WORDS);
  await expect(page.locator('#countMax')).not.toContainText('מינימום');
  // 70 / 416 ≈ 17% — the new bar starts already ~⅙ filled.
  const w = await barWidth(page.locator('#barFill2'));
  expect(w).toBeGreaterThan(14);
  expect(w).toBeLessThan(20);
});

test('bar fill is the warm-sand accent, not black', async ({ page, request }) => {
  // Stage 1 (<70): #barFill1 is visible. Stage 2 (>=70): #barFill2. Check both.
  const stage1 = await makeCollection(request, 'לירי', 40);
  await openCollect(page, stage1.id, stage1.k);
  await expect(page.locator('#stage1')).toBeVisible();
  const fill1 = await page
    .locator('#barFill1')
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  // The sand accent (#b7a389 = rgb(183, 163, 137)) is present; black (rgb(20, 20, 20)) is not.
  expect(fill1).toContain('rgb(183, 163, 137)');
  expect(fill1).not.toContain('rgb(20, 20, 20)');

  const stage2 = await makeCollection(request, 'רומי', 200);
  await openCollect(page, stage2.id, stage2.k);
  await expect(page.locator('#stage2')).toBeVisible();
  const fill2 = await page
    .locator('#barFill2')
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(fill2).toContain('rgb(183, 163, 137)');
  expect(fill2).not.toContain('rgb(20, 20, 20)');
});

test('more words (200): stage-2 fill grows toward the max', async ({ page, request }) => {
  const { id, k } = await makeCollection(request, 'יעל', 200);
  await openCollect(page, id, k);

  await expect(page.locator('#count')).toHaveText('200');
  await expect(page.locator('#stage1')).toBeHidden();
  await expect(page.locator('#stage2')).toBeVisible();
  await expect(page.locator('#countMax')).toContainText('/ ' + MAX_WORDS);
  // 200 / 416 ≈ 48%.
  const w = await barWidth(page.locator('#barFill2'));
  expect(w).toBeGreaterThan(46);
  expect(w).toBeLessThan(50);
});

test('past the 416 cap: capped count, מקסימום note, stage-2 bar full, no fraction', async ({
  page,
  request,
}) => {
  const { id, k } = await makeCollection(request, 'אגם', MAX_WORDS + 1);
  await openCollect(page, id, k);

  // Count is capped for display; never a fraction over the cap.
  await expect(page.locator('#count')).toHaveText(String(MAX_WORDS));
  await expect(page.locator('#countMax')).toContainText('מקסימום');
  await expect(page.locator('.count-pill')).not.toContainText(String(MAX_WORDS + 1));
  await expect(page.locator('.count-pill')).not.toContainText('/ ' + MAX_WORDS);
  await expect(page.locator('#countHint')).toContainText('מקסימום');
  // Stage-2 bar is full.
  await expect(page.locator('#stage2')).toBeVisible();
  expect(await barWidth(page.locator('#barFill2'))).toBe(100);
  // At the cap the label flips to a max-reached framing — it must NOT still
  // claim progress toward the max nor that a quarter is "just full".
  await expect(page.locator('#stage2Label')).toContainText('הגעתם למקסימום');
  await expect(page.locator('#stage2Label')).not.toContainText('ממשיכים');
});
