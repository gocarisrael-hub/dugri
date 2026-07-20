// @vitest-environment node
// Integration test for the index.js wiring behind the order-detail emails:
//   • resolveProductImageUrl — matches the collection's design by its `theme`
//     key, falls back to the shipped static store.webp, and yields an absolute
//     URL that lands in the buyer confirmation HTML;
//   • the owner email gets the order id + a keyed admin-orders-panel link built
//     from ADMIN_KEY (which server/notify.js never sees);
//   • a delivery order surfaces its shipping address in both emails.
// Boots the real Express app with Resend + PeleCard config (fetch stubbed, so
// nothing leaves the machine) and pays a delivery order free via a 100% coupon.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'wire-admin-key';
const BASE_URL = 'https://test.dugri.example';
const realFetch = globalThis.fetch;

let app;
let db;
let server;
let base;
const sent = []; // { to, subject, text, html }

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-details-wiring-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = BASE_URL;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.NOTIFY_TO = 'owner@dugri.example';
  process.env.NOTIFY_FROM = 'Dugri <orders@dugri.example>';

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'design-images.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('api.resend.com')) {
        const msg = opts && opts.body ? JSON.parse(opts.body) : {};
        sent.push({
          to: Array.isArray(msg.to) ? msg.to[0] : msg.to,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        });
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
});

beforeEach(() => {
  sent.length = 0;
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const key = (p) => `${p}?key=${ADMIN_KEY}`;

async function waitForMails(n, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (sent.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return sent;
}

describe('order-detail email wiring (delivery order)', () => {
  it('resolves the product photo, admin link, order id and shipping address end-to-end', async () => {
    await post(key('/api/admin/coupons'), { code: 'WIREFREE', discount_pct: 100 });
    // bachelorette design → theme key the resolver matches; store.webp ships for it.
    const c = db.createCollection('דנה', {
      email: 'buyer@example.com',
      design: 'מסיבת רווקות',
      theme: 'bachelorette',
    });

    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      coupon: 'wirefree',
      address: { street: 'הרצל 5', city: 'תל אביב', postal: '6100000', apartment: '4' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ free: true, paid: true, total: 0 });

    const mails = await waitForMails(2);
    const owner = mails.find((m) => m.subject.includes('התקבלה הזמנה חדשה'));
    const buyer = mails.find((m) => m.subject.includes('ההזמנה שלכם התקבלה'));
    expect(owner).toBeTruthy();
    expect(buyer).toBeTruthy();

    // Owner email: order id + keyed admin link + shipping address.
    expect(owner.text).toContain('מספר הזמנה: ' + c.id);
    expect(owner.text).toContain('ניהול ההזמנה: ' + BASE_URL + '/admin.html?key=' + ADMIN_KEY);
    expect(owner.text).toContain('כתובת למשלוח: ');
    expect(owner.text).toContain('הרצל 5');

    // Buyer email: delivery approx time + address, and the resolved product photo
    // in the HTML (the static store.webp for the matched design).
    expect(buyer.text).toContain('ימי עסקים');
    expect(buyer.text).toContain('הרצל 5');
    expect(buyer.text).toContain('דירה 4');
    expect(buyer.html).toContain(BASE_URL + '/assets/designs/bachelorette/store.webp');
    // The admin key must NEVER reach the buyer.
    expect(buyer.text).not.toContain(ADMIN_KEY);
    expect(buyer.html).not.toContain(ADMIN_KEY);
  });
});
