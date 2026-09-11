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
    expect(batch).toMatchObject([{ id: m.id, to: '0521234567', text: 'המשחק מוכן' }]);
    // …plus the one-use key to this message's report address, so the link the
    // phone is handed never has to carry the shared gateway key.
    expect(batch[0].ack_token).toEqual(expect.any(String));
    expect(batch[0].ack_token.length).toBeGreaterThan(20);
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

describe('a phone that sends but never reports', () => {
  // The lease re-sends an unreported message on the principle that a duplicate
  // beats a silence — true for one duplicate. The owner's own test was picked up
  // six times in half an hour by a phone whose report step was broken; for a
  // customer that is a text every five minutes until the 12-hour expiry.
  it(`stops handing it out after ${3} pickups without a report, and says why`, () => {
    const m = sms.enqueue({
      to: '0521234567',
      text: 'המשחק מוכן',
      event: 'order_ready',
      collection_id: 'c-cap',
      now: NOW,
    });
    let t = NOW;
    for (let i = 0; i < sms.MAX_ATTEMPTS; i++) {
      expect(sms.claim({ now: t }).map((x) => x.id)).toEqual([m.id]);
      t += sms.LEASE_MS + 1000; // never reported; the lease runs out
    }
    expect(sms.claim({ now: t })).toEqual([]);
    const after = sms.list({ now: t }).find((x) => x.id === m.id);
    expect(after.state).toBe('failed');
    expect(after.error).toContain(String(sms.MAX_ATTEMPTS));
  });

  it('still re-sends below the cap — one lost report is exactly what the lease is for', () => {
    const m = sms.enqueue({ to: '0521234567', text: 'המשחק מוכן', now: NOW });
    sms.claim({ now: NOW });
    expect(sms.claim({ now: NOW + sms.LEASE_MS + 1000 }).map((x) => x.id)).toEqual([m.id]);
  });

  // THE WHOLE POINT of the cap, and the part that is easy to get wrong: nothing
  // in this test reads the queue before pressing ready again. A phone that has
  // stopped polling stops everything else too — no poll, no admin page open at
  // 2am, nothing to trigger a reconcile — so the capped message is still sitting
  // in `taken` at the moment the owner presses the button. If enqueue does not
  // reconcile for itself, the dedupe sees a live message, answers null, and the
  // recovery press is a no-op forever. (An earlier draft of this test called
  // sms.list() first, which did the reconcile FOR the code under test and hid
  // exactly that.)
  it('can be queued again by pressing ready once the phone is fixed', () => {
    const args = {
      to: '0521234567',
      text: 'המשחק מוכן',
      event: 'order_ready',
      collection_id: 'c-retry',
    };
    sms.enqueue({ ...args, now: NOW });
    let t = NOW;
    for (let i = 0; i < sms.MAX_ATTEMPTS; i++) {
      sms.claim({ now: t });
      t += sms.LEASE_MS + 1000;
    }
    const again = sms.enqueue({ ...args, now: t });
    expect(again).not.toBeNull();
    expect(again.state).toBe('pending');
    // …and the capped one keeps its reason, rather than being rewritten.
    const all = sms.list({ now: t }).filter((m) => m.dedupe_key === 'c-retry:order_ready');
    expect(all).toHaveLength(2);
    expect(all.filter((m) => m.state === 'failed')).toHaveLength(1);
  });

  // The other end that means the customer was never told. `expired` used to
  // block a replacement just as hard as a live message did: the phone was off
  // all night, the 12-hour window closed, and pressing ready in the morning
  // produced nothing at all.
  it('can be queued again after the first one expired unread', () => {
    const args = {
      to: '0521234567',
      text: 'המשחק מוכן',
      event: 'order_ready',
      collection_id: 'c-exp',
    };
    sms.enqueue({ ...args, now: NOW });
    const t = NOW + sms.DEFAULT_TTL_MS + HOUR;
    const again = sms.enqueue({ ...args, now: t });
    expect(again).not.toBeNull();
    expect(again.state).toBe('pending');
  });

  // The mirror image: a message that IS on its way still blocks, so an
  // accidental double-press cannot text a customer twice.
  it('still refuses a replacement while the first is pending, taken or sent', () => {
    const args = {
      to: '0521234567',
      text: 'המשחק מוכן',
      event: 'order_ready',
      collection_id: 'c-live',
    };
    const m = sms.enqueue({ ...args, now: NOW });
    expect(sms.enqueue({ ...args, now: NOW })).toBeNull(); // pending
    sms.claim({ now: NOW });
    expect(sms.enqueue({ ...args, now: NOW })).toBeNull(); // taken
    sms.ack(m.id, { ok: true, now: NOW });
    expect(sms.enqueue({ ...args, now: NOW })).toBeNull(); // sent
  });
});

// A report can arrive long after we stopped waiting for it — the phone was on a
// dead network for an hour and its retry finally went through. By then the
// message may already carry a decision, and that decision is the only thing
// telling the owner her gateway is broken.
describe('a report that arrives too late', () => {
  const capped = (id = 'c-late') => {
    const m = sms.enqueue({
      to: '0521234567',
      text: 'המשחק מוכן',
      event: 'order_ready',
      collection_id: id,
      now: NOW,
    });
    let t = NOW;
    for (let i = 0; i < sms.MAX_ATTEMPTS; i++) {
      sms.claim({ now: t });
      t += sms.LEASE_MS + 1000;
    }
    sms.reconcile(t);
    return { m, t };
  };

  it('does not turn a capped failure into a green "sent"', () => {
    const { m, t } = capped();
    expect(sms.list({ now: t }).find((x) => x.id === m.id).state).toBe('failed');
    sms.ack(m.id, { ok: true, now: t });
    const after = sms.list({ now: t }).find((x) => x.id === m.id);
    expect(after.state).toBe('failed');
    expect(after.sent_at).toBeNull();
    // The reason survives — without it the owner has a green row and no idea
    // her phone stopped reporting.
    expect(after.error).toContain(String(sms.MAX_ATTEMPTS));
  });

  it('does not revive a message that expired unread', () => {
    const m = sms.enqueue({ to: '0521234567', text: 'המשחק מוכן', now: NOW });
    const t = NOW + sms.DEFAULT_TTL_MS + HOUR;
    sms.reconcile(t);
    sms.ack(m.id, { ok: true, now: t });
    const after = sms.list({ now: t }).find((x) => x.id === m.id);
    expect(after.state).toBe('expired');
    expect(after.error).toBeTruthy();
  });

  // And the other direction: a stray failure report must not undo a text the
  // SIM already accepted.
  it('does not turn a sent message into a failure', () => {
    const m = sms.enqueue({ to: '0521234567', text: 'המשחק מוכן', now: NOW });
    sms.claim({ now: NOW });
    sms.ack(m.id, { ok: true, now: NOW });
    sms.ack(m.id, { ok: false, error: 'no credit', now: NOW + 1000 });
    const after = sms.list({ now: NOW + 1000 }).find((x) => x.id === m.id);
    expect(after.state).toBe('sent');
    expect(after.error).toBeNull();
  });
});

describe('the per-message report token', () => {
  const taken = () => {
    const m = sms.enqueue({ to: '0521234567', text: 'המשחק מוכן', now: NOW });
    return { m, token: sms.claim({ now: NOW })[0].ack_token };
  };

  it('opens its own message', () => {
    const { m, token } = taken();
    expect(sms.checkAckToken(m.id, token)).toBe(true);
  });

  it('opens nothing else — not another message, not a wrong or missing token', () => {
    const a = taken();
    const b = taken();
    expect(sms.checkAckToken(a.m.id, b.token)).toBe(false);
    expect(sms.checkAckToken(a.m.id, 'wrong')).toBe(false);
    expect(sms.checkAckToken(a.m.id, '')).toBe(false);
    expect(sms.checkAckToken(a.m.id, null)).toBe(false);
    expect(sms.checkAckToken('no-such-id', a.token)).toBe(false);
  });

  // A message sitting in the file from before tokens existed has none until it
  // is next handed out; until then it simply cannot be unlocked that way.
  it('refuses a message that has never been handed out', () => {
    const m = sms.enqueue({ to: '0521234567', text: 'המשחק מוכן', now: NOW });
    expect(sms.checkAckToken(m.id, 'anything')).toBe(false);
  });
});
