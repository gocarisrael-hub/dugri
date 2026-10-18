import { test, expect } from '@playwright/test';

// The homepage's (new.html) hero deck dealing by itself, and the tapped design's zoom. What these pin:
// - every AUTO_DEAL_MS the deck deals one card, without moving focus, scrolling the page or speaking to a screen reader;
// - it waits while a design is open, while the hero is off screen, and never deals by itself under reduced motion;
// - in a tapped design, a pinch or a double-tap zooms the board and the cards; a zoomed view is not closed by a tap,
//   Esc and the ✕ still close it, and the next open starts unzoomed; the board asks for its sharper source when zoomed;
// - the name, the price and the button sit halfway between the pictures and the foot of the screen, all on screen.

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

const AUTO = 8000;
const cards = (page) => page.locator('#stage .card:not([style*="pointer-events: none"])');

async function openDesign(page, id = 'bachelorette') {
  const tile = page.locator(`#strip .dz:not([aria-hidden])[data-k="${id}"]`);
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await expect(page.locator('#flood')).toHaveAttribute('open', '');
}
// touch pointers, as a finger sends them: (id, x, y) steps on the element under the point
function touch(page, steps) {
  return page.evaluate((steps) => {
    for (const [type, id, x, y] of steps) {
      const el = document.elementFromPoint(x, y) || document.body;
      el.dispatchEvent(
        new window.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: id,
          pointerType: 'touch',
          isPrimary: id === 1,
          clientX: x,
          clientY: y,
          button: 0,
        })
      );
    }
  }, steps);
}
async function boardCentre(page) {
  const r = await page.locator('#tableau .bd').boundingBox();
  return [r.x + r.width / 2, r.y + r.height * 0.3];
}
const zoomScale = (page) =>
  page.locator('#flood .spread').evaluate((el) => {
    const t = getComputedStyle(el).transform;
    return t === 'none' ? 1 : new window.DOMMatrix(t).a;
  });

test.describe('the hero deck deals by itself', () => {
  test('one card every 8 seconds, with no focus move, no scroll and nothing announced', async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto('/new.html');
    await page.clock.runFor(1000);
    await expect(cards(page)).toHaveCount(1);
    const said = await page.locator('#said').textContent();
    const before = await page.evaluate(() => [window.scrollY, document.activeElement.tagName]);
    await page.clock.runFor(AUTO);
    await expect(cards(page)).toHaveCount(2);
    await page.clock.runFor(AUTO);
    await expect(cards(page)).toHaveCount(3);
    expect(await page.evaluate(() => [window.scrollY, document.activeElement.tagName])).toEqual(
      before
    );
    await expect(page.locator('#said')).toHaveText(said);
  });

  test('waits while a design is open and while the hero is off screen', async ({ page }) => {
    await page.clock.install();
    await page.goto('/new.html');
    await page.clock.runFor(1000);
    await expect(cards(page)).toHaveCount(1);
    await openDesign(page);
    // the hero back on screen under the open design, so only the open design holds the deck back
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect
      .poll(() => page.locator('#stage').evaluate((el) => el.getBoundingClientRect().top >= 0))
      .toBe(true);
    await page.clock.runFor(AUTO * 3);
    await expect(cards(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.clock.runFor(1000);
    await expect(page.locator('#flood')).not.toHaveAttribute('open', '');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect
      .poll(() => page.locator('#stage').evaluate((el) => el.getBoundingClientRect().bottom < 0))
      .toBe(true);
    await page.clock.runFor(AUTO * 3);
    await expect(cards(page)).toHaveCount(1);
  });

  test('never deals by itself under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.install();
    await page.goto('/new.html');
    await page.clock.runFor(1000);
    await expect(cards(page)).toHaveCount(1);
    await page.clock.runFor(AUTO * 3);
    await expect(cards(page)).toHaveCount(1);
  });
});

test.describe('a tapped design zooms', () => {
  test('a pinch zooms the pictures; a tap leaves a zoomed view open; Esc closes it and the next open is unzoomed', async ({
    page,
  }) => {
    await page.goto('/new.html');
    await openDesign(page);
    await page.waitForTimeout(900); // the pictures have landed
    const y0 = await page.evaluate(() => window.scrollY);
    const sizes0 = await page.locator('#tableau .bd').getAttribute('sizes');
    const [x, y] = await boardCentre(page);
    const steps = [
      ['pointerdown', 1, x - 20, y],
      ['pointerdown', 2, x + 20, y],
    ];
    for (let i = 1; i <= 6; i++)
      steps.push(['pointermove', 1, x - 20 - i * 10, y], ['pointermove', 2, x + 20 + i * 10, y]);
    steps.push(['pointerup', 2, x + 80, y], ['pointerup', 1, x - 80, y]);
    await touch(page, steps);
    expect(await zoomScale(page)).toBeCloseTo(4, 1);
    await expect(page.locator('#flood')).toHaveAttribute('open', '');
    await expect(page.locator('#tableau .bd')).not.toHaveAttribute('sizes', sizes0);
    // on a zoomed view a finger dragging down pans the pictures; it is not the swipe down that closes the view
    const ty0 = await page
      .locator('#flood .spread')
      .evaluate((el) => new window.DOMMatrix(getComputedStyle(el).transform).f);
    await touch(page, [
      ['pointerdown', 1, x, y - 60],
      ['pointermove', 1, x, y - 20],
      ['pointermove', 1, x, y + 40],
      ['pointerup', 1, x, y + 40],
    ]);
    await page.waitForTimeout(900); // longer than the closing animation
    await expect(page.locator('#flood')).toHaveAttribute('open', '');
    expect(
      await page
        .locator('#flood .spread')
        .evaluate((el) => new window.DOMMatrix(getComputedStyle(el).transform).f)
    ).toBeGreaterThan(ty0);
    expect(await page.evaluate(() => window.scrollY)).toBe(y0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#flood')).not.toHaveAttribute('open', '');
    await openDesign(page, 'marriage');
    expect(await zoomScale(page)).toBe(1);
    await expect(page.locator('#flood')).not.toHaveClass(/zoomed/);
  });

  test('a double-tap on the board zooms in there, another zooms out, and the ✕ still closes it', async ({
    page,
  }) => {
    await page.goto('/new.html');
    await openDesign(page, 'marriage');
    await page.waitForTimeout(900);
    const [x, y] = await boardCentre(page);
    const dbl = [
      ['pointerdown', 1, x, y],
      ['pointerup', 1, x, y],
      ['pointerdown', 1, x, y],
      ['pointerup', 1, x, y],
    ];
    await touch(page, dbl);
    expect(await zoomScale(page)).toBeCloseTo(2.5, 2);
    await touch(page, dbl);
    expect(await zoomScale(page)).toBe(1);
    await touch(page, dbl);
    expect(await zoomScale(page)).toBeCloseTo(2.5, 2);
    await page.locator('#floodX').click();
    await expect(page.locator('#flood')).not.toHaveAttribute('open', '');
    // reset as it closes, not only on the next open
    await expect(page.locator('#flood .spread')).toHaveAttribute('style', /^(?![\s\S]*scale)/);
    await expect(page.locator('#flood')).not.toHaveClass(/zoomed/);
  });

  test('a swipe down on an unzoomed view still closes it', async ({ page }) => {
    await page.goto('/new.html');
    await openDesign(page);
    await page.waitForTimeout(900);
    await touch(page, [
      ['pointerdown', 1, 30, 200],
      ['pointermove', 1, 30, 260],
      ['pointerup', 1, 30, 300],
    ]);
    await expect(page.locator('#flood')).not.toHaveAttribute('open', '');
  });
});

test.describe('a tapped design on a phone', () => {
  for (const [w, h] of [
    [390, 844],
    [375, 667],
    [360, 740],
  ])
    test(`sets the info halfway between the pictures and the foot of the screen at ${w}x${h}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/new.html');
      await openDesign(page);
      await page.waitForTimeout(900);
      // the owner's call: halfway between right under the pictures and the bottom of the screen
      const spread = await page.locator('#flood .spread').boundingBox();
      const info = await page.locator('#flood .info').boundingBox();
      const under = spread.y + spread.height,
        foot = h - info.height;
      expect(Math.abs(info.y - (under + foot) / 2)).toBeLessThanOrEqual(2);
      expect(info.y - under).toBeGreaterThan(10); // not right under the pictures any more
      const note = await page.locator('#flood .note').boundingBox();
      expect(note.y + note.height).toBeLessThanOrEqual(h);
    });
});

// the strip's cards were 400 px pictures drawn ~250 CSS px wide: on a 3x phone, stretched about 1.9 times
for (const dpr of [3, 1])
  test.describe(`the designs' cards at ${dpr}x`, () => {
    test.use({ deviceScaleFactor: dpr, viewport: { width: 390, height: 844 } });
    test('are drawn from a picture at least as wide as the screen draws them (up to 2x)', async ({
      page,
    }) => {
      await page.goto('/new.html');
      const tiles = page.locator('#strip .dz:not([aria-hidden]) img');
      await expect(tiles.first()).toBeVisible();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('#strip .dz:not([aria-hidden]) img')].every(
          (i) => i.complete && i.naturalWidth
        )
      );
      // the file's own pixels (an <img> with a srcset reports naturalWidth already divided by the density it picked)
      const got = await tiles.evaluateAll((els) =>
        Promise.all(
          els.map(
            (i) =>
              new Promise((ok) => {
                const probe = new window.Image();
                probe.onload = () =>
                  ok({ src: i.currentSrc, nat: probe.naturalWidth, css: i.clientWidth });
                probe.src = i.currentSrc;
              })
          )
        )
      );
      expect(got.length).toBeGreaterThan(0);
      for (const g of got) {
        expect(g.nat, g.src).toBeGreaterThanOrEqual(g.css * Math.min(dpr, 2));
        if (dpr > 1) expect(g.src).toMatch(/@2x\.webp$/);
        else expect(g.src).toMatch(/-f1\.webp$/); // a 1x screen keeps the light 400 px picture
      }
      // the tapped view's cards ask for theirs too
      await page.locator('#strip .dz:not([aria-hidden])').first().click();
      await expect(page.locator('#tableau .fr')).toHaveAttribute('srcset', /@2x\.webp \d+w$/);
    });
  });
