import { test, expect } from '@playwright/test';

// Visual polish on the configurator (items 5 + 6):
//  - the active view tab reads WARM-SAND ACCENT, not black (and no longer pink —
//    pink now lives only on the logo)
//  - colour swatches have NO resting frame/ring, but a clear sand selected ring
//  - the live product preview "just sits there" with no dashed box/outline
//  - the chasers add-on is a clean icon+text row with no box (border/bg/shadow)

const SAND = 'rgb(183, 163, 137)'; // --accent #b7a389
const PINK = 'rgb(232, 90, 151)'; // #e85a97 — must NOT appear (logo-only now)

test.describe('configurator preview polish', () => {
  test('the ACTIVE view tab is the warm-sand accent (not black, not pink)', async ({ page }) => {
    await page.goto('/options.html');
    const front = page.getByTestId('tab-front');
    await expect(front).toHaveAttribute('aria-selected', 'true');
    const bg = await front.evaluate((el) => getComputedStyle(el).backgroundImage);
    // active tab paints a warm-sand gradient — the accent is present…
    expect(bg).toContain(SAND);
    // …and it is NOT the old near-black fill, nor pink (pink is logo-only)
    expect(bg).not.toContain('rgb(20, 20, 20)');
    expect(bg).not.toContain('rgb(0, 0, 0)');
    expect(bg).not.toContain(PINK);

    // an INACTIVE tab is not the accent
    const backBg = await page
      .getByTestId('tab-back')
      .evaluate(
        (el) => getComputedStyle(el).backgroundImage + getComputedStyle(el).backgroundColor
      );
    expect(backBg).not.toContain(SAND);
  });

  test('colour swatches: no resting frame/ring, a sand ring when selected', async ({ page }) => {
    await page.goto('/options.html?step=2');
    const unselected = page.getByTestId('color-1');
    await expect(unselected).toBeVisible();

    // resting swatch: no border, no ring shadow — just the colour
    const resting = await unselected.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, shadow: s.boxShadow };
    });
    expect(resting.border).toBe('0px');
    expect(resting.shadow).toBe('none');

    // select it → a warm-sand ring appears (poll past the box-shadow transition)
    await unselected.click();
    await expect(unselected).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => unselected.evaluate((el) => getComputedStyle(el).boxShadow))
      .toContain(SAND);

    // a sibling that stays unselected keeps no ring
    const other = page.getByTestId('color-2');
    if (await other.count()) {
      expect(await other.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
    }
  });

  test('the product preview has no dashed box/outline around it', async ({ page }) => {
    await page.goto('/options.html');
    const stage = page.getByTestId('preview-stage');
    await expect(stage).toBeVisible();
    const border = await stage.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.borderTopStyle, width: s.borderTopWidth };
    });
    // no visible frame: either no border or a zero-width one, and never dashed
    expect(border.style === 'none' || border.width === '0px').toBeTruthy();
    expect(border.style).not.toBe('dashed');
  });

  test('the chasers add-on is a clean row with no box (border/bg/shadow)', async ({ page }) => {
    await page.goto('/options.html');
    await page.getByTestId('next-btn').click(); // -> 2 (colour + add-ons)
    const card = page.getByTestId('chasers-card');
    await expect(card).toBeVisible();

    const box = await card.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, bg: s.backgroundColor, shadow: s.boxShadow };
    });
    expect(box.border).toBe('0px');
    // transparent background (no card fill)
    expect(box.bg === 'rgba(0, 0, 0, 0)' || box.bg === 'transparent').toBeTruthy();
    expect(box.shadow).toBe('none');

    // the icon is the (boxless) photo, not an svg
    const ico = page.locator('#chasersCard img.addon-ico');
    await expect(ico).toHaveAttribute('src', 'assets/ico-chasers.png');
    await expect(page.locator('#chasersCard svg.addon-ico')).toHaveCount(0);
  });
});
