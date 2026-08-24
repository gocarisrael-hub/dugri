import { test, expect } from '@playwright/test';

// THE PRODUCTION CLOCK'S ONE RULE.
//
// The delivery and pickup promises ("תוך כ-4 / כ-8 ימי עסקים") are counted from
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
  await expect(note(page)).toContainText('16:00');
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
  await expect(note(page)).not.toHaveAttribute('title', /16:00/);
});

test('survives on a phone, where the column headings do not', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(note(page)).toBeVisible();
  await expect(note(page)).toContainText('16:00');
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

// THE SAME RULE, SAID TO THE BUYER.
//
// The owner's copy sits beside her production queue; this one sits where the
// money is, because the buyer is the one it costs a day. The clock starts when
// the word list CLOSES — not at payment — so someone paying at 16:30 who closes
// tonight must not read the option's estimate as starting today.
test.describe('the same cutoff, at the payment step', () => {
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

  async function createCollection(page, title = 'Shira') {
    await page.route('**/api/preview', (route) =>
      route.fulfill({
        json: {
          card: PNG,
          back: PNG,
          board: PNG,
          warning: null,
          word_font: null,
          word_font_options: [],
        },
      })
    );
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    await page.fill('#customTitleInput', title);
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'test@example.com');
    await page.fill('#ownerPhone', '0521234567');
    await page.fill('#buyerNameInput', 'דנה כהן');
    await page.getByTestId('next-btn').click();
    await page.waitForURL(/collect\.html\?c=.+&k=.+/);
  }

  async function openPayPanel(page) {
    const tab = page.getByTestId('tab-pay');
    const shown = await tab
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (shown) await tab.click();
    await page.locator('#payPanel > summary').click();
  }

  test('states when the clock starts, and the cutoff', async ({ page }) => {
    await createCollection(page);
    await openPayPanel(page);
    const cutoff = page.getByTestId('pay-cutoff');
    await expect(cutoff).toBeVisible();
    await expect(cutoff).toContainText('16:00');
    // The clock starts at CLOSING, not at payment — the whole point of saying it
    // here, where a buyer would otherwise assume paying starts it.
    await expect(cutoff).toContainText('סוגרים את רשימת המילים');
    await expect(cutoff).toContainText('יום העסקים הבא');
  });

  test('sits under the security line, above the pay button', async ({ page }) => {
    await createCollection(page);
    await openPayPanel(page);
    const [trustBox, cutoffBox, btnBox] = await Promise.all([
      page.locator('[data-edit="collect-pay-trust"]').boundingBox(),
      page.getByTestId('pay-cutoff').boundingBox(),
      page.locator('#cardPayBtn').boundingBox(),
    ]);
    expect(cutoffBox.y).toBeGreaterThan(trustBox.y);
    // It must not come between the total and the button, and it must not push
    // the button off the panel — it is a qualifier, not a step.
    if (btnBox) expect(cutoffBox.y).toBeLessThan(btnBox.y);
  });

  test('reads lighter than the security promise beside it', async ({ page }) => {
    await createCollection(page);
    await openPayPanel(page);
    const weight = (loc) =>
      loc.evaluate((el) => parseInt(getComputedStyle(el).fontWeight, 10) || 400);
    const size = (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const trust = page.locator('[data-edit="collect-pay-trust"]');
    const cutoff = page.getByTestId('pay-cutoff');
    // Two claims printed at the same weight read as two promises; this one is a
    // qualifier on somebody else's.
    expect(await weight(cutoff)).toBeLessThan(await weight(trust));
    expect(await size(cutoff)).toBeLessThan(await size(trust));
  });

  test('is owner-editable, like every other line in the panel', async ({ page }) => {
    await createCollection(page);
    await openPayPanel(page);
    await expect(page.getByTestId('pay-cutoff')).toHaveAttribute('data-edit', 'collect-pay-cutoff');
  });
});
