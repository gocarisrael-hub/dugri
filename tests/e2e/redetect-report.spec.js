import { test, expect } from '@playwright/test';

// What the owner SEES when she presses "זהה מחדש".
//
// The defect these exist for: she pressed the button on מרקאנה over and over and
// her title style never changed, and asked "why doesn't the website run the
// calibration algorithm?" — when it ran it every time and quietly discarded the
// result. A run that changed nothing looked exactly like a run that changed
// everything, because the page said "זוהה בהצלחה" for both.
//
// Four different endings, four different sentences, only ONE of them green —
// and all of them still on screen a second later. The job itself is stubbed at
// the network: this is about what reaches the owner, not about the detector.
const KEY = 'dugri-admin';
const ONLY = 'Desktop Chrome';
const TPL = 'anniversary';

// Answer the button's POST with 202 and then hand the poll a single finished job
// carrying `result`. Matches the real contract in server/index.js.
async function stubRun(page, result, { state = 'done' } = {}) {
  const job = {
    id: 'redetect-stub',
    key: TPL,
    state,
    stage: null,
    stageText: null,
    fronts: 8,
    frontsTotal: 8,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    elapsedMs: 61000,
    result,
    error: null,
    httpStatus: null,
  };
  await page.route(`**/api/admin/templates/${TPL}/redetect**`, (route) =>
    route.fulfill({
      status: route.request().method() === 'POST' ? 202 : 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, job }),
    })
  );
}

async function pressRedetect(page) {
  await page.goto(`/admin-templates.html?key=${KEY}`);
  const card = page.locator(`.tpl-card[data-key="${TPL}"]`);
  await expect(card).toBeVisible();
  await card.locator('.tpl-redetect-btn').click();
  return card;
}

test.describe('what a re-detection reports', () => {
  // One device profile is enough: this is about wording, not layout.
  test.beforeEach(async ({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'wording test runs on one project only');
  });

  test('a clean run is the only one that reads as success', async ({ page }) => {
    await stubRun(page, {
      key: TPL,
      recipe: '/x.json',
      calibrated: true,
      detail: null,
      declined: [],
      rejected: [],
      kept: [],
    });
    const card = await pressRedetect(page);
    await expect(card.locator('.tpl-msg')).toContainText('זוהה בהצלחה');
  });

  // …and the verdict has to STAY on screen. Every branch used to write its
  // message and then call loadTemplates(), which re-renders the whole list — and
  // a freshly rendered card carries a fresh, EMPTY message box. The answer was
  // destroyed a few hundred milliseconds after it appeared, failures included,
  // so the owner pressed the button, watched the list blink, and was left with
  // nothing either way.
  test('the verdict survives the list refresh that follows it', async ({ page }) => {
    await stubRun(page, {
      key: TPL,
      recipe: '/x.json',
      calibrated: true,
      detail: null,
      declined: [],
      rejected: ['title_style (title_style.fill must be a hex color)'],
      kept: [],
    });
    const card = await pressRedetect(page);
    await expect(card.locator('.tpl-msg')).toContainText('נדחה');
    await page.waitForTimeout(1500);
    await expect(page.locator(`.tpl-card[data-key="${TPL}"] .tpl-msg`)).toContainText('נדחה');
  });

  // THE regression. calibrate.py measures all eight of a paired deck's card
  // backs and applyCalibration did not know the key existed, so every one was
  // dropped while the run reported calibrated:true. Now the merge reports what
  // it threw away and the page has to say it — naming the field, not just
  // hinting that something happened.
  test('a measurement that was refused is named on screen', async ({ page }) => {
    await stubRun(page, {
      key: TPL,
      recipe: '/x.json',
      calibrated: true,
      detail: null,
      declined: [],
      rejected: ['backs (backs.10.fill must be a hex color)'],
      kept: [],
    });
    const card = await pressRedetect(page);
    const msg = card.locator('.tpl-msg');
    await expect(msg).toContainText('נדחה');
    await expect(msg).toContainText('backs.10.fill');
    await expect(msg).not.toContainText('זוהה בהצלחה');
    await expect(msg).toHaveClass(/err/);
  });

  // "I could not read the board this time" is a different fact from "the board
  // has no title", and the owner is the one who has to tell them apart.
  test('a surface that went unmeasured is named on screen', async ({ page }) => {
    await stubRun(page, {
      key: TPL,
      recipe: '/x.json',
      calibrated: true,
      detail: null,
      declined: [],
      rejected: [],
      kept: ['board', 'title_style.italic'],
    });
    const card = await pressRedetect(page);
    const msg = card.locator('.tpl-msg');
    await expect(msg).toContainText('לא נמדד');
    await expect(msg).toContainText('board');
    await expect(msg).toHaveClass(/err/);
  });

  // A calibration killed by its own ceiling. Two things must be on screen: that
  // it TIMED OUT (not that the artwork is broken), and that the template was
  // left untouched — which is what decides whether pressing again is worth
  // anything.
  test('a timed-out calibration says so, and says nothing was saved', async ({ page }) => {
    await stubRun(page, {
      key: TPL,
      recipe: '/x.json',
      calibrated: false,
      timedOut: true,
      detail: 'TIMED OUT after 420s and was killed — nothing was written. Traceback…',
      declined: [],
      rejected: [],
      kept: [],
    });
    const card = await pressRedetect(page);
    const msg = card.locator('.tpl-msg');
    await expect(msg).toContainText('לא הסתיים בזמן');
    await expect(msg).toContainText('שום דבר לא נשמר');
    await expect(msg).toHaveClass(/err/);
  });
});
