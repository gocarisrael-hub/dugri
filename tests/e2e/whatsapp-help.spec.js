import { test, expect } from '@playwright/test';

// The floating WhatsApp "help" button must be present and visible on every
// customer-facing page of the order / word-collection flow, so a customer can
// reach the owner for help at any point. It links to the owner's number and
// opens in a new tab.
const WA_HREF = /wa\.me\/972546577715/;

test('options (order wizard) shows a visible WhatsApp help button', async ({ page }) => {
  await page.goto('/options.html');

  const help = page.getByTestId('wa-help');
  await expect(help).toBeVisible();
  await expect(help).toHaveAttribute('href', WA_HREF);
  await expect(help).toHaveAttribute('target', '_blank');
  await expect(help).toHaveAttribute('rel', /noopener/);
});

// The floating help button must never sit on top of the chasers (drinking-game)
// add-on toggle on the colour + add-ons step — a buyer has to be able to tap the
// toggle cleanly. The button is anchored on the physical RIGHT while the toggle
// sits on the physical LEFT of the RTL card, so their boxes never intersect at any
// scroll position.
test('the help button never overlaps the chasers toggle on the colour step', async ({ page }) => {
  await page.goto('/options.html');
  await page.getByTestId('design-0').click();
  await page.getByTestId('next-btn').click(); // -> step 2 (colour + add-ons)
  await expect(page.getByTestId('step-2')).toBeVisible();

  const help = page.getByTestId('wa-help');
  const toggle = page.getByTestId('chasers-toggle');
  await expect(help).toBeVisible();
  await expect(toggle).toBeVisible();

  const intersects = (a, b) =>
    !(
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y
    );

  // check across scroll positions: the toggle can scroll into the button's fixed
  // band, and it must still never be covered.
  for (const y of [0, 80, 160, 260]) {
    await page.evaluate((s) => window.scrollTo(0, s), y);
    await page.waitForTimeout(80);
    const hb = await help.boundingBox();
    const tb = await toggle.boundingBox();
    expect(hb, `help box at scroll ${y}`).not.toBeNull();
    expect(tb, `toggle box at scroll ${y}`).not.toBeNull();
    expect(intersects(hb, tb), `overlap at scroll ${y}`).toBe(false);
  }
});

test('collect (word-collection) page shows a visible WhatsApp help button', async ({
  page,
  request,
}) => {
  // Seed a collection through the API so we can open collect.html directly.
  const create = await request.post('/api/collections', {
    data: { honoree_name: `עזרה-${Math.random().toString(36).slice(2, 8)}` },
  });
  const { id } = await create.json();

  await page.goto(`/collect.html?c=${id}`);

  const help = page.getByTestId('wa-help');
  await expect(help).toBeVisible();
  await expect(help).toHaveAttribute('href', WA_HREF);
  await expect(help).toHaveAttribute('target', '_blank');
  await expect(help).toHaveAttribute('rel', /noopener/);
});
