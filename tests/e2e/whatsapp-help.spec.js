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
