// The courier control in the orders table (site/admin.html → hfdBox). The E2E
// server runs WITHOUT HFD credentials on purpose — a test must never book a real
// van — so both the armed and the dormant page are produced by patching the two
// admin responses on their way to the browser: /api/admin/hfd/status decides
// whether the control exists at all, and the collections list carries the
// shipment record it renders.
import { test, expect } from '@playwright/test';

const KEY = 'dugri-admin';

const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

async function seed(request, { name, email, phone }) {
  const create = await request.post('/api/collections', {
    data: { honoree_name: name, email, phone },
  });
  return create.json();
}

// Arm (or disarm) the courier for the page under test.
async function armHfd(page, configured) {
  await page.route('**/api/admin/hfd/status*', (route) =>
    route.fulfill({ json: { configured, clientNumber: configured ? '4242' : null } })
  );
}

// Make ONE seeded row look like a delivery order, optionally with a booked
// shipment on it.
async function markRowDelivery(page, honoreeName, hfd) {
  await page.route('**/api/admin/collections*', async (route) => {
    const resp = await route.fetch();
    const body = await resp.json();
    for (const c of body.collections || []) {
      if (c.honoree_name !== honoreeName) continue;
      c.order = {
        ...(c.order || {}),
        version: 'delivery',
        paid: true,
        address: { street: 'הרצל 5', city: 'תל אביב', postal: '6100000' },
        hfd: hfd || null,
      };
    }
    return route.fulfill({ json: body });
  });
}

test('a delivery order offers to book the parcel when HFD is armed', async ({ page, request }) => {
  const name = uniq('שליח');
  await seed(request, { name, email: 'ship@example.com', phone: '0521234567' });
  await armHfd(page, true);
  await markRowDelivery(page, name, null);

  await page.goto(`/admin.html?key=${KEY}`);
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row.getByRole('button', { name: 'שלח ל-HFD' })).toBeVisible();
});

// The one that matters most: no credentials, no button. A control whose only
// possible outcome is "not configured" is worse than no control.
test('no courier control at all while HFD is dormant', async ({ page, request }) => {
  const name = uniq('רדום');
  await seed(request, { name, email: 'dormant@example.com', phone: '0521234567' });
  await armHfd(page, false);
  await markRowDelivery(page, name, null);

  await page.goto(`/admin.html?key=${KEY}`);
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'שלח ל-HFD' })).toHaveCount(0);
});

test('a booked parcel shows its number, sticker, tracking and a way to cancel', async ({
  page,
  request,
}) => {
  const name = uniq('נשלח');
  await seed(request, { name, email: 'booked@example.com', phone: '0521234567' });
  await armHfd(page, true);
  await markRowDelivery(page, name, {
    shipment_number: '987654',
    rand_number: 'r-1',
    tracking_url: 'https://run.hfd.co.il/info/r-1',
    sent_at: new Date().toISOString(),
  });

  await page.goto(`/admin.html?key=${KEY}`);
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row.getByText('HFD 987654')).toBeVisible();
  await expect(row.locator('a[href*="/hfd/label?key="]')).toHaveCount(1);
  await expect(row.locator('a[href="https://run.hfd.co.il/info/r-1"]')).toHaveCount(1);
  await expect(row.getByRole('button', { name: 'בטל משלוח' })).toBeVisible();
  // Booked means booked: the row must not still invite a second van.
  await expect(row.getByRole('button', { name: 'שלח ל-HFD' })).toHaveCount(0);
});

test('a cancelled parcel says so and offers to book again', async ({ page, request }) => {
  const name = uniq('בוטל');
  await seed(request, { name, email: 'cancelled@example.com', phone: '0521234567' });
  await armHfd(page, true);
  await markRowDelivery(page, name, {
    shipment_number: '987654',
    cancelled_at: new Date().toISOString(),
  });

  await page.goto(`/admin.html?key=${KEY}`);
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row.getByText('משלוח בוטל (987654)')).toBeVisible();
  await expect(row.getByRole('button', { name: 'שלח ל-HFD' })).toBeVisible();
});

// A refusal the owner comes back to hours later has to still say what went
// wrong — "it didn't work" with no reason is what sends her to the phone.
test('a refused booking keeps HFD’s reason on the row', async ({ page, request }) => {
  const name = uniq('סירוב');
  await seed(request, { name, email: 'refused@example.com', phone: '0521234567' });
  await armHfd(page, true);
  await markRowDelivery(page, name, { error: 'עיר לא מוכרת', error_at: new Date().toISOString() });

  await page.goto(`/admin.html?key=${KEY}`);
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row.getByText('HFD סירבה: עיר לא מוכרת')).toBeVisible();
  await expect(row.getByRole('button', { name: 'שלח ל-HFD' })).toBeVisible();
});
