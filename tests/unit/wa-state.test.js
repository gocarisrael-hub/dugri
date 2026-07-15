// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// server/wa-state.js is CommonJS and writes whatsapp-state.json under DATA_DIR.
// Point it at a throwaway temp dir (set BEFORE require) so tests never touch
// real data. The fresh-require pattern mirrors tests/unit/collection-lifecycle.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, '..', '..', 'server', 'wa-state.js');

let DATA_DIR;
let wa;

// (Re)load the module fresh against the current DATA_DIR by dropping it from the
// require cache first — this simulates a process restart reading the same file.
function freshRequire() {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

beforeAll(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wa-state-'));
  process.env.DATA_DIR = DATA_DIR;
  wa = freshRequire();
});

const AT = '2026-07-15T10:00:00.000Z';

describe('linkGroup + lookups', () => {
  it('links a group and resolves both directions', () => {
    const entry = wa.linkGroup('g1@g.us', 'col-1', 'owner@c.us', ['owner@c.us', 'bot@c.us'], AT);
    expect(entry.collection_id).toBe('col-1');
    expect(entry.owner_wa).toBe('owner@c.us');
    expect(entry.created_at).toBe(AT);
    expect(entry.last_activity_at).toBe(AT);
    expect(entry.closed).toBe(false);
    expect(entry.welcome_sent).toBe(false);
    expect(entry.invite_dm_sent).toBe(false);

    expect(wa.groupForCollection('col-1')).toBe('g1@g.us');
    const back = wa.collectionForGroup('g1@g.us');
    expect(back.groupId).toBe('g1@g.us');
    expect(back.collection_id).toBe('col-1');
  });

  it('returns null for unknown group/collection', () => {
    expect(wa.groupForCollection('nope')).toBe(null);
    expect(wa.collectionForGroup('nope')).toBe(null);
    expect(wa.linkGroup('', 'c', 'o')).toBe(null);
  });
});

describe('isInitialMember', () => {
  it('recognizes recorded initial members and excludes others', () => {
    wa.linkGroup('g2@g.us', 'col-2', 'owner@c.us', ['owner@c.us', 'bot@c.us'], AT);
    expect(wa.isInitialMember('g2@g.us', 'owner@c.us')).toBe(true);
    expect(wa.isInitialMember('g2@g.us', 'bot@c.us')).toBe(true);
    expect(wa.isInitialMember('g2@g.us', 'guest@c.us')).toBe(false);
    expect(wa.isInitialMember('unknown', 'owner@c.us')).toBe(false);
  });
});

describe('touchActivity', () => {
  it('updates last_activity_at', () => {
    wa.linkGroup('g3@g.us', 'col-3', 'o@c.us', [], AT);
    const later = '2026-07-16T12:00:00.000Z';
    wa.touchActivity('g3@g.us', later);
    expect(wa.collectionForGroup('g3@g.us').last_activity_at).toBe(later);
  });

  it('is a no-op on an unknown group (never throws)', () => {
    expect(() => wa.touchActivity('nope', AT)).not.toThrow();
  });
});

describe('welcome / invite flags', () => {
  it('markWelcomeSent and setInviteDmSent flip the flags', () => {
    wa.linkGroup('g4@g.us', 'col-4', 'o@c.us', [], AT);
    expect(wa.collectionForGroup('g4@g.us').welcome_sent).toBe(false);
    wa.markWelcomeSent('g4@g.us');
    expect(wa.collectionForGroup('g4@g.us').welcome_sent).toBe(true);

    expect(wa.collectionForGroup('g4@g.us').invite_dm_sent).toBe(false);
    wa.setInviteDmSent('g4@g.us');
    expect(wa.collectionForGroup('g4@g.us').invite_dm_sent).toBe(true);
  });
});

describe('nudge slot dedupe', () => {
  it('wasNudged is false before and true after markNudged', () => {
    wa.linkGroup('g5@g.us', 'col-5', 'o@c.us', [], AT);
    const slot = '2026-07-15:daily_morning';
    expect(wa.wasNudged('g5@g.us', slot)).toBe(false);
    wa.markNudged('g5@g.us', slot);
    expect(wa.wasNudged('g5@g.us', slot)).toBe(true);
    // A different slot is still un-fired.
    expect(wa.wasNudged('g5@g.us', '2026-07-16:daily_morning')).toBe(false);
  });

  it('prunes the slot map to the bounded cap, keeping the most recent', () => {
    wa.linkGroup('g6@g.us', 'col-6', 'o@c.us', [], AT);
    const cap = wa.NUDGE_SLOTS_CAP;
    const total = cap + 4;
    for (let i = 0; i < total; i++) {
      wa.markNudged('g6@g.us', `slot-${i}`);
    }
    const slots = wa.collectionForGroup('g6@g.us').nudge_slots;
    expect(Object.keys(slots).length).toBe(cap);
    // Oldest evicted, newest retained.
    expect(wa.wasNudged('g6@g.us', 'slot-0')).toBe(false);
    expect(wa.wasNudged('g6@g.us', `slot-${total - 1}`)).toBe(true);
  });
});

describe('recordQuietReminder', () => {
  it('increments quiet.count and stamps last_at', () => {
    wa.linkGroup('g7@g.us', 'col-7', 'o@c.us', [], AT);
    expect(wa.collectionForGroup('g7@g.us').quiet).toEqual({ count: 0, last_at: null });
    wa.recordQuietReminder('g7@g.us', AT);
    let q = wa.collectionForGroup('g7@g.us').quiet;
    expect(q.count).toBe(1);
    expect(q.last_at).toBe(AT);
    const later = '2026-07-17T08:00:00.000Z';
    wa.recordQuietReminder('g7@g.us', later);
    q = wa.collectionForGroup('g7@g.us').quiet;
    expect(q.count).toBe(2);
    expect(q.last_at).toBe(later);
  });
});

describe('markClosed + activeGroups', () => {
  it('closing a group removes it from activeGroups but keeps lookups', () => {
    wa.linkGroup('g8@g.us', 'col-8', 'o@c.us', [], AT);
    const idsBefore = wa.activeGroups().map((g) => g.groupId);
    expect(idsBefore).toContain('g8@g.us');

    wa.markClosed('g8@g.us');
    const idsAfter = wa.activeGroups().map((g) => g.groupId);
    expect(idsAfter).not.toContain('g8@g.us');
    // Entry + reverse index survive for lookups.
    expect(wa.collectionForGroup('g8@g.us').closed).toBe(true);
    expect(wa.groupForCollection('col-8')).toBe('g8@g.us');
  });

  it('activeGroups entries carry groupId folded in', () => {
    const all = wa.activeGroups();
    for (const g of all) {
      expect(typeof g.groupId).toBe('string');
      expect(g.closed).toBe(false);
    }
  });
});

describe('persistence (atomic write survives a restart)', () => {
  it('re-requiring the module against the same DATA_DIR restores state', () => {
    wa.linkGroup('gp@g.us', 'col-p', 'owner@c.us', ['owner@c.us'], AT);
    wa.markWelcomeSent('gp@g.us');
    wa.markNudged('gp@g.us', 'persist-slot');
    wa.recordQuietReminder('gp@g.us', AT);

    // The file was written where the module thinks it is.
    expect(fs.existsSync(wa._file)).toBe(true);
    expect(wa._file).toBe(path.join(DATA_DIR, 'whatsapp-state.json'));

    // Fresh process: reload from disk.
    const wa2 = freshRequire();
    const entry = wa2.collectionForGroup('gp@g.us');
    expect(entry).not.toBe(null);
    expect(entry.collection_id).toBe('col-p');
    expect(entry.welcome_sent).toBe(true);
    expect(wa2.isInitialMember('gp@g.us', 'owner@c.us')).toBe(true);
    expect(wa2.wasNudged('gp@g.us', 'persist-slot')).toBe(true);
    expect(wa2.collectionForGroup('gp@g.us').quiet.count).toBe(1);
    expect(wa2.groupForCollection('col-p')).toBe('gp@g.us');

    // Rebind the shared handle so later suites (if reordered) use the live one.
    wa = wa2;
  });
});
