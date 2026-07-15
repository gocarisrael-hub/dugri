// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
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

// Restore any fs spies a test installs so later suites keep writing normally.
afterEach(() => {
  vi.restoreAllMocks();
});

// A value is a valid ISO-8601 instant iff Date.parse round-trips it exactly.
function isIso(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
}

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

describe('toIso normalization (via linkGroup timestamps)', () => {
  it('stores a valid ISO created_at even when given an unparseable time', () => {
    const entry = wa.linkGroup('gt@g.us', 'col-t', 'o@c.us', [], 'not-a-real-date');
    // Never the raw junk string; always a valid ISO instant (falls back to now).
    expect(entry.created_at).not.toBe('not-a-real-date');
    expect(isIso(entry.created_at)).toBe(true);
    expect(isIso(entry.last_activity_at)).toBe(true);
    // touchActivity with junk also normalizes to a valid ISO.
    wa.touchActivity('gt@g.us', 'garbage');
    expect(isIso(wa.collectionForGroup('gt@g.us').last_activity_at)).toBe(true);
  });

  it('accepts a Date and an epoch-ms number, normalizing to ISO', () => {
    const d = new Date('2026-07-20T09:00:00.000Z');
    const a = wa.linkGroup('gd@g.us', 'col-d', 'o@c.us', [], d);
    expect(a.created_at).toBe('2026-07-20T09:00:00.000Z');
    const b = wa.linkGroup('gn@g.us', 'col-n', 'o@c.us', [], Date.parse(AT));
    expect(b.created_at).toBe(AT);
  });
});

describe('linkGroup idempotence + reverse-index integrity', () => {
  it('re-linking the same group PRESERVES progress fields', () => {
    wa.linkGroup('gi@g.us', 'col-i', 'o@c.us', ['o@c.us'], AT);
    wa.markWelcomeSent('gi@g.us');
    wa.setInviteDmSent('gi@g.us');
    wa.markNudged('gi@g.us', '2026-07-15:daily_morning');
    wa.recordQuietReminder('gi@g.us', AT);
    wa.touchActivity('gi@g.us', '2026-07-18T00:00:00.000Z');

    // Re-link the SAME collection with a fresh (later) timestamp.
    const re = wa.linkGroup('gi@g.us', 'col-i', 'o@c.us', ['o@c.us'], '2026-07-30T00:00:00.000Z');
    // Progress survived — the bot must not re-send the welcome or re-fire nudges.
    expect(re.welcome_sent).toBe(true);
    expect(re.invite_dm_sent).toBe(true);
    expect(re.quiet.count).toBe(1);
    expect(re.created_at).toBe(AT); // NOT reset to the new timestamp
    expect(re.last_activity_at).toBe('2026-07-18T00:00:00.000Z');
    expect(wa.wasNudged('gi@g.us', '2026-07-15:daily_morning')).toBe(true);
  });

  it('re-linking to a DIFFERENT collection cleans up the stale reverse index', () => {
    wa.linkGroup('gx@g.us', 'col-old', 'o@c.us', [], AT);
    expect(wa.groupForCollection('col-old')).toBe('gx@g.us');

    wa.linkGroup('gx@g.us', 'col-new', 'o@c.us', [], AT);
    // Forward + reverse maps stay in sync: old pointer gone, new one set.
    expect(wa.groupForCollection('col-old')).toBe(null);
    expect(wa.groupForCollection('col-new')).toBe('gx@g.us');
    expect(wa.collectionForGroup('gx@g.us').collection_id).toBe('col-new');
  });
});

describe('prototype-pollution safety', () => {
  it('rejects dangerous keys on the write path without throwing or polluting', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      expect(() => wa.linkGroup(bad, 'col-z', 'o@c.us', [], AT)).not.toThrow();
      // No usable entry was created, and the prototype was not touched.
      expect(wa.collectionForGroup(bad)).toBe(null);
    }
    // Object.prototype is intact — no property leaked onto it.
    expect({}.collection_id).toBeUndefined();
    expect(Object.prototype.collection_id).toBeUndefined();
    // A dangerous collectionId is also rejected (no reverse-index entry).
    wa.linkGroup('gsafe@g.us', '__proto__', 'o@c.us', [], AT);
    expect(wa.groupForCollection('__proto__')).toBe(null);
  });
});

describe('returned state is a deep copy (mutation cannot bypass save)', () => {
  it('mutating a nested field on the returned object does not change the store', () => {
    wa.linkGroup('gc@g.us', 'col-c', 'o@c.us', ['a@c.us'], AT);

    const snap = wa.collectionForGroup('gc@g.us');
    snap.initial_members.push('intruder@c.us');
    snap.quiet.count = 999;
    snap.welcome_sent = true;

    const fresh = wa.collectionForGroup('gc@g.us');
    expect(fresh.initial_members).toEqual(['a@c.us']);
    expect(fresh.quiet.count).toBe(0);
    expect(fresh.welcome_sent).toBe(false);

    // Same for activeGroups() entries.
    const live = wa.activeGroups().find((g) => g.groupId === 'gc@g.us');
    live.quiet.count = 42;
    expect(wa.collectionForGroup('gc@g.us').quiet.count).toBe(0);
  });
});

describe('never-throw on save failure (in-memory stays authoritative)', () => {
  it('linkGroup + touchActivity still update memory and return when disk writes throw', () => {
    // Force the atomic write to blow up.
    const wSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    const rSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });

    let entry;
    expect(() => {
      entry = wa.linkGroup('gf@g.us', 'col-f', 'o@c.us', ['o@c.us'], AT);
    }).not.toThrow();
    // Returned a real entry, and the in-memory store reflects it.
    expect(entry).not.toBe(null);
    expect(entry.collection_id).toBe('col-f');
    expect(wa.collectionForGroup('gf@g.us').collection_id).toBe('col-f');

    const later = '2026-07-19T00:00:00.000Z';
    expect(() => wa.touchActivity('gf@g.us', later)).not.toThrow();
    expect(wa.collectionForGroup('gf@g.us').last_activity_at).toBe(later);

    wSpy.mockRestore();
    rSpy.mockRestore();
  });
});

describe('reserveCollection / releaseCollection (TOCTOU latch)', () => {
  it('grants the FIRST caller and refuses a second until released', () => {
    expect(wa.reserveCollection('col-res')).toBe(true);
    // A second reserve for the same collection is refused while the first holds it.
    expect(wa.reserveCollection('col-res')).toBe(false);
    wa.releaseCollection('col-res');
    // After release, it can be reserved again (retry after a failed create).
    expect(wa.reserveCollection('col-res')).toBe(true);
    wa.releaseCollection('col-res');
  });

  it('refuses reservation when a group already backs the collection', () => {
    wa.linkGroup('gres@g.us', 'col-linked', 'o@c.us', ['o@c.us'], AT);
    expect(wa.reserveCollection('col-linked')).toBe(false);
  });

  it('is a safe no-op for a bad/empty id', () => {
    expect(wa.reserveCollection('')).toBe(false);
    expect(wa.reserveCollection('__proto__')).toBe(false);
    expect(() => wa.releaseCollection('')).not.toThrow();
  });

  it('is IN-MEMORY only — a restart (fresh require) clears a stale reservation', () => {
    // Reserve but NEVER release (simulates a crash between reserve and release).
    expect(wa.reserveCollection('col-crash')).toBe(true);
    // The on-disk file must NOT carry the reservation. A reload (process restart)
    // starts with an empty latch, so the collection can be reserved again — it is
    // never permanently stranded and unable to get its group.
    const persisted = JSON.parse(fs.readFileSync(wa._file, 'utf8'));
    expect(persisted.pending).toBeUndefined();
    const wa2 = freshRequire();
    expect(wa2.reserveCollection('col-crash')).toBe(true);
  });
});

describe('wasEventProcessed / markEventProcessed (at-least-once de-dupe)', () => {
  it('records then recognises a processed event id for a group', () => {
    wa.linkGroup('gev@g.us', 'col-ev', 'o@c.us', ['o@c.us'], AT);
    expect(wa.wasEventProcessed('gev@g.us', 'e1')).toBe(false);
    wa.markEventProcessed('gev@g.us', 'e1');
    expect(wa.wasEventProcessed('gev@g.us', 'e1')).toBe(true);
    // A different id is still unseen.
    expect(wa.wasEventProcessed('gev@g.us', 'e2')).toBe(false);
  });

  it('no-ops for an unmapped group or empty id', () => {
    expect(wa.wasEventProcessed('nogroup@g.us', 'x')).toBe(false);
    expect(() => wa.markEventProcessed('nogroup@g.us', 'x')).not.toThrow();
    wa.linkGroup('gev2@g.us', 'col-ev2', 'o@c.us', ['o@c.us'], AT);
    expect(wa.wasEventProcessed('gev2@g.us', '')).toBe(false);
    wa.markEventProcessed('gev2@g.us', ''); // ignored
    expect(wa.wasEventProcessed('gev2@g.us', '')).toBe(false);
  });

  it('caps the processed-event list (bounded growth)', () => {
    wa.linkGroup('gcap@g.us', 'col-cap', 'o@c.us', ['o@c.us'], AT);
    const cap = wa.PROCESSED_EVENTS_CAP;
    for (let i = 0; i < cap + 20; i++) wa.markEventProcessed('gcap@g.us', 'ev' + i);
    // The oldest ids were pruned; the most recent cap ids are retained.
    expect(wa.wasEventProcessed('gcap@g.us', 'ev0')).toBe(false);
    expect(wa.wasEventProcessed('gcap@g.us', 'ev' + (cap + 19))).toBe(true);
    const entry = wa.collectionForGroup('gcap@g.us');
    expect(entry.processed_events.length).toBeLessThanOrEqual(cap);
  });

  it('touchActivityWithEvent stamps activity AND records the id in ONE persist', () => {
    wa.linkGroup('gtwe@g.us', 'col-twe', 'o@c.us', ['o@c.us'], AT);
    const later = '2026-07-20T08:00:00.000Z';
    // Spy the disk write to prove a SINGLE persist covers both mutations.
    const wSpy = vi.spyOn(fs, 'writeFileSync');
    wa.touchActivityWithEvent('gtwe@g.us', 'evX', later);
    expect(wSpy).toHaveBeenCalledTimes(1); // one write, not two
    wSpy.mockRestore();
    expect(wa.collectionForGroup('gtwe@g.us').last_activity_at).toBe(later);
    expect(wa.wasEventProcessed('gtwe@g.us', 'evX')).toBe(true);
  });

  it('touchActivityWithEvent with no id only stamps activity', () => {
    wa.linkGroup('gtwe2@g.us', 'col-twe2', 'o@c.us', ['o@c.us'], AT);
    const later = '2026-07-21T08:00:00.000Z';
    wa.touchActivityWithEvent('gtwe2@g.us', '', later);
    expect(wa.collectionForGroup('gtwe2@g.us').last_activity_at).toBe(later);
    const entry = wa.collectionForGroup('gtwe2@g.us');
    expect(entry.processed_events == null || entry.processed_events.length === 0).toBe(true);
  });
});
