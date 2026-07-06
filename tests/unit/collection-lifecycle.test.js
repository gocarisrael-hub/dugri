import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// server/db.js is CommonJS and writes a JSON file under DATA_DIR. Point it at a
// throwaway temp dir (set before require) so the test never touches real data.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDbPath = path.join(__dirname, '..', '..', 'server', 'db.js');

const DAY_MS = 24 * 60 * 60 * 1000;

let db;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-lifecycle-'));
  db = require(serverDbPath);
});

// Helper: is a given collection id present in the due list computed at `now`?
function isDue(id, now) {
  return db.collectionsDueForReminder(now).some((c) => c.id === id);
}

describe('createCollection expiry', () => {
  it('sets expires_at ~1 year (365 days) after created_at, not 7 days', () => {
    const c = db.createCollection('בדיקה', { email: 'exp@example.com' });
    const span = Date.parse(c.expires_at) - Date.parse(c.created_at);
    const years = span / (365 * DAY_MS);
    // Within a small tolerance of exactly one year (and unambiguously not a week).
    expect(years).toBeGreaterThan(0.99);
    expect(years).toBeLessThan(1.01);
    expect(span).toBeGreaterThan(300 * DAY_MS);
  });

  it('starts a new collection un-reminded (reminded_at null)', () => {
    const c = db.createCollection('בדיקה', { email: 'exp2@example.com' });
    expect(c.reminded_at).toBe(null);
  });
});

describe('collectionsDueForReminder', () => {
  it('is DUE when 0 words + 3+ days old + has email + not reminded', () => {
    const c = db.createCollection('לקוח', { email: 'due@example.com' });
    // created_at is "now"; evaluate the query 4 days later.
    const now = Date.parse(c.created_at) + 4 * DAY_MS;
    expect(isDue(c.id, now)).toBe(true);
  });

  it('is NOT due when the collection has words', () => {
    const c = db.createCollection('לקוח', { email: 'words@example.com' });
    db.addWords(c.id, ['מילה'], null);
    const now = Date.parse(c.created_at) + 4 * DAY_MS;
    expect(isDue(c.id, now)).toBe(false);
  });

  it('is NOT due when less than 3 days old', () => {
    const c = db.createCollection('לקוח', { email: 'fresh@example.com' });
    const now = Date.parse(c.created_at) + 1 * DAY_MS;
    expect(isDue(c.id, now)).toBe(false);
  });

  it('is NOT due once already reminded', () => {
    const c = db.createCollection('לקוח', { email: 'reminded@example.com' });
    const now = Date.parse(c.created_at) + 4 * DAY_MS;
    expect(isDue(c.id, now)).toBe(true);
    db.markReminded(c.id);
    expect(isDue(c.id, now)).toBe(false);
  });

  it('is NOT due when there is no owner_email', () => {
    const c = db.createCollection('לקוח'); // no contact => owner_email null
    expect(c.owner_email).toBe(null);
    const now = Date.parse(c.created_at) + 4 * DAY_MS;
    expect(isDue(c.id, now)).toBe(false);
  });

  it('is NOT due when the collection is cancelled', () => {
    const c = db.createCollection('לקוח', { email: 'cancel@example.com' });
    db.cancelCollection(c.id);
    const now = Date.parse(c.created_at) + 4 * DAY_MS;
    expect(isDue(c.id, now)).toBe(false);
  });

  it('uses paid_at (not created_at) as the reference when the order is paid', () => {
    const c = db.createCollection('לקוח', { email: 'paid@example.com' });
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id);
    // Simulate: created long ago, but only just paid — the paid_at basis (recent)
    // means it is NOT yet due even though created_at is old.
    const live = db.getCollection(c.id);
    live.created_at = new Date(Date.now() - 10 * DAY_MS).toISOString();
    live.order.paid_at = new Date().toISOString();
    expect(isDue(c.id, Date.now())).toBe(false);
    // Four days after the payment it becomes due.
    expect(isDue(c.id, Date.parse(live.order.paid_at) + 4 * DAY_MS)).toBe(true);
  });
});

describe('markReminded', () => {
  it('stamps reminded_at and returns true; false for an unknown id', () => {
    const c = db.createCollection('לקוח', { email: 'mark@example.com' });
    expect(db.markReminded(c.id)).toBe(true);
    expect(db.getCollection(c.id).reminded_at).not.toBe(null);
    expect(db.markReminded('no-such-id')).toBe(false);
  });
});

describe('reopenCollection', () => {
  it('reopens an owner-closed collection so it accepts words again', () => {
    const c = db.createCollection('לקוח', { email: 'reopen-closed@example.com' });
    db.closeCollection(c.id, c.owner_token);
    expect(db.effectiveStatus(db.getCollection(c.id))).toBe('closed');
    // While closed, addWords refuses.
    expect(db.addWords(c.id, ['לפני'], null)).toMatchObject({ closed: true });

    expect(db.reopenCollection(c.id)).toBe('open');
    const live = db.getCollection(c.id);
    expect(live.status).toBe('open');
    expect(live.closed_at).toBe(null);
    // Now words are accepted again.
    expect(db.addWords(c.id, ['אחרי'], null)).toMatchObject({ added: 1 });
  });

  it('reopens an expired collection by pushing expires_at ~1 year out', () => {
    const c = db.createCollection('לקוח', { email: 'reopen-expired@example.com' });
    // Force the deadline into the past — the exact scenario we are recovering.
    db.getCollection(c.id).expires_at = new Date(Date.now() - DAY_MS).toISOString();
    expect(db.effectiveStatus(db.getCollection(c.id))).toBe('expired');
    expect(db.addWords(c.id, ['לפני'], null)).toMatchObject({ closed: true });

    expect(db.reopenCollection(c.id)).toBe('open');
    const live = db.getCollection(c.id);
    expect(Date.parse(live.expires_at)).toBeGreaterThan(Date.now() + 300 * DAY_MS);
    expect(db.addWords(c.id, ['אחרי'], null)).toMatchObject({ added: 1 });
  });

  it('is a no-op on a soft-cancelled collection: stays cancelled, keeps closed_at/expires_at', () => {
    const c = db.createCollection('לקוח', { email: 'reopen-cancelled@example.com' });
    // Close it (records closed_at), then cancel it while closed.
    db.closeCollection(c.id, c.owner_token);
    db.cancelCollection(c.id);
    const before = db.getCollection(c.id);
    const closedAt = before.closed_at;
    const expiresAt = before.expires_at;
    expect(closedAt).not.toBe(null);

    // Reopen must NOT touch a cancelled collection — mutating it would drop the
    // original closed_at/expiry that a later restore relies on.
    expect(db.reopenCollection(c.id)).toBe('cancelled');
    const after = db.getCollection(c.id);
    expect(after.cancelled).toBe(true);
    expect(after.status).toBe('closed');
    expect(after.closed_at).toBe(closedAt);
    expect(after.expires_at).toBe(expiresAt);
  });

  it('returns null for an unknown id', () => {
    expect(db.reopenCollection('no-such-id')).toBe(null);
  });
});
