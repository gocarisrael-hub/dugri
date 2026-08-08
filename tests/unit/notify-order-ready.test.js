// @vitest-environment node
// The BUYER's "your game is ready" email — fired by the owner marking an order
// ready on the admin orders page. This module owns the message; the button and
// the route that calls it belong to the orders side.
//
// The load-bearing properties:
//   • pickup and delivery make DIFFERENT promises ("come and get it" vs "it's on
//     its way"), and both wordings are owner-editable;
//   • the pickup address is read from pickup_info — the one place it already
//     lives — so it can never drift from the address on the confirmation;
//   • the copies line appears only when there is more than one copy;
//   • it RE-SENDS. The owner can un-mark and re-mark an order ready, and the
//     second press is a real signal (a re-print, a corrected date, a customer who
//     says they never got it). There is deliberately no once-only guard here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// Both modules read their store/env at require time; give them a throwaway
// DATA_DIR before the first load so no real settings file is touched.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-order-ready-'));

function loadFresh() {
  delete require.cache[require.resolve(notifyPath)];
  delete require.cache[require.resolve(settingsPath)];
  return { notify: require(notifyPath), settings: require(settingsPath) };
}

function stubFetch({ ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok, status, text: async () => '' };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const RESEND = {
  RESEND_API_KEY: 're_test_key',
  NOTIFY_TO: 'owner@dugri.example',
  NOTIFY_FROM: 'Dugri <orders@dugri.example>',
};
function setResend(on) {
  for (const k of Object.keys(RESEND)) {
    if (on) process.env[k] = RESEND[k];
    else delete process.env[k];
  }
}

const BASE = 'https://dugri.example';
function collection(order) {
  return {
    id: 'col-1',
    order_no: 'DG-1042',
    honoree_name: 'שירה',
    owner_email: 'buyer@example.com',
    owner_token: 'tok-abc',
    order: { version: 'pickup', paid: true, total: 199, quantity: 1, ...order },
  };
}

beforeEach(() => setResend(false));
afterEach(() => {
  vi.unstubAllGlobals();
  setResend(false);
});

describe('buildOrderReady — the two promises', () => {
  it('a PICKUP order says come and collect it, and where from', () => {
    const { notify } = loadFresh();
    const msg = notify.buildOrderReady(collection({ version: 'pickup' }), BASE);
    expect(msg.subject).toBe('דוגרי · המשחק של שירה מוכן');
    expect(msg.text).toContain('המשחק של שירה מוכן!');
    expect(msg.text).toContain('תאמו אתנו'); // coordinate before coming
    // The address comes from pickup_info — the same one the confirmation shows.
    expect(msg.text).toContain('כתובת לאיסוף');
    expect(msg.text).toContain('גלאור');
    // ...and it must NOT promise a delivery.
    expect(msg.text).not.toContain('יוצא אליכם');
  });

  it('a DELIVERY order says it ships, to the address on the order', () => {
    const { notify } = loadFresh();
    const msg = notify.buildOrderReady(
      collection({
        version: 'delivery',
        address: { street: 'הרצל 5', city: 'תל אביב', postal: '6100000' },
      }),
      BASE
    );
    expect(msg.text).toContain('יוצא אליכם');
    expect(msg.text).toContain('הרצל 5');
    expect(msg.text).toContain('תל אביב');
    // ...and must NOT tell them to come and collect it.
    expect(msg.text).not.toContain('תאמו אתנו');
    expect(msg.text).not.toContain('כתובת לאיסוף');
  });

  it('still sends for a version with no fulfilment promise (pdf/custom)', () => {
    const { notify } = loadFresh();
    const msg = notify.buildOrderReady(collection({ version: 'pdf' }), BASE);
    expect(msg.subject).toContain('שירה');
    expect(msg.text).toContain('המשחק של שירה מוכן!');
  });

  it('both wordings are owner-editable', () => {
    const { notify, settings } = loadFresh();
    settings.set('email', 'order_ready_info', {
      pickup: 'בואו לקחת אותו מתי שנוח',
      delivery: 'שלחנו אותו הבוקר',
      copies: '{count} קופסאות',
    });
    expect(notify.buildOrderReady(collection({ version: 'pickup' }), BASE).text).toContain(
      'בואו לקחת אותו מתי שנוח'
    );
    expect(notify.buildOrderReady(collection({ version: 'delivery' }), BASE).text).toContain(
      'שלחנו אותו הבוקר'
    );
    settings.reset('email', 'order_ready_info');
  });
});

describe('buildOrderReady — copies', () => {
  it('names the copy count when there is more than one', () => {
    const { notify } = loadFresh();
    const msg = notify.buildOrderReady(collection({ quantity: 5 }), BASE);
    expect(msg.text).toContain('5 עותקים מוכנים');
  });

  it('omits the line entirely for a single copy', () => {
    const { notify } = loadFresh();
    expect(notify.buildOrderReady(collection({ quantity: 1 }), BASE).text).not.toContain('עותקים');
  });

  it('omits it for an order placed before copies existed (no quantity at all)', () => {
    const { notify } = loadFresh();
    const c = collection();
    delete c.order.quantity;
    expect(notify.buildOrderReady(c, BASE).text).not.toContain('עותקים');
  });
});

describe('buildOrderReady — the rest of the shell', () => {
  it('carries the order reference and a CTA to the collection page', () => {
    const { notify } = loadFresh();
    const msg = notify.buildOrderReady(collection(), BASE);
    expect(msg.text).toContain('מספר הזמנה: DG-1042');
    const link = BASE + '/collect.html?c=col-1&k=tok-abc';
    expect(msg.text).toContain(link);
    // The HTML shell escapes the query separator, as it does for every CTA.
    expect(msg.html).toContain(link.replace('&', '&amp;'));
    expect(msg.html).toContain('לצפייה בהזמנה');
  });

  it('renders the branded shell with the logo', () => {
    const { notify } = loadFresh();
    const msg = notify.buildOrderReady(collection(), BASE);
    expect(msg.html).toContain('<!DOCTYPE html>');
    expect(msg.html).toContain(BASE + '/assets/dugri-logo-email.png');
  });

  it('omits the link rather than rendering a broken one without a baseUrl', () => {
    const { notify } = loadFresh();
    const msg = notify.buildOrderReady(collection(), '');
    expect(msg.text).not.toContain('collect.html');
  });
});

describe('sendOrderReady', () => {
  it('is a no-op (returns false, no fetch) when Resend is unconfigured', async () => {
    const { notify } = loadFresh();
    const { fn } = stubFetch();
    await expect(notify.sendOrderReady(collection(), BASE)).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('goes to the BUYER, not the owner inbox', async () => {
    setResend(true);
    const { notify } = loadFresh();
    const { calls } = stubFetch();
    await expect(notify.sendOrderReady(collection(), BASE)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.to).toEqual(['buyer@example.com']);
  });

  it('returns false when the buyer gave no email', async () => {
    setResend(true);
    const { notify } = loadFresh();
    const { fn } = stubFetch();
    const c = collection();
    c.owner_email = '';
    await expect(notify.sendOrderReady(c, BASE)).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns false when the owner switched the template off', async () => {
    setResend(true);
    const { notify, settings } = loadFresh();
    settings.set('email', 'order_ready', {
      ...settings.get('email', 'order_ready'),
      enabled: false,
    });
    const { fn } = stubFetch();
    try {
      await expect(notify.sendOrderReady(collection(), BASE)).resolves.toBe(false);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      settings.reset('email', 'order_ready');
    }
  });

  it('never throws when the transport fails', async () => {
    setResend(true);
    const { notify } = loadFresh();
    stubFetch({ ok: false, status: 500 });
    await expect(notify.sendOrderReady(collection(), BASE)).resolves.toBe(false);
  });

  it('RE-SENDS on a second call — pressing ready again is a real signal', async () => {
    // The owner can un-mark an order and mark it ready again: a re-print, a
    // corrected pickup date, a customer who says they never got it. A silent
    // no-op would leave them pressing a button that does nothing.
    setResend(true);
    const { notify } = loadFresh();
    const { calls } = stubFetch();
    await notify.sendOrderReady(collection(), BASE);
    await notify.sendOrderReady(collection(), BASE);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.to).toEqual(['buyer@example.com']);
  });
});
