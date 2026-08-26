// The self-pickup page (/pickup).
//
// Everything a buyer needs on the morning she drives to collect the game used to
// live in one sentence at checkout ("איסוף מבית דפוס גלאור, ת״א") and in a
// placeholder line in the confirmation email. That is a print house's name and a
// city — not an entrance, a floor, a closing time, or what to say when she gets
// there. This page is that information, and these tests hold it to being
// COMPLETE: an address that names the entrance and the floor, real opening
// hours, what to bring, and how to tell her order from the next one on the table.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/pickup.html');
});

test('the page opens on the extension-less /pickup route too', async ({ page }) => {
  // The route the emails and the FAQ link to. resolveHtmlFile maps it to the
  // file; if that ever stops working, every link we send out 404s.
  const res = await page.goto('/pickup');
  expect(res.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'איסוף עצמי', level: 1 })).toBeVisible();
});

test('the address names the entrance and the floor, not just the street', async ({ page }) => {
  const card = page.getByTestId('pickup-address');
  await expect(card).toContainText('התחייה 14');
  await expect(card).toContainText('תל אביב');
  // The two details that decide whether she finds the door.
  await expect(card).toContainText('כניסה B');
  await expect(card).toContainText('קומה ראשונה');
});

test('both map links point at the real address', async ({ page }) => {
  for (const id of ['pickup-waze', 'pickup-gmaps']) {
    const href = await page.getByTestId(id).getAttribute('href');
    expect(decodeURIComponent(href), id).toContain('התחייה 14 תל אביב');
    await expect(page.getByTestId(id)).toHaveAttribute('target', '_blank');
    await expect(page.getByTestId(id)).toHaveAttribute('rel', /noopener/);
  }
});

test('opening hours are a real table — every day, with Thursday short and the weekend closed', async ({
  page,
}) => {
  const rows = page.getByTestId('pickup-hours').locator('tbody tr');
  await expect(rows).toHaveCount(7);
  // Thursday closes an hour earlier than the rest of the week; that hour is
  // exactly the sort of thing someone arrives too late for.
  await expect(rows.filter({ hasText: 'חמישי' })).toContainText('15:30');
  await expect(rows.filter({ hasText: 'רביעי' })).toContainText('16:30');
  for (const day of ['שישי', 'שבת']) {
    await expect(rows.filter({ hasText: day }), day).toContainText('סגור');
  }
});

test('it says to wait for our message before driving anywhere', async ({ page }) => {
  // Above the address on purpose: the game is not on the table until we say so.
  const wait = page.getByTestId('pickup-wait');
  await expect(wait).toBeVisible();
  await expect(wait).toContainText('אל תגיעו');
  const waitBox = await wait.boundingBox();
  const addrBox = await page.getByTestId('pickup-address').boundingBox();
  expect(waitBox.y).toBeLessThan(addrBox.y);
});

test('it lists all three identifying details to bring', async ({ page }) => {
  const bring = page.getByTestId('pickup-bring');
  await expect(bring).toContainText('הכותרת');
  await expect(bring).toContainText('הטלפון');
  await expect(bring).toContainText('השם');
});

test('it explains how to pick the right order off the table', async ({ page }) => {
  const find = page.getByTestId('pickup-find');
  await expect(find).toContainText('דוגרי איסוף עצמי');
  // The instruction that prevents someone walking off with a stranger's game.
  await expect(find).toContainText('וּודאו');
});

test('the route is three numbered steps plus the photo', async ({ page }) => {
  const route = page.getByTestId('pickup-route');
  await expect(route.locator('ol.steps li')).toHaveCount(3);
  const img = route.locator('figure.route img');
  await expect(img).toBeVisible();
  // A described photo, not a decorative one: the steps it illustrates are the
  // whole point, so a reader who cannot see it must still be told what it shows.
  const alt = await img.getAttribute('alt');
  expect(alt.length).toBeGreaterThan(10);
  // And it actually loaded — a broken directions photo is worse than none.
  expect(await img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
});

// AT THE CHECKOUT the pickup details OPEN IN PLACE. They shipped as a link to
// this page, which walked a buyer out of a half-filled order to read an address:
// the words she had typed, the copies she had chosen and the coupon she had
// applied were all behind a Back button she had no reason to trust. Nobody
// leaves a checkout to look something up and comes back sure their order
// survived.
test.describe('at the checkout', () => {
  test.beforeEach(async ({ page, request }) => {
    const r = await request.post('/api/collections', {
      data: { honoree_name: 'איסוף' + Date.now(), owner_email: 'pickup@example.com' },
    });
    const { id, owner_token } = await r.json();
    await page.goto(`/collect.html?c=${id}&k=${owner_token}&pay=1`);
  });

  test('the details expand in place and never leave the order', async ({ page }) => {
    const note = page.getByTestId('pickup-details');
    await expect(note).toBeVisible();
    // Shut on arrival — it is a footnote, not a section of the checkout.
    expect(await note.evaluate((el) => el.open)).toBe(false);

    const before = page.url();
    await note.locator('summary').click();
    expect(await note.evaluate((el) => el.open)).toBe(true);
    // THE WHOLE POINT: still on the order, at the same address.
    expect(page.url()).toBe(before);
    await expect(note).toContainText('התחייה 14');
    await expect(note).toContainText('כניסה B');
  });

  test('opening it does not touch the buyer’s chosen version', async ({ page }) => {
    // .pay-opt IS a <label>: anything inside one forwards its click to that
    // radio, so the note has to be a sibling — and opening it must leave the
    // selection exactly as she left it.
    const note = page.getByTestId('pickup-details');
    expect(await note.evaluate((el) => !!el.closest('label'))).toBe(false);

    const chosen = () => page.locator('input[name="payVersion"]:checked').getAttribute('value');
    const before = await chosen();
    await note.locator('summary').click();
    expect(await chosen()).toBe(before);
  });

  test('the note offers no way out of the checkout at all', async ({ page }) => {
    // The note used to end with a link to the full pickup page. Even opening in a
    // new tab, it invited a buyer mid-order to go and read something else; the
    // note already answers the question it asks, so the way out is gone. The full
    // page is still reachable from the footer of every page and from the FAQ,
    // where there is no half-filled order to lose.
    const note = page.getByTestId('pickup-details');
    await note.locator('summary').click();
    expect(await note.evaluate((el) => el.open)).toBe(true);
    await expect(page.getByTestId('pickup-details-link')).toHaveCount(0);
    await expect(note.locator('a')).toHaveCount(0);
    // What it must still answer, on its own.
    await expect(note).toContainText('התחייה 14');
    await expect(note).toContainText('9:00');
    await expect(note).toContainText('להביא');
  });
});

// The footer link, on every page that carries a footer. Self-pickup is the half
// of the order that happens OFF the site — an address, a floor, a closing time —
// so it is looked up long after the wizard is done and the confirmation mail has
// been buried. It sits beside the terms because both are the small print someone
// goes hunting for rather than reads on the way past.
const FOOTER_PAGES = ['/index.html', '/products.html', '/product.html', '/how.html'];

test.describe('the footer link', () => {
  for (const path of FOOTER_PAGES) {
    test(`${path} links to the pickup page, beside the terms`, async ({ page }) => {
      await page.goto(path);
      const link = page.getByTestId('footer-pickup');
      await expect(link).toHaveAttribute('href', 'pickup.html');
      await expect(link).toHaveText('איסוף עצמי');
      // Beside, not instead of: adding one line of fine print must not cost the
      // other, and the terms link is a legal requirement on a shop that charges.
      await expect(page.getByTestId('footer-terms')).toBeVisible();
      // One line, both links — same <p>, so the row reads as fine print rather
      // than as two separate footer sections.
      const sameRow = await link.evaluate(
        (el) =>
          el.closest('p') ===
          el.ownerDocument.querySelector('[data-testid="footer-terms"]').closest('p')
      );
      expect(sameRow).toBe(true);
    });
  }

  test('and the link actually opens the page', async ({ page }) => {
    await page.goto('/index.html');
    await page.getByTestId('footer-pickup').click();
    await expect(page).toHaveURL(/pickup\.html$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('איסוף עצמי');
  });
});
