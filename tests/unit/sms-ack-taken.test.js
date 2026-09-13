// @vitest-environment node
//
// One fixed address that reports a batch — and reports THAT batch.
//
// The per-message report has to be ASSEMBLED on the phone — a formula reading a
// field out of the message the loop is on — and that single field is where the
// owner's gateway kept breaking: first an address built by hand that resolved to
// nothing, then the same field left as plain text because the formula toggle was
// off. Both failures are silent from the server's side: the message stays leased,
// the lease runs out, and the customer is texted the same thing again.
//
// So there is an address with nothing in it to get wrong. But "nothing to get
// wrong" is not "nothing to say": `taken` is a single global state, so a report
// that only said "everything I am holding went out" would settle every leased
// message anywhere — a second poll's, a second phone's, or the whole queue the
// moment the owner opened the URL in a browser to check it. And `sent` is
// terminal: ack() will not move it, reconcile() will not re-queue it, and
// enqueue()'s dedupe will not let "מוכן" queue a replacement. A message wrongly
// settled is a customer who is never told, with no way back. Hence one token per
// poll, carried on the fixed address and settling only its own batch.
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
// The one value a poll hands back for the whole run.
const batchOf = (claimed) => claimed[0].batch;

describe('reporting the batch', () => {
  it('marks everything this batch is holding as sent', () => {
    const a = queue('c1');
    const b = queue('c2');
    const claimed = sms.claim({ now: NOW });
    expect(claimed).toHaveLength(2);

    const { known, sent } = sms.ackTaken({ batch: batchOf(claimed), now: NOW + 1000 });
    expect(known).toBe(true);
    expect(sent).toHaveLength(2);
    expect(stateOf(a.id, NOW + 1000).state).toBe('sent');
    expect(stateOf(b.id, NOW + 1000).state).toBe('sent');
    expect(stateOf(a.id, NOW + 1000).sent_at).toBeTruthy();
  });

  it('gives one token to the whole poll, and a fresh one to the next', () => {
    queue('c1');
    queue('c2');
    const first = sms.claim({ now: NOW, limit: 1 });
    const second = sms.claim({ now: NOW, limit: 1 });
    expect(batchOf(first)).toBeTruthy();
    expect(batchOf(second)).toBeTruthy();
    expect(batchOf(first)).not.toBe(batchOf(second));
  });

  it('is a no-op when the batch is holding nothing, rather than an error', () => {
    queue('c1');
    const claimed = sms.claim({ now: NOW });
    sms.ackTaken({ batch: batchOf(claimed), now: NOW + 1000 });
    const again = sms.ackTaken({ batch: batchOf(claimed), now: NOW + 2000 });
    expect(again).toMatchObject({ known: true });
    expect(again.sent).toEqual([]);
    expect(sms.counts(NOW + 2000)).toMatchObject({ sent: 1, taken: 0, pending: 0 });
  });

  it('never touches a message that is still waiting its turn', () => {
    const a = queue('c1');
    const claimed = sms.claim({ now: NOW, limit: 1 });
    const b = queue('c2', NOW + 1000);
    sms.ackTaken({ batch: batchOf(claimed), now: NOW + 2000 });
    expect(stateOf(a.id, NOW + 2000).state).toBe('sent');
    expect(stateOf(b.id, NOW + 2000).state).toBe('pending');
  });
});

// THE DEFECT this token exists for. `taken` on its own records that a message
// was handed out, not to whom — so a report with no name on it settles every
// lease in the file, including the ones that never left the building.
describe('a report settles its own batch and nothing else', () => {
  const twoBatches = () => {
    const ids = ['c1', 'c2', 'c3', 'c4'].map((c) => queue(c).id);
    const a = sms.claim({ now: NOW, limit: 2 });
    const b = sms.claim({ now: NOW, limit: 2 });
    return { ids, a, b, aIds: a.map((m) => m.id), bIds: b.map((m) => m.id) };
  };

  // The poll's HTTP response is lost on the way back, so the phone retries the
  // poll and is handed a SECOND batch. It sends that one and reports. Before the
  // token, all four were marked sent and the first two customers — never texted —
  // were unreachable for good.
  it('leaves the batch whose response was lost untouched', () => {
    const { a, b, aIds, bIds } = twoBatches();
    const { sent } = sms.ackTaken({ batch: batchOf(b), now: NOW + 1000 });
    expect(sent.map((m) => m.id).sort()).toEqual(bIds.slice().sort());
    for (const id of aIds) expect(stateOf(id, NOW + 1000).state).toBe('taken');
    expect(sms.counts(NOW + 1000)).toMatchObject({ sent: 2, taken: 2, pending: 0 });
    expect(batchOf(a)).not.toBe(batchOf(b));
  });

  // …and it is not stranded there: the lease is what rescues it, exactly as it
  // does for a phone killed mid-batch. Back to pending, and out again.
  it('returns that batch to the queue when its lease runs out', () => {
    const { b, aIds } = twoBatches();
    sms.ackTaken({ batch: batchOf(b), now: NOW + 1000 });
    const later = NOW + sms.LEASE_MS + 1000;
    for (const id of aIds) expect(stateOf(id, later).state).toBe('pending');
    const again = sms.claim({ now: later }).map((m) => m.id);
    expect(again.sort()).toEqual(aIds.slice().sort());
  });

  // Two phones, or one phone whose old run is still alive: run 1's report must
  // not settle run 2's freshly claimed messages.
  it('does not let an earlier run settle a later one', () => {
    const { a, bIds } = twoBatches();
    sms.ackTaken({ batch: batchOf(a), now: NOW + 1000 });
    for (const id of bIds) expect(stateOf(id, NOW + 1000).state).toBe('taken');
  });

  // The doc tells the owner she can check the pasted address works. Opening the
  // bare address in a browser — no token — must not settle the batch the phone
  // is in the middle of sending.
  it('settles nothing at all when no token is given', () => {
    const { ids } = twoBatches();
    const r = sms.ackTaken({ now: NOW + 1000 });
    expect(r).toMatchObject({ known: false });
    expect(r.sent).toEqual([]);
    for (const id of ids) expect(stateOf(id, NOW + 1000).state).toBe('taken');
  });

  it('settles nothing for a token we never issued, and says it does not know it', () => {
    const { ids } = twoBatches();
    const r = sms.ackTaken({ batch: 'f0e1d2c3-0000-0000-0000-000000000000', now: NOW + 1000 });
    expect(r).toMatchObject({ known: false });
    expect(r.sent).toEqual([]);
    for (const id of ids) expect(stateOf(id, NOW + 1000).state).toBe('taken');
  });

  // A stale token is one whose messages went back in the queue and were handed
  // to a LATER batch. Its report is about a run that no longer holds them.
  it('is stale once the message has been re-leased to a later batch', () => {
    const m = queue('c1');
    const first = sms.claim({ now: NOW });
    const later = NOW + sms.LEASE_MS + 1000;
    const second = sms.claim({ now: later });
    expect(second.map((x) => x.id)).toEqual([m.id]);

    const r = sms.ackTaken({ batch: batchOf(first), now: later + 1000 });
    expect(r).toMatchObject({ known: false });
    expect(stateOf(m.id, later + 1000).state).toBe('taken');

    sms.ackTaken({ batch: batchOf(second), now: later + 2000 });
    expect(stateOf(m.id, later + 2000).state).toBe('sent');
  });
});

describe('what it must not swallow', () => {
  // The rule this module is built on: a duplicate beats a customer never told. A
  // phone killed mid-batch has had its messages returned to the queue by then,
  // and a report that arrives afterwards must not take them back out of it.
  it('leaves a message whose lease already ran out in the queue', () => {
    const m = queue('c1');
    const claimed = sms.claim({ now: NOW });
    const late = NOW + 6 * MINUTE;
    expect(sms.ackTaken({ batch: batchOf(claimed), now: late }).sent).toEqual([]);
    expect(stateOf(m.id, late).state).toBe('pending');
  });

  it('does not revive a message that was given up on', () => {
    const m = queue('c1');
    const claimed = sms.claim({ now: NOW });
    sms.ack(m.id, { ok: false, error: 'אין יתרה', now: NOW + 1000 });
    expect(sms.ackTaken({ batch: batchOf(claimed), now: NOW + 2000 }).sent).toEqual([]);
    const after = stateOf(m.id, NOW + 2000);
    expect(after.state).toBe('failed');
    expect(after.error).toBe('אין יתרה');
  });

  it('does not re-date a message already reported one by one', () => {
    const m = queue('c1');
    const claimed = sms.claim({ now: NOW });
    sms.ack(m.id, { ok: true, now: NOW + 1000 });
    const at = stateOf(m.id, NOW + 1000).sent_at;
    expect(sms.ackTaken({ batch: batchOf(claimed), now: NOW + 5000 }).sent).toEqual([]);
    expect(stateOf(m.id, NOW + 5000).sent_at).toBe(at);
  });
});

describe('alongside the per-message report', () => {
  it('settles only what is left after some were reported singly', () => {
    const a = queue('c1');
    const b = queue('c2');
    const claimed = sms.claim({ now: NOW });
    sms.ack(a.id, { ok: true, now: NOW + 500 });
    const { sent } = sms.ackTaken({ batch: batchOf(claimed), now: NOW + 1000 });
    expect(sent.map((m) => m.id)).toEqual([b.id]);
    expect(sms.counts(NOW + 1000)).toMatchObject({ sent: 2, taken: 0, pending: 0 });
  });
});

describe('the token as a key', () => {
  it('recognises a token it issued, and nothing else', () => {
    queue('c1');
    const claimed = sms.claim({ now: NOW });
    expect(sms.checkBatchToken(batchOf(claimed))).toBe(true);
    expect(sms.checkBatchToken('')).toBe(false);
    expect(sms.checkBatchToken(null)).toBe(false);
    expect(sms.checkBatchToken(batchOf(claimed) + 'x')).toBe(false);
    expect(sms.checkBatchToken('f0e1d2c3-0000-0000-0000-000000000000')).toBe(false);
  });

  // It stays a key after the batch is settled, so the phone's own retry of a
  // report it already made is answered rather than refused.
  it('still recognises a batch that has already been reported', () => {
    queue('c1');
    const claimed = sms.claim({ now: NOW });
    sms.ackTaken({ batch: batchOf(claimed), now: NOW + 1000 });
    expect(sms.checkBatchToken(batchOf(claimed))).toBe(true);
  });
});
