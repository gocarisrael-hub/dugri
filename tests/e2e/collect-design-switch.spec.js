import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// THE DESIGN SWITCH on the collection page's design tab: a strip of every design
// the site offers, each drawn with her title, and "בחרו בעיצוב הזה" to move the
// order to it. What is pinned here, in both looks:
//   - the strip is lazy: on arrival it asks only for the neighbours of her design
//     (her own is the card already on screen), never a render per design;
//   - RTL: the first design sits on the right and the next one to its left;
//   - choosing moves the order, and the main preview and the pawn card follow;
//   - once the collection is closed for production the switch is gone and the
//     server refuses it.
// The renders are stubbed — each answers with a picture NAMING the theme it was
// asked for, so "the preview follows" is read off the picture's own source. The
// renders themselves are the generator's business and covered there.

function pic(label) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 224 312"><rect width="224" height="312" fill="#eee"/>' +
    '<text x="10" y="150" font-size="18">' +
    label +
    '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

async function order(request) {
  const created = await request.post('/api/collections', {
    data: {
      honoree_name: 'שירה',
      custom_title: 'לשירה באהבה',
      theme: 'bachelorette',
      design: 'פריז',
    },
  });
  expect(created.ok()).toBe(true);
  const { id, owner_token: k } = await created.json();
  const list = await request.get(`/api/collections/${id}/designs?k=${encodeURIComponent(k)}`);
  expect(list.ok()).toBe(true);
  const { designs } = await list.json();
  return { id, k, designs, url: `/collect.html?c=${id}&k=${encodeURIComponent(k)}` };
}

// Every render the page asks for, by kind.
function stubRenders(page) {
  const calls = { preview: [], card: [], pawn: 0 };
  page.route('**/api/preview', (route) => {
    const body = route.request().postDataJSON() || {};
    calls.preview.push(body.theme);
    return route.fulfill({
      json: { card: pic('preview:' + body.theme), word_font: null, word_font_options: [] },
    });
  });
  page.route('**/design-card?**', (route) => {
    const design = new URL(route.request().url()).searchParams.get('design');
    calls.card.push(design);
    return route.fulfill({ json: { id: design, card: pic('card:' + design) } });
  });
  page.route('**/pawn-card**', (route) => {
    calls.pawn += 1;
    return route.fulfill({ json: { card: pic('pawn') } });
  });
  return calls;
}

for (const mode of ['classic', 'redesign']) {
  test.describe(`design switch (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      if (mode === 'redesign') await previewRedesign(page);
    });

    test('swipes lazily, switches, and the preview and pawn card follow', async ({
      page,
      request,
    }) => {
      const { id, k, designs, url } = await order(request);
      expect(designs.length).toBeGreaterThan(2);
      const calls = stubRenders(page);
      await page.goto(url);

      // the pawn card drawn once, BEFORE the switch
      await page.getByTestId('tab-pawns').click();
      await expect.poll(() => calls.pawn).toBe(1);

      await page.getByTestId('tab-design').click();
      const sw = page.getByTestId('design-switch');
      await expect(sw).toBeVisible();
      const options = page.getByTestId('design-option');
      await expect(options).toHaveCount(designs.length);
      const cur = page.locator('.dsw-card.current');
      await expect(cur).toHaveAttribute('data-id', 'bachelorette');
      await expect(cur).toHaveClass(/focus/);
      await expect(page.getByTestId('design-is-current')).toBeVisible();
      await expect(page.getByTestId('design-choose')).toBeHidden();

      // RTL: the list runs right to left
      const a = await options.nth(0).boundingBox();
      const b = await options.nth(1).boundingBox();
      expect(b.x).toBeLessThan(a.x);

      // LAZY: her own design is the card already on screen (no ask), and only its
      // neighbours are asked for, one by one — never a render per design.
      const at = designs.findIndex((d) => d.id === 'bachelorette');
      const near = [designs[at - 1], designs[at + 1]].filter(Boolean).map((d) => d.id);
      await expect.poll(() => calls.card.length).toBe(near.length);
      expect([...calls.card].sort()).toEqual([...near].sort());
      expect(calls.card).not.toContain('bachelorette');

      // tap the neighbour: it slides to the middle and becomes the choice
      const target = designs[at + 1] || designs[at - 1];
      await page.locator(`.dsw-card[data-id="${target.id}"]`).click();
      await expect(page.locator(`.dsw-card[data-id="${target.id}"]`)).toHaveClass(/focus/);
      const choose = page.getByTestId('design-choose');
      await expect(choose).toBeVisible();
      await expect(choose).toBeEnabled();
      await expect(page.locator(`.dsw-card[data-id="${target.id}"] img`)).toHaveAttribute(
        'src',
        pic('card:' + target.id)
      );
      // a settle asks for the new neighbours only, still no full sweep
      await page.waitForTimeout(400);
      expect(calls.card.length).toBeLessThanOrEqual(near.length + 2);
      expect(new Set(calls.card).size).toBe(calls.card.length);

      await choose.click();
      await expect(page.locator('.dsw-card.current')).toHaveAttribute('data-id', target.id);
      await expect(page.getByTestId('design-is-current')).toBeVisible();
      // the main preview is now the new design's
      await expect(page.locator('#prevImg')).toHaveAttribute('src', pic('preview:' + target.theme));
      expect(calls.preview.at(-1)).toBe(target.theme);

      // the order holds it
      const view = await request.get(`/api/collections/${id}?k=${encodeURIComponent(k)}`);
      expect((await view.json()).theme).toBe(target.theme);

      // …and the pawn card is drawn again, for the new design
      await page.getByTestId('tab-pawns').click();
      await expect.poll(() => calls.pawn).toBe(2);
    });

    test('closed for production: no switch, and the server refuses one', async ({
      page,
      request,
    }) => {
      const { id, k, designs, url } = await order(request);
      const other = designs.find((d) => !d.current);
      const closed = await request.post(`/api/collections/${id}/close`, {
        data: { owner_token: k },
      });
      expect(closed.ok()).toBe(true);
      stubRenders(page);
      await page.goto(url);
      await page.getByTestId('tab-design').click();
      await expect(page.locator('#sheetClosedNote')).toBeVisible();
      await expect(page.getByTestId('title-input')).toBeDisabled();
      await expect(page.getByTestId('design-switch')).toBeHidden();
      const put = await request.put(`/api/collections/${id}/design?k=${encodeURIComponent(k)}`, {
        data: { design: other.id },
      });
      expect(put.status()).toBe(409);
    });
  });
}
