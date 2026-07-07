import { test, expect } from '@playwright/test';

// Visual polish on the configurator (items 5 + 6):
//  - the active view tab reads BRAND PINK, not black
//  - colour swatches have NO resting frame/ring, but a clear pink selected ring
//  - the live product preview "just sits there" with no dashed box/outline
//  - the chasers add-on is a clean icon+text row with no box (border/bg/shadow)

const PINK = 'rgb(232, 90, 151)'; // #e85a97

test.describe('configurator preview polish', () => {
  test('the ACTIVE view tab is brand pink (not black)', async ({ page }) => {
    await page.goto('/options.html');
    const front = page.getByTestId('tab-front');
    await expect(front).toHaveAttribute('aria-selected', 'true');
    const bg = await front.evaluate((el) => getComputedStyle(el).backgroundImage);
    // active tab paints a pink gradient — the brand pink is present…
    expect(bg).toContain(PINK);
    // …and it is NOT the old near-black fill
    expect(bg).not.toContain('rgb(20, 20, 20)');
    expect(bg).not.toContain('rgb(0, 0, 0)');

    // an INACTIVE tab is not pink
    const backBg = await page
      .getByTestId('tab-back')
      .evaluate(
        (el) => getComputedStyle(el).backgroundImage + getComputedStyle(el).backgroundColor
      );
    expect(backBg).not.toContain(PINK);
  });

  test('colour swatches: no resting frame/ring, a pink ring when selected', async ({ page }) => {
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

    // select it → a pink ring appears (poll past the box-shadow transition)
    await unselected.click();
    await expect(unselected).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => unselected.evaluate((el) => getComputedStyle(el).boxShadow))
      .toContain(PINK);

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
    await page.getByTestId('next-btn').click(); // -> 2
    await page.getByTestId('next-btn').click(); // -> 3
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
