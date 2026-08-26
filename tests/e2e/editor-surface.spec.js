// The template editor, opened for real.
//
// WHAT THIS CAN AND CANNOT SEE. The editor draws nothing until it has a
// template WITH ARTWORK — it fetches the card SVGs and the faces before it lays
// a single control out. The E2E fixture template has no artwork, so the panel
// never renders here and its controls cannot be asserted from a browser. That
// coverage lives in tests/unit/editor-hebrew.test.js, which reads the markup.
//
// What IS worth running in a browser is the part a markup test cannot reach:
// that the page comes up at all, reads right-to-left, and — when it cannot load
// a template — says so in the owner's language instead of showing her a blank
// screen or a stack trace.
import { test, expect } from '@playwright/test';

const KEY = 'dugri-admin'; // matches webServer.env in playwright.config.js

test('the editor comes up right-to-left, in Hebrew, without throwing', async ({ page }) => {
  const boom = [];
  page.on('pageerror', (e) => boom.push(String(e)));
  await page.goto('/admin-bench.html?key=' + KEY);
  await expect(page).toHaveTitle(/עורך התבנית/);
  const dir = await page.evaluate(() => getComputedStyle(document.documentElement).direction);
  expect(dir).toBe('rtl');
  expect(boom, 'the page threw on load: ' + boom.join(' | ')).toEqual([]);
});

test('a template it cannot load is reported, in Hebrew, not left blank', async ({ page }) => {
  await page.goto('/admin-bench.html?key=' + KEY);
  // Either it loaded a template (the pitch slider is VISIBLE) or it explains itself.
  //
  // Asserted as one wait over both, not as "decide, then check". `#wPitch` ships
  // in the static markup, so an `attached` probe answers yes before the fetch has
  // resolved — and when the load then fails, the error render REMOVES it. That
  // left a window where the probe said "drawn" and the assertion found nothing,
  // which is exactly how this failed under a full-suite run and passed alone.
  const drew = page.locator('#wPitch');
  const said = page.getByText('לא הצלחתי לטעון את התבנית');
  await expect(drew.or(said).first()).toBeVisible({ timeout: 15000 });
});

test('a wrong key is refused, and says so', async ({ page }) => {
  await page.goto('/admin-bench.html?key=not-the-key');
  await expect(page.locator('body')).toContainText('לא הצלחתי לטעון את התבנית');
});
