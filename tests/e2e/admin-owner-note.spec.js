import { test, expect } from '@playwright/test';

// The owner's own note, written straight onto the order row. Hers, not the
// buyer's: `comment` is what the customer typed at checkout and lives in the
// edit dialog; this is what WE wrote down, and it is on the row because the
// moment a note gets written is a phone call.
const KEY = 'dugri-admin';

// Unique per call so the parallel device projects (which share one server + JSON
// store) never collide on a honoree name.
const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

async function seed(request, name, extra = {}) {
  const create = await request.post('/api/collections', {
    data: {
      honoree_name: name,
      email: `${Math.random().toString(36).slice(2)}@example.com`,
      ...extra,
    },
  });
  const { id, owner_token } = await create.json();
  await request.post(`/api/collections/${id}/order`, { data: { owner_token, version: 'pickup' } });
  return { id, owner_token };
}

const rowFor = (page, name) => page.locator('tbody tr').filter({ hasText: name });
const noteIn = (page, name) => rowFor(page, name).getByTestId('owner-note');

test('a note typed on the row is saved on blur and survives a reload', async ({
  page,
  request,
}) => {
  const name = uniq('הערה');
  await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);

  const box = noteIn(page, name);
  await expect(box).toHaveValue('');
  await box.fill('מחכה לתמונה שלה');
  // No save button by design — blur is the save.
  await box.blur();

  await page.reload();
  await expect(noteIn(page, name)).toHaveValue('מחכה לתמונה שלה');
});

test('the note reaches the server, not just the screen', async ({ page, request }) => {
  const name = uniq('שרת');
  const { id } = await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);

  const box = noteIn(page, name);
  await box.fill('שלחתי לגלאור ביום שני');
  await box.blur();
  // Wait for the write to land, then read the stored record back over the API.
  await expect
    .poll(async () => {
      const r = await request.get(`/api/admin/collections?key=${KEY}`);
      const d = await r.json();
      return (d.collections || []).find((c) => c.id === id)?.owner_note || '';
    })
    .toBe('שלחתי לגלאור ביום שני');
});

test('blurring an unchanged note writes nothing', async ({ page, request }) => {
  const name = uniq('ללא');
  const { id } = await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);

  let patches = 0;
  await page.route(`**/api/admin/collections/${id}?**`, (route) => {
    if (route.request().method() === 'PATCH') patches++;
    return route.continue();
  });

  // Tabbing through the table must not write to every order it passes.
  const box = noteIn(page, name);
  await box.focus();
  await box.blur();
  await page.waitForTimeout(300);
  expect(patches).toBe(0);
});

test('the 15-second auto-refresh does not eat a half-typed note', async ({ page, request }) => {
  // The table repaints itself every 15s, which would tear the box out from under
  // whoever is typing and lose the words. A note being written is the one thing
  // on this page that cannot be rebuilt from the server, so it wins.
  //
  // Waiting out the REAL timer rather than reaching into the page: the guard
  // lives in a module scope with no window handle, and the behaviour — "my
  // half-typed note is still here, and I am still in it" — is the thing worth
  // asserting anyway.
  test.setTimeout(60000);
  const name = uniq('רענון');
  await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);

  const box = noteIn(page, name);
  await box.click();
  await box.fill('חצי מש');
  await page.waitForTimeout(18000); // one full refresh tick, and then some
  await expect(box).toHaveValue('חצי מש');
  await expect(box).toBeFocused();
});

test('the owner note is its own field — it never touches the buyer’s comment', async ({
  page,
  request,
}) => {
  const name = uniq('נפרד');
  const { id } = await seed(request, name, { comment: 'זו הפתעה, אל תתקשרו אליה' });
  await page.goto(`/admin.html?key=${KEY}`);

  await noteIn(page, name).fill('הודפס פעמיים');
  await noteIn(page, name).blur();

  await expect
    .poll(async () => {
      const r = await request.get(`/api/admin/collections?key=${KEY}`);
      const d = await r.json();
      const c = (d.collections || []).find((x) => x.id === id) || {};
      return `${c.comment || ''}|${c.owner_note || ''}`;
    })
    .toBe('זו הפתעה, אל תתקשרו אליה|הודפס פעמיים');
});

test('every mobile card labels the note with its own column heading', async ({ page, request }) => {
  // The regression #419 fixed structurally: a column added to the row without
  // its heading mislabels every value after it on a phone.
  const name = uniq('תווית');
  await seed(request, name);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin.html?key=${KEY}`);

  const label = await rowFor(page, name)
    .locator('td')
    .filter({ has: page.getByTestId('owner-note') })
    .first()
    .getAttribute('data-label');
  expect(label).toBe('הערה שלי');
});
