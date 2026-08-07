import { test, expect } from '@playwright/test';

// The switch over the press build's COLOUR PASS, on the orders page.
//
// Why it is on this page and not in a settings screen: it decides what the "PDF
// לבית דפוס" button next to every order actually produces, and both kinds of
// file end up in the same orders folder looking identical. The owner has to be
// able to see which mode she is in from the page where she presses the button.
//
// Every test here STUBS /api/admin/settings rather than writing to it. The E2E
// server is shared by the parallel device projects and this is a single global
// setting, so a real write would have the two projects fighting over it — and
// what is under test is the page, not the store (server/settings.js has its own
// unit tests, and tests/unit/press-routes.test.js covers what the build does
// with the value).
const KEY = 'dugri-admin';

// Serve a settings payload with press.cmyk_pass at `on`, and record what the
// page POSTs back.
async function stubSettings(page, on) {
  const posted = [];
  let current = on;
  await page.route('**/api/admin/settings*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      posted.push(body);
      current = body.value;
      return route.fulfill({ json: { effective: current } });
    }
    return route.fulfill({
      json: {
        defaults: { press: { cmyk_pass: false } },
        overrides: {},
        effective: { press: { cmyk_pass: current } },
        registry: { press: { cmyk_pass: { tokens: [], kind: 'flag' } } },
      },
    });
  });
  return posted;
}

const switchBox = (page) => page.locator('#press-cmyk');
const note = (page) => page.locator('#press-cmyk-note');

test('the orders page shows which press file the button will produce', async ({ page }) => {
  await stubSettings(page, false);
  await page.goto(`/admin.html?key=${KEY}`);

  await expect(switchBox(page)).toBeVisible();
  await expect(switchBox(page)).not.toBeChecked();
  // The default state has to read as a deliberate choice, not as a missing
  // feature: it says what the shop gets AND what is still sent regardless.
  await expect(note(page)).toContainText('RGB');
  await expect(note(page)).toContainText('בית הדפוס ממיר');
  await expect(note(page)).toContainText('סימוני החיתוך');
});

test('switching the colour pass on saves it and says what changed', async ({ page }) => {
  const posted = await stubSettings(page, false);
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(switchBox(page)).toBeVisible();

  await switchBox(page).check();
  await expect(note(page)).toContainText('CMYK');
  // The cost of turning it back on is stated, because that cost is the entire
  // reason it was turned off.
  await expect(note(page)).toContainText('דקות');
  expect(posted).toEqual([{ section: 'press', key: 'cmyk_pass', value: true }]);
});

test('an ON setting renders as ON after a reload', async ({ page }) => {
  await stubSettings(page, true);
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(switchBox(page)).toBeChecked();
  await expect(note(page)).toContainText('CMYK');
});

test('a refused save snaps the switch back to what the server holds', async ({ page }) => {
  // A switch showing a state the server does not have is worse than one that
  // refuses: the owner would believe the next press build is CMYK when it is
  // not, and the file would go to the shop under that belief.
  //
  // THE REFUSAL IS HELD OPEN by `release` rather than answered straight away,
  // and that is what makes this test say anything. Both of the obvious ways to
  // write it are worthless:
  //
  //   .check()   asserts the box ends up CHECKED — the exact opposite of the
  //              behaviour under test. It only ever passed by winning a race
  //              against the revert, and on CI it lost that race.
  //   .click() followed by expect(not.toBeChecked())  passes VACUOUSLY: the box
  //              starts unchecked, so a click that never landed — or an app that
  //              never tried to save at all — satisfies it just as well.
  //
  // Holding the response lets the intermediate state be asserted for real: the
  // box goes checked, the POST is in flight, and only then does the refusal
  // arrive and have to undo it.
  let release;
  const refused = new Promise((r) => (release = r));
  const posted = [];
  await page.route('**/api/admin/settings*', async (route) => {
    if (route.request().method() === 'POST') {
      posted.push(route.request().postDataJSON());
      await refused;
      return route.fulfill({ status: 500, json: { error: 'nope' } });
    }
    return route.fulfill({
      json: {
        defaults: { press: { cmyk_pass: false } },
        overrides: {},
        effective: { press: { cmyk_pass: false } },
        registry: { press: { cmyk_pass: { tokens: [], kind: 'flag' } } },
      },
    });
  });
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(switchBox(page)).toBeVisible();
  await expect(switchBox(page)).not.toBeChecked();

  // 1. the click really lands, and the switch really shows the new state...
  await switchBox(page).click();
  await expect(switchBox(page)).toBeChecked();
  // 2. ...and the page really tried to persist it, with the right payload.
  await expect.poll(() => posted).toEqual([{ section: 'press', key: 'cmyk_pass', value: true }]);

  // 3. now the save is refused, and the switch has to hand the state back.
  release();
  await expect(switchBox(page)).not.toBeChecked();
  await expect(note(page)).toContainText('RGB');
  await expect(note(page)).not.toContainText('CMYK');
  // 4. and the owner is told, rather than left watching a switch undo itself.
  await expect.poll(() => dialogs.length).toBe(1);
});

test('a settings outage hides the switch but never the orders table', async ({ page }) => {
  // The orders list is what this page is for. A settings hiccup costs the owner
  // the switch, not her ability to see her orders.
  await page.route('**/api/admin/settings*', (route) => route.fulfill({ status: 503, json: {} }));
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('table')).toBeVisible();
  await expect(page.locator('#pressmode')).toBeHidden();
});
