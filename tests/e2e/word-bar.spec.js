import { test, expect } from '@playwright/test';

// These tests exercise the two-stage progress bar on collect.html independently
// of the order wizard: the collection is created directly via the HTTP API
// (POST /api/collections, POST /api/collections/:id/words) so the test doesn't
// depend on options.html (which is changing under a separate PR).

const WORD_GOAL = 100; // stage-1 target (the minimum)
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

test('stage 1 (<100 words): bar is scaled to the 100-word minimum', async ({ page, request }) => {
  const { id, k } = await makeCollection(request, 'שירה', 40);
  await openCollect(page, id, k);

  await expect(page.locator('#count')).toHaveText('40');
  // Stage-1 bar shown, stage-2 hidden.
  await expect(page.locator('#stage1')).toBeVisible();
  await expect(page.locator('#stage2')).toBeHidden();
  // Pill frames the 100-word minimum, not the max.
  await expect(page.locator('#countMax')).toContainText('/ ' + WORD_GOAL);
  await expect(page.locator('#countMax')).toContainText('מינימום');
  await expect(page.locator('.count-pill')).not.toContainText(String(MAX_WORDS));
  // 40 / 100 ≈ 40% on the stage-1 bar.
  const w = await barWidth(page.locator('#barFill1'));
  expect(w).toBeGreaterThan(38);
  expect(w).toBeLessThan(42);
});

test('crossing to exactly 100 words: stage-2 bar replaces stage-1, ~¼ full', async ({
  page,
  request,
}) => {
  const { id, k } = await makeCollection(request, 'דנה', WORD_GOAL);
  await openCollect(page, id, k);

  await expect(page.locator('#count')).toHaveText(String(WORD_GOAL));
  // The swap happened: stage-1 gone, the new stage-2 bar is shown.
  await expect(page.locator('#stage1')).toBeHidden();
  await expect(page.locator('#stage2')).toBeVisible();
  await expect(page.locator('#stage2')).toContainText('הרבע הראשון מלא');
  // Pill now frames the max.
  await expect(page.locator('#countMax')).toContainText('/ ' + MAX_WORDS);
  await expect(page.locator('#countMax')).not.toContainText('מינימום');
  // 100 / 416 ≈ 24% — the new bar starts already ~¼ filled.
  const w = await barWidth(page.locator('#barFill2'));
  expect(w).toBeGreaterThan(20);
  expect(w).toBeLessThan(30);
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
});
