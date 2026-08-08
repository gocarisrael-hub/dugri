// @vitest-environment node
// The PAYMENT receipts: one email to the owner and one to the buyer, fired at the
// real unpaid->paid transition (and only there). These are the second half of the
// two-email pair — the first pair fires at order CREATION (see
// order-created-notify.test.js / free-order-emails.test.js).
//
// Two layers are covered:
//   1. The pure builders in server/notify.js — subject, body, the charged amount,
//      the branded HTML (logo, hero product photo, add-words CTA).
//   2. The wiring in server/index.js — that a manual admin mark-paid fires the
//      pair exactly once, and that a re-click never re-sends.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const notifyPath = path.join(serverDir, 'notify.js');
const settingsPath = path.join(serverDir, 'settings.js');

const BASE = 'https://dugri.example';
const link = `${BASE}/collect.html?c=col-1&k=tok-abc`;

const collection = {
  id: 'col-1',
  honoree_name: 'שירה',
  owner_token: 'tok-abc',
  owner_email: 'buyer@example.com',
  design: 'קלאסי',
  color: 'ורוד',
  order: { version: 'pdf', total: 199, paid: true },
  count: 142,
};

// Fresh notify + settings sharing one settings instance against a temp DATA_DIR,
// so template overrides start empty and stay isolated per test.
function loadFresh() {
  delete require.cache[require.resolve(notifyPath)];
  delete require.cache[require.resolve(settingsPath)];
  const settings = require(settingsPath);
  const notify = require(notifyPath);
  return { settings, notify };
}

describe('payment receipt builders', () => {
  let notify;
  let settings;

  beforeEach(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-receipt-'));
    ({ notify, settings } = loadFresh());
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
  });

  it("the owner receipt states the payment and carries the order's details", () => {
    const msg = notify.buildPaymentReceipt(collection, BASE, {
      amountCharged: 149,
      adminLink: BASE + '/admin.html?key=secret',
    });
    expect(msg.subject).toBe('דוגרי · התקבל תשלום — שירה');
    expect(msg.text).toContain('התקבל תשלום עבור ההזמנה של שירה.');
    expect(msg.text).toContain('מספר הזמנה: col-1');
    expect(msg.text).toContain('מספר מילים: 142');
    expect(msg.text).toContain('קישור לניהול: ' + link);
    expect(msg.text).toContain('ניהול ההזמנה: ' + BASE + '/admin.html?key=secret');
    // The AMOUNT CHARGED, not the order's pre-coupon total.
    expect(msg.text).toContain('סכום: 149 ₪');
    expect(msg.text).not.toContain('199');
  });

  it('the owner receipt falls back to the order total when no charge is known', () => {
    // A manual admin mark-paid knows no charged amount.
    const msg = notify.buildPaymentReceipt(collection, BASE, {});
    expect(msg.text).toContain('סכום: 199 ₪');
  });

  it('a fully-free (100%-coupon) order reads as free, not as 0 ₪', () => {
    const msg = notify.buildPaymentReceipt(collection, BASE, { amountCharged: 0 });
    expect(msg.text).toContain('קופון 100%');
  });

  it('the buyer receipt confirms payment and links to the words, without itemising', () => {
    const msg = notify.buildBuyerReceipt(collection, BASE, { amountCharged: 149 });
    expect(msg.subject).toBe('דוגרי · התשלום התקבל — שירה');
    expect(msg.text).toContain('התשלום התקבל — תודה רבה!');
    // The itemised block is gone: the buyer is shown the template photo (asserted
    // in the HTML case below) rather than read a paid/design/colour list. The
    // OWNER's receipt still carries all of it — see the owner cases above.
    expect(msg.text).not.toContain('· שולם: 149 ₪');
    expect(msg.text).not.toContain('· עיצוב: קלאסי');
    expect(msg.text).not.toContain('· צבע: ורוד');
    // The order REFERENCE is the one detail that stayed: it is what the customer
    // quotes back at us when they write about this order.
    expect(msg.text).toContain('מספר הזמנה: col-1');
    // The words link is in the plain-text body...
    expect(msg.text).toContain(link);
    // ...and the admin key never is (the buyer's copy gets no admin link).
    expect(msg.text).not.toContain('admin.html');
  });

  it('the buyer receipt is branded HTML with the logo, product photo and CTA', () => {
    const photo = BASE + '/assets/designs/classic/store.webp';
    const msg = notify.buildBuyerReceipt(collection, BASE, {
      amountCharged: 149,
      productImageUrl: photo,
    });
    expect(msg.html).toContain('<!DOCTYPE html>');
    expect(msg.html).toContain('dir="rtl"');
    // Logo (header + sign-off), hero product photo, and the add-words button.
    expect(msg.html).toContain(BASE + '/assets/dugri-logo-email.png');
    expect(msg.html).toContain(photo);
    expect(msg.html).toContain('alt="קלאסי"');
    // The CTA href is the same link, HTML-escaped by the shell (& -> &amp;).
    expect(msg.html).toContain('href="' + link.replace(/&/g, '&amp;') + '"');
    expect(msg.html).toContain('התשלום התקבל — שירה');
    // The raw URL line is plain-text only — in HTML the link is the button.
    expect(msg.html).not.toContain('כאן:');
  });

  it('both receipts are owner-editable through the settings registry', () => {
    settings.set('email', 'payment_received', {
      subject: 'שולם · {honoree} · {orderId}',
      body: 'כסף נכנס. {adminLink}',
    });
    settings.set('email', 'buyer_payment_received', {
      subject: 'קבלה · {honoree}',
      body: 'תודה! המילים כאן: {link}',
    });
    const owner = notify.buildPaymentReceipt(collection, BASE, {
      amountCharged: 149,
      adminLink: BASE + '/admin.html?key=secret',
    });
    expect(owner.subject).toBe('שולם · שירה · col-1');
    expect(owner.text).toContain('כסף נכנס. ' + BASE + '/admin.html?key=secret');

    const buyer = notify.buildBuyerReceipt(collection, BASE, { amountCharged: 149 });
    expect(buyer.subject).toBe('קבלה · שירה');
    expect(buyer.text).toContain('תודה! המילים כאן: ' + link);
  });

  it('the buyer receipt is skipped when the customer left no email', async () => {
    const sent = await notify.sendBuyerReceipt({ ...collection, owner_email: '' }, BASE, {});
    expect(sent).toBe(false);
  });
});

describe('a real paid transition fires the receipts exactly once', () => {
  const ADMIN_KEY = 'test-admin-key';
  const realFetch = globalThis.fetch;
  const sent = [];
  let app;
  let db;
  let server;
  let base;

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-receipt-route-'));
    // pay/init refuses (503) unless card payment is configured, even on the free
    // coupon path — these creds are never used, no card call is made.
    process.env.PELECARD_TERMINAL = '0962210';
    process.env.PELECARD_USER = 'peletest';
    process.env.PELECARD_PASSWORD = 'secret';
    process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.NOTIFY_TO = 'owner@dugri.example';
    process.env.NOTIFY_FROM = 'Dugri <orders@dugri.example>';

    for (const f of ['db.js', 'notify.js', 'settings.js', 'pelecard.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    db = require(path.join(serverDir, 'db.js'));
    app = require(path.join(serverDir, 'index.js'));

    // Capture Resend traffic instead of sending it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        const u = String(url);
        if (u.includes('api.resend.com')) {
          const msg = opts && opts.body ? JSON.parse(opts.body) : {};
          sent.push({ to: Array.isArray(msg.to) ? msg.to[0] : msg.to, subject: msg.subject });
          return { ok: true, status: 200, text: async () => '{"id":"stub"}' };
        }
        throw new Error('unexpected fetch ' + u);
      })
    );

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (server) server.close();
    delete process.env.DATA_DIR;
  });

  const receipts = () =>
    sent.filter((m) => m.subject.includes('התקבל תשלום') || m.subject.includes('התשלום התקבל'));

  async function post(urlPath, body) {
    const res = await realFetch(base + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // Fire-and-forget sends: poll briefly, then give any stray extra a chance to
  // land so "exactly once" is a real assertion and not a race we won early.
  async function settle(timeout = 400) {
    const deadline = Date.now() + timeout;
    while (receipts().length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  it('sends one owner + one buyer receipt, and never re-sends on a repeat call', async () => {
    await post(`/api/admin/coupons?key=${ADMIN_KEY}`, { code: 'RECEIPT1', discount_pct: 100 });
    const c = db.createCollection('קופון מלא', { email: 'paid@example.com' });
    sent.length = 0;

    // A 100%-coupon order is a REAL paid transition — no card, but real money
    // logic: the order is created and marked paid in this one call.
    const r = await post(`/api/collections/${c.id}/pay/init`, {
      owner_token: c.owner_token,
      version: 'pickup', // enabled by default
      coupon: 'RECEIPT1',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ free: true, paid: true, total: 0 });
    await settle();

    const first = receipts();
    expect(first.length).toBe(2);
    expect(first.find((m) => m.subject.includes('התקבל תשלום')).to).toBe('owner@dugri.example');
    expect(first.find((m) => m.subject.includes('התשלום התקבל')).to).toBe('paid@example.com');

    // Re-running pay/init on an already-paid order must stay silent.
    const again = await post(`/api/collections/${c.id}/pay/init`, {
      owner_token: c.owner_token,
      version: 'pickup',
      coupon: 'RECEIPT1',
    });
    expect(again.status).toBe(409); // already paid
    await new Promise((r2) => setTimeout(r2, 200));
    expect(receipts().length).toBe(2);
  });

  it('has no admin route that can mark an order paid by hand', async () => {
    const c = db.createCollection('בלי סימון ידני', { email: 'nomanual@example.com' });
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    sent.length = 0;

    // The route is GONE — a receipt must never follow a payment that didn't
    // happen, so there is nothing to flip `paid` outside a real money event.
    const r = await post(`/api/admin/collections/${c.id}/paid?key=${ADMIN_KEY}`);
    expect(r.status).toBe(404);
    await new Promise((r2) => setTimeout(r2, 200));
    expect(db.getCollection(c.id).order.paid).toBe(false);
    expect(receipts().length).toBe(0);
  });
});
