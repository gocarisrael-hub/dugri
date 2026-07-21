// @vitest-environment node
// Unit tests for the payment-reminder building blocks: the db due-query +
// idempotency mark, the owner-editable payment_reminder trigger + its `delay`
// timing validation, and the notify email builder.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const HOUR = 60 * 60 * 1000;

let db;
let settings;
let notify;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pay-reminder-'));
  for (const f of ['db.js', 'settings.js', 'notify.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  settings = require(path.join(serverDir, 'settings.js'));
  notify = require(path.join(serverDir, 'notify.js'));
});

function orderCollection(contact = { email: 'b@x.com', phone: '0521234567' }) {
  const c = db.createCollection('דנה', contact);
  db.setOrder(c.id, c.owner_token, { version: 'pdf' }, { admin: true });
  return c;
}

describe('db.collectionsDueForPaymentReminder', () => {
  it('an unpaid order becomes due only after the delay elapses', () => {
    const c = orderCollection();
    const now = Date.now();
    const idsAt = (t) => db.collectionsDueForPaymentReminder(t, 24).map((x) => x.id);
    expect(idsAt(now)).not.toContain(c.id); // just created — not yet due
    expect(idsAt(now + 25 * HOUR)).toContain(c.id); // 25h later — due
  });

  it('paid / cancelled / already-reminded / no-contact orders are never due', () => {
    const later = Date.now() + 48 * HOUR;
    const paid = orderCollection();
    db.markPaid(paid.id, { charged_total: 79 });
    const cancelled = orderCollection();
    db.cancelCollection(cancelled.id);
    const reminded = orderCollection();
    db.markPaymentReminded(reminded.id);
    const noContact = orderCollection({}); // no email, no phone
    const due = db.collectionsDueForPaymentReminder(later, 24).map((x) => x.id);
    expect(due).not.toContain(paid.id);
    expect(due).not.toContain(cancelled.id);
    expect(due).not.toContain(reminded.id);
    expect(due).not.toContain(noContact.id);
  });

  it('a phone-only order (no email) is still due — WhatsApp can reach it', () => {
    const c = orderCollection({ phone: '0521234567' });
    const due = db.collectionsDueForPaymentReminder(Date.now() + 25 * HOUR, 24).map((x) => x.id);
    expect(due).toContain(c.id);
  });

  it('markPaymentReminded stamps it and drops it from the due set (idempotent)', () => {
    const c = orderCollection();
    const later = Date.now() + 25 * HOUR;
    expect(db.collectionsDueForPaymentReminder(later, 24).map((x) => x.id)).toContain(c.id);
    expect(db.markPaymentReminded(c.id)).toBe(true);
    expect(db.getCollection(c.id).payment_reminded_at).toBeTruthy();
    expect(db.collectionsDueForPaymentReminder(later, 24).map((x) => x.id)).not.toContain(c.id);
  });
});

describe('payment_reminder settings', () => {
  it('ships an email template + a WA trigger (default OFF) + a pay CTA label', () => {
    expect(settings.get('email', 'payment_reminder').subject).toContain('תשלום');
    const t = settings.get('wa', 'trigger.payment_reminder');
    expect(t.enabled).toBe(false);
    expect(t.timing).toEqual({ delay_hours: 24, window: [9, 21] });
    expect(settings.get('email', 'cta_labels').pay).toBeTruthy();
  });

  it('validates the delay timing shape', () => {
    const v = (timing) => settings.validateValue('wa', 'trigger.payment_reminder', { timing });
    expect(v({ delay_hours: 12, window: [8, 20] })).toBeNull();
    expect(v({ delay_hours: 12 })).toBeNull(); // partial merges over the default window
    expect(v({ delay_hours: 0, window: [9, 21] })).toMatch(/delay_hours/);
    expect(v({ delay_hours: 1.5, window: [9, 21] })).toMatch(/delay_hours/);
    expect(v({ delay_hours: 12, window: [21, 9] })).toMatch(/before end/);
    expect(v({ delay_hours: 12, window: [9, 25] })).toMatch(/0\.\.23/);
  });
});

describe('notify.buildPaymentReminder', () => {
  it('builds the reminder with the pay link + pay CTA', () => {
    const c = { id: 'c1', owner_token: 'tok', honoree_name: 'דנה', owner_email: 'b@x.com' };
    const msg = notify.buildPaymentReminder(c, 'https://d.example');
    expect(msg.subject).toContain('תשלום');
    expect(msg.text).toContain('https://d.example/collect.html?c=c1&k=tok');
    expect(msg.html).toContain('להשלמת התשלום'); // cta.pay button label
  });
});
