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

// The rule this file exists for, stated directly: a GENERAL "דברו איתנו" must
// never carry the owner's own number. A business enquiry may — that is the whole
// point of having two numbers.
//
// This used to assert the stronger "the owner's number must not appear at all",
// on the stated premise that none of these four pages had a business link. That
// premise expired: the home page's לעסקים band (#506) put a deliberate business
// CTA on index.html pointing at her number, and the assertion started failing on
// main for a page that was behaving exactly as intended. Note the file already
// asserts, a few tests up, that her number MUST appear on index.html in the
// footer's לעסקים line — the two had drifted into contradicting each other.
//
// So it checks the real rule instead of the shortcut. A business link identifies
// itself in the markup — its own testid, its analytics slot, or the b2b block it
// sits in — and everything else on the page is a general contact link that must
// be support. A new "דברו איתנו" quietly wired to her personal phone still fails
// here, which is the failure worth catching.
test('no page carries the owner’s number on a GENERAL contact link', async ({ page }) => {
  for (const path of ['/index.html', '/how.html', '/collect.html', '/options.html']) {
    await page.goto(path);
    const links = await page.locator('a[href*="wa.me"]').evaluateAll((els) =>
      els.map((e) => ({
        href: e.getAttribute('href'),
        business: !!e.closest('[data-testid*="b2b"], [data-ga-where*="b2b"], [class*="b2b"]'),
      }))
    );
    const general = links.filter((l) => !l.business).map((l) => l.href);
    expect(general.filter((h) => OWNER.test(h))).toEqual([]);
  }
});

// The other half of the same rule: the business link that IS allowed to carry her
// number must still be reachable and still be hers. Without this, deleting the
// band (or repointing it at support) would pass the test above in silence — and a
// quantity enquiry landing in the support inbox is a sale nobody answers.
test('the home page’s business band still reaches the owner herself', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.getByTestId('b2b-wa')).toHaveAttribute('href', OWNER);
});
