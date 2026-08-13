// @vitest-environment node
//
// The SMS outbox — the queue an Android phone with the owner's SIM polls, sends
// from, and reports back on. Everything worth pinning here comes from ONE fact:
// the phone is behind a home router, so it may be asleep, off, or gone for a day.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-07-15T09:00:00.000Z');

let sms;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-sms-'));
  delete require.cache[require.resolve(path.join(serverDir, 'sms.js'))];
  sms = require(path.join(serverDir, 'sms.js'));
});

afterAll(() => vi.restoreAllMocks());
beforeEach(() => sms._reset());

describe('the number it will dial', () => {
  it('normalises to the local form an Israeli SIM sends', () => {
    expect(sms.ilMobile('052-123-4567')).toBe('0521234567');
    expect(sms.ilMobile('+972521234567')).toBe('0521234567');
    expect(sms.ilMobile('00972521234567')).toBe('0521234567');
    expect(sms.ilMobile('972-52-1234567')).toBe('0521234567');
  });

  it('refuses anything that is not a mobile, rather than queueing a dead message', () => {
    expect(sms.ilMobile('03-1234567')).toBe(''); // landline
    expect(sms.ilMobile('05212345')).toBe(''); // too short
    expect(sms.ilMobile('hello')).toBe('');
    expect(sms.ilMobile('')).toBe('');
    expect(sms.enqueue({ to: '03-1234567', text: 'שלום' })).toBeNull();
    expect(sms.enqueue({ to: '0521234567', text: '   ' })).toBeNull();
  });
});

describe('queue → phone → report', () => {
  it('hands a queued message to the phone, and marks it sent on the report', () => {
    const m = sms.enqueue({ to: '0521234567', text: 'המשחק מוכן', event: 'order_ready', now: NOW });
    expect(m.state).toBe('pending');

    const batch = sms.claim({ now: NOW });
    expect(batch).toEqual([{ id: m.id, to: '0521234567', text: 'המשחק מוכן' }]);
    // Leased, not deleted: a second poll must not hand out the same text again.
    expect(sms.claim({ now: NOW })).toEqual([]);

    sms.ack(m.id, { ok: true, now: NOW });
    expect(sms.counts(NOW)).toMatchObject({ sent: 1, pending: 0 });
  });

  it('records the SIM’s own reason when the phone reports a failure', () => {
    const m = sms.enqueue({ to: '0521234567', text: 'שלום', now: NOW });
    sms.claim({ now: NOW });
    sms.ack(m.id, { ok: false, error: 'no credit', now: NOW });
    const rec = sms.list({ now: NOW })[0];
    expect(rec.state).toBe('failed');
    expect(rec.error).toBe('no credit');
    // NOT retried: a refusal the SIM reported is not a transport hiccup, and
    // retrying it would just fail again on a loop.
    expect(sms.claim({ now: NOW + HOUR })).toEqual([]);
  });

  it('returns a message whose phone never came back, so nothing is lost by one read', () => {
    const m = sms.enqueue({ to: '0521234567', text: 'שלום', now: NOW });
    sms.claim({ now: NOW }); // the app takes it, then is killed mid-send
    // Within the lease it stays taken…
    expect(sms.claim({ now: NOW + 60 * 1000 })).toEqual([]);
    // …and after it, it is owed again. A duplicate text beats a customer who was
    // never told.
    const again = sms.claim({ now: NOW + sms.LEASE_MS + 1000 });
    expect(again.map((x) => x.id)).toEqual([m.id]);
    expect(sms.list({ now: NOW + sms.LEASE_MS + 1000 })[0].attempts).toBe(2);
  });
});

describe('what a sleeping phone must not cause', () => {
  it('drops a message that waited too long instead of sending it stale', () => {
    const m = sms.enqueue({ to: '0521234567', text: 'המשחק מוכן', now: NOW });
    // Nobody polled for half a week.
    expect(sms.claim({ now: NOW + sms.DEFAULT_TTL_MS + HOUR })).toEqual([]);
    const rec = sms.list({ now: NOW + sms.DEFAULT_TTL_MS + HOUR }).find((x) => x.id === m.id);
    expect(rec.state).toBe('expired');
    // …and it says why, so the owner can send it herself if it still matters.
    expect(rec.error).toContain('לא נאסף');
  });

  it('queues one message per order and event, however many times it is pressed', () => {
    const first = sms.enqueue({
      to: '0521234567',
      text: 'המשחק מוכן',
      event: 'order_ready',
      collection_id: 'c1',
      now: NOW,
    });
    const second = sms.enqueue({
      to: '0521234567',
      text: 'המשחק מוכן',
      event: 'order_ready',
      collection_id: 'c1',
      now: NOW + 1000,
    });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(sms.counts(NOW + 2000).pending).toBe(1);

    // A DIFFERENT order is a different message, obviously.
    expect(
      sms.enqueue({ to: '0521234567', text: 'x', event: 'order_ready', collection_id: 'c2' })
    ).toBeTruthy();
  });

  it('lets a failed one be queued again — that press is a retry, not a duplicate', () => {
    const m = sms.enqueue({
      to: '0521234567',
      text: 'a',
      event: 'order_ready',
      collection_id: 'c1',
    });
    sms.claim({});
    sms.ack(m.id, { ok: false, error: 'no signal' });
    expect(
      sms.enqueue({ to: '0521234567', text: 'a', event: 'order_ready', collection_id: 'c1' })
    ).toBeTruthy();
  });
});

describe('is the phone alive', () => {
  it('remembers when it last asked for work', () => {
    expect(sms.lastPollAt()).toBeNull();
    sms.markPolled(NOW);
    expect(sms.lastPollAt()).toBe(new Date(NOW).toISOString());
  });
});
