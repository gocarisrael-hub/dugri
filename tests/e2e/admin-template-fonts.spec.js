import { test, expect } from '@playwright/test';

// The FONT rows on the admin templates screen.
//
// A template may carry two OPTIONAL second faces: a Latin face every English
// word is set in, and a second title face for a title written in the script the
// template's own title face cannot draw. Both are uploaded here, and — because
// a font has already been uploaded to the wrong template once — both can be
// REMOVED here without support.
//
// The screen also has to make the state legible: which face is on which role,
// what each one is FOR in her words, and which templates have a script gap (the
// מרקאנה case — a League Spartan title font with no Hebrew glyphs and a Hebrew
// honoree name, where the back title silently did not print).
//
// Fully MOCKED — the list and the DELETE are stubbed — so this never touches the
// shared fixture or the owner store and can run beside the mutating specs.
const KEY = 'dugri-admin';

const FONT_ASSETS = [
  {
    role: 'title-font',
    label: 'פונט כותרת',
    kind: 'font',
    optional: false,
    present: true,
    rel: 'fonts/LeagueSpartan-Bold.ttf',
    fontName: 'LeagueSpartan-Bold.ttf',
    scripts: { hebrew: false, latin: true },
  },
  {
    role: 'title-font-alt',
    label: 'פונט כותרת שני — לכותרת בשפה שהפונט הראשי לא יודע לצייר (רשות)',
    kind: 'font',
    optional: true,
    present: false,
    rel: null,
    fontName: null,
    scripts: null,
  },
  {
    role: 'word-font',
    label: 'פונט מילים',
    kind: 'font',
    optional: false,
    present: true,
    rel: 'fonts/Playpen.ttf',
    fontName: 'Playpen.ttf',
    scripts: { hebrew: true, latin: true },
  },
  {
    role: 'word-font-alt',
    label: 'פונט למילים באנגלית — כל מילה באנגלית תודפס בו (רשות)',
    kind: 'font',
    optional: true,
    present: true,
    rel: 'fonts/Latin.otf',
    fontName: 'Latin.otf',
    scripts: { hebrew: false, latin: true },
  },
];

const TEMPLATE = {
  key: 'markana',
  slug: 'markana',
  display_he: 'מרקאנה',
  visibility: 'public',
  in_store: true,
  calibrated: true,
  language: 'english',
  name_form: 'hebrew',
  extra_fields: [],
  title_text: "{NAME}'s B-day",
  title_lines: ["{NAME}'s B-day"],
  title_style: { fill: '#000000', outline: '#ffffff' },
  board: null,
  back: null,
  assets: FONT_ASSETS,
  complete: true,
  missingRequired: [],
  fontNotes: [
    {
      role: 'title-font-alt',
      text: 'פונט הכותרת של התבנית לא יודע לצייר עברית — כותרת עם שם בעברית לא תודפס. העלו פונט כותרת שני שיודע עברית.',
    },
  ],
};

async function mockList(page, overrides) {
  await page.route('**/api/admin/templates?key=*', (route) =>
    route.fulfill({ json: { templates: [{ ...TEMPLATE, ...(overrides || {}) }] } })
  );
}

const card = (page) => page.locator('.tpl-card[data-key="markana"]');

test.describe('admin templates — the second fonts', () => {
  test('every font role is offered, including the two optional second faces', async ({ page }) => {
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    for (const role of ['title-font', 'title-font-alt', 'word-font', 'word-font-alt']) {
      await expect(card(page).locator(`.asset[data-role="${role}"]`)).toHaveCount(1);
    }
    // An optional face nobody uploaded reads as "not uploaded" — never as
    // missing or broken, which is what it would be if the role were required.
    const alt = card(page).locator('.asset[data-role="title-font-alt"]');
    await expect(alt).toContainText('לא הועלה');
    await expect(alt.locator('.repl')).toHaveText('העלה');
    await expect(card(page).locator('.tpl-badge.incomplete')).toHaveCount(0);
  });

  test('a font row names its FILE and says which scripts that file can draw', async ({ page }) => {
    // With four font roles a bare ✓ no longer says what the template prints
    // with — and the whole point of a second face is a face that cannot draw
    // the script it is being handed.
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const title = card(page).locator('.asset[data-role="title-font"]');
    await expect(title).toContainText('LeagueSpartan-Bold.ttf');
    await expect(title).toContainText('יודע אנגלית');
    await expect(card(page).locator('.asset[data-role="word-font"]')).toContainText(
      'יודע עברית + אנגלית'
    );
  });

  test('a script gap is spelled out — this title font cannot draw Hebrew', async ({ page }) => {
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const notes = card(page).locator('.tpl-font-notes li');
    await expect(notes).toHaveCount(1);
    await expect(notes.first()).toContainText('לא יודע לצייר עברית');
    await expect(notes.first()).toContainText('פונט כותרת שני');
  });

  test('an optional font can be removed; a required one offers no such button', async ({
    page,
  }) => {
    await mockList(page);
    let deleted = null;
    await page.route('**/api/admin/templates/markana/assets/*', async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      deleted = new URL(route.request().url()).pathname;
      await route.fulfill({
        json: { ok: true, key: 'markana', role: 'word-font-alt', removed: true, fileDeleted: true },
      });
    });
    page.on('dialog', (d) => d.accept());

    await page.goto(`/admin-templates.html?key=${KEY}`);
    // Only where removal is real: the two required faces cannot be removed at
    // all (the server refuses), so no button is offered for them.
    await expect(card(page).locator('.asset[data-role="title-font"] .asset-remove')).toHaveCount(0);
    await expect(card(page).locator('.asset[data-role="word-font"] .asset-remove')).toHaveCount(0);
    // Nor on an optional role with nothing on it — there is nothing to undo.
    await expect(
      card(page).locator('.asset[data-role="title-font-alt"] .asset-remove')
    ).toHaveCount(0);

    await card(page).locator('.asset[data-role="word-font-alt"] .asset-remove').click();
    await expect.poll(() => deleted).toContain('/assets/word-font-alt');
    await expect(card(page).locator('.tpl-msg.ok')).toContainText('הפונט הוסר');
  });

  test('a removal that only cleared the field says the file is still in use', async ({ page }) => {
    // A template may record ONE file under two roles; clearing one field must
    // not delete the font the other is still printing with, and the owner has to
    // be told which of the two happened.
    await mockList(page);
    await page.route('**/api/admin/templates/markana/assets/*', async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      await route.fulfill({
        json: {
          ok: true,
          key: 'markana',
          role: 'word-font-alt',
          removed: true,
          fileDeleted: false,
        },
      });
    });
    page.on('dialog', (d) => d.accept());
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await card(page).locator('.asset[data-role="word-font-alt"] .asset-remove').click();
    await expect(card(page).locator('.tpl-msg.ok')).toContainText('הקובץ נשאר');
  });

  test('dismissing the confirmation removes nothing', async ({ page }) => {
    await mockList(page);
    let calls = 0;
    await page.route('**/api/admin/templates/markana/assets/*', async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      calls += 1;
      await route.fulfill({ json: { ok: true, removed: true } });
    });
    page.on('dialog', (d) => d.dismiss());
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await card(page).locator('.asset[data-role="word-font-alt"] .asset-remove').click();
    await page.waitForTimeout(200);
    expect(calls).toBe(0);
  });

  test('the onboarding form offers both second fonts, and neither is required', async ({
    page,
  }) => {
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    for (const name of ['word_font_alt', 'title_font_alt']) {
      const input = page.locator(`#form input[name="${name}"]`);
      await expect(input).toHaveCount(1);
      expect(await input.evaluate((el) => el.required)).toBe(false);
      expect(await input.getAttribute('accept')).toBe('.ttf,.otf');
    }
    // The originals stay required — a template still cannot render without them.
    for (const name of ['word_font', 'title_font']) {
      const input = page.locator(`#form input[name="${name}"]`);
      expect(await input.evaluate((el) => el.required)).toBe(true);
    }
  });
});
