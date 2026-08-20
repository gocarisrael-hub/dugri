import { test, expect } from '@playwright/test';

// THE PRODUCTION CLOCK'S ONE RULE.
//
// The delivery and pickup promises ("תוך כ-3 / כ-7 ימי עסקים") are counted from
// the moment the word list CLOSES — but a list closed at 19:40 has not bought
// itself a day. The owner asked for that stated where she works the production
// queue, so she is not re-deriving it per order at the end of a night.
//
// It is ONE line for the whole table, not a line per order: the sentence is
// identical for every order, and forty rows would print it forty times. These
// tests pin that, and pin that it is real text rather than a tooltip — the table
// is worked from a phone, where nothing can be hovered.
const KEY = 'dugri-admin';

const note = (page) => page.getByTestId('stage-note');

test('states the cutoff, and where the count starts from', async ({ page }) => {
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(note(page)).toBeVisible();
  await expect(note(page)).toContainText('19:00');
  // Both halves of the rule: when the day ends, and what that means for a list
  // closed after it.
  await expect(note(page)).toContainText('יום עסקים');
  await expect(note(page)).toContainText('יום העסקים הבא');
});

test('sits with the stage chips it explains, under them', async ({ page }) => {
  await page.goto(`/admin.html?key=${KEY}`);
  const chips = page.locator('#tabs-stage');
  await expect(chips).toBeVisible();
  const [chipBox, noteBox] = await Promise.all([chips.boundingBox(), note(page).boundingBox()]);
  // Under the שלב row — the note explains how those stages are timed, so it
  // follows them rather than heading the filters.
  expect(noteBox.y).toBeGreaterThan(chipBox.y);
});

test('is text on the page, not a tooltip, and appears exactly once', async ({ page }) => {
  await page.goto(`/admin.html?key=${KEY}`);
  // Exactly one: the alternative shape for this — a copy in every order's הפקה
  // cell — would grow with the table.
  await expect(note(page)).toHaveCount(1);
  // Nothing about the rule may hide behind a hover: the phone layout has no
  // hover at all, and it takes the <thead> off screen, so a title= on the הפקה
  // heading would be unreachable exactly where this is needed.
  await expect(note(page)).not.toHaveAttribute('title', /19:00/);
});

test('survives on a phone, where the column headings do not', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(note(page)).toBeVisible();
  await expect(note(page)).toContainText('19:00');
});

test('is not shown to someone without the key', async ({ page }) => {
  // The note lives inside #controls, which admin.html only unhides once the
  // keyed load succeeds (hideControls() on any failure). Without a key the load
  // fails, so an operating detail is never printed for a stray visitor —
  // asserted here because the note is new furniture inside that box and must
  // stay inside it.
  await page.goto('/admin.html');
  await expect(page.locator('#controls')).toBeHidden();
  await expect(note(page)).toBeHidden();
});
