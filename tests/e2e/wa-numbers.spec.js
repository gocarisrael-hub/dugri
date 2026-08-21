// TWO WhatsApp numbers, and which one a link carries is a decision, not an
// accident.
//
//   • SUPPORT (0552441334) — every general "דברו איתנו": the footer icon, the
//     footer's call button and the number printed beside it, the wizard's help
//     button, the word-collection page, the confirmation page. This is where a
//     customer with a question lands.
//   • THE OWNER'S OWN (0546577715) — business enquiries only. She takes those
//     herself, and a quantity enquiry routed to support is a sale nobody answers.
//
// The number is written into each page by hand (there is no build step), so this
// file is what stops the two drifting into each other.
import { test, expect } from '@playwright/test';

const SUPPORT = /wa\.me\/972552441334/;
const OWNER = /wa\.me\/972546577715/;

test('the home footer WhatsApp goes to support', async ({ page }) => {
  await page.goto('/index.html');
  // The footer icon's href is written by the page's own config (js/configurator).
  await expect(page.locator('#waLink')).toHaveAttribute('href', SUPPORT);
});

// The footer shows a number AND dials one AND opens a chat. Three places, one
// number: a footer that prints 054 next to an icon that opens 055 is a customer
// writing to the wrong phone and getting no answer.
test('the footer prints, dials and chats the same number', async ({ page }) => {
  await page.goto('/index.html');
  // The CONTACT block — the number a customer reads, dials and chats — is all
  // support. The "לעסקים" line lives in the same footer and deliberately still
  // carries the owner's own number, which is why this asserts on the contact
  // block rather than on the whole footer.
  const contact = page.locator('footer .foot-contact');
  await expect(contact).toContainText('0552441334');
  await expect(contact).not.toContainText('0546577715');
  await expect(page.locator('footer a[href^="tel:"]')).toHaveAttribute('href', 'tel:+972552441334');
  await expect(page.locator('#waLink')).toHaveAttribute('href', SUPPORT);
  await expect(page.getByTestId('footer-b2b')).toContainText('0546577715');
});

test('the shop’s business line still goes to the owner herself', async ({ page }) => {
  await page.goto('/products.html');
  const b2b = page.getByTestId('store-b2b').locator('a');
  await expect(b2b).toHaveAttribute('href', OWNER);
});

test('the product page’s WhatsApp goes to support', async ({ page }) => {
  await page.goto('/product.html');
  const wa = page.locator('footer a[href*="wa.me"]').first();
  await expect(wa).toHaveAttribute('href', SUPPORT);
});

// The rule is about WHICH KIND of link carries which number, so the check has to
// be per link, not per page. It was written as "these four pages have no business
// link at all, so the owner's number must not appear on them" — true when it was
// written, and false the moment the home page grew a B2B band of its own. Stated
// that way it failed on a link that is CORRECT: a business enquiry belongs to the
// owner, which is the whole point of having two numbers.
//
// So: every link the page offers as a general contact goes to support, and a
// business CTA is exempt the same way the footer's לעסקים line already is —
// identified by what it IS (data-ga-where="b2b-band" / the shop's store-b2b),
// never by which page it happens to sit on. A new business CTA on any page is
// then correct by construction, and a general link that quietly picks up the
// owner's number still fails here.
test('no page carries the owner’s number on a GENERAL contact link', async ({ page }) => {
  for (const path of ['/index.html', '/how.html', '/collect.html', '/options.html']) {
    await page.goto(path);
    const hrefs = await page
      .locator('a[href*="wa.me"]:not([data-ga-where="b2b-band"]):not([data-testid="b2b-wa"])')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(
      hrefs.filter((h) => OWNER.test(h)),
      `${path} routes a general link to the owner`
    ).toEqual([]);
  }
});

// …and the exemption is not a hole: the business CTA it lets through must really
// be the owner's, or the number split has silently reversed itself and quantity
// enquiries are landing in the support inbox.
test('the home page’s business CTA does go to the owner herself', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.getByTestId('b2b-wa')).toHaveAttribute('href', OWNER);
});
