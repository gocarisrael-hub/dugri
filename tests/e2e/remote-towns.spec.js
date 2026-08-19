import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// "יישובים חריגים" — the collapsed note listing the localities where delivery
// takes longer than the estimate printed beside it.
//
// The owner types the list in admin-pricing; the checkout prints it in BOTH
// places a buyer asks for delivery: the "שלחו לי עד הבית" tick, and the card
// that adds delivery to an order already paid for. Two surfaces, one payload —
// so the tests below check both, and check them against the SAME stub.
//
// Two behaviours matter more than the rest, and both are here as their own test:
//   • nothing renders until the owner has actually filled the list (an empty
//     list is the shipped state, and a note announcing an exception with no
//     towns under it is worse than no note);
//   • opening the note must not TICK delivery. The tick is a <label>, and a
//     <summary> nested inside one gets its click forwarded to the checkbox — the
//     buyer would find the order changed by reading about it.

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const TOWNS = ['אילת', 'מצפה רמון', 'ראש פינה'];

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// Pricing with delivery live. `exceptions` is spliced in as the server would
// send it — already parsed into { towns, eta_days }.
async function stubPricing(page, exceptions) {
  const body = {
    store: { now: 199, was: 239 },
    // Sale ON: the option list is only painted from a RESOLVED payload, and
    // data-sale="on" is the unambiguous signal that the stub (not the seeded
    // fallback) is what the page is showing.
    sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
    delivery_fee: 39,
    versions: {
      pdf: { enabled: false, price: 79 },
      pickup: { enabled: true, price: 199 },
      delivery: { enabled: true, price: 199 },
      custom: { enabled: false, price: 599 },
    },
  };
  if (exceptions !== undefined) body.delivery_exceptions = exceptions;
  await page.route('**/api/pricing', (route) => route.fulfill({ json: body }));
}

// The server's answer about the after-the-fact delivery offer, injected into the
// collection GET — there is no way to make an order genuinely paid in a test.
async function stubUpgrade(page) {
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const body = await resp.json();
    body.card_enabled = true;
    body.shipping_upgrade = { offered: true, reason: null, fee: 39, paid: false, address: null };
    return route.fulfill({ json: body });
  });
}

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
  return page.url();
}

async function openPayPanel(page) {
  const tab = page.getByTestId('tab-pay');
  const shown = await tab
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (shown) await tab.click();
  await page.locator('#payPanel > summary').click();
  // Only a resolved payload paints the option list; until then applyPricing
  // hides the whole box and the note legitimately is not there yet.
  await expect(page.locator('html')).toHaveAttribute('data-sale', 'on');
  await expect(page.locator('#payOpts')).toBeVisible();
}

const noteAt = (page, where) => page.locator(`[data-testid="remote-note"][data-where="${where}"]`);

test.describe('in the checkout, under the delivery tick', () => {
  test('lists the towns and the days, and starts collapsed', async ({ page }) => {
    await stubPricing(page, { towns: TOWNS, eta_days: 11 });
    await createCollection(page);
    await openPayPanel(page);

    const note = noteAt(page, 'ship-toggle');
    await expect(note).toBeVisible();
    // COLLAPSED on arrival: it is a footnote to the delivery estimate above it,
    // not a warning, and an open block of town names would dominate the tick.
    await expect(note).not.toHaveAttribute('open', '');
    await expect(note.locator('summary')).toHaveText('יישובים חריגים');
    await expect(note.locator('[data-role="towns"]')).toBeHidden();

    await note.locator('summary').click();
    await expect(note.locator('[data-role="eta"]')).toContainText('11 ימי עסקים');
    const towns = note.locator('[data-role="towns"]');
    for (const t of TOWNS) await expect(towns).toContainText(t);
  });

  test('opening it does NOT tick delivery', async ({ page }) => {
    await stubPricing(page, { towns: TOWNS, eta_days: 11 });
    await createCollection(page);
    await openPayPanel(page);

    const tick = page.locator('#shipToggle');
    await expect(tick).not.toBeChecked();
    const before = await page.locator('#payTotal').textContent();

    await noteAt(page, 'ship-toggle').locator('summary').click();

    // The note opened, the order did not change, and the buyer was not quietly
    // charged shipping for reading a footnote.
    await expect(noteAt(page, 'ship-toggle')).toHaveAttribute('open', '');
    await expect(tick).not.toBeChecked();
    await expect(page.locator('#payTotal')).toHaveText(before.trim());
  });

  test('sits under the delivery tick, not above it', async ({ page }) => {
    await stubPricing(page, { towns: TOWNS, eta_days: 11 });
    await createCollection(page);
    await openPayPanel(page);

    const [tickBox, noteBox] = await Promise.all([
      page.getByTestId('ship-toggle').boundingBox(),
      noteAt(page, 'ship-toggle').boundingBox(),
    ]);
    expect(noteBox.y).toBeGreaterThan(tickBox.y);
  });

  test('stays away until the owner has filled the list', async ({ page }) => {
    await stubPricing(page, { towns: [], eta_days: 11 });
    await createCollection(page);
    await openPayPanel(page);
    await expect(page.getByTestId('ship-toggle')).toBeVisible();
    await expect(noteAt(page, 'ship-toggle')).toBeHidden();
  });

  test('an older server that sends no exceptions block shows no note', async ({ page }) => {
    await stubPricing(page, undefined);
    await createCollection(page);
    await openPayPanel(page);
    await expect(page.getByTestId('ship-toggle')).toBeVisible();
    await expect(noteAt(page, 'ship-toggle')).toBeHidden();
  });

  test('a failed pricing fetch promises nothing', async ({ page }) => {
    await page.route('**/api/pricing', (route) => route.abort('failed'));
    await createCollection(page);
    const tab = page.getByTestId('tab-pay');
    await tab.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await tab.click().catch(() => {});
    await page.locator('#payPanel > summary').click();
    // No estimate we could not read: the note is absent even though the markup
    // for it is on the page.
    await expect(noteAt(page, 'ship-toggle')).toBeHidden();
  });
});

test.describe('on the card that adds delivery after payment', () => {
  test('carries the same note', async ({ page }) => {
    await stubPricing(page, { towns: TOWNS, eta_days: 11 });
    await stubUpgrade(page);
    const url = await createCollection(page);
    await page.goto(url);
    await page.getByTestId('tab-finish').click();

    const card = page.locator('#shipAddCard');
    await expect(card).toBeVisible();
    await page.getByTestId('ship-add-summary').click();

    const note = noteAt(page, 'ship-add');
    await expect(note).toBeVisible();
    await expect(note).not.toHaveAttribute('open', '');
    await note.locator('summary').click();
    await expect(note.locator('[data-role="eta"]')).toContainText('11 ימי עסקים');
    await expect(note.locator('[data-role="towns"]')).toContainText('אילת');
  });

  test('and hides there too when the list is empty', async ({ page }) => {
    await stubPricing(page, { towns: [], eta_days: 11 });
    await stubUpgrade(page);
    const url = await createCollection(page);
    await page.goto(url);
    await page.getByTestId('tab-finish').click();
    await page.getByTestId('ship-add-summary').click();
    await expect(page.getByTestId('ship-street')).toBeVisible();
    await expect(noteAt(page, 'ship-add')).toBeHidden();
  });
});
