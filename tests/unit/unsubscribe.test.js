// @vitest-environment node
//
// "A button that stops sending them mail at all, no matter what."
//
// The strict reading, on purpose: the gate is in notify.send(), the one place
// every message passes through, so a receipt and a "your order is ready" stop too
// — and so does every mail written after this test. What is pinned here is that
// totality, the signature that stops one person unsubscribing another, and the
// one address that is deliberately exempt (the owner's own inbox).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const OWNER = 'owner@dugri.example';
const BUYER = 'buyer@example.com';

let unsub;
let notify;
let sent;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-unsub-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.UNSUBSCRIBE_SECRET = 'test-secret';
  // Resend "configured", with fetch stubbed — no network, and every send is
  // captured so a suppressed one is visible as an ABSENCE.
  process.env.RESEND_API_KEY = 'test-key';
  process.env.NOTIFY_TO = OWNER;
  process.env.NOTIFY_FROM = 'dugri@dugri.example';

  for (const f of ['unsubscribe.js', 'notify.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  unsub = require(path.join(serverDir, 'unsubscribe.js'));
  notify = require(path.join(serverDir, 'notify.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      sent.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    })
  );
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sent = [];
  unsub.resubscribe(BUYER);
  unsub.resubscribe(OWNER);
});

describe('the signed link', () => {
  it('carries the address and a token nobody can forge', () => {
    const link = unsub.linkFor(BUYER, 'https://test.dugri.example');
    expect(link).toContain('/unsubscribe.html?e=' + encodeURIComponent(BUYER));
    expect(link).toMatch(/t=[a-f0-9]{32}$/);
    // Somebody else's address does not verify against this token.
    const token = new URL(link).searchParams.get('t');
    expect(unsub.verify(BUYER, token)).toBe(true);
    expect(unsub.verify('someone-else@example.com', token)).toBe(false);
    expect(unsub.verify(BUYER, 'x'.repeat(32))).toBe(false);
    expect(unsub.verify(BUYER, '')).toBe(false);
  });

  it('treats an address case-insensitively, so one person is one entry', () => {
    unsub.unsubscribe('Dana@Example.COM', 'link');
    expect(unsub.isUnsubscribed('dana@example.com')).toBe(true);
    expect(unsub.isUnsubscribed('  DANA@example.com ')).toBe(true);
    unsub.resubscribe('dana@example.com');
    expect(unsub.isUnsubscribed('Dana@Example.COM')).toBe(false);
  });

  it('has no link to give without a public base url', () => {
    expect(unsub.linkFor(BUYER, '')).toBeNull();
    expect(unsub.linkFor('', 'https://x.example')).toBeNull();
  });
});

describe('what an unsubscribe actually stops', () => {
  it('stops EVERY message, transactional ones included', async () => {
    const c = { honoree_name: 'שירה', owner_email: BUYER, order: { total: 199 } };
    // Before: each of these reaches the buyer.
    expect(await notify.sendBuyerConfirmation(c, 'https://test.dugri.example', {})).toBe(true);
    expect(await notify.sendOrderReady(c, 'https://test.dugri.example')).toBe(true);
    expect(sent.length).toBe(2);

    unsub.unsubscribe(BUYER, 'link');
    sent = [];

    // After: nothing goes out — not a reminder, and not a receipt or a "ready".
    expect(await notify.sendBuyerConfirmation(c, 'https://test.dugri.example', {})).toBe(false);
    expect(await notify.sendOrderReady(c, 'https://test.dugri.example')).toBe(false);
    expect(await notify.sendPaymentReminder(c, 'https://test.dugri.example')).toBe(false);
    expect(await notify.sendProductionStarted(c, 'https://test.dugri.example')).toBe(false);
    expect(sent).toEqual([]);
  });

  it('never silences the owner, whose inbox is the one exempt address', async () => {
    unsub.unsubscribe(OWNER, 'link');
    // An owner-facing alert goes to NOTIFY_TO and must still arrive: it is how
    // she hears about orders, and the button that suppressed it would be one she
    // pressed in her own copy of a customer's mail.
    expect(await notify.sendSystemAlert('בדיקה', ['שורה'])).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toEqual([OWNER]);
  });
});

describe('the footer and the one-click header', () => {
  it('every mail to a buyer carries the link, in both the text and the html', async () => {
    await notify.sendBuyerConfirmation(
      { honoree_name: 'דנה', owner_email: BUYER, order: { total: 199 } },
      'https://test.dugri.example',
      {}
    );
    const msg = sent[0];
    expect(msg.text).toContain('/unsubscribe.html?e=');
    expect(msg.html).toContain('/unsubscribe.html?e=');
    // Inside the table, not appended after it — outside, some clients render it
    // above the whole layout.
    expect(msg.html.trim().endsWith('</html>')).toBe(true);
    // Gmail and Outlook draw their own control from these, and POST to the API
    // without ever opening the page.
    expect(msg.headers['List-Unsubscribe']).toContain('/api/unsubscribe?e=');
    expect(msg.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it("the owner's own mail gets no unsubscribe footer — it would not work", async () => {
    await notify.sendSystemAlert('בדיקה', ['שורה']);
    expect(sent[0].text).not.toContain('/unsubscribe.html');
    expect(sent[0].headers).toBeUndefined();
  });
});
