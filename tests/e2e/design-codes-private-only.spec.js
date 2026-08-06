import { test, expect } from '@playwright/test';

// The design-codes admin (site/design-codes.html) mints a code that UNLOCKS a
// private design. Its dropdown used to list every static built-in — all of which
// are public — so it could never offer a design a code is actually for.
//
// The API is mocked at the network layer so the parallel device projects stay
// race-free against the shared server, exactly as admin-images.spec.js does.
const KEY = 'dugri-admin';

function design(over = {}) {
  return {
    id: 'bachelorette',
    name: 'מסיבת רווקות',
    visibility: 'public',
    public: true,
    inStore: true,
    ...over,
  };
}

function stub(page, designs, codes = []) {
  page.route('**/api/admin/designs*', (route) => route.fulfill({ json: { designs } }));
  page.route('**/api/admin/design-codes*', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ json: { design_codes: codes } });
  });
}

test.describe('design codes — only designs a code can unlock', () => {
  test('lists PRIVATE designs and leaves public ones out', async ({ page }) => {
    await stub(page, [
      design(),
      design({ id: 'japanese', name: 'יפני', visibility: 'private', public: false }),
      // An owner-uploaded template is a legitimate target like any other — the
      // built-in/custom distinction must not reach this screen.
      design({
        id: 'grapefruit',
        name: 'דוגרי אשכוליות',
        visibility: 'private',
        public: false,
        custom: true,
      }),
    ]);
    await page.goto(`/design-codes.html?key=${KEY}`);

    const opts = page.locator('#design option');
    await expect(opts).toHaveCount(2);
    await expect(opts.nth(0)).toHaveAttribute('value', 'japanese');
    await expect(opts.nth(1)).toHaveAttribute('value', 'grapefruit');
    await expect(page.locator('#design')).toBeEnabled();
    await expect(page.locator('#submitBtn')).toBeEnabled();
  });

  test('with NO private design it explains why, instead of an empty box', async ({ page }) => {
    await stub(page, [design(), design({ id: 'japanese', name: 'יפני' })]);
    await page.goto(`/design-codes.html?key=${KEY}`);

    await expect(page.locator('#design option')).toHaveCount(0);
    await expect(page.locator('#design')).toBeDisabled();
    await expect(page.locator('#submitBtn')).toBeDisabled();
    await expect(page.locator('#form')).toContainText('אין עיצובים פרטיים');
  });

  test('a private design that is OFF the shop floor is not offered', async ({ page }) => {
    // The validate route rejects a code for a withdrawn design, so listing one
    // would mint a code that can never work.
    await stub(page, [
      design({
        id: 'japanese',
        name: 'יפני',
        visibility: 'private',
        public: false,
        inStore: false,
      }),
    ]);
    await page.goto(`/design-codes.html?key=${KEY}`);

    await expect(page.locator('#design option')).toHaveCount(0);
    await expect(page.locator('#form')).toContainText('לא בחנות');
  });

  test('an existing code still shows its design NAME, public or not', async ({ page }) => {
    // A code outlives the setting that justified it: a design made public again
    // keeps its old codes, and they must not degrade to a raw id.
    await stub(
      page,
      [design(), design({ id: 'japanese', name: 'יפני', visibility: 'private', public: false })],
      [{ code: 'OLDCODE', design_id: 'bachelorette', uses: 0, valid_until: null }]
    );
    await page.goto(`/design-codes.html?key=${KEY}`);

    await expect(page.locator('#content')).toContainText('מסיבת רווקות');
  });
});
