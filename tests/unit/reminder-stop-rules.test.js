// @vitest-environment node
// WHEN THE CHASING STOPS, and how much of it there can ever be.
//
// Two rules the owner asked for, and one she asked about:
//   • an order that is READY has been made and handed over — stop reminding;
//   • a word list that is CLOSED has its words — stop asking for words;
//   • and "what is the maximum mail someone gets, worst case?" — which had no
//     answer, because nothing bounded the total: the reminder list holds up to 20
//     entries, each with an uncapped max_total. There is a ceiling now, spent
//     across all three schedulers together.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;
let db;
let settings;
let notify;
let whatsapp;
let reminders;
let emailSpy;
let wordsSpy;
let paySpy;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// 09:30 Asia/Jerusalem — inside every window used below.
const NOW = Date.parse('2026-07-15T06:30:00.000Z');

const R = {
  id: 'morning',
  enabled: true,
  text: 'עוד זמן להוסיף מילים על {honoree}: {link}',
  channels: { email: true, whatsapp: false },
  every_days: 1,
  weekdays: null,
  only_if_idle_hours: null,
  window: [8, 21],
  max_total: 3,
};

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-rem-stop-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  for (const f of [
    'db.js',
    'settings.js',
    'reminders.js',
    'notify.js',
    'whatsapp.js',
    'index.js',
  ]) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  settings = require(path.join(serverDir, 'settings.js'));
  reminders = require(path.join(serverDir, 'reminders.js'));
  notify = require(path.join(serverDir, 'notify.js'));
  whatsapp = require(path.join(serverDir, 'whatsapp.js'));
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      throw new Error('unexpected fetch ' + url);
    })
  );
  vi.spyOn(notify, 'isConfigured').mockReturnValue(true);
  vi.spyOn(whatsapp, 'isConfigured').mockReturnValue(false);
  emailSpy = vi.spyOn(notify, 'sendReminderEmail').mockResolvedValue(true);
  wordsSpy = vi.spyOn(notify, 'sendWordsReminder').mockResolvedValue(true);
  paySpy = vi.spyOn(notify, 'sendPaymentReminder').mockResolvedValue(true);
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  emailSpy.mockClear();
  wordsSpy.mockClear();
  paySpy.mockClear();
  for (const c of db.listAllCollections()) db.deleteCollection(c.id);
  settings.set('reminders', 'list', []);
  settings.set('reminders', 'max_emails', 8);
  settings.set('wa', 'trigger.payment_reminder', {
    enabled: true,
    text: 'עוד לא שילמת על {honoree}: {link}',
    timing: { delays: [24], window: [0, 23] },
  });
});

// A collection old enough for every scheduler to consider it, with a buyer email.
function seed(honoree, { at = NOW - 10 * DAY } = {}) {
  const c = db.createCollection(honoree, { phone: '0521234567', email: 'buyer@example.com' });
  c.created_at = new Date(at).toISOString();
  return c;
}

// An unpaid order on a collection, old enough to be past the first milestone.
function order(c, extra = {}) {
  c.order = {
    version: 'pickup',
    total: 199,
    quantity: 1,
    paid: false,
    ordered_at: new Date(NOW - 5 * DAY).toISOString(),
    address: null,
    production: null,
    sent_to_print_at: null,
    ready_at: null,
    ...extra,
  };
  return c;
}

describe('the pure rules', () => {
  it('words: stopped by a closed list, the printer, ready, or a cancellation', () => {
    expect(reminders.wordRemindersStopped({ status: 'open' })).toBe(false);
    expect(reminders.wordRemindersStopped({ status: 'closed' })).toBe(true);
    expect(reminders.wordRemindersStopped({ status: 'expired' })).toBe(true);
    expect(reminders.wordRemindersStopped({ status: 'open', cancelled: true })).toBe(true);
    expect(
      reminders.wordRemindersStopped({ status: 'open', order: { sent_to_print_at: 'x' } })
    ).toBe(true);
    expect(reminders.wordRemindersStopped({ status: 'open', order: { ready_at: 'x' } })).toBe(true);
  });

  it('money: stopped by the close too — production is where automated chasing ends', () => {
    expect(reminders.paymentRemindersStopped({ status: 'open' })).toBe(false);
    // The owner's correction to where this first landed: once the list is closed
    // the order is being MADE, and anything still outstanding is a conversation
    // with a person, not a scheduler.
    expect(reminders.paymentRemindersStopped({ status: 'closed' })).toBe(true);
    expect(reminders.paymentRemindersStopped({ status: 'expired' })).toBe(true);
    expect(reminders.paymentRemindersStopped({ order: { ready_at: 'x' } })).toBe(true);
    expect(reminders.paymentRemindersStopped({ cancelled: true })).toBe(true);
  });
});

describe('the word nudge (3 days, no words yet)', () => {
  it('goes out for an open collection…', async () => {
    seed('שירה');
    expect(await app.runReminderScan(NOW)).toBe(1);
    expect(wordsSpy).toHaveBeenCalledTimes(1);
  });

  it('…but not once the buyer has closed her list', async () => {
    const c = seed('דנה');
    db.closeCollection(c.id, c.owner_token);
    expect(await app.runReminderScan(NOW)).toBe(0);
    expect(wordsSpy).not.toHaveBeenCalled();
  });

  it('…and not once the order is at the printer or ready', async () => {
    const a = order(seed('יעל'), { sent_to_print_at: new Date(NOW - DAY).toISOString() });
    const b = order(seed('נועה'), { ready_at: new Date(NOW - DAY).toISOString() });
    expect(a.order.sent_to_print_at).toBeTruthy();
    expect(b.order.ready_at).toBeTruthy();
    expect(await app.runReminderScan(NOW)).toBe(0);
    expect(wordsSpy).not.toHaveBeenCalled();
  });
});

describe('the reminder list', () => {
  it('stops the moment the order is marked ready, even while the list is open', async () => {
    const c = seed('מאיה');
    settings.set('reminders', 'list', [R]);
    expect(await app.runReminderListScan(NOW)).toBe(1);
    expect(emailSpy).toHaveBeenCalledTimes(1);

    // The owner marks it ready. The list is still open (she may have reopened it),
    // but there is nothing left to ask for.
    order(c, { ready_at: new Date(NOW).toISOString() });
    expect(await app.runReminderListScan(NOW + 2 * DAY)).toBe(0);
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it('stops once the deck has gone to the printer', async () => {
    const c = seed('אורית');
    settings.set('reminders', 'list', [R]);
    order(c, { sent_to_print_at: new Date(NOW).toISOString() });
    expect(await app.runReminderListScan(NOW)).toBe(0);
    expect(emailSpy).not.toHaveBeenCalled();
  });
});

describe('payment reminders', () => {
  it('run while the list is still open and nothing has started', async () => {
    const c = seed('רותם');
    order(c);
    expect(await app.runPaymentReminderScan(NOW)).toBe(1);
    expect(paySpy).toHaveBeenCalledTimes(1);
  });

  it('stop the moment the buyer closes her list — production has begun', async () => {
    const c = seed('אביב');
    order(c);
    db.closeCollection(c.id, c.owner_token);
    expect(await app.runPaymentReminderScan(NOW)).toBe(0);
    expect(paySpy).not.toHaveBeenCalled();
  });

  it('stop once the order is ready — that conversation is the owner’s to have', async () => {
    const c = seed('טל');
    order(c, { ready_at: new Date(NOW - HOUR).toISOString() });
    expect(await app.runPaymentReminderScan(NOW)).toBe(0);
    expect(paySpy).not.toHaveBeenCalled();
  });
});

describe('the ceiling on automated reminder email', () => {
  it('bounds the total across every scheduler, however the list is configured', async () => {
    settings.set('reminders', 'max_emails', 3);
    const c = seed('הילה');
    // A list that would otherwise send far more than three: five reminders, each
    // allowed twenty times, every day. This is the shape the question was about.
    settings.set(
      'reminders',
      'list',
      Array.from({ length: 5 }, (_, i) => ({ ...R, id: 'r' + i, max_total: 20 }))
    );

    let total = 0;
    for (let day = 0; day < 6; day += 1) total += await app.runReminderListScan(NOW + day * DAY);
    expect(total).toBe(3);
    expect(emailSpy).toHaveBeenCalledTimes(3);
    expect(db.reminderEmailsSent(db.getCollection(c.id))).toBe(3);
  });

  it('is one budget: the words nudge and the payment milestones spend it too', async () => {
    settings.set('reminders', 'max_emails', 2);
    const c = seed('ליאור');
    order(c);
    settings.set('reminders', 'list', [R]);

    // Nudge (1) + payment milestone (2) = the whole budget…
    expect(await app.runReminderScan(NOW)).toBe(1);
    expect(await app.runPaymentReminderScan(NOW)).toBe(1);
    // …so the list has nothing left to spend, whatever it is configured to do.
    expect(await app.runReminderListScan(NOW)).toBe(0);
    expect(emailSpy).not.toHaveBeenCalled();
    expect(db.reminderEmailsSent(db.getCollection(c.id))).toBe(2);
  });

  it('a ceiling of 0 turns automated reminder email off entirely', async () => {
    settings.set('reminders', 'max_emails', 0);
    const c = seed('כרמל');
    order(c);
    settings.set('reminders', 'list', [R]);
    expect(await app.runReminderScan(NOW)).toBe(0);
    expect(await app.runPaymentReminderScan(NOW)).toBe(0);
    expect(await app.runReminderListScan(NOW)).toBe(0);
    expect(db.reminderEmailsSent(db.getCollection(c.id))).toBe(0);
  });

  it('spends nothing it did not send: a skipped nudge stays owed', async () => {
    settings.set('reminders', 'max_emails', 0);
    const c = seed('שקד');
    expect(await app.runReminderScan(NOW)).toBe(0);
    // Not marked as reminded — so raising the ceiling later still lets it out.
    expect(db.getCollection(c.id).reminded_at).toBeFalsy();
    settings.set('reminders', 'max_emails', 5);
    expect(await app.runReminderScan(NOW)).toBe(1);
  });
});
