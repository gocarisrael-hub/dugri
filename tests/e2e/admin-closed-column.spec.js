import { test, expect } from '@playwright/test';

const KEY = 'dugri-admin';

// Unique per call so the parallel device projects (which share one server + JSON
// store) never collide on a honoree name.
const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

async function seed(request, { name, words = ['א', 'ב'], close = false }) {
  const create = await request.post('/api/collections', {
    data: { honoree_name: name, email: `${Math.random().toString(36).slice(2)}@example.com` },
  });
  const { id, owner_token } = await create.json();
  await request.post(`/api/collections/${id}/words`, { data: { words } });
  await request.post(`/api/collections/${id}/order`, { data: { owner_token, version: 'pickup' } });
  if (close) await request.post(`/api/collections/${id}/close`, { data: { owner_token } });
  return { id, owner_token };
}

// The honoree name of every row, top to bottom — the table's current order.
// The honoree is the SECOND cell: ניהול leads the row, so the buttons are
// reachable without scrolling the table sideways.
const rowNames = (page) =>
  page.$$eval('tbody tr td:nth-child(2)', (tds) => tds.map((td) => td.textContent || ''));

test('נסגר shows when the buyer closed her list, and a dash while it is open', async ({
  page,
  request,
}) => {
  const closedName = uniq('נסגרה');
  const openName = uniq('פתוחה');
  await seed(request, { name: closedName, close: true });
  await seed(request, { name: openName });

  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('table')).toBeVisible();
  await expect(page.locator('thead')).toContainText('נסגר');

  // The closed list carries the moment the clock started, plus how long ago it
  // was — that pair is the whole point of the column.
  const closedCell = page
    .locator('tbody tr', { hasText: closedName })
    .locator('td[data-label="נסגר"]');
  await expect(closedCell).toContainText(/\d{2}\.\d{2}/);
  await expect(closedCell).toContainText('לפני');

  // A list still collecting words has no close time and must not invent one.
  const openCell = page.locator('tbody tr', { hasText: openName }).locator('td[data-label="נסגר"]');
  await expect(openCell).toHaveText('—');
});

test('sorting by נסגר queues the longest-waiting order first', async ({ page, request }) => {
  const first = uniq('ראשונה');
  const second = uniq('שנייה');
  const stillOpen = uniq('עודפתוחה');
  await seed(request, { name: first, close: true });
  await seed(request, { name: second, close: true });
  await seed(request, { name: stillOpen });

  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('tbody tr').first()).toBeVisible();

  await page.locator('#sort').selectOption('closed');
  await expect(page.locator('tbody tr').first()).toBeVisible();

  const names = await rowNames(page);
  const at = (n) => names.findIndex((t) => t.includes(n));
  // Closed earliest = waiting longest = produce it next.
  expect(at(first)).toBeGreaterThanOrEqual(0);
  expect(at(first)).toBeLessThan(at(second));
  // Nothing was handed over on a list still open, so it sits below both.
  expect(at(second)).toBeLessThan(at(stillOpen));

  // The default sort (newest created first) is the other way round — proving the
  // order above came from the close time and not from the seeding order.
  await page.locator('#sort').selectOption('created');
  const byCreated = await rowNames(page);
  expect(byCreated.findIndex((t) => t.includes(second))).toBeLessThan(
    byCreated.findIndex((t) => t.includes(first))
  );
});

// The regression this page shipped with: "לדפוס" and "מוכן" were added to the row
// while the hard-coded label list stayed at seventeen entries, so on a phone every
// card from "הפקה" down printed its value under the WRONG heading (the close time
// appeared as "וואטסאפ", the WhatsApp button as "ניהול"). Labels now come from the
// same column list the <thead> does; this checks the two can't drift apart again.
test('every phone-card label is the heading of its own column', async ({ page, request }) => {
  const name = uniq('תווית');
  await seed(request, { name, close: true });

  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('tbody tr').first()).toBeVisible();

  const { heads, labels } = await page.evaluate(() => ({
    // The heading's NAME, not its whole content: a filterable heading also holds
    // the column's filter control (see admin-column-filters.spec.js).
    heads: [...document.querySelectorAll('thead th')].map(
      (th) => th.querySelector('.th-in span')?.textContent ?? th.textContent
    ),
    labels: [...document.querySelectorAll('tbody tr:first-child td')].map(
      (td) => td.dataset.label || null
    ),
  }));
  expect(labels).toEqual(heads);
});

// The owner's layout for this table: the buttons lead, ONE identity column says
// what the deck prints, and four columns she never used are gone. The four are
// worth pinning by NAME — "הפקה" in particular carried the PDF/board/press
// controls, and those had to survive its removal (they live in ניהול).
test('the row leads with ניהול, then the title, and drops the unused columns', async ({
  page,
  request,
}) => {
  const name = uniq('סדר');
  const title = uniq('הכותרת-שלי');
  await seed(request, { name, close: true });
  await request.post(`/api/collections`, { data: { honoree_name: name, custom_title: title } });

  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('tbody tr').first()).toBeVisible();

  const heads = await page.$$eval('thead th', (ths) => ths.map((th) => th.textContent.trim()));
  expect(heads[0]).toBe('ניהול');
  // ONE identity column now: the printed title. The honoree column beside it was
  // the same fact told twice, once the buyer stopped giving us a name at all.
  expect(heads[1]).toBe('כותרת');
  expect(heads).not.toContain('בעל/ת השמחה');
  for (const gone of ['צ׳ייסרים', 'הפקה', 'צבע', 'סכום']) {
    expect(heads, `${gone} should be gone`).not.toContain(gone);
  }
  // Every row still carries exactly one cell per heading.
  const widths = await page.$$eval('tbody tr', (trs) => trs.map((tr) => tr.children.length));
  for (const w of widths) expect(w).toBe(heads.length);

  // The production controls did NOT go with "הפקה" — they were always in ניהול,
  // which is now the first cell.
  await expect(page.locator('tbody tr td:first-child').first()).toContainText('צור PDF');

  // The title IS the identity cell.
  const titled = page.locator('tbody tr', { hasText: title }).first();
  await expect(titled.locator('td:nth-child(2)')).toHaveText(title);
  // …and an order from before the change, which has no title of its own, falls
  // back to its name rather than reading as an empty row.
  const legacy = page.locator('tbody tr', { hasText: name }).last();
  await expect(legacy.locator('td:nth-child(2)')).toHaveText(name);
});

// The buttons the owner reported: squeezed into slivers, one letter per line.
// A row action must always be one line tall and wide enough to read.
for (const [label, width] of [
  ['phone', 390],
  ['laptop', 1440],
]) {
  test(`row actions stay full-size on a ${label}`, async ({ page, request }) => {
    const name = uniq('כפתורים');
    await seed(request, { name, close: true });

    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/admin.html?key=${KEY}`);
    const row = page.locator('tbody tr', { hasText: name });
    await expect(row).toHaveCount(1);

    const boxes = await row.locator('button:visible, a.act:visible').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { text: (el.textContent || '').trim(), w: r.width, h: r.height };
      })
    );
    expect(boxes.length).toBeGreaterThan(4);
    for (const b of boxes) {
      // One line: a wrapped label doubles the height, and a label broken per
      // character multiplies it.
      expect(b.h, `${b.text} is ${b.h}px tall — its label wrapped`).toBeLessThan(40);
      // Wide enough to hold the label rather than a shrunken column of letters.
      expect(b.w, `${b.text} is only ${b.w}px wide`).toBeGreaterThan(6 * b.text.length);
    }
  });
}

// The wide table scrolls INSIDE its box; the page itself never does. That is what
// keeps the filter tabs and the sort control reachable on a phone.
test('the widened table never side-scrolls the page', async ({ page, request }) => {
  await seed(request, { name: uniq('רוחב'), close: true });

  for (const width of [390, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/admin.html?key=${KEY}`);
    await expect(page.locator('tbody tr').first()).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    expect(overflows, `page scrolls sideways at ${width}px`).toBe(false);
  }
});
