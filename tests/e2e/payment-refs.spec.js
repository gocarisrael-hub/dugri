import { test, expect } from '@playwright/test';

// The payment numbers on the orders page: a chargeback letter or a customer
// quotes an approval number, a voucher or a transaction id, and the owner finds
// the order from it and sees each number under its own name.
const KEY = 'dugri-admin';
const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
// A 7-digit number unique to this run, so parallel device projects sharing one
// store never find each other's order.
const num7 = () => String(1000000 + Math.floor(Math.random() * 8999999));

async function seed(request, name) {
  const create = await request.post('/api/collections', {
    data: { honoree_name: name, email: 'refs@example.com', phone: '0521234567' },
  });
  const { id, owner_token } = await create.json();
  await request.post(`/api/collections/${id}/order`, { data: { owner_token, version: 'pickup' } });
  return id;
}

// No route marks an order paid outside a real money event, so the payment fields
// are injected into the admin list response, like markRowPaid in admin.spec.js.
async function payRow(page, name, fields) {
  await page.route('**/api/admin/collections*', async (route) => {
    const resp = await route.fetch();
    const body = await resp.json();
    for (const c of body.collections || []) {
      if (c.honoree_name === name && c.order) Object.assign(c.order, { paid: true, ...fields });
    }
    return route.fulfill({ json: body });
  });
}

test('the edit dialog names every payment number', async ({ page, request }) => {
  const name = uniq('תשלום');
  const approval = num7();
  const voucher = num7();
  await seed(request, name);
  await payRow(page, name, {
    paid_method: 'pelecard',
    paid_approval_no: approval,
    paid_voucher_no: voucher,
    paid_transaction_id: 'TX-' + approval,
    charged_total: 199,
  });
  await page.goto(`/admin.html?key=${KEY}`);
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'ערוך' }).click();

  const pay = page.getByTestId('e-pay');
  await expect(pay).toBeVisible();
  await expect(page.getByTestId('pay-charge-order')).toContainText('פלאקארד');
  await expect(page.getByTestId('pay-charge-order')).toContainText('199 ₪');
  await expect(page.getByTestId('pay-ref-order-approval')).toHaveText(`מספר אישור: ${approval}`);
  await expect(page.getByTestId('pay-ref-order-voucher')).toHaveText(`שובר: ${voucher}`);
  await expect(page.getByTestId('pay-note-order')).toHaveCount(0);
});

test('an older PeleCard charge says its voucher was never stored', async ({ page, request }) => {
  const name = uniq('ישן');
  await seed(request, name);
  await payRow(page, name, { paid_method: 'pelecard', paid_approval_no: num7() });
  await page.goto(`/admin.html?key=${KEY}`);
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'ערוך' }).click();
  await expect(page.getByTestId('pay-ref-order-voucher')).toHaveCount(0);
  await expect(page.getByTestId('pay-note-order')).toContainText('זה לא מוכיח');
});

test('an unpaid order shows no payment block', async ({ page, request }) => {
  const name = uniq('לאשולם');
  await seed(request, name);
  await page.goto(`/admin.html?key=${KEY}`);
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'ערוך' }).click();
  await expect(page.locator('#edit')).toBeVisible();
  await expect(page.getByTestId('e-pay')).toBeHidden();
});

test('searching a voucher finds its order past the chips, and says what matched', async ({
  page,
  request,
}) => {
  const name = uniq('חיפוש');
  const other = uniq('אחרת');
  const voucher = num7();
  await seed(request, name);
  await seed(request, other);
  await payRow(page, name, {
    paid_method: 'pelecard',
    paid_approval_no: num7(),
    paid_voucher_no: voucher,
  });
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('tr', { hasText: other })).toBeVisible();

  // Grouped the way it is read off a letter.
  await page.getByTestId('ref-search').fill(voucher.slice(0, 3) + ' ' + voucher.slice(3));
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tr', { hasText: name })).toBeVisible();
  await expect(page.getByTestId('ref-note')).toContainText('שובר של ההזמנה');

  // Part of the number is not a match: a shared run of digits is another customer.
  await page.getByTestId('ref-search').fill(voucher.slice(0, 6));
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByTestId('ref-note')).toContainText('לא נמצאה הזמנה');

  // Clearing the box brings the table back.
  await page.getByTestId('ref-search').fill('');
  await expect(page.getByTestId('ref-note')).toBeHidden();
  await expect(page.locator('tr', { hasText: other })).toBeVisible();
});
