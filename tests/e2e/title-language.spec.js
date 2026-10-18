import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';
import { previewRedesign } from './helpers/redesign.js';

// THE ONE-LANGUAGE TITLE (the shop owner, 2026-10-18): the printed title is Hebrew OR English, never both; digits,
// spaces and punctuation are free. The generator sets the whole title in the one face its first letter picks
// (render_page.title_script / title_font_for), so a mixed title prints half in a face chosen for the other script.
// Both doors onto the title say so in the field and hold the button, in both looks of the site, and the API refuses it.

const MSG = 'כותרת בשפה אחת בלבד - עברית או אנגלית';
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const ORDER = {
  honoree_name: 'ליאת',
  email: 'lang@example.com',
  phone: '0521234567',
  design: 'פריז',
  theme: 'bachelorette',
  extra_fields: {},
  buyer_name: 'דנה כהן',
};

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      }),
    })
  );
});

for (const mode of ['off', 'on']) {
  test(`the wizard says it in the field and holds "הבא" (mode ${mode})`, async ({ page }) => {
    if (mode === 'on') await previewRedesign(page);
    await page.goto('/options.html');
    const next = page.getByTestId('next-btn');
    await next.click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await next.click();
    await expect(page.getByTestId('step-3')).toBeVisible();

    const err = page.getByTestId('custom-title-err');
    await page.getByTestId('custom-title-input').fill('Liat חוגגת 40');
    await expect(err).toBeVisible();
    await expect(err).toHaveText(MSG);
    await expect(next).toBeDisabled();

    await page.getByTestId('custom-title-input').fill('ליאת חוגגת 40!');
    await expect(err).toBeHidden();
    await expect(next).toBeEnabled();
    await page.getByTestId('custom-title-input').fill('Liat turns 40');
    await expect(err).toBeHidden();
    await expect(next).toBeEnabled();
  });

  test(`the collection page says it in the field and holds שמירה (mode ${mode})`, async ({
    page,
  }) => {
    if (mode === 'on') await previewRedesign(page);
    const res = await page.request.post('/api/collections', {
      data: { ...ORDER, custom_title: 'ליאת חוגגת 40' },
    });
    expect(res.ok()).toBe(true);
    const { id, owner_token: k } = await res.json();
    await page.goto(`/collect.html?c=${id}&k=${k}`);
    await page.locator('.tabbar-btn[data-tab="design"]').click();

    const input = page.getByTestId('title-input');
    const err = page.getByTestId('title-err');
    const save = page.getByTestId('title-save');
    await input.fill('ליאת turns 40');
    await expect(err).toBeVisible();
    await expect(err).toHaveText(MSG);
    await expect(save).toBeDisabled();

    await input.fill('ליאת חוגגת 41');
    await expect(err).toBeHidden();
    await expect(save).toBeEnabled();
    await save.click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/collections/${id}?k=${k}`)).json()).custom_title
      )
      .toBe('ליאת חוגגת 41');
  });
}

test('the API refuses a mixed title at both doors, and takes either language alone', async ({
  request,
}) => {
  const mixed = await request.post('/api/collections', {
    data: { ...ORDER, custom_title: 'Liat חוגגת 40' },
  });
  expect(mixed.status()).toBe(400);
  expect(await mixed.json()).toMatchObject({
    error: 'title_language',
    field: 'custom_title',
    message: MSG,
  });

  const ok = await request.post('/api/collections', {
    data: { ...ORDER, custom_title: 'Liat turns 40' },
  });
  expect(ok.ok()).toBe(true);
  const { id, owner_token: k } = await ok.json();

  const retitle = await request.put(`/api/collections/${id}/title?k=${k}`, {
    data: { custom_title: 'Liat חוגגת 40' },
  });
  expect(retitle.status()).toBe(400);
  expect((await retitle.json()).error).toBe('title_language');

  const hebrew = await request.put(`/api/collections/${id}/title?k=${k}`, {
    data: { custom_title: 'ליאת חוגגת 40' },
  });
  expect(hebrew.ok()).toBe(true);
});
