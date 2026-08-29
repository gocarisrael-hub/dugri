import { test, expect } from '@playwright/test';

const KEY = 'dugri-admin';

// Filtering is client-side work over the admin payload, so the payload is fixed
// here: a paid order cannot be created through the API (payment needs a real money
// event — see admin.spec.js), and the shared E2E store would make every count
// depend on whatever else is running in parallel.
const iso = (d) => new Date(Date.UTC(2026, 6, d, 9, 0, 0)).toISOString();

function row(i, { name, design, version, paid = false, status = 'closed', ready = false }) {
  return {
    id: 'stub-' + i,
    owner_token: 'tok-' + i,
    honoree_name: name,
    owner_email: `stub${i}@example.com`,
    owner_phone: '0521234567',
    word_count: 80,
    status,
    cancelled: false,
    created_at: iso(20 - i),
    closed_at: status === 'closed' ? iso(19 - i) : null,
    expires_at: iso(300),
    design,
    color: 'שחור',
    pawn_images: [],
    pawn_cutouts: {},
    extra_fields: {},
    chasers: false,
    order: version
      ? {
          version,
          total: 199,
          quantity: 1,
          paid,
          address: null,
          production: null,
          sent_to_print_at: null,
          ready_at: ready ? iso(18) : null,
        }
      : null,
  };
}

// Two designs × three versions, so every filter has something to separate.
const ROWS = [
  row(1, { name: 'איסוף-קלאסי', design: 'קלאסי', version: 'pickup', paid: true }),
  row(2, { name: 'איסוף-מודרני', design: 'מודרני', version: 'pickup' }),
  row(3, { name: 'משלוח-קלאסי', design: 'קלאסי', version: 'delivery', paid: true }),
  row(4, { name: 'משלוח-מודרני', design: 'מודרני', version: 'delivery', ready: true }),
  row(5, { name: 'דיגיטלי-קלאסי', design: 'קלאסי', version: 'pdf' }),
  row(6, { name: 'ליד-בלי-הזמנה', design: 'מודרני', version: null, status: 'open' }),
];

async function openAdmin(page, { width = 1440, height = 900 } = {}) {
  await page.route('**/api/admin/collections?*', (route) =>
    route.fulfill({ json: { collections: ROWS } })
  );
  await page.route('**/api/admin/whatsapp/groups?*', (route) => route.fulfill({ json: {} }));
  await page.setViewportSize({ width, height });
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('tbody tr').first()).toBeVisible();
}

const names = async (page) =>
  (
    await page.$$eval('tbody tr td[data-label="כותרת"]', (tds) =>
      tds.map((td) => td.textContent || '')
    )
  ).map((t) => t.trim());

// Open a column's picker from its heading and tick one of its values.
async function pick(page, columnId, valueLabel) {
  await page.getByTestId('colfilter-' + columnId).click();
  const menu = page.locator('.colmenu');
  await expect(menu).toBeVisible();
  await menu.locator('label', { hasText: valueLabel }).locator('input').first().check();
}

test('only columns with a value worth narrowing by carry a filter', async ({ page }) => {
  await openAdmin(page);
  // The ones the owner asked for, and the rest of the bounded columns.
  for (const id of ['version', 'design', 'status', 'paid', 'to_print', 'ready']) {
    await expect(page.getByTestId('colfilter-' + id)).toBeVisible();
  }
  // Free text is not a filter — a list of every honoree name is the table again.
  const heads = await page.$$eval('thead th', (ths) =>
    ths.map((th) => ({
      label: th.querySelector('span')?.textContent || '',
      hasFilter: !!th.querySelector('.th-f'),
    }))
  );
  // Stated as "nothing OUTSIDE the list above", rather than by naming the free-text
  // columns: the column set itself moves (another PR is adding and removing some
  // right now), and a test that names them fails on the columns rather than on the
  // rule. Any new column that quietly grows a filter still trips this.
  const FILTERABLE = ['סטטוס', 'עיצוב', 'גרסה', 'תשלום', 'לדפוס', 'מוכן'];
  const unexpected = heads.filter((h) => h.hasFilter && !FILTERABLE.includes(h.label));
  expect(
    unexpected.map((h) => h.label),
    'a column grew a filter unannounced'
  ).toEqual([]);
  // …and the free-text ones that are here today are named anyway: a list of every
  // distinct title is not a filter, it is the table again.
  for (const label of ['כותרת', 'לקוח', 'כתובת']) {
    const head = heads.find((h) => h.label === label);
    expect(head, `${label} is missing from the table`).toBeTruthy();
    expect(head.hasFilter, `${label} should not filter`).toBe(false);
  }
});

// The control goes in a wrapper inside the heading, never on the <th> itself:
// `display: flex` on a table cell stops it BEING a table cell and the whole heading
// row slides out of line with its columns. Every testid still resolved when that
// happened, so this measures the alignment instead.
test('the heading row still lines up with its columns', async ({ page }) => {
  await openAdmin(page);
  const rows = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('thead th')];
    const cells = [...document.querySelectorAll('tbody tr:first-child td')];
    return {
      heads: heads.length,
      cells: cells.length,
      // Each heading sits directly above its own cell, at the same left edge.
      offBy: heads
        .map((th, i) =>
          Math.abs(th.getBoundingClientRect().left - cells[i].getBoundingClientRect().left)
        )
        .filter((d) => d > 1).length,
      // …and the whole row is one line of headings, not a stack.
      headTop: new Set(heads.map((th) => Math.round(th.getBoundingClientRect().top))).size,
    };
  });
  expect(rows.cells).toBe(rows.heads);
  expect(rows.offBy, 'headings drifted off their columns').toBe(0);
  expect(rows.headTop, 'the heading row broke into several lines').toBe(1);
});

test('picking a version in the column narrows the table to it', async ({ page }) => {
  await openAdmin(page);
  expect(await names(page)).toHaveLength(6);

  await pick(page, 'version', 'המפונקת (משלוח)');
  expect((await names(page)).sort()).toEqual(['משלוח-מודרני', 'משלוח-קלאסי']);

  // The heading says it is filtering, and the strip says what by.
  await expect(page.getByTestId('colfilter-version')).toHaveClass(/on/);
  const chip = page.getByTestId('colfilter-chip-version');
  await expect(chip).toContainText('גרסה');
  await expect(chip).toContainText('המפונקת');
  await expect(page.locator('#sub')).toHaveText('מציג 2 מתוך 6 הזמנות');

  // The chip clears it.
  await chip.click();
  expect(await names(page)).toHaveLength(6);
  await expect(page.getByTestId('colfilter-version')).not.toHaveClass(/on/);
});

test('several values in one column are OR, and the menu stays open between them', async ({
  page,
}) => {
  await openAdmin(page);
  await pick(page, 'version', 'המפונקת (משלוח)');
  // Still open — the useful questions are plural, and a menu that closed on every
  // tick would make the second value a second trip.
  await expect(page.locator('.colmenu')).toBeVisible();
  await page
    .locator('.colmenu label', { hasText: 'משחק מוכן (איסוף)' })
    .locator('input')
    .first()
    .check();
  await expect(page.locator('.colmenu')).toBeVisible();

  expect((await names(page)).sort()).toEqual([
    'איסוף-מודרני',
    'איסוף-קלאסי',
    'משלוח-מודרני',
    'משלוח-קלאסי',
  ]);
  await expect(page.getByTestId('colfilter-version')).toHaveText('2 ▾');
});

test('two columns are ANDed', async ({ page }) => {
  await openAdmin(page);
  await pick(page, 'version', 'המפונקת (משלוח)');
  await page.keyboard.press('Escape');
  await pick(page, 'design', 'קלאסי');
  expect(await names(page)).toEqual(['משלוח-קלאסי']);
  await expect(page.getByTestId('colfilter-clear-all')).toBeVisible();

  // …and "נקה הכל" puts every column back at once.
  await page.keyboard.press('Escape');
  await page.getByTestId('colfilter-clear-all').click();
  expect(await names(page)).toHaveLength(6);
});

test('the counts in a menu are what that value would actually show', async ({ page }) => {
  await openAdmin(page);
  // With nothing else on: two designs, three and three.
  await page.getByTestId('colfilter-design').click();
  const counts = async () =>
    Object.fromEntries(
      await page
        .locator('.colmenu label')
        .evaluateAll((ls) =>
          ls.map((l) => [
            l.querySelector('span:not(.n)').textContent,
            Number(l.querySelector('.n').textContent),
          ])
        )
    );
  expect(await counts()).toEqual({ קלאסי: 3, מודרני: 3 });
  await page.keyboard.press('Escape');

  // Filter another column, and the design counts follow it…
  await pick(page, 'version', 'המפונקת (משלוח)');
  await page.keyboard.press('Escape');
  await page.getByTestId('colfilter-design').click();
  expect(await counts()).toEqual({ קלאסי: 1, מודרני: 1 });
  await page.keyboard.press('Escape');

  // …while a column's OWN choice is excluded from its own counts, so the numbers
  // say what each value WOULD give rather than what it gives on top of itself.
  await page.getByTestId('colfilter-version').click();
  const versionCounts = await counts();
  expect(versionCounts['המפונקת (משלוח)']).toBe(2);
  expect(versionCounts['משחק מוכן (איסוף)']).toBe(2);
});

test('column filters AND with the payment and stage rows', async ({ page }) => {
  await openAdmin(page);
  await pick(page, 'design', 'קלאסי');
  await page.keyboard.press('Escape');
  expect((await names(page)).sort()).toEqual(['איסוף-קלאסי', 'דיגיטלי-קלאסי', 'משלוח-קלאסי']);

  // Only the paid ones of those.
  await page.locator('#tabs .tab', { hasText: 'שולמו' }).click();
  expect((await names(page)).sort()).toEqual(['איסוף-קלאסי', 'משלוח-קלאסי']);
});

// A menu only offers values that are actually there, which is the useful half of
// faceting: you cannot pick your way into an empty table.
test('a menu never offers a value that would show nothing', async ({ page }) => {
  await openAdmin(page);
  // Only one design has a digital order, so with "דיגיטלי" chosen the design menu
  // must not offer the other one.
  await pick(page, 'version', 'דיגיטלי');
  await page.keyboard.press('Escape');
  await page.getByTestId('colfilter-design').click();
  const offered = await page.locator('.colmenu label span:not(.n)').allTextContents();
  expect(offered).toEqual(['קלאסי']);
});

// An empty table CAN still happen — the payment/stage rows above are chosen
// independently of the column menus. When it does, it must read as a narrowing.
test('an empty result names the filters, and the strip is still there to undo it', async ({
  page,
}) => {
  await openAdmin(page);
  await pick(page, 'design', 'קלאסי');
  await page.keyboard.press('Escape');
  await page.locator('#tabs-stage .tab', { hasText: 'מבוטלות' }).click();

  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.locator('#content')).toContainText('אין רשומות שמתאימות לסינון');
  await expect(page.locator('#content')).toContainText('עיצוב');

  // The strip lives outside the table, so it survives the table being empty.
  await expect(page.getByTestId('colfilter-chip-design')).toBeVisible();
  await page.getByTestId('colfilter-chip-design').click();
  await page.locator('#tabs-stage .tab', { hasText: 'הכל' }).click();
  expect(await names(page)).toHaveLength(6);
});

test('on a phone the filters are reachable even though the headings are hidden', async ({
  page,
}) => {
  await openAdmin(page, { width: 390, height: 900 });
  // The stacked-card layout takes the <thead> off screen…
  await expect(page.locator('thead')).not.toBeInViewport();
  // …so the strip carries an opener per filterable column.
  const opener = page.getByTestId('colfilter-bar-version');
  await expect(opener).toBeVisible();
  await expect(opener).toHaveText('גרסה ▾');

  await opener.click();
  await page
    .locator('.colmenu label', { hasText: 'משחק מוכן (איסוף)' })
    .locator('input')
    .first()
    .check();
  expect((await names(page)).sort()).toEqual(['איסוף-מודרני', 'איסוף-קלאסי']);
});

// The opener can sit at the very bottom edge of a phone screen (the admin nav
// wraps to three rows there, and the strip follows it down). The browser scrolls
// such a control into view before delivering its click, and that scroll event
// arrives AFTER the menu has opened — so a menu that closes on any scroll used to
// vanish the instant it appeared, and no value could ever be ticked.
test('a menu opened from the bottom edge survives the scroll that opening it caused', async ({
  page,
}) => {
  // Short enough that the strip is below the fold and the click must scroll.
  await openAdmin(page, { width: 390, height: 640 });
  const opener = page.getByTestId('colfilter-bar-version');
  await opener.scrollIntoViewIfNeeded();
  await opener.click();

  const menu = page.locator('.colmenu');
  await expect(menu).toBeVisible();
  // Give the scroll event its frame, then a couple more: it must still be there.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
  await expect(menu).toBeVisible();

  await menu.locator('label', { hasText: 'משחק מוכן (איסוף)' }).locator('input').first().check();
  expect((await names(page)).sort()).toEqual(['איסוף-מודרני', 'איסוף-קלאסי']);

  // A REAL scroll still closes it — the grace is one frame, not a repeal.
  await page.mouse.wheel(0, 120);
  await expect(menu).toHaveCount(0);
});
