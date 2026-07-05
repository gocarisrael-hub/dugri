import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// db.js is CommonJS and writes a JSON file under DATA_DIR — point it at a
// throwaway temp dir (set before require) so the test never touches real data.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDbPath = path.join(__dirname, '..', '..', 'server', 'db.js');

let db;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-design-codes-'));
  db = require(serverDbPath);
});

// A YYYY-MM-DD string offset (in days) from TODAY IN ISRAEL — matching the
// timezone validateDesignCode compares against, so these cases are stable no
// matter the test runner's timezone. Anchors at noon UTC to dodge DST edges.
function dateOffset(days) {
  const todayIsrael = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(
    new Date()
  );
  const d = new Date(todayIsrael + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(d);
}

describe('createDesignCode validation', () => {
  it('creates a valid code and normalizes the code to uppercase', () => {
    const c = db.createDesignCode({ code: 'vip26', design_id: 'bachelorette', valid_until: null });
    expect(c.error).toBeUndefined();
    expect(c.code).toBe('VIP26');
    expect(c.design_id).toBe('bachelorette');
    expect(c.valid_until).toBe(null);
    expect(c.active).toBe(true);
    expect(c.uses).toBe(0);
    expect(typeof c.id).toBe('string');
    expect(typeof c.created_at).toBe('string');
  });

  it('accepts a theme key (with spaces) as the design_id, trimmed + capped', () => {
    const c = db.createDesignCode({ code: 'THEMEKEY', design_id: '  trip comeback  ' });
    expect(c.design_id).toBe('trip comeback');
    const long = db.createDesignCode({ code: 'LONGDES', design_id: 'a'.repeat(200) });
    expect(long.design_id.length).toBe(80);
  });

  it('rejects a missing/blank design_id', () => {
    expect(db.createDesignCode({ code: 'NODESIGN' }).error).toBe('bad design_id');
    expect(db.createDesignCode({ code: 'BLANKDES', design_id: '   ' }).error).toBe('bad design_id');
  });

  it('rejects bad code chars or length', () => {
    expect(db.createDesignCode({ code: 'ab', design_id: 'x' }).error).toBe('bad code'); // too short
    expect(db.createDesignCode({ code: 'a'.repeat(21), design_id: 'x' }).error).toBe('bad code');
    expect(db.createDesignCode({ code: 'VI P', design_id: 'x' }).error).toBe('bad code'); // space
    expect(db.createDesignCode({ code: 'VIP-1', design_id: 'x' }).error).toBe('bad code'); // dash
  });

  it('rejects a malformed valid_until', () => {
    expect(
      db.createDesignCode({ code: 'BADDATE', design_id: 'x', valid_until: '2026/01/01' }).error
    ).toBe('bad valid_until');
    expect(
      db.createDesignCode({ code: 'BADDATE2', design_id: 'x', valid_until: '2026-13-40' }).error
    ).toBe('bad valid_until');
  });

  it('rejects a duplicate code (case-insensitive)', () => {
    expect(db.createDesignCode({ code: 'UNIQ1', design_id: 'x' }).error).toBeUndefined();
    expect(db.createDesignCode({ code: 'uniq1', design_id: 'y' }).error).toBe('duplicate');
  });
});

describe('validateDesignCode', () => {
  it('returns valid + the unlocked design_id for an active, unexpired code', () => {
    db.createDesignCode({ code: 'GOOD10', design_id: 'neon', valid_until: dateOffset(30) });
    const r = db.validateDesignCode('good10');
    expect(r).toEqual({ valid: true, design_id: 'neon' });
  });

  it('returns valid for a code whose valid_until is today (inclusive)', () => {
    db.createDesignCode({ code: 'TODAY', design_id: 'neon', valid_until: dateOffset(0) });
    expect(db.validateDesignCode('TODAY').valid).toBe(true);
  });

  it('returns not_found for an unknown code', () => {
    expect(db.validateDesignCode('NOPE')).toEqual({ valid: false, reason: 'not_found' });
  });

  it('returns inactive when the code is disabled', () => {
    const c = db.createDesignCode({ code: 'OFF', design_id: 'neon' });
    db.setDesignCodeActive(c.id, false);
    expect(db.validateDesignCode('OFF')).toEqual({ valid: false, reason: 'inactive' });
  });

  it('returns expired when today is after valid_until', () => {
    db.createDesignCode({ code: 'PAST', design_id: 'neon', valid_until: dateOffset(-1) });
    expect(db.validateDesignCode('PAST')).toEqual({ valid: false, reason: 'expired' });
  });
});

describe('validateDesignCode expiry uses the Israel calendar date', () => {
  afterEach(() => vi.useRealTimers());

  it('expires by Asia/Jerusalem date, not the server/UTC date', () => {
    // 2026-07-01T22:30:00Z is still July 1 in UTC, but already 01:30 on July 2
    // in Israel (IDT, UTC+3). A code valid through 2026-07-01 must read EXPIRED,
    // while one through 2026-07-02 is still valid (inclusive).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T22:30:00Z'));
    db.createDesignCode({ code: 'TZJUL1', design_id: 'neon', valid_until: '2026-07-01' });
    db.createDesignCode({ code: 'TZJUL2', design_id: 'neon', valid_until: '2026-07-02' });
    expect(db.validateDesignCode('TZJUL1')).toEqual({ valid: false, reason: 'expired' });
    expect(db.validateDesignCode('TZJUL2').valid).toBe(true);
  });
});

describe('setDesignCodeActive / deleteDesignCode / listDesignCodes', () => {
  it('toggles active and returns the code; null for unknown id', () => {
    const c = db.createDesignCode({ code: 'TOGGLE', design_id: 'neon' });
    expect(db.setDesignCodeActive(c.id, false).active).toBe(false);
    expect(db.setDesignCodeActive(c.id, true).active).toBe(true);
    expect(db.setDesignCodeActive('nope', false)).toBe(null);
  });

  it('deletes a code; false for unknown id', () => {
    const c = db.createDesignCode({ code: 'DELME', design_id: 'neon' });
    expect(db.deleteDesignCode(c.id)).toBe(true);
    expect(db.getDesignCodeByCode('DELME')).toBe(null);
    expect(db.deleteDesignCode('nope')).toBe(false);
  });

  it('lists codes newest first', () => {
    const list = db.listDesignCodes();
    expect(Array.isArray(list)).toBe(true);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].created_at.localeCompare(list[i].created_at)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('incrementDesignCodeUses', () => {
  it('bumps the use counter and returns false for an unknown code', () => {
    db.createDesignCode({ code: 'USES', design_id: 'neon' });
    expect(db.incrementDesignCodeUses('USES')).toBe(true);
    expect(db.getDesignCodeByCode('USES').uses).toBe(1);
    expect(db.incrementDesignCodeUses('USES')).toBe(true);
    expect(db.getDesignCodeByCode('USES').uses).toBe(2);
    expect(db.incrementDesignCodeUses('NOPE')).toBe(false);
  });
});
