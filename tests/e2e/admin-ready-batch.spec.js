import { test, expect } from '@playwright/test';

// The button that marks the whole בדפוס pile ready — from the owner's side.
//
// The server half is covered by tests/unit/ready-batch.test.js against real paid
// orders. What can only be checked here is the part she actually touches: that
// the button appears with the right count, that the dialog tells her the truth
// about what is about to happen, and that nothing is sent when she says no.
//
// Orders are injected on their way to the page rather than created paid: the
// E2E server runs without card credentials on purpose, so no order can become
// paid in the store (see the note in admin.spec.js).
const KEY = 'dugri-admin';

// Two orders resting in בדפוס: paid, sent to print, not yet ready.
async function stagePile(page, { pickup = 1, delivery = 1 } = {}) {
  await page.route('**/api/admin/collections*', async (route) => {
    const resp = await route.fetch();
    const body = await resp.json();
    const rows = [];
    const mk = (i, version) => ({
      id: 'batch-' + version + '-' + i,
      honoree_name: 'הזמנה ' + version + ' ' + i,
      order_no: 'DG-90' + i,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      status: 'closed',
      word_count: 100,
      order: {
        version,
        paid: true,
        total: 199,
        quantity: 1,
        sent_to_print_at: new Date().toISOString(),
        ready_at: null,
      },
    });
    for (let i = 0; i < pickup; i++) rows.push(mk(i, 'pickup'));
    for (let i = 0; i < delivery; i++) rows.push(mk(i, 'delivery'));
    body.collections = rows;
    await route.fulfill({ response: resp, json: body });
  });
}

// The server's own preview + press, stubbed so the dialog's wording and the
// press are observable without texting anybody.
async function stageBatchApi(page, { preview, pressed }) {
  await page.route('**/api/admin/orders/ready-batch*', async (route) => {
    if (route.request().method() === 'POST') {
      pressed.count++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, marked: 2, sms_queued: 1, orders: [], failed: [] }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(preview),
    });
  });
}

const PREVIEW = {
  count: 2,
  pickup: 1,
  delivery: 1,
  no_phone: ['DG-9001'],
  sms_enabled: true,
  orders: [],
};

test.describe('marking the whole בדפוס pile ready', () => {
  test('the button carries its count and is hidden when there is nothing to press', async ({
    page,
  }) => {
    await stagePile(page, { pickup: 1, delivery: 1 });
    await page.goto(`/admin.html?key=${KEY}`);
    const btn = page.getByTestId('batch-ready');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('2');

    // Nothing in בדפוס: no button at all, rather than one whose only answer is
    // "there was nothing to press".
    await page.unroute('**/api/admin/collections*');
    await stagePile(page, { pickup: 0, delivery: 0 });
    await page.reload();
    await expect(page.getByTestId('batch-ready')).toBeHidden();
  });

  test('the dialog says how many, of which kind, and who will get no text', async ({ page }) => {
    const pressed = { count: 0 };
    await stagePile(page);
    await stageBatchApi(page, { preview: PREVIEW, pressed });
    await page.goto(`/admin.html?key=${KEY}`);

    let asked = '';
    page.on('dialog', (d) => {
      asked = d.message();
      d.dismiss();
    });
    await page.getByTestId('batch-ready').click();
    await expect.poll(() => asked).toContain('2');
    expect(asked).toContain('באיסוף עצמי');
    expect(asked).toContain('במשלוח');
    expect(asked).toContain('מייל ו-SMS');
    // The orders that will hear nothing are NAMED — three order numbers tell her
    // which three to phone; a count sends her hunting through the table.
    expect(asked).toContain('DG-9001');
    expect(asked).toContain('אי אפשר לבטל');

    // Dismissed means nothing happened. A confirm that fires anyway is worse
    // than no confirm at all.
    expect(pressed.count).toBe(0);
  });

  test('saying no sends nothing; saying yes presses once and reports back', async ({ page }) => {
    const pressed = { count: 0 };
    await stagePile(page);
    await stageBatchApi(page, { preview: PREVIEW, pressed });
    await page.goto(`/admin.html?key=${KEY}`);

    const messages = [];
    page.on('dialog', (d) => {
      messages.push(d.message());
      // The confirm is accepted; the alert that follows is dismissed.
      if (d.type() === 'confirm') d.accept();
      else d.dismiss();
    });
    await page.getByTestId('batch-ready').click();
    await expect.poll(() => pressed.count).toBe(1);
    // What actually happened, not what was asked for.
    await expect.poll(() => messages.join('|')).toContain('סומנו 2');
    expect(messages.join('|')).toContain('1 הודעות SMS');
  });

  test('with SMS switched off the dialog promises a text to nobody', async ({ page }) => {
    const pressed = { count: 0 };
    await stagePile(page);
    await stageBatchApi(page, { preview: { ...PREVIEW, sms_enabled: false }, pressed });
    await page.goto(`/admin.html?key=${KEY}`);

    let asked = '';
    page.on('dialog', (d) => {
      asked = d.message();
      d.dismiss();
    });
    await page.getByTestId('batch-ready').click();
    await expect.poll(() => asked).toContain('SMS כבוי');
  });
});
