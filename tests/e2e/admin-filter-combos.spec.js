import { test, expect } from '@playwright/test';

const KEY = 'dugri-admin';

// These tests are about how the two filter rows COMBINE, so the page is fed a
// fixed set of orders rather than seeded ones: a paid order cannot be created
// through the API (payment needs a real money event, see admin.spec.js), and the
// shared E2E store would make chip counts depend on whatever else is running.
// The filtering is pure client-side work over this payload.
const iso = (daysAgo, hour) => new Date(Date.UTC(2026, 6, 20 - daysAgo, hour, 0, 0)).toISOString();

function order(extra) {
  return {
    version: 'pickup',
    total: 199,
    quantity: 1,
    paid: false,
    address: null,
    production: null,
    sent_to_print_at: null,
    ready_at: null,
    ...extra,
  };
}

const generated = { state: 'generated', pdf_file: 'x.pdf', board_file: null };

// One order per state the owner works through, half of them paid.
const COLLECTIONS = [
  // Still collecting words.
  { name: 'אוספת-שולמה', status: 'open', order: order({ paid: true }) },
  { name: 'אוספת-ליד', status: 'open', order: order({}) },
  // Closed, nothing produced yet — the production queue.
  { name: 'להפקה-שולמה', status: 'closed', closed: 2, order: order({ paid: true }) },
  { name: 'להפקה-ליד', status: 'closed', closed: 3, order: order({}) },
  // Produced and still here — waiting to go to the printer.
  {
    name: 'לגלאור-שולמה',
    status: 'closed',
    closed: 4,
    order: order({ paid: true, production: generated }),
  },
  // At the printer.
  {
    name: 'בדפוס-שולמה',
    status: 'closed',
    closed: 5,
    order: order({ paid: true, production: generated, sent_to_print_at: iso(1, 9) }),
  },
  // Back and handed over.
  {
    name: 'מוכנה-שולמה',
    status: 'closed',
    closed: 6,
    order: order({
      paid: true,
      production: generated,
      sent_to_print_at: iso(5, 9),
      ready_at: iso(4, 9),
    }),
  },
  // Cancelled, and paid — it must stay out of every working step.
  {
    name: 'מבוטלת-שולמה',
    status: 'closed',
    closed: 7,
    cancelled: true,
    order: order({ paid: true }),
  },
];

async function stubOrders(page) {
  await page.route('**/api/admin/collections?*', (route) =>
    route.fulfill({
      json: {
        collections: COLLECTIONS.map((c, i) => ({
          id: 'stub-' + i,
          owner_token: 'tok-' + i,
          honoree_name: c.name,
          owner_email: `stub${i}@example.com`,
          owner_phone: '0521234567',
          word_count: 80,
          status: c.status,
          cancelled: !!c.cancelled,
          created_at: iso(10 - i, 8),
          closed_at: c.closed ? iso(c.closed, 12) : null,
          expires_at: iso(-300, 8),
          design: 'קלאסי',
          color: 'שחור',
          pawn_images: [],
          pawn_cutouts: {},
          extra_fields: {},
          chasers: false,
          order: c.order,
        })),
      },
    })
  );
  // The WhatsApp map is a separate best-effort call; keep it out of the way.
  await page.route('**/api/admin/whatsapp/groups?*', (route) => route.fulfill({ json: {} }));
}

// Click a chip by its exact label (the counts ride in the same text node).
const chip = (page, label) =>
  page.locator('.tab').filter({ hasText: new RegExp(`^${label} \\(\\d+\\)$`) });

const shownNames = async (page) =>
  (
    await page.$$eval('tbody tr td:first-child', (tds) => tds.map((td) => td.textContent || ''))
  ).map((t) => t.trim());

test.beforeEach(async ({ page }) => {
  await stubOrders(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('tbody tr').first()).toBeVisible();
});

test('two filter rows: payment and where the order stands', async ({ page }) => {
  await expect(page.locator('#tabs .tab')).toHaveCount(3);
  await expect(page.locator('#tabs-stage .tab')).toHaveCount(7);
  await expect(page.locator('#tabs-stage')).toContainText('נסגרו — להפקה');
  await expect(page.locator('#tabs-stage')).toContainText('הופקו — לשליחה לדפוס');
  await expect(page.locator('#tabs-stage')).toContainText('בדפוס');
  await expect(page.locator('#tabs-stage')).toContainText('מוכנות');
  // Nothing filtered yet: all eight rows.
  expect(await shownNames(page)).toHaveLength(8);
});

// The three combinations the owner asked for, each on its own.
const COMBOS = [
  ['נסגרו — להפקה', 'להפקה-שולמה'],
  ['הופקו — לשליחה לדפוס', 'לגלאור-שולמה'],
  ['מוכנות', 'מוכנה-שולמה'],
];
for (const [stage, expected] of COMBOS) {
  test(`שולמו + ${stage} narrows to exactly that order`, async ({ page }) => {
    await chip(page, 'שולמו').click();
    await chip(page, stage).click();
    expect(await shownNames(page)).toEqual([expected]);
  });
}

test('the stage row keeps working on its own, across payment states', async ({ page }) => {
  await chip(page, 'נסגרו — להפקה').click();
  expect((await shownNames(page)).sort()).toEqual(['להפקה-ליד', 'להפקה-שולמה']);

  // ...and switching the payment row narrows the same stage rather than replacing it.
  await chip(page, 'לידים').click();
  expect(await shownNames(page)).toEqual(['להפקה-ליד']);
});

test('a produced order leaves the production queue, and a printed one leaves both', async ({
  page,
}) => {
  // Each order sits at exactly ONE step: the queue chip must not still be
  // counting orders that are already at the printer or back from it.
  await chip(page, 'נסגרו — להפקה').click();
  const queue = await shownNames(page);
  expect(queue).not.toContain('לגלאור-שולמה');
  expect(queue).not.toContain('בדפוס-שולמה');
  expect(queue).not.toContain('מוכנה-שולמה');

  await chip(page, 'הופקו — לשליחה לדפוס').click();
  expect(await shownNames(page)).toEqual(['לגלאור-שולמה']);

  await chip(page, 'בדפוס').click();
  expect(await shownNames(page)).toEqual(['בדפוס-שולמה']);
});

test('a cancelled order is in no working step, even when it was paid', async ({ page }) => {
  for (const stage of [
    'באיסוף מילים',
    'נסגרו — להפקה',
    'הופקו — לשליחה לדפוס',
    'בדפוס',
    'מוכנות',
  ]) {
    await chip(page, stage).click();
    expect(await shownNames(page), `${stage} shows the cancelled order`).not.toContain(
      'מבוטלת-שולמה'
    );
  }
  await chip(page, 'מבוטלות').click();
  expect(await shownNames(page)).toEqual(['מבוטלת-שולמה']);
});

test('each chip counts what it would show given the other row', async ({ page }) => {
  const countOf = async (label) => {
    const text = await chip(page, label).textContent();
    return Number(text.match(/\((\d+)\)$/)[1]);
  };
  // Against everything: two orders sit in the production queue, one paid.
  expect(await countOf('נסגרו — להפקה')).toBe(2);

  await chip(page, 'שולמו').click();
  expect(await countOf('נסגרו — להפקה')).toBe(1);
  expect(await countOf('מוכנות')).toBe(1);
  // ...and the payment chips are counted against the stage in the same way.
  await chip(page, 'מוכנות').click();
  expect(await countOf('לידים')).toBe(0);
  expect(await countOf('שולמו')).toBe(1);
});

test('the header says how much the pair narrowed to', async ({ page }) => {
  await expect(page.locator('#sub')).toHaveText('8 הזמנות');
  await chip(page, 'שולמו').click();
  await chip(page, 'מוכנות').click();
  await expect(page.locator('#sub')).toHaveText('מציג 1 מתוך 8 הזמנות');
  // An empty combination says so as a count, not as an empty page.
  await chip(page, 'לידים').click();
  await expect(page.locator('#sub')).toHaveText('מציג 0 מתוך 8 הזמנות');
  await expect(page.locator('#content')).toContainText('אין רשומות להצגה');
});
