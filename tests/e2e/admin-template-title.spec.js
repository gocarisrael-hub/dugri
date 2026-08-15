import { test, expect } from '@playwright/test';

// The TITLE editor on the admin templates screen.
//
// A template was onboarded whose title carried no usable {NAME}, so every card
// printed "'s Birthday" — and there was NO way to change it: the settings patch
// accepted no title field at all. These specs cover the editor that fixes that:
// one input per RENDERED line (title_lines is a list; the generator stacks one
// line per entry and fits the title box to the stack), the placeholder palette,
// the mismatch warning, the no-{NAME} confirmation, and the automatic re-render
// after a save so the corrected title is actually seen.
//
// Fully MOCKED — the template list, the settings POST and /api/preview are all
// stubbed — so nothing here touches the shared e2e fixture or the owner store,
// and the spec can run concurrently with the mutating template specs.
const KEY = 'dugri-admin';

const TEMPLATE = {
  key: 'nameless',
  slug: 'nameless',
  display_he: 'יום הולדת',
  visibility: 'public',
  in_store: true,
  // Uncalibrated so the calibration panel (and its preview button) is open by
  // default — that is also the state a freshly onboarded template is in.
  calibrated: false,
  language: 'english',
  name_form: 'english',
  extra_fields: [],
  assets: [],
  // The reported breakage, exactly: no {NAME} anywhere in the rendered lines.
  title_text: "'s\nBirthday",
  title_lines: ["'s", 'Birthday'],
  title_style: { fill: '#000000', outline: '#ffffff' },
  board: null,
  back: null,
};

// Stub the list; `overrides` patches the single template it returns.
async function mockList(page, overrides) {
  await page.route('**/api/admin/templates?key=*', (route) =>
    route.fulfill({ json: { templates: [{ ...TEMPLATE, ...(overrides || {}) }] } })
  );
}

// The editor lives in the settings <details>, which springs open by itself only
// when the title is actually broken. Open it either way so a spec never depends
// on that.
async function openSettings(page) {
  const details = page.locator('.tpl-card[data-key="nameless"] .tpl-settings');
  await expect(details).toBeVisible();
  if (!(await details.evaluate((d) => d.open))) await details.locator('summary').click();
  return details;
}

test.describe('admin templates — the title editor', () => {
  test('shows the saved title as one input per rendered line', async ({ page }) => {
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const ed = page.locator('.tpl-card[data-key="nameless"] .tpl-title-ed');
    await expect(ed).toBeVisible();
    // Two lines in, two inputs out — NOT one blob. Where the break falls is a
    // layout decision the renderer honors.
    await expect(ed.locator('.title-line-input')).toHaveCount(2);
    await expect(ed.locator('.title-line-input').nth(0)).toHaveValue("'s");
    await expect(ed.locator('.title-line-input').nth(1)).toHaveValue('Birthday');
  });

  test('a title that cannot print its name is badged on the card head', async ({ page }) => {
    // The whole failure was that nobody noticed until a customer's cards came out
    // reading "'s Birthday". The badge sits beside the uncalibrated one, so the
    // problem is visible without opening anything — and a healthy title shows none.
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const badge = page.locator('.tpl-card[data-key="nameless"] .tpl-badge.notitle');
    await expect(badge).toBeVisible();

    await page.unroute('**/api/admin/templates?key=*');
    await mockList(page, { title_lines: ["{NAME}'S", 'BIRTHDAY'] });
    await page.reload();
    await expect(page.locator('.tpl-card[data-key="nameless"] .tpl-title-ed')).toHaveCount(1);
    await expect(badge).toHaveCount(0);
  });

  test('a title using a field the template does not collect is badged too', async ({ page }) => {
    // {AGE} with no AGE in extra_fields prints a gap — the same failure wearing a
    // different hat, and just as invisible.
    await mockList(page, { title_lines: ['{NAME} בן {AGE}'], extra_fields: [] });
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await expect(page.locator('.tpl-card[data-key="nameless"] .tpl-badge.notitle')).toBeVisible();
  });

  test('warns that the title prints no name, and stops warning once {NAME} is added', async ({
    page,
  }) => {
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const ed = page.locator('.tpl-card[data-key="nameless"] .tpl-title-ed');
    await expect(ed.locator('.title-warn')).toContainText('{NAME}');
    await ed.locator('.title-line-input').nth(0).fill("{NAME}'s");
    await expect(ed.locator('.title-warn')).toHaveText('');
  });

  test('lists the placeholders available for THIS template and inserts one on click', async ({
    page,
  }) => {
    // {NAME} always; {AGE} only because this template collects it. The owner
    // cannot be expected to remember the syntax, and the legal set is per-template.
    await mockList(page, { extra_fields: ['AGE'], title_lines: ['{NAME}', '{AGE}'] });
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const ed = page.locator('.tpl-card[data-key="nameless"] .tpl-title-ed');
    await expect(ed.locator('.title-ph code')).toHaveText(['{NAME}', '{AGE}']);

    const second = ed.locator('.title-line-input').nth(1);
    await second.fill('בן ');
    await ed.locator('.title-ph code', { hasText: '{AGE}' }).click();
    await expect(second).toHaveValue('בן {AGE}');
  });

  test('the palette follows extra_fields as it is typed', async ({ page }) => {
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const card = page.locator('.tpl-card[data-key="nameless"]');
    await expect(card.locator('.title-ph code')).toHaveText(['{NAME}']);
    await card.locator('input[data-field="extra_fields"]').fill('AGE');
    await expect(card.locator('.title-ph code')).toHaveText(['{NAME}', '{AGE}']);
  });

  test('flags a placeholder the template does not collect', async ({ page }) => {
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const ed = page.locator('.tpl-card[data-key="nameless"] .tpl-title-ed');
    // {AGE} with no AGE in extra_fields: the wizard never asks for it, so the
    // generator strips it and the card prints a gap. Exactly the reported bug.
    await ed.locator('.title-line-input').nth(0).fill('{NAME} בן {AGE}');
    await expect(ed.locator('.title-warn')).toContainText('{AGE}');
    await expect(ed.locator('.title-warn')).toContainText('extra_fields');
  });

  test('a gender marker is NOT read as a missing field', async ({ page }) => {
    // The reported harm: she pasted {m:בן|f:בת} into a title and the screen told
    // her the template does not collect a field called "m:בן|f:בת" and that "the
    // card will print without it". Both false — the server strips markers before
    // placeholder validation (it accepts this save), and the card prints the
    // word. The screen simply never learned about markers.
    // A SAVED title carrying the marker must not be badged as broken on the card
    // head either — that badge is what "this template is broken" looks like at a
    // glance, and it was lighting up on a perfectly good title.
    await mockList(page, { title_lines: ['{NAME} {m:בן|f:בת}'], title_text: '{NAME} {m:בן|f:בת}' });
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await expect(page.locator('.tpl-card[data-key="nameless"]')).toBeVisible();
    await expect(page.locator('.tpl-card[data-key="nameless"] .tpl-badge.notitle')).toHaveCount(0);
    await openSettings(page);
    const ed = page.locator('.tpl-card[data-key="nameless"] .tpl-title-ed');
    await expect(ed.locator('.title-warn')).toHaveText('');
    // ...and typing one into the editor raises no warning as she types.
    await ed.locator('.title-line-input').nth(0).fill('{NAME} {f:בת|m:בן}');
    await expect(ed.locator('.title-warn')).toHaveText('');
  });

  test('an UNLABELLED gender marker is still called out, as a marker problem', async ({ page }) => {
    // Stripping markers before the placeholder scan must not swallow a broken
    // one: the server refuses "{בן|בת}" on purpose (with a free-form order,
    // position cannot also say which word is masculine), so saying nothing here
    // would leave her staring at a 400 she was given no warning about.
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const ed = page.locator('.tpl-card[data-key="nameless"] .tpl-title-ed');
    await ed.locator('.title-line-input').nth(0).fill('{NAME} {בן|בת}');
    await expect(ed.locator('.title-warn')).toContainText('{m:בן|f:בת}');
    // Both forms labelled the same is refused too.
    await ed.locator('.title-line-input').nth(0).fill('{NAME} {m:בן|m:בת}');
    await expect(ed.locator('.title-warn')).toContainText('מגדר');
  });

  test('a warning about an uncollected field says what is CHECKED, not what will print', async ({
    page,
  }) => {
    // The old text ended "הקלף יודפס בלעדיו" — an outcome this screen never
    // measured, and the wrong one: the SAVE is what the server refuses.
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const ed = page.locator('.tpl-card[data-key="nameless"] .tpl-title-ed');
    await ed.locator('.title-line-input').nth(0).fill('{NAME} בן {AGE}');
    await expect(ed.locator('.title-warn')).toContainText('השמירה תידחה');
    await expect(ed.locator('.title-warn')).not.toContainText('יודפס בלעדיו');
  });

  test('lines can be added and removed, and the last one is never deleted away', async ({
    page,
  }) => {
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const ed = page.locator('.tpl-card[data-key="nameless"] .tpl-title-ed');
    await ed.locator('.title-line-add').click();
    await expect(ed.locator('.title-line-input')).toHaveCount(3);
    await ed.locator('.title-line-del').nth(2).click();
    await ed.locator('.title-line-del').nth(1).click();
    await expect(ed.locator('.title-line-input')).toHaveCount(1);
    // The last row is emptied rather than removed — an editor with nothing to
    // type into is a dead end.
    await ed.locator('.title-line-del').nth(0).click();
    await expect(ed.locator('.title-line-input')).toHaveCount(1);
    await expect(ed.locator('.title-line-input').nth(0)).toHaveValue('');
  });

  test('saves the title as a LIST and re-renders it immediately', async ({ page }) => {
    await mockList(page);
    let saved = null;
    await page.route('**/api/admin/templates/nameless/settings?key=*', async (route) => {
      saved = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({ json: { ok: true, key: 'nameless', settings: {} } });
    });
    let previewed = 0;
    await page.route('**/api/preview*', async (route) => {
      previewed += 1;
      await route.fulfill({ json: { card: 'data:image/png;base64,iVBORw0KGgo=' } });
    });

    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const card = page.locator('.tpl-card[data-key="nameless"]');
    await card.locator('.title-line-input').nth(0).fill("{NAME}'s");
    await card.locator('.tpl-settings-save').click();

    // Sent as the LIST the generator reads, one entry per rendered line.
    await expect.poll(() => saved && saved.title_lines).toEqual(["{NAME}'s", 'Birthday']);
    // A saved title is only believable once RENDERED — the preview fires by
    // itself instead of leaving the owner to save blind and hunt for the button.
    await expect.poll(() => previewed).toBeGreaterThan(0);
    await expect(page.locator('.tpl-card[data-key="nameless"] .cal-preview img')).toHaveCount(1);
  });

  test('a save that does not touch the title does NOT spend a render', async ({ page }) => {
    await mockList(page);
    await page.route('**/api/admin/templates/nameless/settings?key=*', (route) =>
      route.fulfill({ json: { ok: true, key: 'nameless', settings: {} } })
    );
    let previewed = 0;
    await page.route('**/api/preview*', async (route) => {
      previewed += 1;
      await route.fulfill({ json: { card: 'data:image/png;base64,iVBORw0KGgo=' } });
    });
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const card = page.locator('.tpl-card[data-key="nameless"]');
    await card.locator('select[data-field="visibility"]').selectOption('private');
    await card.locator('.tpl-settings-save').click();
    // The confirmation lands on the card that SURVIVES the list reload.
    await expect(page.locator('.tpl-card[data-key="nameless"] .tpl-msg.ok')).toContainText('נשמרו');
    expect(previewed).toBe(0);
  });

  test('a title with no {NAME} needs an explicit confirmation — dismissing writes nothing', async ({
    page,
  }) => {
    await mockList(page);
    const posts = [];
    await page.route('**/api/admin/templates/nameless/settings?key=*', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      posts.push(body);
      // The server refuses a nameless title ONCE, flagging it as confirmable.
      if (!body.allow_titleless) {
        return route.fulfill({
          status: 400,
          json: { error: 'title has no {NAME} placeholder', titleless: true },
        });
      }
      return route.fulfill({ json: { ok: true, key: 'nameless', settings: {} } });
    });

    let asked = '';
    page.on('dialog', (d) => {
      asked = d.message();
      d.dismiss();
    });
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const card = page.locator('.tpl-card[data-key="nameless"]');
    await card.locator('.title-line-input').nth(0).fill('Bride in One Pot');
    await card.locator('.title-line-del').nth(1).click();
    await card.locator('.tpl-settings-save').click();

    await expect.poll(() => asked).toContain('{NAME}');
    // Dismissed → exactly one request, and no confirmed re-post.
    await expect(card.locator('.tpl-settings-save')).toBeEnabled();
    expect(posts).toHaveLength(1);
    expect(posts[0].allow_titleless).toBeUndefined();
  });

  test('confirming a nameless title re-posts with allow_titleless and saves', async ({ page }) => {
    // A fixed title is legitimate — some decks carry no honoree name at all — so
    // it must be POSSIBLE, just never reachable by accident.
    await mockList(page);
    const posts = [];
    await page.route('**/api/admin/templates/nameless/settings?key=*', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      posts.push(body);
      if (!body.allow_titleless) {
        return route.fulfill({
          status: 400,
          json: { error: 'title has no {NAME} placeholder', titleless: true },
        });
      }
      return route.fulfill({ json: { ok: true, key: 'nameless', settings: {} } });
    });
    await page.route('**/api/preview*', (route) =>
      route.fulfill({ json: { card: 'data:image/png;base64,iVBORw0KGgo=' } })
    );
    page.on('dialog', (d) => d.accept());

    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const card = page.locator('.tpl-card[data-key="nameless"]');
    await card.locator('.title-line-input').nth(0).fill('Bride in One Pot');
    await card.locator('.tpl-settings-save').click();

    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1].allow_titleless).toBe(true);
    expect(posts[1].title_lines).toEqual(['Bride in One Pot', 'Birthday']);
    // …and the confirmed save renders, same as any other title edit.
    await expect(page.locator('.tpl-card[data-key="nameless"] .cal-preview img')).toHaveCount(1);
  });

  test('a mismatch rejection is shown as-is and is NOT confirmable', async ({ page }) => {
    await mockList(page);
    const posts = [];
    await page.route('**/api/admin/templates/nameless/settings?key=*', async (route) => {
      posts.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({
        status: 400,
        json: { error: 'title uses {AGE} but the template does not collect it' },
      });
    });
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs += 1;
      d.accept();
    });
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await openSettings(page);
    const card = page.locator('.tpl-card[data-key="nameless"]');
    await card.locator('.title-line-input').nth(0).fill('{NAME} בן {AGE}');
    await card.locator('.tpl-settings-save').click();
    await expect(card.locator('.tpl-msg.err')).toContainText('{AGE}');
    // No confirmation offered — declaring the field is the only fix.
    expect(dialogs).toBe(0);
    expect(posts).toHaveLength(1);
  });
});

test.describe('admin templates — the onboarding form', () => {
  test('the title field is multi-line, matching "a new line is another title line"', async ({
    page,
  }) => {
    await page.goto(`/admin-templates.html?key=${KEY}`);
    // It was a single-line <input> while the hint promised multi-line titles, so
    // a two-line title was literally impossible to type on the form that creates
    // templates.
    await expect(page.locator('#form textarea[name="title_text"]')).toHaveCount(1);
    await expect(page.locator('#form input[name="title_text"]')).toHaveCount(0);
  });

  test('creating a shell with a nameless title asks for confirmation before registering it', async ({
    page,
  }) => {
    const posts = [];
    await page.route('**/api/admin/templates/create?key=*', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      posts.push(body);
      if (!body.allow_titleless) {
        return route.fulfill({
          status: 400,
          json: { error: 'title has no {NAME} placeholder', titleless: true },
        });
      }
      return route.fulfill({ status: 201, json: { ok: true, key: body.slug } });
    });
    page.on('dialog', (d) => d.accept());
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await page.fill('#form input[name="slug"]', 'titleless-shell');
    await page.fill('#form input[name="display_he"]', 'בלי שם');
    // The composed title lives behind a disclosure now — it is legacy, only ever
    // reached by orders placed before the buyer started typing her own title —
    // so a test that sets one has to open it, the way the owner would.
    await page.locator('#form details.legacy-title > summary').click();
    await page.fill('#form textarea[name="title_text"]', "'s Birthday");
    // A composed title needs a name_form beside it — it decides how {NAME} is
    // cast. The select defaults to "—" now, because a template without a title
    // has no name to cast.
    await page.selectOption('#form select[name="name_form"]', 'hebrew');
    await page.click('#createShell');
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1].allow_titleless).toBe(true);
  });
});
