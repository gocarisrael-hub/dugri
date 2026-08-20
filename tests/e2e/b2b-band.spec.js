// The business band on the home page (#business).
//
// "לעסקים" used to be one line in the footer: enough to click, not enough to
// decide from. What is under test is that the band SAYS what the offer is, that
// its WhatsApp link arrives looking like a business enquiry rather than like
// every other question, and that every word of it is the owner's to rewrite
// from the site itself.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
});

test('the band names the three things a business orders', async ({ page }) => {
  const band = page.locator('#business');
  await band.scrollIntoViewIfNeeded();
  await expect(band).toBeVisible();
  await expect(band.getByRole('heading', { name: 'דוגרי לעסקים' })).toBeVisible();
  for (const use of ['מתנה לצוות', 'כנסים וגיבושים', 'משחק ממותג']) {
    await expect(band.getByText(use, { exact: true })).toBeVisible();
  }
  // The one commitment the band makes, because a business needs it before it can
  // buy anything. It promises NO minimum quantity and NO turnaround: both were
  // written here on my guess and taken out on the owner's word — she is the one
  // who knows what she can hold to, and a promise on a page is a promise.
  await expect(band).toContainText('חשבונית מס');
  await expect(band).not.toContainText('יחידות');
  await expect(band).not.toContainText('יום עבודה');
});

test('its WhatsApp link carries a business message, not the general one', async ({ page }) => {
  const cta = page.getByTestId('b2b-wa');
  const href = await cta.getAttribute('href');
  expect(href).toContain('wa.me/972546577715');
  // The pre-filled text is percent-encoded Hebrew; decoding is what makes this
  // assertion readable — and what catches a link that lost its message.
  expect(decodeURIComponent(href)).toContain('הזמנה לעסק/אירוע גדול');
  await expect(cta).toHaveAttribute('target', '_blank');
  await expect(cta).toHaveAttribute('rel', /noopener/);
});

test('the click is counted, and counted as its own place', async ({ page }) => {
  const cta = page.getByTestId('b2b-wa');
  await expect(cta).toHaveAttribute('data-ga', 'contact_click');
  await expect(cta).toHaveAttribute('data-ga-channel', 'whatsapp');
  // Its own `where`, so the band can be judged against the footer line rather
  // than lumped in with it.
  await expect(cta).toHaveAttribute('data-ga-where', 'b2b-band');
});

test('every word of it is owner-editable', async ({ page }) => {
  const band = page.locator('#business');
  // Heading, sub, three titles, three bodies, the button and the terms line.
  await expect(band.locator('[data-edit^="index-b2b-"]')).toHaveCount(10);
});

test('it sits between the closing CTA and the footer', async ({ page }) => {
  // Last thing before the footer: a business reader has by then seen the whole
  // consumer pitch, which is the argument the band leans on.
  // Read the page order off the DOM as a list of landmarks, which needs no
  // browser globals in this file and says the same thing more plainly.
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('section.final, #business, footer')].map(
      (el) => el.id || el.tagName.toLowerCase()
    )
  );
  // "order" is the closing CTA section's own id.
  expect(order).toEqual(['order', 'business', 'footer']);
});
