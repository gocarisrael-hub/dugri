// @vitest-environment node
// Unit tests for the pure reminder scheduling engine (server/reminders.js). No
// I/O: remindersDue() is fed a reminder list + per-collection send state + "now"
// and must return exactly the reminders due, honouring window / weekdays /
// every_days spacing / max_total lifetime cap / only_if_idle_hours. This is the
// logic that replaces the fixed daily/quiet triggers and prevents another
// fire-every-hour spam loop, so it's covered exhaustively.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REMINDERS,
  validateReminders,
  remindersDue,
  tzParts,
} from '../../server/reminders.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// 2026-07-15T06:30Z -> 09:30 Asia/Jerusalem (UTC+3 in July), hour 9, inside [8,21].
const NOW = Date.parse('2026-07-15T06:30:00.000Z');

// A minimal valid reminder we can spread + tweak per case.
const base = {
  id: 'morning',
  enabled: true,
  text: 'שלום {honoree} {link}',
  channels: { email: false, whatsapp: true },
  every_days: 1,
  weekdays: null,
  only_if_idle_hours: null,
  window: [8, 21],
  max_total: 3,
};

function due(reminders, { sentState = {}, lastActivityMs, nowMs = NOW } = {}) {
  return remindersDue({ reminders, nowMs, sentState, lastActivityMs });
}

describe('validateReminders', () => {
  it('accepts the shipped default list', () => {
    expect(validateReminders(DEFAULT_REMINDERS)).toBeNull();
  });
  it('accepts a well-formed reminder', () => {
    expect(validateReminders([base])).toBeNull();
  });
  it('rejects a non-array', () => {
    expect(validateReminders({})).toMatch(/must be an array/);
  });
  it('rejects more than 20 reminders', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ ...base, id: 'r' + i }));
    expect(validateReminders(many)).toMatch(/too many/);
  });
  it('rejects a bad id and duplicate ids', () => {
    expect(validateReminders([{ ...base, id: 'Bad Id' }])).toMatch(/id must be/);
    expect(validateReminders([base, { ...base }])).toMatch(/duplicate/);
  });
  it('rejects a non-boolean enabled and empty text', () => {
    expect(validateReminders([{ ...base, enabled: 'yes' }])).toMatch(/enabled/);
    expect(validateReminders([{ ...base, text: '   ' }])).toMatch(/text/);
  });
  it('rejects bad channels and a no-channel reminder', () => {
    expect(validateReminders([{ ...base, channels: { email: false } }])).toMatch(/channels/);
    expect(validateReminders([{ ...base, channels: { email: false, whatsapp: false } }])).toMatch(
      /at least one channel/
    );
  });
  it('rejects bad every_days / max_total', () => {
    expect(validateReminders([{ ...base, every_days: 0 }])).toMatch(/every_days/);
    expect(validateReminders([{ ...base, max_total: 0 }])).toMatch(/max_total/);
  });
  it('rejects a bad window', () => {
    expect(validateReminders([{ ...base, window: [21, 8] }])).toMatch(/window/);
    expect(validateReminders([{ ...base, window: [8] }])).toMatch(/window/);
    expect(validateReminders([{ ...base, window: [8, 25] }])).toMatch(/window/);
  });
  it('rejects bad weekdays and only_if_idle_hours, accepts null', () => {
    expect(validateReminders([{ ...base, weekdays: [7] }])).toMatch(/weekdays/);
    expect(validateReminders([{ ...base, weekdays: [0, 3] }])).toBeNull();
    expect(validateReminders([{ ...base, only_if_idle_hours: 0 }])).toMatch(/only_if_idle_hours/);
    expect(validateReminders([{ ...base, only_if_idle_hours: null }])).toBeNull();
  });
});

describe('remindersDue — core gating', () => {
  it('a never-sent, enabled, in-window reminder is due, with channels + text', () => {
    const d = due([base]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      id: 'morning',
      text: 'שלום {honoree} {link}',
      channels: { email: false, whatsapp: true },
    });
  });
  it('a disabled reminder is never due', () => {
    expect(due([{ ...base, enabled: false }])).toHaveLength(0);
  });
  it('outside the hour window it is not due', () => {
    // 03:30 Jerusalem is outside [8,21].
    const early = Date.parse('2026-07-15T00:30:00.000Z');
    expect(due([base], { nowMs: early })).toHaveLength(0);
  });
  it('an invalid now yields nothing', () => {
    expect(remindersDue({ reminders: [base], nowMs: NaN })).toEqual([]);
  });
});

describe('remindersDue — weekdays', () => {
  it('is due only on a listed weekday', () => {
    const today = tzParts(NOW).weekday;
    const other = (today + 1) % 7;
    expect(due([{ ...base, weekdays: [today] }])).toHaveLength(1);
    expect(due([{ ...base, weekdays: [other] }])).toHaveLength(0);
    // empty/null = any day
    expect(due([{ ...base, weekdays: [] }])).toHaveLength(1);
  });
});

describe('remindersDue — max_total lifetime cap', () => {
  it('stops once count reaches max_total', () => {
    expect(due([base], { sentState: { morning: { count: 2 } } })).toHaveLength(1); // 2 < 3
    expect(due([base], { sentState: { morning: { count: 3 } } })).toHaveLength(0); // capped
  });
});

describe('remindersDue — every_days spacing', () => {
  it('suppresses within every_days of the last send, allows after', () => {
    const recent = { morning: { count: 1, last_at: new Date(NOW - 12 * HOUR).toISOString() } };
    expect(due([base], { sentState: recent })).toHaveLength(0); // 12h < 1 day
    const old = { morning: { count: 1, last_at: new Date(NOW - 25 * HOUR).toISOString() } };
    expect(due([base], { sentState: old })).toHaveLength(1); // 25h >= 1 day
  });
  it('respects a multi-day cadence (every 2 days)', () => {
    const r = { ...base, every_days: 2 };
    const oneDay = { morning: { count: 1, last_at: new Date(NOW - 25 * HOUR).toISOString() } };
    expect(due([r], { sentState: oneDay })).toHaveLength(0); // 25h < 2 days
    const twoDays = {
      morning: { count: 1, last_at: new Date(NOW - 2 * DAY - HOUR).toISOString() },
    };
    expect(due([r], { sentState: twoDays })).toHaveLength(1);
  });
});

describe('remindersDue — only_if_idle_hours', () => {
  const quiet = { ...base, only_if_idle_hours: 20 };
  it('suppresses when the collection was recently active', () => {
    expect(due([quiet], { lastActivityMs: NOW - 10 * HOUR })).toHaveLength(0); // 10h < 20h
  });
  it('fires when idle past the threshold', () => {
    expect(due([quiet], { lastActivityMs: NOW - 21 * HOUR })).toHaveLength(1);
  });
  it('treats unknown activity as idle (allowed)', () => {
    expect(due([quiet], { lastActivityMs: NaN })).toHaveLength(1);
  });
});

describe('remindersDue — multiple reminders', () => {
  it('returns each independently-due reminder', () => {
    const evening = {
      ...base,
      id: 'evening',
      text: 'ערב טוב',
      window: [8, 21],
      channels: { email: true, whatsapp: false },
    };
    const d = due([base, evening]);
    expect(d.map((x) => x.id).sort()).toEqual(['evening', 'morning']);
    expect(d.find((x) => x.id === 'evening').channels).toEqual({ email: true, whatsapp: false });
  });
});
