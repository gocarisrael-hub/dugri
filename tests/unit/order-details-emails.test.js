// @vitest-environment node
// Unit tests for the order-detail email enrichments (owner + buyer):
//   • buyer confirmation gains a product description, a delivery OR self-pickup
//     block (approx time + address), and a template product photo in the HTML;
//   • the branded HTML uses the Assistant font and carries a signature logo;
//   • owner emails gain the order id, the shipping address (delivery), an admin
//     orders-panel link, and the {orderId}/{link}/{adminLink} body tokens.
// These exercise the PURE builders in server/notify.js against the registry
// defaults — no server boot, no network.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const BASE = 'https://test.dugri.example';

let notify;
let settings;

beforeAll(() => {
  // Isolated DATA_DIR so settings resolves to registry defaults (no stray
  // overrides from a developer's machine).
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-order-details-'));
  delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
  delete require.cache[require.resolve(path.join(serverDir, 'notify.js'))];
  settings = require(path.join(serverDir, 'settings.js'));
  notify = require(path.join(serverDir, 'notify.js'));
});

function collection(order, extra = {}) {
  return {
    id: 'col-123',
    owner_token: 'tok-abc',
    honoree_name: 'דנה',
    owner_email: 'buyer@example.com',
    design: 'מסיבת רווקות',
    color: 'מגנטה',
    theme: 'bachelorette',
    order,
    ...extra,
  };
}

describe('buyer confirmation — fulfilment + photo', () => {
  it('a DELIVERY order shows the approx delivery time and the address, but no spec list', () => {
    const c = collection({
      version: 'delivery',
      total: 199,
      address: { street: 'הרצל 5', city: 'תל אביב', postal: '6100000', apartment: '4', floor: '2' },
    });
    const msg = notify.buildBuyerConfirmation(c, BASE, {
      amountCharged: 199,
      productImageUrl: BASE + '/assets/designs/bachelorette/store.webp',
    });
    // delivery approx time (delivery_info.eta)
    expect(msg.text).toContain('ימי עסקים');
    // the shipping address, formatted from the order — the buyer still needs to
    // see where their game is going.
    expect(msg.text).toContain('הרצל 5');
    expect(msg.text).toContain('תל אביב');
    expect(msg.text).toContain('דירה 4');
    expect(msg.text).toContain('קומה 2');
    // But the itemised order block is gone: no product description line, no
    // price. What they bought is the photo, which the HTML case below asserts.
    expect(msg.text).not.toContain('חפיסת קלפים');
    expect(msg.text).not.toContain('199 ₪');
  });

  it('a PICKUP order says we email when ready + prep time + the print-house address', () => {
    const c = collection({ version: 'pickup', total: 199, address: null });
    const msg = notify.buildBuyerConfirmation(c, BASE, { amountCharged: 199 });
    expect(msg.text).toContain('נעדכן אותך במייל'); // pickup_info.ready
    expect(msg.text).toContain('ימי עסקים'); // pickup_info.eta
    expect(msg.text).toContain('בית הדפוס'); // pickup_info.address default
    // The address that used to end this block was a placeholder telling the OWNER
    // to fill it in; it names the entrance and the floor now, and points at the
    // page that holds the hours and what to bring.
    expect(msg.text).toContain('התחייה 14'); // pickup_info.address
    // Built from THIS deployment's origin, never a domain typed into the
    // default. It was typed in once, as a dugri.co.il that does not resolve,
    // and every pickup buyer got a dead link.
    expect(msg.text).toContain(BASE + '/pickup'); // pickup_info.link
    expect(msg.text).not.toContain('{url}');
  });

  it('drops the pickup-page line entirely when there is no base url to build it from', () => {
    const c = collection({ version: 'pickup', total: 199, address: null });
    const msg = notify.buildBuyerConfirmation(c, '', { amountCharged: 199 });
    // The rest of the pickup block survives — only the link goes.
    expect(msg.text).toContain('התחייה 14');
    // A literal "{url}" or a bare "/pickup" both LOOK like a link and neither
    // is one; no line at all is the honest outcome.
    expect(msg.text).not.toContain('{url}');
    expect(msg.text).not.toContain('/pickup');
  });

  it('the HTML uses the Assistant font, embeds the product photo, and carries the signature logo', () => {
    const c = collection({
      version: 'delivery',
      total: 199,
      address: { street: 'א', city: 'ב', postal: '1' },
    });
    const img = BASE + '/assets/designs/bachelorette/store.webp';
    const msg = notify.buildBuyerConfirmation(c, BASE, {
      amountCharged: 199,
      productImageUrl: img,
    });
    expect(msg.html).toContain('Assistant'); // font-family + @import
    expect(msg.html).toContain(img); // hero product photo
    expect(msg.html).toContain('alt="מסיבת רווקות"'); // alt = chosen design (WebP fallback)
    expect(msg.html).toContain('/assets/dugri-logo-email.png'); // header + signature logo
  });

  it('omits the hero <img> when no product photo resolves', () => {
    const c = collection({ version: 'pdf', total: 79 });
    const msg = notify.buildBuyerConfirmation(c, BASE, { amountCharged: 79 });
    expect(msg.html).not.toContain('<img src="' + BASE + '/assets/designs');
    expect(msg.html).toContain('ההזמנה שלכם התקבלה'); // still a valid email
  });
});

describe('owner emails — order id, admin link, shipping address', () => {
  it('includes the order id and a keyed admin-panel link', () => {
    const c = collection({ version: 'pickup', total: 199 });
    const adminLink = BASE + '/admin.html?key=SEKRET';
    const msg = notify.buildPaidMessage(c, BASE, { amountCharged: 199, adminLink });
    expect(msg.text).toContain('מספר הזמנה: col-123');
    expect(msg.text).toContain('ניהול ההזמנה: ' + adminLink);
  });

  it('surfaces the shipping address for a delivery order', () => {
    const c = collection({
      version: 'delivery',
      total: 199,
      address: { street: 'ויצמן 10', city: 'רעננה', postal: '4300000' },
    });
    const msg = notify.buildPaidMessage(c, BASE, { amountCharged: 199 });
    expect(msg.text).toContain('כתובת למשלוח: ');
    expect(msg.text).toContain('ויצמן 10');
    expect(msg.text).toContain('רעננה');
  });

  it('exposes {orderId}, {link} and {adminLink} tokens in the owner template body', () => {
    settings.set('email', 'order_paid', {
      subject: 'הזמנה {orderId}',
      body: 'ניהול: {adminLink}\nמילים: {link}',
    });
    try {
      const c = collection({ version: 'pickup', total: 199 });
      const adminLink = BASE + '/admin.html?key=SEKRET';
      const msg = notify.buildPaidMessage(c, BASE, { amountCharged: 199, adminLink });
      expect(msg.subject).toBe('הזמנה col-123');
      expect(msg.text).toContain('ניהול: ' + adminLink);
      expect(msg.text).toContain('מילים: ' + BASE + '/collect.html?c=col-123&k=tok-abc');
    } finally {
      settings.reset('email', 'order_paid');
    }
  });
});
