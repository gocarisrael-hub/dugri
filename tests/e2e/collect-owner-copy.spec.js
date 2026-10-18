import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// The owner's copy on the word collection (feedback on the redesign, 2026-10-18). Text, so it is the same on the
// live site and in redesign mode, and both are checked:
// - the share box: "שתפו עם חברות" and one sentence about what the link is for;
// - the word-list choice: one short line;
// - no "minimum" anywhere on the page, and no running commentary under the words bar.

async function makeCollection(request) {
  const res = await request.post('/api/collections', {
    data: {
      honoree_name: 'ליאת',
      email: 'copy@example.com',
      phone: '0521234567',
      design: 'פריז',
      theme: 'bachelorette',
      extra_fields: {},
      custom_title: 'ליאת חוגגת 40',
      buyer_name: 'דנה כהן',
    },
  });
  expect(res.ok()).toBe(true);
  const { id, owner_token: k } = await res.json();
  return { id, k };
}

for (const mode of ['off', 'on']) {
  test(`the share box, the word-list line and the counter read as the owner wrote them (mode ${mode})`, async ({
    page,
    request,
  }) => {
    if (mode === 'on') await previewRedesign(page);
    // the shipped copy, not whatever a content override on this data store says
    await page.route('**/api/content*', (route) => route.fulfill({ json: { overrides: {} } }));
    const { id, k } = await makeCollection(request);
    await page.goto(`/collect.html?c=${id}&k=${k}`);
    await expect(page.locator('#sharePanel')).toBeVisible();

    await expect(page.locator('[data-edit="collect-share-heading"]')).toHaveText('שתפו עם חברות');
    await expect(page.locator('[data-edit="collect-share-hint"]')).toHaveText(
      'שלחו את הקישור הזה לכל מי שמכיר/ה את בעל/ת השמחה שיעזרו באיסוף המילים.'
    );
    await expect(page.locator('#poolHint')).toHaveText(
      'בחרו את רשימת המילים ממנה נשלים לכם לחפיסה מלאה'
    );

    await page.fill('#wordInput', 'מילה');
    await page.locator('#addBtn').click();
    await expect(page.locator('#count')).toHaveText('1');
    await expect(page.locator('#countMax')).toHaveText(' / 70 מילים');
    await expect(page.locator('#countHint')).toHaveText('');
    expect(await page.locator('body').innerText()).not.toContain('מינימום');
  });
}
