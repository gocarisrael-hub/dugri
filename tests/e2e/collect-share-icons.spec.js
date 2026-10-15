import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The owner's share card as two icon buttons, the link it shares always on the
// site's own domain, and the question flow's GA events.

const uniq = (p) => `${p}${Math.random().toString(36).slice(2, 8)}`;

async function makeParty(request, name = 'Shira') {
  const r = await request.post('/api/collections', { data: { honoree_name: name } });
  expect(r.ok()).toBeTruthy();
  const { id, owner_token: k } = await r.json();
  return { id, k };
}

const gaEvents = (page, name) =>
  page.evaluate(
    (n) =>
      (window.dataLayer || [])
        .map((a) => Array.from(a))
        .filter((a) => a[0] === 'event' && a[1] === n)
        .map((a) => a[2] || {}),
    name
  );

// The page asks GET /api/collections/<id>; answer with the server's real body
// plus the PUBLIC_BASE_URL a deployed server sends (the E2E server has none).
async function withShareBase(page, base) {
  await page.route(/\/api\/collections\/[^/?]+(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    return route.fulfill({ response: res, json: { ...body, share_base: base } });
  });
}

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

test('the share card is two labelled icon buttons, no visible link, and copy says so', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t) => (window.__copied.push(t), Promise.resolve()) },
    });
  });
  const { id, k } = await makeParty(request);
  await page.goto(`/collect.html?c=${id}&k=${k}`);
  const panel = page.locator('#sharePanel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('שלחו את הקישור הזה');

  // No link on screen: the one input left is the hidden carrier of the URL.
  await expect(panel.locator('input:visible')).toHaveCount(0);
  await expect(page.locator('#friendsLink')).toHaveAttribute('type', 'hidden');
  await expect(panel).not.toContainText('collect.html');

  const wa = page.getByTestId('share-whatsapp');
  const copy = page.getByTestId('copy-friends');
  await expect(wa).toHaveAttribute('aria-label', 'שיתוף בוואטסאפ');
  await expect(wa).toHaveAttribute('title', 'שיתוף בוואטסאפ');
  await expect(copy).toHaveAttribute('aria-label', 'העתקת הקישור');
  await expect(copy).toHaveAttribute('title', 'העתקת הקישור');
  // Icon only: no words on the buttons themselves.
  expect((await wa.innerText()).trim()).toBe('');
  expect((await copy.innerText()).trim()).toBe('');
  for (const b of [wa, copy]) {
    const box = await b.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  await copy.click();
  await expect(page.getByTestId('copy-done')).toHaveText('הועתק ✓');
  const link = await page.locator('#friendsLink').inputValue();
  expect(await page.evaluate(() => window.__copied)).toEqual([link]);
  expect(link).toContain(`/collect.html?c=${id}&k=${k}`);
  // The confirmation goes away again.
  await expect(page.getByTestId('copy-done')).toHaveText('', { timeout: 4000 });
});

test('the shared link is on the site’s domain, whichever host the page was opened on', async ({
  page,
  request,
}) => {
  const { id, k } = await makeParty(request);
  await withShareBase(page, 'https://dugri-israel.co.il');
  await page.goto(`/collect.html?c=${id}&k=${k}`);
  const expected = `https://dugri-israel.co.il/collect.html?c=${id}&k=${k}`;
  await expect(page.locator('#friendsLink')).toHaveValue(expected);
  const href = await page.getByTestId('share-whatsapp').getAttribute('href');
  const text = new URL(href).searchParams.get('text');
  expect(text).toContain(expected);
  expect(text).not.toContain(new URL(page.url()).origin);
});

test('the question flow reports idea, category and the word’s method, never the word', async ({
  page,
  request,
}) => {
  const { id, k } = await makeParty(request);
  await page.goto(`/collect.html?c=${id}&k=${k}`);

  await page.locator('#ideaBtn').click();
  expect(await gaEvents(page, 'idea_click')).toEqual([{ source: 'collect' }]);

  await page.locator('#catChips .chip').first().click();
  expect(await gaEvents(page, 'question_category')).toEqual([{ category: 'people' }]);

  const word = uniq('answer');
  const row = page.getByTestId('q-row').first();
  await row.getByTestId('q-input').fill(word);
  await row.getByTestId('q-add').click();
  await expect(page.locator('#wordsWrap')).toContainText(word);
  const added = await gaEvents(page, 'word_added');
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ method: 'question', category: 'people', count: 1 });
  const all = await page.evaluate(() => JSON.stringify(window.dataLayer));
  expect(all).not.toContain(word);

  // The main box still says single, with no category.
  await page.locator('#wordInput').fill(uniq('w'));
  await page.locator('#addBtn').click();
  await expect.poll(async () => (await gaEvents(page, 'word_added')).length).toBe(2);
  const single = (await gaEvents(page, 'word_added'))[1];
  expect(single.method).toBe('single');
  expect(single).not.toHaveProperty('category');
});
