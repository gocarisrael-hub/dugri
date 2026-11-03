import { test, expect } from '@playwright/test';

// A template whose artwork names an image that will not render.
//
// Chrome prints such an image as its broken-image icon and says nothing; the
// grapefruit board reached the shop that way. The server reports every stored
// SVG that names a missing image (templates.js brokenSvgImages → imageNotes), and
// this screen has to put that in front of the owner, naming the file and the
// image, without calling the template incomplete (the file IS there).
//
// Fully MOCKED, like admin-template-fonts.spec.js, so it never touches the shared
// fixture or the owner store.
const KEY = 'dugri-admin';

const TEMPLATE = {
  key: 'oasis',
  slug: 'oasis',
  display_he: 'אואזיס',
  visibility: 'public',
  in_store: true,
  calibrated: true,
  language: 'hebrew',
  name_form: 'hebrew',
  extra_fields: [],
  title_text: 'רווקות ל{NAME}',
  title_lines: ['רווקות ל{NAME}'],
  title_style: { fill: '#711d20', outline: '#711d20' },
  board: null,
  back: null,
  card_structure: 'sheet',
  assets: [
    {
      role: 'clean-board',
      label: 'לוח (נקי)',
      kind: 'svg',
      optional: false,
      present: true,
      rel: 'clean/board.svg',
      brokenImages: [{ href: '../assets/aaf3dfada98d810c.png', reason: 'missing' }],
    },
  ],
  complete: true,
  missingRequired: [],
  fontNotes: [],
  imageNotes: [
    {
      role: 'clean-board',
      text: 'בקובץ "לוח (נקי)" יש תמונה שלא תוצג ותודפס כאייקון שבור: ../assets/aaf3dfada98d810c.png (הקובץ לא נמצא). העלו את הקובץ מחדש כשהתמונות מוטמעות בו.',
    },
  ],
};

async function mockList(page, overrides) {
  await page.route('**/api/admin/templates?key=*', (route) =>
    route.fulfill({ json: { templates: [{ ...TEMPLATE, ...(overrides || {}) }] } })
  );
  // The thumbnail fetch is irrelevant here; keep it off the real server.
  await page.route('**/api/admin/templates/*/asset-svg/**', (route) =>
    route.fulfill({ status: 404, body: 'Not found' })
  );
}

const card = (page) => page.locator('.tpl-card[data-key="oasis"]');

test.describe('admin templates — artwork with a broken image', () => {
  test('names the file and the image, without marking the template incomplete', async ({
    page,
  }) => {
    await mockList(page);
    await page.goto(`/admin-templates.html?key=${KEY}`);
    const notes = card(page).locator('.tpl-image-notes li');
    await expect(notes).toHaveCount(1);
    await expect(notes.first()).toContainText('לוח (נקי)');
    await expect(notes.first()).toContainText('../assets/aaf3dfada98d810c.png');
    await expect(notes.first()).toContainText('אייקון שבור');
    await expect(card(page).locator('.tpl-badge.incomplete')).toHaveCount(0);
  });

  test('a template whose images all resolve shows no such note', async ({ page }) => {
    await mockList(page, { imageNotes: [] });
    await page.goto(`/admin-templates.html?key=${KEY}`);
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('.tpl-image-notes')).toHaveCount(0);
  });
});
