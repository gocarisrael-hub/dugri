import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The floating WhatsApp help button is on two buyer pages: the order wizard
// (options.html) and the word-collection page (collect.html). It used to be a
// 90x44 green pill anchored bottom-LEFT on collect and bottom-right on the
// wizard, and it landed on things: the cookie notice's close ×, the design-code
// box, half of the first gender option (tests/e2e/
// wizard-noscroll.spec.js had that one written down as somebody else's bug).
//
// It is smaller now, and — where the page has a bar already fixed to the bottom
// — it rides IN that bar rather than floating over the content. These tests pin
// both: the size, and that nothing a buyer taps ends up underneath it.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

const PHONE = { width: 390, height: 800 };
const DESKTOP = { width: 1280, height: 900 };

const intersects = (a, b) =>
  !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

// Every control whose CENTRE — the point a tap actually lands on — is covered by
// the help button. Centre rather than "any pixel": the button is in a corner, and
// grazing the rounded edge of a full-width card is not the same as taking the tap.
async function controlsTakenOver(page) {
  return page.evaluate(() => {
    const help = document.querySelector('[data-testid="wa-help"]');
    if (!help) return ['no help button on the page'];
    const out = [];
    for (const el of document.querySelectorAll(
      'button, a, input, select, textarea, [role="button"], label'
    )) {
      if (help.contains(el) || el.contains(help)) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none')
        continue;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
      const top = document.elementFromPoint(cx, cy);
      if (top && (top === help || help.contains(top))) {
        out.push(el.dataset.testid || el.id || el.className || el.tagName);
      }
    }
    return out;
  });
}

async function seedCollection(request) {
  const create = await request.post('/api/collections', {
    data: { honoree_name: `עזרה-${Math.random().toString(36).slice(2, 8)}` },
  });
  return create.json();
}

// ---------------------------------------------------------------- the wizard

test('the wizard help rides inside the sticky bar, not over the step', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/options.html');

  const help = page.getByTestId('wa-help');
  await expect(help).toBeVisible();
  // In the bar, literally: its box sits inside the bar's box, so it cannot cover
  // anything the bar does not already cover.
  const [h, bar] = await Promise.all([help.boundingBox(), page.locator('.wiz-bar').boundingBox()]);
  expect(h.x).toBeGreaterThanOrEqual(bar.x - 1);
  expect(h.y).toBeGreaterThanOrEqual(bar.y - 1);
  expect(h.x + h.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
  expect(h.y + h.height).toBeLessThanOrEqual(bar.y + bar.height + 1);

  // And it shares the bar with the two buttons rather than sitting on either.
  for (const id of ['next-btn', 'back-btn']) {
    const b = await page.getByTestId(id).boundingBox();
    if (b) expect(intersects(h, b), `help overlaps ${id}`).toBe(false);
  }
});

test('the wizard help stays in the bar on every step, at any scroll', async ({ page }) => {
  await page.setViewportSize(PHONE);
  for (const step of [1, 2, 3, 4, 5, 6]) {
    await page.goto(`/options.html?design=bachelorette&step=${step}`);
    const help = page.getByTestId('wa-help');
    await expect(help).toBeVisible();
    for (const y of [0, 400, 99999]) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      const taken = await controlsTakenOver(page);
      expect(taken, `step ${step} @${y}`).toEqual([]);
    }
  }
});

// The reason it moved into the bar: the cookie notice pins itself to the bottom
// LEFT, which is where a left-anchored (or bar-end) button used to be.
test('the cookie notice and the help button never share a corner', async ({ page, request }) => {
  const { id } = await seedCollection(request);
  for (const [size, url] of [
    [PHONE, '/options.html'],
    [PHONE, `/collect.html?c=${id}`],
    [DESKTOP, `/collect.html?c=${id}`],
  ]) {
    await page.setViewportSize(size);
    await page.goto(url);
    const notice = page.locator('#cookieNotice');
    // It fades itself out after ~6s; only assert while it is really up.
    if (!(await notice.count())) continue;
    const [h, n] = await Promise.all([
      page.getByTestId('wa-help').boundingBox(),
      notice.boundingBox(),
    ]);
    if (!n) continue;
    expect(intersects(h, n), `cookie notice overlap at ${url}`).toBe(false);
  }
});

// ------------------------------------------------------- word collection page

for (const [label, size] of [
  ['phone', PHONE],
  ['desktop', DESKTOP],
]) {
  test(`collect: no control is taken over by the help button on a ${label}`, async ({
    page,
    request,
  }) => {
    const { id, owner_token } = await seedCollection(request);
    await page.setViewportSize(size);

    for (const url of [`/collect.html?c=${id}`, `/collect.html?c=${id}&k=${owner_token}`]) {
      await page.goto(url);
      await expect(page.getByTestId('wa-help')).toBeVisible();
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      for (const y of [0, Math.round(height / 3), Math.round(height / 2), 99999]) {
        await page.evaluate((v) => window.scrollTo(0, v), y);
        const taken = await controlsTakenOver(page);
        expect(taken, `${url} @${y}`).toEqual([]);
      }
    }
  });
}

// It used to float ABOVE the pay bar, lifted by the bar's measured height; the
// share buttons, the card-pay pill and the order button still scrolled under it.
// While the bar is up it now rides INSIDE it (js/wa-help.js, the wizard's docked
// style), so nothing is ever under it. wa-help-avoid.spec.js scrolls the page.
test('collect: the help button rides in the pay bar when it is up', async ({ page, request }) => {
  const { id, owner_token } = await seedCollection(request);
  await page.setViewportSize(PHONE);
  await page.goto(`/collect.html?c=${id}&k=${owner_token}`);

  const bar = page.locator('#payBar');
  const help = page.getByTestId('wa-help');
  // The bar is shown for an unpaid owner on a card-enabled deployment; the E2E
  // server runs without card credentials, so put the bar on screen directly —
  // what is under test is where the button goes WHILE it is there.
  await bar.evaluate((el) => el.classList.remove('hidden'));
  await expect(bar).toBeVisible();
  await expect(help).toHaveClass(/wa-help--docked/);

  const [h, b] = await Promise.all([help.boundingBox(), bar.boundingBox()]);
  expect(h.x).toBeGreaterThanOrEqual(b.x - 1);
  expect(h.y).toBeGreaterThanOrEqual(b.y - 1);
  expect(h.x + h.width).toBeLessThanOrEqual(b.x + b.width + 1);
  expect(h.y + h.height).toBeLessThanOrEqual(b.y + b.height + 1);
  // ...and clear of the pay button itself, the one thing the page exists to get
  // pressed.
  const go = await page.getByTestId('pay-bar-btn').boundingBox();
  expect(intersects(h, go), 'help overlaps the pay button').toBe(false);
});

// It was a 90x44 pill with a label. Smaller, and on a phone the icon alone.
test('the button is small: an icon-sized square on a phone, a compact pill on desktop', async ({
  page,
  request,
}) => {
  const { id } = await seedCollection(request);

  await page.setViewportSize(PHONE);
  await page.goto(`/collect.html?c=${id}`);
  const phoneBox = await page.getByTestId('wa-help').boundingBox();
  expect(phoneBox.width).toBeLessThanOrEqual(44);
  expect(phoneBox.height).toBeLessThanOrEqual(44);
  // Still a real tap target.
  expect(phoneBox.width).toBeGreaterThanOrEqual(36);
  await expect(page.locator('.wa-help-label')).toBeHidden();

  await page.setViewportSize(DESKTOP);
  await page.goto(`/collect.html?c=${id}`);
  const deskBox = await page.getByTestId('wa-help').boundingBox();
  expect(deskBox.height).toBeLessThanOrEqual(40);
  expect(deskBox.width).toBeLessThanOrEqual(110);
  await expect(page.locator('.wa-help-label')).toBeVisible();
});
