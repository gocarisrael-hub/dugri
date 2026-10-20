import { test, expect } from '@playwright/test';

// The "נוספה מילה ✓" toast must sit UNDER the page's sheets. The friend-coupon
// sheet opens right after a friend's first word, which is exactly when the toast
// is up, and at z-index 200 it lay over the sheet's send button. Checked by
// what is actually on top at a point (elementFromPoint), not by comparing
// z-index numbers: stacking contexts make the numbers lie.

const uniq = (p) => `${p}${Math.random().toString(36).slice(2, 8)}`;

test('the add-word toast never covers the friend-coupon sheet', async ({ page, request }) => {
  const r = await request.post('/api/collections', { data: { honoree_name: 'Shira' } });
  expect(r.ok()).toBeTruthy();
  const { id } = await r.json();

  await page.goto(`/collect.html?c=${id}`);
  await page.locator('#wordInput').fill(uniq('word'));
  await page.locator('#addBtn').click();
  await expect(page.locator('#toast')).toHaveText(/נוספה מילה/);
  await page.getByTestId('friend-bar-go').click();
  await expect(page.getByTestId('friend-send')).toBeVisible();

  // Hold the toast up: its 1.8s life is a timing detail, the layering is not.
  await page.evaluate(() => {
    const t = document.getElementById('toast');
    t.style.transition = 'none';
    t.classList.add('show');
    // The toast is pointer-events:none, and elementFromPoint skips such an
    // element, so a probe would never find it even when it IS on top. Turned
    // on here for the probe only: it changes hit-testing, not stacking.
    t.style.pointerEvents = 'auto';
  });
  await expect(page.locator('#toast')).toHaveCSS('opacity', '1');

  const hits = await page.evaluate(() => {
    const centre = (el) => {
      const b = el.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    };
    const toast = document.getElementById('toast');
    const send = document.querySelector('[data-testid="friend-send"]');
    const sheet = document.getElementById('friendSheet');
    const atToast = document.elementFromPoint(...centre(toast));
    const atSend = document.elementFromPoint(...centre(send));
    return {
      toastOnTop: toast.contains(atToast),
      sheetAtToast: sheet.contains(atToast),
      sendOnTop: send.contains(atSend),
    };
  });
  expect(hits.toastOnTop).toBe(false);
  expect(hits.sheetAtToast).toBe(true);
  expect(hits.sendOnTop).toBe(true);
});
