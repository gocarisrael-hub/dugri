import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';
import { previewRedesign } from './helpers/redesign.js';

// The title step in redesign mode, the owner's round of 2026-10-19:
//  - the chosen design's pictures are the homepage's prints (new.html "איך דוגרי נולד"): bigger, a white paper frame,
//    the ink outline, a strip of tape, a small tilt;
//  - the live preview (card → back → board, whichever are on offer) goes round both ways, by swipe and by the arrows beside its dots;
//  - on a wide screen "הבא" is a button beside "הקודם", not a bar across the gap. A phone keeps the stretched one.
// The live site keeps its look: the preview stops at the ends and has no arrows (wizard-preview-visual.spec.js).

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// views that tell apart by their picture
const VIEWS = {
  card: '/assets/card-front.png',
  back: '/assets/card-back.png',
  board: '/assets/card-real.png',
};
function mockPreview(page) {
  return page.route('**/api/preview', async (route) => {
    const body = route.request().postDataJSON() || {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...VIEWS,
        warning: null,
        word_font: body.word_font || null,
        word_font_options: [],
      }),
    });
  });
}

const activeView = (page) =>
  page.evaluate(() => {
    const sel = document.querySelector('#namePreviewDots .np-dot[aria-selected="true"]');
    return sel ? sel.dataset.npdot : null;
  });
const swipe = async (page, fromX, toX) => {
  const vp = page.getByTestId('name-preview-viewport');
  await vp.dispatchEvent('pointerdown', { clientX: fromX, clientY: 200 });
  await vp.dispatchEvent('pointerup', { clientX: toX, clientY: 200 });
};

async function toTitleStep(page, { live = false } = {}) {
  if (!live) await previewRedesign(page);
  await mockPreview(page);
  await page.goto('/options.html?design=japanese&step=3');
  await expect(page.getByTestId('step-3')).toBeVisible();
}

test('the chosen design shows big taped prints, and they never widen the step', async ({
  page,
}) => {
  await toTitleStep(page);
  const pic = page.getByTestId('chosen-design-pic').first();
  await expect(pic).toBeVisible();
  const look = await pic.evaluate((el) => {
    const cs = getComputedStyle(el);
    const tape = getComputedStyle(el, '::before');
    const img = el.querySelector('img').getBoundingClientRect();
    return {
      bg: cs.backgroundColor,
      outline: parseFloat(cs.outlineWidth),
      shadow: cs.boxShadow,
      rotate: cs.rotate,
      tape: tape.content,
      imgW: img.width,
      imgH: img.height,
    };
  });
  expect(look.bg).toBe('rgb(255, 255, 255)'); // the paper frame
  expect(look.outline).toBeGreaterThanOrEqual(2);
  expect(look.shadow).not.toBe('none');
  expect(look.rotate).not.toBe('none');
  expect(look.tape).not.toBe('none');
  // the old strip was 72 px tall; a print is at least 136 px wide on any screen
  expect(look.imgW).toBeGreaterThanOrEqual(120);
  expect(look.imgH).toBeGreaterThan(90);

  // neighbouring prints lean opposite ways
  const second = await page
    .getByTestId('chosen-design-pic')
    .nth(1)
    .evaluate((el) => getComputedStyle(el).rotate);
  expect(second).not.toBe(look.rotate);

  // the strip scrolls inside the box: the box is no wider than the step, and the page does not scroll sideways
  const fits = await page.evaluate(() => {
    const box = document.getElementById('chosenDesign').getBoundingClientRect();
    const step = document.querySelector('[data-step="3"]').getBoundingClientRect();
    return {
      inStep: box.width <= step.width + 1,
      noSideScroll: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
  expect(fits).toEqual({ inStep: true, noSideScroll: true });
});

test('the live preview goes round both ways, by swipe and by arrow', async ({ page }) => {
  await toTitleStep(page);
  await page.getByTestId('custom-title-input').fill('ליאת חוגגת 40');
  await expect(page.getByTestId('name-preview-dot-back')).toBeVisible();
  // the views on offer, in track order (the dots are one per present view)
  const views = await page
    .locator('#namePreviewDots .np-dot')
    .evaluateAll((dots) => dots.map((d) => d.dataset.npdot));
  expect(views.length).toBeGreaterThanOrEqual(2);
  const [first, second, last] = [views[0], views[1], views[views.length - 1]];
  expect(await activeView(page)).toBe(first);

  // a swipe back from the first view lands on the last
  await swipe(page, 60, 300);
  await expect.poll(() => activeView(page)).toBe(last);
  // and a swipe on from the last lands on the first
  await swipe(page, 300, 60);
  await expect.poll(() => activeView(page)).toBe(first);

  // the arrows do the same; the row runs like the filmstrip, so next is the right-hand one
  const prev = page.getByTestId('name-preview-prev');
  const next = page.getByTestId('name-preview-next');
  await expect(prev).toHaveAccessibleName('התצוגה הקודמת');
  await expect(next).toHaveAccessibleName('התצוגה הבאה');
  const [pb, nb] = [await prev.boundingBox(), await next.boundingBox()];
  expect(nb.x).toBeGreaterThan(pb.x);
  await prev.click();
  await expect.poll(() => activeView(page)).toBe(last);
  await next.click();
  await expect.poll(() => activeView(page)).toBe(first);
  await next.click();
  await expect.poll(() => activeView(page)).toBe(second);

  // the picture on screen is the view the dot says, once the wrap's slide-in has settled
  const shown = () =>
    page.evaluate(() => {
      const vp = document.getElementById('namePreviewViewport').getBoundingClientRect();
      const mid = vp.left + vp.width / 2;
      const fig = [...document.querySelectorAll('.name-preview-fig')].find((f) => {
        const r = f.getBoundingClientRect();
        return !f.hidden && r.left <= mid && r.right >= mid;
      });
      return fig && fig.dataset.npview;
    });
  await expect.poll(shown).toBe(second);
  await prev.click();
  await prev.click(); // round past the first
  await expect.poll(shown).toBe(last);
});

test('the live site keeps a preview that stops at the ends, with no arrows', async ({ page }) => {
  await toTitleStep(page, { live: true });
  await page.getByTestId('custom-title-input').fill('ליאת חוגגת 40');
  await expect(page.getByTestId('name-preview-dot-back')).toBeVisible();
  await expect(page.getByTestId('name-preview-next')).toHaveCount(0);
  const first = await page.locator('#namePreviewDots .np-dot').first().getAttribute('data-npdot');
  expect(await activeView(page)).toBe(first);
  await swipe(page, 60, 300);
  await page.waitForTimeout(150);
  expect(await activeView(page)).toBe(first);
});

test('on a wide screen הבא is a button beside הקודם; a phone keeps the wide one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await toTitleStep(page);
  const next = page.getByTestId('next-btn');
  const back = page.getByTestId('back-btn');
  await expect(back).toBeVisible();
  let [nb, bb] = [await next.boundingBox(), await back.boundingBox()];
  expect(nb.width).toBeLessThan(300);
  expect(nb.width).toBeGreaterThanOrEqual(180);
  // side by side at the far (left) end, not with the whole gap between them
  expect(bb.x - (nb.x + nb.width)).toBeLessThan(40);

  await page.setViewportSize({ width: 390, height: 844 });
  [nb, bb] = [await next.boundingBox(), await back.boundingBox()];
  expect(nb.width).toBeGreaterThan(bb.width * 1.5);
});
