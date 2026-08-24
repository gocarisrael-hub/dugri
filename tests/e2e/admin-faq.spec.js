import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

// How many questions the SEED ships — read from the seed, never typed in here.
// The list has grown before (the self-pickup question), and every literal 5 in
// this file failed at once when it did, saying nothing about what broke.
const require = createRequire(import.meta.url);
const { DEFAULT_FAQ } = require('../../server/faq.js');
const SHIPPED = DEFAULT_FAQ.length;

// The owner FAQ editor (add / edit / reorder / hide / delete) and the public
// home-page render it drives. Behind the admin key: the e2e server runs with
// ADMIN_KEY=dugri-admin and DATA_DIR=.e2e-data (throwaway), so writes here never
// touch real data.
const KEY = 'dugri-admin';

// This spec owns the ONLY writes to the shared `faq` settings key. Like
// admin-pricing.spec.js, the tests that read or write that shared state run on
// ONE project — the two device profiles run the same file CONCURRENTLY against a
// single server, so a save on the desktop would race a read on the phone. The
// pure client-side tests (validation, unsaved reordering) run on both, since they
// never touch the server.
const ONLY = 'Desktop Chrome';

async function resetFaq(request) {
  const r = await request.delete(`/api/admin/settings?section=faq&settingKey=list&key=${KEY}`);
  expect(r.ok()).toBeTruthy();
}

const cards = (page) => page.locator('#faqCards [data-faq]');

test.describe('admin FAQ editor', () => {
  test('without a key the page reveals nothing and asks for ?key=', async ({ page }) => {
    let hitAdmin = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/settings')) hitAdmin = true;
    });
    await page.goto('/admin-faq.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    expect(hitAdmin).toBe(false);
  });

  test('with the key it renders one card per shipped question', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'reads shared faq state — one project only');
    await page.goto(`/admin-faq.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();
    await expect(cards(page)).toHaveCount(SHIPPED);

    const first = cards(page).first();
    await expect(first.locator('[data-f="q"]')).toHaveValue('מה זה בעצם המשחק?');
    await expect(first.locator('[data-f="enabled"]')).toBeChecked();
    // The first card can't move up and the last can't move down.
    await expect(first.locator('[data-act="up"]')).toBeDisabled();
    await expect(cards(page).last().locator('[data-act="down"]')).toBeDisabled();
  });

  test('adding a question saves it and it appears on the home page', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared faq state — one project only');
    await page.goto(`/admin-faq.html?key=${KEY}`);
    await expect(cards(page)).toHaveCount(SHIPPED);

    await page.locator('#addFaq').click();
    await expect(cards(page)).toHaveCount(SHIPPED + 1);
    const fresh = cards(page).last();
    await fresh.locator('[data-f="q"]').fill('יש משלוח עד הבית?');
    await fresh.locator('[data-f="a"]').fill('כרגע איסוף עצמי בלבד.\n\nמשלוחים בקרוב.');
    await fresh.locator('[data-f="link_text"]').fill('להזמנה');
    await fresh.locator('[data-f="link_url"]').fill('/options.html');

    await page.locator('#saveFaq').click();
    await expect(page.locator('#faqStatus')).toHaveText(/נשמר/);

    // The public endpoint carries it…
    const api = await (await request.get('/api/faq')).json();
    expect(api.items.map((r) => r.q)).toContain('יש משלוח עד הבית?');

    // …and so does the rendered home page: a fifth <details>, the answer split
    // into two paragraphs on the blank line, and the link as a real href.
    await page.goto('/index.html');
    const added = page.locator('#faqList details').last();
    await expect(added.locator('summary')).toHaveText('יש משלוח עד הבית?');
    await expect(added.locator('p')).toHaveCount(3); // 2 paragraphs + the link
    await expect(added.locator('a')).toHaveAttribute('href', '/options.html');

    await resetFaq(request);
  });

  test('hiding a question keeps it in the admin list but drops it from the site', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared faq state — one project only');
    await page.goto(`/admin-faq.html?key=${KEY}`);
    const second = cards(page).nth(1);
    await expect(second).toBeVisible();
    const hiddenText = await second.locator('[data-f="q"]').inputValue();

    await second.locator('[data-f="enabled"]').uncheck();
    await expect(second).toHaveClass(/off/); // greyed immediately
    await page.locator('#saveFaq').click();
    await expect(page.locator('#faqStatus')).toHaveText(/נשמר/);

    // Still every card for the owner, one of them off.
    await expect(cards(page)).toHaveCount(SHIPPED);
    await expect(cards(page).nth(1).locator('[data-f="enabled"]')).not.toBeChecked();

    // The visitor sees one fewer.
    await page.goto('/index.html');
    await expect(page.locator('#faqList details')).toHaveCount(SHIPPED - 1);
    await expect(page.locator('#faqList')).not.toContainText(hiddenText);

    await resetFaq(request);
  });

  test('deleting asks first, and only then removes the question', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared faq state — one project only');
    await page.goto(`/admin-faq.html?key=${KEY}`);
    await expect(cards(page)).toHaveCount(SHIPPED);
    const last = cards(page).last();
    const doomed = await last.locator('[data-f="q"]').inputValue();

    // Cancelling leaves everything alone.
    await last.locator('[data-act="del"]').click();
    await expect(page.locator('[data-confirm]')).toBeVisible();
    await page.locator('[data-act="del-no"]').click();
    await expect(page.locator('[data-confirm]')).toHaveCount(0);
    await expect(cards(page)).toHaveCount(SHIPPED);

    // Confirming removes it locally; saving persists.
    await cards(page).last().locator('[data-act="del"]').click();
    await page.locator('[data-act="del-yes"]').click();
    await expect(cards(page)).toHaveCount(SHIPPED - 1);
    await page.locator('#saveFaq').click();
    await expect(page.locator('#faqStatus')).toHaveText(/נשמר/);

    await page.goto('/index.html');
    await expect(page.locator('#faqList details')).toHaveCount(SHIPPED - 1);
    await expect(page.locator('#faqList')).not.toContainText(doomed);

    await resetFaq(request);
  });

  test('deleting every question hides the FAQ section on the home page', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared faq state — one project only');
    await page.goto(`/admin-faq.html?key=${KEY}`);
    await expect(cards(page)).toHaveCount(SHIPPED);

    // Deletes whatever the shipped list holds rather than a literal, so adding a
    // question to the seed can never leave this test one card short of empty.
    const shipped = await cards(page).count();
    for (let i = 0; i < shipped; i++) {
      await cards(page).first().locator('[data-act="del"]').click();
      await page.locator('[data-act="del-yes"]').click();
    }
    await expect(page.locator('[data-empty]')).toBeVisible();
    await page.locator('#saveFaq').click();
    await expect(page.locator('#faqStatus')).toHaveText(/נשמר/);

    await page.goto('/index.html');
    await expect(page.locator('#faq')).toBeHidden();

    // Reset brings the shipped questions (and the section) back.
    await resetFaq(request);
    await page.goto('/index.html');
    await expect(page.locator('#faqList details')).toHaveCount(SHIPPED);
  });

  test('the arrows reorder the list and the new order reaches the site', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared faq state — one project only');
    await page.goto(`/admin-faq.html?key=${KEY}`);
    const firstQ = await cards(page).nth(0).locator('[data-f="q"]').inputValue();
    const secondQ = await cards(page).nth(1).locator('[data-f="q"]').inputValue();

    await cards(page).nth(1).locator('[data-act="up"]').click();
    await expect(cards(page).nth(0).locator('[data-f="q"]')).toHaveValue(secondQ);
    await expect(cards(page).nth(1).locator('[data-f="q"]')).toHaveValue(firstQ);

    await page.locator('#saveFaq').click();
    await expect(page.locator('#faqStatus')).toHaveText(/נשמר/);

    await page.goto('/index.html');
    await expect(page.locator('#faqList details').first().locator('summary')).toHaveText(secondQ);

    await resetFaq(request);
  });

  // The two tests below are about CLIENT behaviour only, so they stub the admin
  // GET with a fixed list instead of reading the shared settings the other tests
  // are busy mutating. That keeps them deterministic AND lets them run on the
  // phone profile too — reorder-by-arrows exists precisely because the owner
  // works from a phone, so it must be exercised there.
  const STUB_LIST = [
    { id: 'one', enabled: true, q: 'ראשונה', a: 'תשובה א', link_text: '', link_url: '' },
    { id: 'two', enabled: true, q: 'שנייה', a: 'תשובה ב', link_text: '', link_url: '' },
    { id: 'three', enabled: true, q: 'שלישית', a: 'תשובה ג', link_text: '', link_url: '' },
  ];
  const stubSettings = (page) =>
    page.route('**/api/admin/settings*', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({
        json: {
          defaults: {},
          overrides: {},
          effective: { faq: { list: STUB_LIST } },
          registry: {},
        },
      });
    });

  test('reordering does NOT discard unsaved typing in another card', async ({ page }) => {
    await stubSettings(page);
    await page.goto(`/admin-faq.html?key=${KEY}`);
    await expect(cards(page)).toHaveCount(3);

    await cards(page).nth(0).locator('[data-f="q"]').fill('ערכתי ולא שמרתי');
    await cards(page).nth(2).locator('[data-act="up"]').click();

    // The edit survives the re-render, and the moved card swapped with its neighbour.
    await expect(cards(page).nth(0).locator('[data-f="q"]')).toHaveValue('ערכתי ולא שמרתי');
    await expect(cards(page).nth(1).locator('[data-f="q"]')).toHaveValue('שלישית');
    await expect(cards(page).nth(2).locator('[data-f="q"]')).toHaveValue('שנייה');
    // Focus follows the card that moved, so a second tap keeps moving it.
    await expect(cards(page).nth(1).locator('[data-act="up"]')).toBeFocused();
  });

  test('the client refuses to save an empty question or a dangerous link', async ({ page }) => {
    let posted = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/settings') && req.method() === 'POST') posted = true;
    });
    await stubSettings(page);
    await page.goto(`/admin-faq.html?key=${KEY}`);
    await expect(cards(page)).toHaveCount(3);

    await cards(page).first().locator('[data-f="q"]').fill('');
    await page.locator('#saveFaq').click();
    await expect(page.locator('#faqStatus')).toHaveText(/שאלה 1: .*ריקה/);
    expect(posted).toBe(false);

    await page.reload();
    await cards(page).first().locator('[data-f="link_text"]').fill('לחצו');
    await cards(page).first().locator('[data-f="link_url"]').fill('javascript:alert(1)');
    await page.locator('#saveFaq').click();
    await expect(page.locator('#faqStatus')).toHaveText(/https:\/\//);
    expect(posted).toBe(false);
  });

  test('the server refuses a dangerous link even if the client is bypassed', async ({
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'touches shared faq state — one project only');
    const res = await request.post(`/api/admin/settings?key=${KEY}`, {
      data: {
        section: 'faq',
        key: 'list',
        value: [
          {
            id: 'evil',
            enabled: true,
            q: 'שאלה',
            a: 'תשובה',
            link_text: 'לחצו',
            link_url: 'javascript:alert(1)',
          },
        ],
      },
    });
    expect(res.status()).toBe(400);
    // And the public list is untouched — still the shipped questions.
    const api = await (await request.get('/api/faq')).json();
    expect(api.items).toHaveLength(SHIPPED);
  });
});

test.describe('home-page FAQ rendering', () => {
  test('renders the questions from the API', async ({ page }) => {
    await page.route('**/api/faq', (route) =>
      route.fulfill({
        json: {
          items: [
            { id: 'x', q: 'שאלה מהשרת', a: 'תשובה מהשרת', link_text: '', link_url: '' },
            { id: 'y', q: 'שאלה שנייה', a: 'עוד תשובה', link_text: '', link_url: '' },
          ],
        },
      })
    );
    await page.goto('/index.html');
    await expect(page.locator('#faqList details')).toHaveCount(2);
    await expect(page.locator('#faqList summary').first()).toHaveText('שאלה מהשרת');
  });

  test('FAILS SOFT: a broken API leaves the shipped questions in place', async ({ page }) => {
    await page.route('**/api/faq', (route) => route.abort('failed'));
    await page.goto('/index.html');
    await expect(page.locator('#faqList details')).toHaveCount(SHIPPED);
    await expect(page.locator('#faqList summary').first()).toHaveText('מה זה בעצם המשחק?');
    await expect(page.locator('#faq')).toBeVisible();
  });

  test('a 500 or a malformed payload also leaves the shipped questions', async ({ page }) => {
    await page.route('**/api/faq', (route) => route.fulfill({ status: 500, json: {} }));
    await page.goto('/index.html');
    await expect(page.locator('#faqList details')).toHaveCount(SHIPPED);

    await page.unroute('**/api/faq');
    await page.route('**/api/faq', (route) => route.fulfill({ json: { items: 'nope' } }));
    await page.goto('/index.html');
    await expect(page.locator('#faqList details')).toHaveCount(SHIPPED);
  });

  test('an owner answer containing markup is shown as text, not executed', async ({ page }) => {
    await page.route('**/api/faq', (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: 'x',
              q: 'שאלה',
              a: '<img src=x onerror="window.__pwned=true">',
              link_text: 'לחצו',
              link_url: 'javascript:alert(1)',
            },
          ],
        },
      })
    );
    await page.goto('/index.html');
    await expect(page.locator('#faqList details p').first()).toContainText('onerror');
    expect(await page.locator('#faqList img').count()).toBe(0);
    expect(await page.locator('#faqList a').count()).toBe(0); // unsafe href dropped
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });
});
