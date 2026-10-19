import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// GA on the redesigned pages. What these pin:
// - every link and button on new.html and new-faq.html is counted: it carries data-ga, or it is on the short list below
//   of controls counted from the page's code (or closers that lead nowhere). A new link without data-ga fails here;
// - the events land with the names the live site's reports already use: nav_order, contact_click (channel call /
//   email, where footer), whatsapp_click, plus nav_click (target, where) and menu_open;
// - the redesign shell (the restyled pages in the mode) counts its menu the same way.

const COUNTED_IN_CODE = [
  '#deck', // deck_deal (js/home-new.js)
  '#track button.rc', // review_open
  '#strip .dz', // design_open
  '#stage .card', // dealt cards: part of the deck, deck_deal
  '#lead button[type="submit"]', // business_lead, once the lead is sent
  '#menuX', // closers: they lead nowhere
  '#sheetX',
  '#floodX',
  '#cookieNotice button', // the cookie notice's own close
  '#faqList a', // links the owner writes inside an FAQ answer (the shared FAQ text, js/faq.js)
];

const uncounted = (page) =>
  page.evaluate(
    (allow) =>
      [...document.querySelectorAll('a, button')]
        .filter((e) => !e.closest('[aria-hidden="true"]') && !e.hasAttribute('data-ga'))
        .filter((e) => !allow.some((s) => e.matches(s)))
        .map((e) => e.outerHTML.slice(0, 120)),
    COUNTED_IN_CODE
  );

const events = (page) =>
  page.evaluate(() =>
    window.dataLayer.filter((a) => a[0] === 'event').map((a) => [a[1], { ...a[2] }])
  );

// keep the page where it is so its dataLayer can be read after the click
const holdLinks = (page) =>
  page.evaluate(() =>
    document.addEventListener('click', (e) => e.target.closest('a') && e.preventDefault(), true)
  );

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

for (const path of ['/new.html', '/new-faq.html'])
  test(`${path}: every link and button is counted`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('load');
    expect(await uncounted(page)).toEqual([]);
  });

test('the homepage’s menu, footer and business fallback send their events', async ({ page }) => {
  await page.goto('/new.html');
  await page.waitForLoadState('load');
  await holdLinks(page);
  await page.locator('#menuBtn').click();
  await expect(page.locator('#menu')).toHaveAttribute('open', '');
  await page.locator('#menu a[href="#story"]').click();
  await page.locator('#menu .pill').evaluate((a) => a.click());
  for (const sel of [
    'footer a[href^="tel:"]:not(.ft-icon)',
    'footer a[href^="mailto:"]',
    'footer [data-testid="footer-timer"]',
    '#leadErr a',
  ])
    await page.locator(sel).evaluate((a) => a.click());
  const got = await events(page);
  for (const want of [
    ['menu_open', {}],
    ['nav_click', { target: 'story', where: 'menu' }],
    ['nav_order', { where: 'menu' }],
    ['contact_click', { channel: 'call', where: 'footer' }],
    ['contact_click', { channel: 'email', where: 'footer' }],
    ['nav_click', { target: 'timer', where: 'footer' }],
    ['whatsapp_click', { cta: 'business', where: 'lead-error' }],
  ])
    expect(got, want[0]).toContainEqual(want);
});

test('the redesign shell counts its menu', async ({ page }) => {
  await previewRedesign(page);
  await page.goto('/wordlists.html');
  await page.waitForLoadState('load');
  await holdLinks(page);
  await page.locator('#rdMenuBtn').click();
  await page.locator('#rdMenu a[href="how.html"]').click();
  await page.locator('#rdMenu .rd-btn').evaluate((a) => a.click());
  const got = await events(page);
  expect(got).toContainEqual(['menu_open', {}]);
  expect(got).toContainEqual(['nav_click', { target: 'how', where: 'menu' }]);
  expect(got).toContainEqual(['nav_order', { where: 'menu' }]);
});
