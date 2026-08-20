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

// Pricing with delivery live. `exceptions` is the HEADLINE the server sends on
// this endpoint — { count, eta_days }. The names come from their own endpoint
// (stubTowns below), because a real courier list is thousands of them and every
// storefront page fetches pricing.
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

// The names, on their own endpoint. `undefined` leaves the route unstubbed so
// the real (empty) server answer stands.
async function stubTowns(page, towns, etaDays = 11) {
  await page.route('**/api/delivery-exceptions', (route) =>
    route.fulfill({ json: { towns, eta_days: etaDays } })
  );
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
    await stubPricing(page, { count: TOWNS.length, eta_days: 11 });
    await stubTowns(page, TOWNS);
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
    await stubPricing(page, { count: TOWNS.length, eta_days: 11 });
    await stubTowns(page, TOWNS);
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
    await stubPricing(page, { count: TOWNS.length, eta_days: 11 });
    await stubTowns(page, TOWNS);
    await createCollection(page);
    await openPayPanel(page);

    const [tickBox, noteBox] = await Promise.all([
      page.getByTestId('ship-toggle').boundingBox(),
      noteAt(page, 'ship-toggle').boundingBox(),
    ]);
    expect(noteBox.y).toBeGreaterThan(tickBox.y);
  });

  test('stays away until the owner has filled the list', async ({ page }) => {
    await stubPricing(page, { count: 0, eta_days: 11 });
    await stubTowns(page, []);
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

test.describe('a real-sized list', () => {
  // The owner's own list is a courier's exceptions list — thousands of names,
  // not the three this spec uses elsewhere. The first cap shipped at 400 lines
  // and she met it on her first save.
  const MANY = Array.from({ length: 2500 }, (_, i) => 'יישוב ' + i);

  test('prints in full, and the note still opens collapsed', async ({ page }) => {
    await stubPricing(page, { count: MANY.length, eta_days: 11 });
    await stubTowns(page, MANY);
    await createCollection(page);
    await openPayPanel(page);

    const note = noteAt(page, 'ship-toggle');
    await expect(note).toBeVisible();
    await expect(note).not.toHaveAttribute('open', '');
    await note.locator('summary').click();
    const towns = note.locator('[data-role="towns"]');
    // First, last and one from the middle — the whole list travelled.
    await expect(towns).toContainText('יישוב 0');
    await expect(towns).toContainText('יישוב 1250');
    await expect(towns).toContainText('יישוב 2499');
  });

  test('the names do NOT ride on /api/pricing', async ({ page }) => {
    // What the storefront pays for this feature. Every page fetches pricing for
    // its numbers and not one prints a town, so the list must not be in there.
    let pricingBody = '';
    await page.route('**/api/pricing', async (route) => {
      const body = {
        store: { now: 199, was: 239 },
        sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
        delivery_fee: 39,
        versions: {
          pdf: { enabled: false, price: 79 },
          pickup: { enabled: true, price: 199 },
          delivery: { enabled: true, price: 199 },
          custom: { enabled: false, price: 599 },
        },
        delivery_exceptions: { count: MANY.length, eta_days: 11 },
      };
      pricingBody = JSON.stringify(body);
      return route.fulfill({ json: body });
    });
    await stubTowns(page, MANY);
    await createCollection(page);
    await openPayPanel(page);
    await expect(noteAt(page, 'ship-toggle')).toBeVisible();
    expect(pricingBody).not.toContain('יישוב 0');
    expect(pricingBody.length).toBeLessThan(1000);
  });

  test('if the names fail to load, the note still states the wait', async ({ page }) => {
    await stubPricing(page, { count: 2500, eta_days: 11 });
    await page.route('**/api/delivery-exceptions', (route) => route.abort('failed'));
    await createCollection(page);
    await openPayPanel(page);

    // The heading is true without the names — it says how long the wait is and
    // that a list exists — so a failed second fetch must not blank a note the
    // buyer is already reading.
    const note = noteAt(page, 'ship-toggle');
    await expect(note).toBeVisible();
    await note.locator('summary').click();
    await expect(note.locator('[data-role="eta"]')).toContainText('11 ימי עסקים');
  });
});

test.describe('finding your own town in a long list', () => {
  // A courier list is thousands of names. Opened, it is a wall of text: nobody
  // reads it, they look for one town. So above FIND_MIN the note carries a
  // search box — and below it does not, because a search field over six names is
  // furniture.
  const MANY = Array.from({ length: 2500 }, (_, i) => 'יישוב ' + i).concat(['אילת', 'מצפה רמון']);

  async function openNote(page, towns) {
    await stubPricing(page, { count: towns.length, eta_days: 11 });
    await stubTowns(page, towns);
    await createCollection(page);
    await openPayPanel(page);
    const note = noteAt(page, 'ship-toggle');
    await note.locator('summary').click();
    return note;
  }

  test('filters the list down to what was typed', async ({ page }) => {
    const note = await openNote(page, MANY);
    const find = note.getByTestId('remote-find');
    await expect(find).toBeVisible();

    await find.fill('אילת');
    const towns = note.locator('[data-role="towns"]');
    await expect(towns).toHaveText('אילת');
    // …and the 2,500 that do not match are gone, not merely scrolled past.
    await expect(towns).not.toContainText('יישוב 0');
  });

  test('a partial word is enough — nobody types the whole name', async ({ page }) => {
    const note = await openNote(page, MANY);
    await note.getByTestId('remote-find').fill('מצפה');
    await expect(note.locator('[data-role="towns"]')).toHaveText('מצפה רמון');
  });

  test('counts the hits, so a wide match is obviously wide', async ({ page }) => {
    const note = await openNote(page, MANY);
    await note.getByTestId('remote-find').fill('יישוב 1');
    // "יישוב 1", "יישוב 1x", "יישוב 1xx"… — the buyer sees at a glance that the
    // query is too loose rather than scrolling to find out.
    await expect(note.locator('[data-role="count"]')).toContainText('נמצאו');
  });

  test('a miss is an ANSWER, not a failed search', async ({ page }) => {
    const note = await openNote(page, MANY);
    await note.getByTestId('remote-find').fill('תל אביב');
    // The thing the buyer actually came to find out: not on the list means the
    // normal delivery time. "Nothing found" alone would read as a broken search.
    await expect(note.locator('[data-role="count"]')).toContainText('זמן האספקה הרגיל');
    await expect(note.locator('[data-role="towns"]')).toHaveText('');
  });

  test('clearing the box brings the whole list back', async ({ page }) => {
    const note = await openNote(page, MANY);
    const find = note.getByTestId('remote-find');
    await find.fill('אילת');
    await expect(note.locator('[data-role="towns"]')).toHaveText('אילת');
    await find.fill('');
    await expect(note.locator('[data-role="towns"]')).toContainText('יישוב 0');
    await expect(note.locator('[data-role="count"]')).toBeHidden();
  });

  test('no search box over a list short enough to read', async ({ page }) => {
    const note = await openNote(page, TOWNS);
    await expect(note.getByTestId('remote-find')).toBeHidden();
    await expect(note.locator('[data-role="towns"]')).toContainText('אילת');
  });

  test('the open list scrolls inside the note, not the panel', async ({ page }) => {
    const note = await openNote(page, MANY);
    const list = note.locator('[data-role="towns"]');
    // 2,500 names must not push the pay button off the screen: the list is a
    // bounded, scrollable box of its own.
    const [h, scrollH] = await list.evaluate((el) => [el.clientHeight, el.scrollHeight]);
    expect(h).toBeLessThan(400);
    expect(scrollH).toBeGreaterThan(h);
  });
});

test.describe('on the card that adds delivery after payment', () => {
  test('carries the same note', async ({ page }) => {
    await stubPricing(page, { count: TOWNS.length, eta_days: 11 });
    await stubTowns(page, TOWNS);
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
    await stubPricing(page, { count: 0, eta_days: 11 });
    await stubTowns(page, []);
    await stubUpgrade(page);
    const url = await createCollection(page);
    await page.goto(url);
    await page.getByTestId('tab-finish').click();
    await page.getByTestId('ship-add-summary').click();
    await expect(page.getByTestId('ship-street')).toBeVisible();
    await expect(noteAt(page, 'ship-add')).toBeHidden();
  });
});
