// @vitest-environment node
//
// One fixed address that reports the whole batch.
//
// The per-message report has to be ASSEMBLED on the phone — a formula reading a
// field out of the message the loop is on — and that single field is where the
// owner's gateway kept breaking: first an address built by hand that resolved to
// nothing, then the same field left as plain text because the formula toggle was
// off. Both failures are silent from the server's side: the message stays leased,
// the lease runs out, and the customer is texted the same thing again.
//
// So there is an address with nothing in it to get wrong. It is still the phone
// reporting and not the server guessing — a send that throws stops the flow
// before the report block is reached.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-09-13T09:00:00.000Z');

let sms;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-sms-acktaken-'));
  delete require.cache[require.resolve(path.join(serverDir, 'sms.js'))];
  sms = require(path.join(serverDir, 'sms.js'));
});
beforeEach(() => sms._reset());

const queue = (id, now = NOW) =>
  sms.enqueue({
    to: '0521234567',
    text: 'ההזמנה מוכנה',
    event: 'order_ready',
    collection_id: id,
    now,
  });
const stateOf = (id, now) => sms.list({ now }).find((m) => m.id === id);

describe('reporting the batch', () => {
  it('marks everything the phone is holding as sent', () => {
    const a = queue('c1');
    const b = queue('c2');
    expect(sms.claim({ now: NOW })).toHaveLength(2);

    const done = sms.ackTaken({ now: NOW + 1000 });
    expect(done).toHaveLength(2);
    expect(stateOf(a.id, NOW + 1000).state).toBe('sent');
    expect(stateOf(b.id, NOW + 1000).state).toBe('sent');
    expect(stateOf(a.id, NOW + 1000).sent_at).toBeTruthy();
  });

  it('is a no-op when the phone is holding nothing, rather than an error', () => {
    queue('c1');
    expect(sms.ackTaken({ now: NOW })).toEqual([]);
    expect(sms.counts(NOW)).toMatchObject({ pending: 1, sent: 0 });
  });

  it('never touches a message that is still waiting its turn', () => {
    const a = queue('c1');
    sms.claim({ now: NOW, limit: 1 });
    const b = queue('c2', NOW + 1000);
    sms.ackTaken({ now: NOW + 2000 });
    expect(stateOf(a.id, NOW + 2000).state).toBe('sent');
    expect(stateOf(b.id, NOW + 2000).state).toBe('pending');
  });
});

describe('what it must not swallow', () => {
  // The rule this module is built on: a duplicate beats a customer never told. A
  // phone killed mid-batch has had its messages returned to the queue by then,
  // and a report that arrives afterwards must not take them back out of it.
  it('leaves a message whose lease already ran out in the queue', () => {
    const m = queue('c1');
    sms.claim({ now: NOW });
    const late = NOW + 6 * MINUTE;
    expect(sms.ackTaken({ now: late })).toEqual([]);
    expect(stateOf(m.id, late).state).toBe('pending');
  });

  it('does not revive a message that was given up on', () => {
    const m = queue('c1');
    sms.claim({ now: NOW });
    sms.ack(m.id, { ok: false, error: 'אין יתרה', now: NOW + 1000 });
    expect(sms.ackTaken({ now: NOW + 2000 })).toEqual([]);
    const after = stateOf(m.id, NOW + 2000);
    expect(after.state).toBe('failed');
    expect(after.error).toBe('אין יתרה');
  });

  it('does not re-date a message already reported one by one', () => {
    const m = queue('c1');
    sms.claim({ now: NOW });
    sms.ack(m.id, { ok: true, now: NOW + 1000 });
    const at = stateOf(m.id, NOW + 1000).sent_at;
    expect(sms.ackTaken({ now: NOW + 5000 })).toEqual([]);
    expect(stateOf(m.id, NOW + 5000).sent_at).toBe(at);
  });
});

describe('alongside the per-message report', () => {
  it('settles only what is left after some were reported singly', () => {
    const a = queue('c1');
    const b = queue('c2');
    sms.claim({ now: NOW });
    sms.ack(a.id, { ok: true, now: NOW + 500 });
    expect(sms.ackTaken({ now: NOW + 1000 }).map((m) => m.id)).toEqual([b.id]);
    expect(sms.counts(NOW + 1000)).toMatchObject({ sent: 2, taken: 0, pending: 0 });
  });
});
