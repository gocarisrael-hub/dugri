import { test, expect } from '@playwright/test';

// The button that marks the whole בדפוס pile ready — from the owner's side.
//
// The server half is covered by tests/unit/ready-batch.test.js against real paid
// orders. What can only be checked here is the part she actually touches: that
// the button appears with the right count, on the right section, that the dialog
// tells her the truth about what is about to happen, and that nothing is sent
// when she says no.
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
async function stageBatchApi(page, { preview, pressed, pressResult }) {
  await page.route('**/api/admin/orders/ready-batch*', async (route) => {
    if (route.request().method() === 'POST') {
      pressed.count++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          marked: 2,
          sms_queued: 1,
          // What the server reports after AWAITING each send: one mail landed,
          // one did not, and the one that did not is named.
          emailed: 1,
          not_emailed: ['DG-9002'],
          email_enabled: true,
          sms_enabled: true,
          orders: [],
          failed: [],
          ...(pressResult || {}),
        }),
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
  kinds: { pickup: 1, delivery: 1, pdf: 0, custom: 0, other: 0 },
  no_phone: ['DG-9001'],
  sms_enabled: true,
  email_enabled: true,
  orders: [],
};

// The two filter rows. Chips carry their count in their label ("בדפוס (2)"), so
// they are picked by data-filter rather than by text.
const stageChip = (page, id) => page.locator(`#tabs-stage button[data-filter="${id}"]`);
const payChip = (page, id) => page.locator(`#tabs button[data-filter="${id}"]`);

// הכל מוכן lives on the בדפוס chip and nowhere else: it empties that stage, so it
// is drawn only while the table shows it. Every test that presses it opens that
// section first, the way the owner does.
async function openOnPrinting(page) {
  await page.goto(`/admin.html?key=${KEY}`);
  await stageChip(page, 'printing').click();
  await expect(stageChip(page, 'printing')).toHaveClass(/active/);
}

test.describe('marking the whole בדפוס pile ready', () => {
  test('the button carries its count and is hidden when there is nothing to press', async ({
    page,
  }) => {
    await stagePile(page, { pickup: 1, delivery: 1 });
    await openOnPrinting(page);
    const btn = page.getByTestId('batch-ready');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('2');

    // Nothing in בדפוס: no button at all, even on its own section, rather than
    // one whose only answer is "there was nothing to press".
    await page.unroute('**/api/admin/collections*');
    await stagePile(page, { pickup: 0, delivery: 0 });
    await page.reload();
    await stageChip(page, 'printing').click();
    await expect(stageChip(page, 'printing')).toHaveClass(/active/);
    await expect(page.getByTestId('batch-ready')).toBeHidden();
  });

  // The button empties the בדפוס stage, so it is drawn on that chip and no
  // other. On הכל, or on any other stage, the table is showing rows the button
  // does not press on — and it used to sit there anyway.
  test('the button is shown on the בדפוס section and hidden on every other', async ({ page }) => {
    await stagePile(page);
    await page.goto(`/admin.html?key=${KEY}`);
    // Loaded, with a pile to press on: the chip counts it.
    await expect(stageChip(page, 'printing')).toContainText('(2)');
    const btn = page.getByTestId('batch-ready');

    // The default view is every stage at once — not the button's section.
    await expect(stageChip(page, 'all')).toHaveClass(/active/);
    await expect(btn).toBeHidden();

    for (const other of ['collecting', 'to-produce', 'to-print', 'ready', 'cancelled']) {
      await stageChip(page, other).click();
      await expect(stageChip(page, other)).toHaveClass(/active/);
      await expect(btn, `shown on the ${other} stage`).toBeHidden();
    }

    // Its own section: there at once, with the count, no reload needed.
    await stageChip(page, 'printing').click();
    await expect(btn).toBeVisible();
    await expect(page.locator('#batchReadyCount')).toHaveText('2');

    // …and gone again the moment she moves off it.
    await stageChip(page, 'all').click();
    await expect(btn).toBeHidden();
  });

  // בדפוס with לידים shows the unpaid orders at the printer, and the pile is
  // paid orders only — so on that pair the button would act entirely on rows
  // the table is not showing.
  test('on בדפוס the payment row keeps it only while the pile is on screen', async ({ page }) => {
    await stagePile(page);
    await openOnPrinting(page);
    const btn = page.getByTestId('batch-ready');
    await expect(btn).toBeVisible();

    await payChip(page, 'leads').click();
    await expect(payChip(page, 'leads')).toHaveClass(/active/);
    await expect(btn).toBeHidden();

    await payChip(page, 'paid').click();
    await expect(btn).toBeVisible();
    await payChip(page, 'all').click();
    await expect(btn).toBeVisible();
  });

  test('the dialog says how many, of which kind, and who will get no text', async ({ page }) => {
    const pressed = { count: 0 };
    await stagePile(page);
    await stageBatchApi(page, { preview: PREVIEW, pressed });
    await openOnPrinting(page);

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
    await openOnPrinting(page);

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
    // The mails that really went — and the customer whose mail did not, named,
    // because she is the one who now has to be told by hand.
    expect(messages.join('|')).toContain('1 מיילים נשלחו');
    expect(messages.join('|')).toContain('DG-9002');
  });

  test('with SMS switched off the dialog promises a text to nobody', async ({ page }) => {
    const pressed = { count: 0 };
    await stagePile(page);
    await stageBatchApi(page, { preview: { ...PREVIEW, sms_enabled: false }, pressed });
    await openOnPrinting(page);

    let asked = '';
    page.on('dialog', (d) => {
      asked = d.message();
      d.dismiss();
    });
    await page.getByTestId('batch-ready').click();
    await expect.poll(() => asked).toContain('SMS כבוי');
  });

  // The owner can switch the ready mail off, and then the dialog's old promise
  // ("each one will get a mail") was simply false — confirmed on that basis,
  // with nothing sent. What is switched off has to say so.
  test('with the ready mail switched off the dialog does not promise one', async ({ page }) => {
    const pressed = { count: 0 };
    await stagePile(page);
    await stageBatchApi(page, { preview: { ...PREVIEW, email_enabled: false }, pressed });
    await openOnPrinting(page);

    let asked = '';
    page.on('dialog', (d) => {
      asked = d.message();
      d.dismiss();
    });
    await page.getByTestId('batch-ready').click();
    await expect.poll(() => asked).toContain('המיילים כבויים');
    expect(asked).not.toContain('כל אחת תקבל מייל');
  });

  test('with both switched off it says plainly that nobody will hear anything', async ({
    page,
  }) => {
    const pressed = { count: 0 };
    await stagePile(page);
    await stageBatchApi(page, {
      preview: { ...PREVIEW, email_enabled: false, sms_enabled: false },
      pressed,
    });
    await openOnPrinting(page);

    let asked = '';
    page.on('dialog', (d) => {
      asked = d.message();
      d.dismiss();
    });
    await page.getByTestId('batch-ready').click();
    await expect.poll(() => asked).toContain('לא יישלחו מיילים ולא הודעות SMS');
    expect(asked).not.toContain('אי אפשר לבטל');
  });

  // A digital order in the pile is not a box at גלאור. Filing it under
  // self-pickup tells her to expect one.
  test('the dialog counts a digital order as digital, not as self-pickup', async ({ page }) => {
    const pressed = { count: 0 };
    await stagePile(page);
    await stageBatchApi(page, {
      preview: {
        ...PREVIEW,
        count: 2,
        pickup: 1,
        delivery: 0,
        kinds: { pickup: 1, delivery: 0, pdf: 1, custom: 0, other: 0 },
      },
      pressed,
    });
    await openOnPrinting(page);

    let asked = '';
    page.on('dialog', (d) => {
      asked = d.message();
      d.dismiss();
    });
    await page.getByTestId('batch-ready').click();
    await expect.poll(() => asked).toContain('1 דיגיטליות');
    expect(asked).toContain('1 באיסוף עצמי');
    expect(asked).not.toContain('2 באיסוף עצמי');
  });
});
