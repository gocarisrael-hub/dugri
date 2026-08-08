// @vitest-environment node
// The owner's per-message email switch: every `kind:'email'` template carries an
// `enabled` flag, and notify.js skips that ONE message when it is off — the email
// counterpart to a WhatsApp trigger's `enabled`.
//
// What these tests pin, in order of how much a regression would cost:
//   1. OFF actually stops the network send (not just the builder).
//   2. Turning one message off leaves every other message sending.
//   3. Backward compatibility: an override stored before this flag existed
//      ({subject, body}, no `enabled`) keeps sending. The store on the live
//      volume is full of those, so a wrong default here silences production.
//   4. The gate fails OPEN — a corrupt store must not swallow a buyer's receipt.
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

// notify reads its Resend config at require() time, so the env has to be set
// BEFORE the fresh require — otherwise every send short-circuits on
// isConfigured() and an "it didn't send" assertion would pass for the wrong
// reason.
function loadFresh() {
  process.env.RESEND_API_KEY = 're_test';
  process.env.NOTIFY_TO = 'owner@example.com';
  process.env.NOTIFY_FROM = 'orders@example.com';
  delete require.cache[require.resolve(notifyPath)];
  delete require.cache[require.resolve(settingsPath)];
  const settings = require(settingsPath);
  const notify = require(notifyPath);
  return { settings, notify };
}

const collection = {
  id: 'col-1',
  honoree_name: 'שירה',
  owner_token: 'tok-abc',
  owner_email: 'buyer@example.com',
  order: { version: 'pdf', total: 79 },
  count: 100,
};

let sent;

beforeEach(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-email-toggles-'));
  sent = [];
  vi.stubGlobal('fetch', async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '' };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DATA_DIR;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_TO;
  delete process.env.NOTIFY_FROM;
});

// (registry key, the notify call that renders it). Every gated send, so a new
// email added without a switch shows up as a failing row here rather than as a
// message the owner cannot turn off.
const GATED = [
  ['order_paid', (n) => n.sendOrderPaid(collection, null)],
  ['payment_received', (n) => n.sendPaymentReceipt(collection, null)],
  ['buyer_payment_received', (n) => n.sendBuyerReceipt(collection, null)],
  ['custom_order_alert', (n) => n.sendCustomOrderAlert(collection, null)],
  ['buyer_confirmation', (n) => n.sendBuyerConfirmation(collection, null)],
  ['words_reminder', (n) => n.sendWordsReminder(collection, null)],
  ['payment_reminder', (n) => n.sendPaymentReminder(collection, null)],
  ['order_finished', (n) => n.sendOrderFinished(collection, null)],
  ['buyer_production_started', (n) => n.sendProductionStarted(collection, null)],
  ['production_error', (n) => n.sendProductionError(collection, null, ['bad'])],
];

describe('every email template carries a switch', () => {
  it('defaults to on, for all of them', () => {
    const { settings } = loadFresh();
    for (const [key] of GATED) {
      expect(settings.get('email', key).enabled, key).toBe(true);
      expect(settings.emailEnabled(key), key).toBe(true);
    }
  });

  it.each(GATED)('%s sends when on and sends nothing when off', async (key, call) => {
    const { settings, notify } = loadFresh();

    expect(await call(notify)).toBe(true);
    expect(sent.length, 'on: ' + key).toBeGreaterThan(0);

    sent = [];
    const tpl = settings.get('email', key);
    settings.set('email', key, { ...tpl, enabled: false });
    expect(await call(notify)).toBe(false);
    expect(sent, 'off: ' + key).toEqual([]);
  });

  it('gates ONE message — the others keep sending', async () => {
    const { settings, notify } = loadFresh();
    const tpl = settings.get('email', 'words_reminder');
    settings.set('email', 'words_reminder', { ...tpl, enabled: false });

    expect(await notify.sendWordsReminder(collection, null)).toBe(false);
    expect(sent).toEqual([]);
    expect(await notify.sendBuyerConfirmation(collection, null)).toBe(true);
    expect(sent.length).toBe(1);
  });

  it('leaves the operational system alert ungated', async () => {
    // Not a message the owner composes: it is the escalation that says a human is
    // needed, so there is no switch that could silence it.
    const { notify } = loadFresh();
    expect(await notify.sendSystemAlert('בדיקה', ['שורה'])).toBe(true);
    expect(sent.length).toBe(1);
  });
});

describe('backward compatibility with overrides saved before the switch existed', () => {
  it('keeps sending for a stored { subject, body } override with no enabled', async () => {
    const { settings } = loadFresh();
    // Written straight to the store, bypassing set(), exactly as the live volume
    // holds it today.
    fs.writeFileSync(
      settings._file,
      JSON.stringify({ email: { buyer_confirmation: { subject: 'ישן', body: 'גוף ישן' } } })
    );
    const fresh = loadFresh();
    expect(fresh.settings.get('email', 'buyer_confirmation')).toEqual({
      enabled: true,
      subject: 'ישן',
      body: 'גוף ישן',
    });
    expect(await fresh.notify.sendBuyerConfirmation(collection, null)).toBe(true);
    expect(sent.length).toBe(1);
  });

  it('deep-merges a switch-only override, keeping the owner’s text', () => {
    const { settings } = loadFresh();
    settings.set('email', 'buyer_production_started', {
      subject: 'הנוסח שלי',
      body: 'הגוף שלי',
    });
    settings.set('email', 'buyer_production_started', {
      ...settings.get('email', 'buyer_production_started'),
      enabled: false,
    });
    expect(settings.get('email', 'buyer_production_started')).toEqual({
      enabled: false,
      subject: 'הנוסח שלי',
      body: 'הגוף שלי',
    });
  });
});

describe('validation and failure posture', () => {
  it('rejects a non-boolean enabled rather than coercing it', () => {
    const { settings } = loadFresh();
    const tpl = settings.get('email', 'order_paid');
    // 'false' and 0 read as OFF to a human but are not booleans; coercing either
    // way would send (or drop) a message against the owner's intent.
    expect(settings.validateValue('email', 'order_paid', { ...tpl, enabled: 'false' })).toMatch(
      /enabled must be a boolean/
    );
    expect(settings.validateValue('email', 'order_paid', { ...tpl, enabled: 0 })).toMatch(
      /enabled must be a boolean/
    );
    expect(settings.validateValue('email', 'order_paid', { ...tpl, enabled: false })).toBe(null);
    // Still optional — a payload without it stays valid.
    expect(settings.validateValue('email', 'order_paid', { subject: 'a', body: 'b' })).toBe(null);
  });

  it('fails OPEN on an unknown key or a corrupt store', async () => {
    const { settings } = loadFresh();
    expect(settings.emailEnabled('no_such_email')).toBe(true);

    // A wrong-typed override can't strip the switch: get() falls back to the
    // complete default, and the gate answers "on" either way. A silently swallowed
    // receipt is worse than a message the owner can switch off again.
    fs.writeFileSync(
      settings._file,
      JSON.stringify({ email: { buyer_production_started: 'not-an-object' } })
    );
    const fresh = loadFresh();
    expect(fresh.settings.emailEnabled('buyer_production_started')).toBe(true);
    expect(await fresh.notify.sendProductionStarted(collection, null)).toBe(true);
  });
});
