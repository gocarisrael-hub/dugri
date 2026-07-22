// @vitest-environment node
// Integration test for runPaymentReminderScan: boots the app with email (Resend,
// captured) AND the WhatsApp bot armed (impure calls spied), enables the
// payment_reminder trigger, and drives one scan at a FIXED daytime timestamp
// (deterministic window gate). Asserts a due unpaid order gets an email + a
// WhatsApp DM once, is idempotent, respects the master switch, and skips paid
// orders.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// 12:00 Israel time on a future date: hour 12 ∈ the default [9,21] window, and far
// enough ahead that any order created "now" is well past the 24h delay.
const NOW = Date.parse('2030-06-01T12:00:00+03:00');

let app;
let db;
let settings;
let whatsapp;
const sent = []; // captured Resend emails
let dmCalls; // whatsapp.sendMessage calls

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pay-scan-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.NOTIFY_TO = 'owner@dugri.example';
  process.env.NOTIFY_FROM = 'Dugri <orders@dugri.example>';
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHAPI_TOKEN = 'tok-secret';
  process.env.WHAPI_BASE_URL = 'https://gate.example.test';
  process.env.WHAPI_WEBHOOK_SECRET = 'hook-secret';

  for (const f of ['db.js', 'settings.js', 'wa-state.js', 'whatsapp.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  db = require(path.join(serverDir, 'db.js'));
  whatsapp = require(path.join(serverDir, 'whatsapp.js'));
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
        });
        return { ok: true, status: 200, text: async () => '{"id":"stub"}' };
      }
      throw new Error('unexpected fetch ' + u);
    })
  );
  vi.spyOn(whatsapp, 'sendMessage').mockImplementation(async (to, text) => {
    dmCalls.push({ to, text });
    return { ok: true, sent: true, messageId: 'm1' };
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sent.length = 0;
  dmCalls = [];
  // Master switch ON, a SINGLE milestone for the once-per-order cases.
  settings.set('wa', 'trigger.payment_reminder', {
    enabled: true,
    timing: { delays: [24], window: [9, 21] },
  });
});

// Unique contact per test — the db accumulates across tests in one file, so
// assertions target THIS order's buyer/number rather than a global send count.
function unpaidOrder(email, phone) {
  const c = db.createCollection('דנה', { email, phone });
  db.setOrder(c.id, c.owner_token, { version: 'pdf' }, { admin: true });
  return c;
}

describe('runPaymentReminderScan', () => {
  it('emails the buyer AND WhatsApp-DMs them once for a due unpaid order', async () => {
    const c = unpaidOrder('b1@example.com', '0521111111');
    await app.runPaymentReminderScan(NOW);

    const mail = sent.find((m) => m.to === 'b1@example.com');
    expect(mail).toBeTruthy();
    expect(mail.subject).toContain('תשלום');

    const dm = dmCalls.find((d) => d.to === '972521111111');
    expect(dm).toBeTruthy();
    expect(dm.text).toContain('/collect.html?c=' + c.id);

    expect(db.getCollection(c.id).payment_reminded_at).toBeTruthy();
  });

  it('is idempotent — a second scan does not re-remind the same order', async () => {
    const c = unpaidOrder('b2@example.com', '0521222222');
    await app.runPaymentReminderScan(NOW);
    const stamp = db.getCollection(c.id).payment_reminded_at;
    expect(stamp).toBeTruthy();
    sent.length = 0;
    dmCalls = [];
    await app.runPaymentReminderScan(NOW + 60 * 60 * 1000);
    expect(sent.some((m) => m.to === 'b2@example.com')).toBe(false);
    expect(dmCalls.some((d) => d.to === '972521222222')).toBe(false);
    expect(db.getCollection(c.id).payment_reminded_at).toBe(stamp); // unchanged
  });

  it('sends nothing when the trigger (master switch) is off', async () => {
    settings.set('wa', 'trigger.payment_reminder', { enabled: false });
    const c = unpaidOrder('b3@example.com', '0521333333');
    const n = await app.runPaymentReminderScan(NOW); // off -> short-circuits to 0
    expect(n).toBe(0);
    expect(db.getCollection(c.id).payment_reminded_at).toBeFalsy();
    db.markPaymentReminderSent(c.id); // clean up so it can't pollute later scans
  });

  it('skips a PAID order (no email, no DM to its number, not marked)', async () => {
    const c = unpaidOrder('b4@example.com', '0521444444');
    db.markPaid(c.id, { charged_total: 79 });
    await app.runPaymentReminderScan(NOW);
    expect(sent.some((m) => m.to === 'b4@example.com')).toBe(false);
    expect(dmCalls.some((d) => d.to === '972521444444')).toBe(false);
    expect(db.getCollection(c.id).payment_reminded_at).toBeFalsy();
  });

  it('does not fire outside the daytime window (03:00 Israel short-circuits)', async () => {
    unpaidOrder('b5@example.com', '0521555555');
    const nightNow = Date.parse('2030-06-01T03:00:00+03:00');
    const n = await app.runPaymentReminderScan(nightNow);
    expect(n).toBe(0);
    expect(dmCalls).toHaveLength(0);
  });

  it('MULTIPLE milestones: one reminder per scan, then stops (until paid)', async () => {
    // Two milestones; NOW is past both, so both are due — but the scan sends ONE
    // per pass and advances the stage, so the buyer gets one nudge per scan.
    settings.set('wa', 'trigger.payment_reminder', {
      enabled: true,
      timing: { delays: [48, 120], window: [9, 21] },
    });
    const c = unpaidOrder('bmulti@example.com', '0521666666');
    const buyerMails = () => sent.filter((m) => m.to === 'bmulti@example.com');

    await app.runPaymentReminderScan(NOW);
    expect(buyerMails()).toHaveLength(1); // milestone 1
    expect(db.getCollection(c.id).payment_reminders_sent).toBe(1);

    sent.length = 0;
    await app.runPaymentReminderScan(NOW);
    expect(buyerMails()).toHaveLength(1); // milestone 2
    expect(db.getCollection(c.id).payment_reminders_sent).toBe(2);

    sent.length = 0;
    await app.runPaymentReminderScan(NOW);
    expect(buyerMails()).toHaveLength(0); // no more milestones — done
    expect(db.getCollection(c.id).payment_reminders_sent).toBe(2);
  });
});
