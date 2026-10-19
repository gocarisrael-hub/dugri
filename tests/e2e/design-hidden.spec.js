import { test, expect } from '@playwright/test';

// A design the owner hides from the site ("מוצג באתר: לא") is hidden EVERYWHERE a buyer can meet it. The server says
// which built-in designs are hidden on /api/design-names (`hidden`; tests/unit/design-shown.test.js pins that side and
// the order route's refusal); here each page is fed that answer and must drop the design:
// - the homepage (new.html) and the live homepage (index.html), the shop grid, a product page's related rail;
// - its own product page sends the visitor to the shop;
// - the wizard's picker loses its tile, and a link straight to it (?design=…&step=2) lands on the picker, not on it;
// - and when /api/design-names does not answer, nothing is blanked: every bundled design still shows.
// The answer is mocked per page, so hiding a design here touches no other test.

const HIDDEN = 'bachelorette';
const OTHER = 'japanese';

async function hide(page, ids = [HIDDEN]) {
  await page.route('**/api/design-names', async (route) => {
    // a page that redirects (the hidden design's own page) can leave while this is in flight
    const res = await route.fetch().catch(() => null);
    if (!res) return route.abort().catch(() => {});
    const body = await res.json();
    await route.fulfill({ json: { ...body, hidden: ids } }).catch(() => {});
  });
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
}

test.describe('a design the owner hid', () => {
  test('is on neither homepage', async ({ page }) => {
    await hide(page);
    await page.goto('/new.html');
    const tiles = page.locator('#strip .dz');
    await expect(page.locator(`#strip .dz[data-k="${OTHER}"]`).first()).toBeAttached();
    await expect(page.locator(`#strip .dz[data-k="${HIDDEN}"]`)).toHaveCount(0);
    expect(await tiles.count()).toBeGreaterThan(0);

    await page.goto('/index.html');
    const rail = page.locator('#productsTrack');
    await expect(rail.locator(`[data-design-id="${OTHER}"]`).first()).toBeAttached();
    await expect(rail.locator(`[data-design-id="${HIDDEN}"]`)).toHaveCount(0);
  });

  test('leaves the shop and the related rail, and its own page sends the visitor to the shop', async ({
    page,
  }) => {
    await hide(page);
    await page.goto('/products.html');
    await expect(page.locator(`.product-card[data-design-id="${OTHER}"]`)).toBeVisible();
    await expect(page.locator(`.product-card[data-design-id="${HIDDEN}"]`)).toHaveCount(0);

    await page.goto(`/product.html?design=${OTHER}`);
    await expect(page.locator(`a[data-design-id]`).first()).toBeAttached();
    await expect(page.locator(`a[data-design-id="${HIDDEN}"]`)).toHaveCount(0);

    await page.goto(`/product.html?design=${HIDDEN}`);
    await expect(page).toHaveURL(/\/products\.html$/);
  });

  test('is not in the wizard’s picker, and a link straight to it lands on the picker', async ({
    page,
  }) => {
    await hide(page);
    await page.goto('/options.html');
    await expect(page.locator(`.design[data-design-id="${OTHER}"]`)).toBeVisible();
    await expect(page.locator(`.design[data-design-id="${HIDDEN}"]`)).toBeHidden();

    await page.goto(`/options.html?design=${HIDDEN}&step=2`);
    await expect(page.getByTestId('design-list')).toBeVisible(); // step 1, the picker
    await expect(page.locator(`.design[data-design-id="${HIDDEN}"]`)).toBeHidden();
    await expect(page.locator('.design[aria-pressed="true"]')).toBeVisible();
    await expect(page.locator('.design[aria-pressed="true"]')).not.toHaveAttribute(
      'data-design-id',
      HIDDEN
    );
  });
});

test('when the live catalog does not answer, every bundled design still shows', async ({
  page,
}) => {
  await page.route('**/api/design-names', (route) => route.abort());
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
  await page.goto('/products.html');
  await expect(page.locator(`.product-card[data-design-id="${HIDDEN}"]`)).toBeVisible();
  await page.goto('/options.html');
  await expect(page.locator(`.design[data-design-id="${HIDDEN}"]`)).toBeVisible();
});
