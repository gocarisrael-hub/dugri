import { test, expect } from '@playwright/test';

// The order explainer is a POPUP, and that made its copy unreachable to the owner
// in two separate ways:
//
//   1. It only exists after a click on a wizard CTA — and in edit mode that click is
//      swallowed (the CTA is itself editable text, so clicking it places a caret
//      instead of opening anything). There was no way to get the sheet on screen to
//      edit what is inside it. `?explainer=1` is the door, and the toolbar's page
//      picker is the handle.
//   2. Content overrides are stored per page, and this one popup opens from index,
//      products and product — so the same sentence had to be edited three times, and
//      an edit made on one page never reached the other two. Everything inside the
//      sheet now lives in one shared bucket (data-edit-scope).
const SCOPE = 'start-explainer.html';
const OVERLAY = 'start-explainer';

// The sheet enters with a 9px translateY; height read mid-animation is 9px of
// overflow nobody sees (see the note in start-explainer.spec.js).
const settled = (page) =>
  page.waitForFunction(() => {
    const inner = document.querySelector('.sx-inner');
    return inner && inner.getAnimations().every((a) => a.playState !== 'running');
  });

// Answer the page's own overrides and the shared bucket separately, so a test can
// tell WHICH one a value came from.
async function stubContent(page, { pageOverrides = {}, scopeOverrides = {} } = {}) {
  await page.route('**/api/content?page=*', (route) => {
    const asked = new URL(route.request().url()).searchParams.get('page');
    return route.fulfill({ json: { overrides: asked === SCOPE ? scopeOverrides : pageOverrides } });
  });
}

test('?explainer=1 opens the briefing on load, with no click at all', async ({ page }) => {
  await page.goto('/index.html?explainer=1');
  await expect(page.getByTestId(OVERLAY)).toBeVisible();
  // It is the real sheet, not an empty shell.
  await expect(page.getByTestId('start-explainer-step')).toHaveCount(4);
  // Without the flag it stays closed — the briefing is still a click-to-open popup.
  await page.goto('/index.html');
  await expect(page.getByTestId(OVERLAY)).toHaveCount(0);
});

test('the copy comes from ONE shared bucket, on every page the popup opens from', async ({
  page,
}) => {
  await stubContent(page, {
    scopeOverrides: { 'start-explainer-title': { text: 'ככה זה עובד — גרסת הבעלים' } },
  });

  for (const url of ['/index.html?explainer=1', '/product.html?design=bachelorette&explainer=1']) {
    await page.goto(url);
    await expect(page.locator('#sxTitle')).toHaveText('ככה זה עובד — גרסת הבעלים');
  }
});

test('an edit inside the sheet is saved to the shared bucket, not to the page', async ({
  page,
}) => {
  await stubContent(page);
  let resolveBody;
  const bodyPromise = new Promise((resolve) => (resolveBody = resolve));
  await page.route('**/api/admin/content*', (route) => {
    if (route.request().method() === 'POST') resolveBody(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto('/index.html?edit=1&key=dugri-admin&explainer=1');
  await expect(page.getByText('מצב עריכה')).toBeVisible();
  await expect(page.getByTestId(OVERLAY)).toBeVisible();

  const title = page.locator('#sxTitle');
  await expect(title).toHaveAttribute('contenteditable', /plaintext-only|true/);
  await title.click();
  await title.evaluate((el) => {
    el.textContent = 'ארבעה צעדים וזהו';
  });
  await title.evaluate((el) => el.blur());

  const body = await bodyPromise;
  expect(body).toEqual({
    page: SCOPE, // NOT index.html — that is the whole point
    key: 'start-explainer-title',
    text: 'ארבעה צעדים וזהו',
  });
});

test("the page's own copy still saves to the page", async ({ page }) => {
  // The scope must not swallow everything else on the page it is opened from.
  await stubContent(page);
  let resolveBody;
  const bodyPromise = new Promise((resolve) => (resolveBody = resolve));
  await page.route('**/api/admin/content*', (route) => {
    if (route.request().method() === 'POST') resolveBody(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto('/index.html?edit=1&key=dugri-admin');
  const node = page.locator('[data-edit="index-faq-heading"]');
  await node.click();
  await node.evaluate((el) => {
    el.textContent = 'שאלות';
  });
  await node.evaluate((el) => el.blur());

  expect((await bodyPromise).page).toBe('index.html');
});

test('every string in the sheet is editable, and each has its own key', async ({ page }) => {
  await page.goto('/index.html?edit=1&key=dugri-admin&explainer=1');
  const overlay = page.getByTestId(OVERLAY);
  await expect(overlay).toBeVisible();

  // Each visible run of text carries a data-edit key: title, subtitle, the four
  // step titles + texts, the soft-launch note, the WhatsApp line, the button.
  const { keys, untagged } = await overlay.evaluate((root) => {
    const keys = [...root.querySelectorAll('[data-edit]')].map((el) =>
      el.getAttribute('data-edit')
    );
    // Any leaf with visible text that is NOT covered by a data-edit node (the step
    // numerals are decorative and aria-hidden; the X is a control, not copy).
    const untagged = [...root.querySelectorAll('h2,h3,p,a,span')]
      .filter((el) => (el.textContent || '').trim().length > 1)
      .filter((el) => !el.closest('[data-edit]'))
      .filter((el) => !el.classList.contains('sx-num') && !el.classList.contains('sx-x'))
      .map((el) => (el.textContent || '').trim().slice(0, 20));
    return { keys, untagged };
  });
  expect(untagged, 'text in the sheet with no way to edit it').toEqual([]);
  expect(new Set(keys).size, 'two nodes share one key').toBe(keys.length);
  expect(keys).toEqual(
    expect.arrayContaining([
      'start-explainer-title',
      'start-explainer-sub',
      'start-explainer-continue',
      'start-explainer-step1-title',
      'start-explainer-step1-text',
      'start-explainer-step1-note',
      'start-explainer-step4-wa',
    ])
  );

  // …and they are all actually editable, not merely tagged.
  const notEditable = await overlay.evaluate((root) =>
    [...root.querySelectorAll('[data-edit]')]
      .filter((el) => !el.isContentEditable)
      .map((el) => el.getAttribute('data-edit'))
  );
  expect(notEditable).toEqual([]);
});

test('the toolbar offers the popup as somewhere to edit', async ({ page }) => {
  await page.goto('/index.html?edit=1&key=dugri-admin');
  const select = page.locator('[data-role="pageselect"]');
  await expect(select).toBeVisible();
  const values = await select.locator('option').evaluateAll((os) => os.map((o) => o.value));
  expect(values).toContain('index.html?edit=1&key=dugri-admin&explainer=1');

  // Choosing it lands on the page with the sheet open, still in edit mode.
  await select.selectOption('index.html?edit=1&key=dugri-admin&explainer=1');
  await expect(page.getByTestId(OVERLAY)).toBeVisible();
  await expect(page.getByText('מצב עריכה')).toBeVisible();
});

// The fit is MEASURED, so it follows the owner's copy — a type scale tuned by hand
// against the shipped text cannot. This pins both ends of that: the shipped copy is
// one page on an iPhone 16, and copy the owner has grown lands smaller rather than
// running off the screen — down to a floor, past which the briefing would stop being
// readable and the sheet keeps its scroll with the CTA pinned instead.
//
// The extra copy is multiplied rather than lengthened by a sentence. How many lines
// a given sentence wraps to depends on which font is installed, and the first
// version of this test asserted a one-line difference that CI's fonts did not
// produce; several times the text is more text under any font on any machine.
const FLOOR = 11.5;
test('the fit follows the copy: more text is set smaller, never below the floor', async ({
  page,
}) => {
  const read = async () => {
    await page.goto('/index.html?explainer=1');
    await expect(page.getByTestId(OVERLAY)).toBeVisible();
    await settled(page);
    return page.evaluate(() => {
      const o = document.getElementById('startExplainer');
      const inner = o.querySelector('.sx-inner');
      const cta = o.querySelector('.sx-go').getBoundingClientRect();
      return {
        base: parseFloat(getComputedStyle(inner).fontSize),
        need: inner.scrollHeight,
        have: o.clientHeight,
        ctaBottom: Math.round(cta.bottom),
        vh: window.innerHeight,
      };
    });
  };

  // An iPhone 16 in Safari, home indicator included — the phone from the report.
  await page.setViewportSize({ width: 393, height: 745 });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.setProperty('--sx-safe-b', '34px');
    });
  });
  const onPhone = await read();
  expect(onPhone.need, 'the shipped copy must fit an iPhone 16').toBeLessThanOrEqual(
    onPhone.have + 2
  );

  // The comparison itself is made on a TALLER screen, where the shipped copy is set
  // at the ceiling with room to spare. On the phone it is already near the floor, so
  // a font a little wider than ours would leave nothing to shrink and the comparison
  // would measure nothing — which is how CI first disagreed with this machine.
  await page.setViewportSize({ width: 393, height: 900 });
  const shipped = await read();
  expect(shipped.base, 'a tall screen should not need the floor').toBeGreaterThan(FLOOR);

  const grown = (t) => (t + ' ').repeat(4).trim();
  await stubContent(page, {
    scopeOverrides: {
      'start-explainer-step1-text': {
        text: grown('מתאימים את המשחק שיהיה שלכם: השם של בעל או בעלת השמחה, או כל כותרת שבא לכם.'),
      },
      'start-explainer-step2-text': {
        text: grown('מעלים 4 תמונות, אנחנו חותכים אותן אוטומטית והן הופכות לפיונים שלכם במשחק.'),
      },
      'start-explainer-step3-text': {
        text: grown('משאירים מייל וטלפון כדי שנכיר אתכם, ונשלח לכם את הקישור לחברים.'),
      },
      'start-explainer-step4-text': {
        text: grown('שולחים לחברים ולמשפחה את האפשרות לאסוף מילים על בעל או בעלת השמחה.'),
      },
    },
  });
  const grownSheet = await read();
  expect(grownSheet.base, 'more text must be set smaller').toBeLessThan(shipped.base);
  expect(grownSheet.base, 'the type must stop at the readable floor').toBeGreaterThanOrEqual(FLOOR);
  // Whatever the copy does, the button is on screen — the promise that never bends.
  expect(grownSheet.ctaBottom).toBeLessThanOrEqual(grownSheet.vh + 1);
});

// The editor's toolbar is fixed across the foot of the screen, and the sheet's last
// editable string — the button's label — sits exactly there. In edit mode the sheet
// reserves room for it, or that one string can only be edited from underneath.
test('in edit mode the button label is not left under the toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/index.html?edit=1&key=dugri-admin&explainer=1');
  await expect(page.getByTestId(OVERLAY)).toBeVisible();
  await expect(page.locator('.dugri-editbar')).toBeVisible();
  await settled(page);

  const clear = await page.evaluate(() => {
    const go = document.querySelector('.sx-go').getBoundingClientRect();
    const bar = document.querySelector('.dugri-editbar').getBoundingClientRect();
    return { goBottom: Math.round(go.bottom), barTop: Math.round(bar.top) };
  });
  expect(clear.goBottom, 'the CTA label is under the edit toolbar').toBeLessThanOrEqual(
    clear.barTop
  );
});
