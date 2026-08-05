import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The free word quota: a collection may gather `pricing.free_word_limit` words,
// after which adding is refused until the order is paid. Both the quota and the
// enforce switch are owner-editable, so this suite drives them through settings
// rather than hardcoding 20.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDbPath = path.join(__dirname, '..', '..', 'server', 'db.js');
const settingsPath = path.join(__dirname, '..', '..', 'server', 'settings.js');

let db;
let settings;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-freelimit-'));
  delete require.cache[require.resolve(settingsPath)];
  settings = require(settingsPath);
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  db = require(serverDbPath);
});

afterEach(() => {
  // Every test starts from the registry defaults.
  settings.reset('pricing', 'free_word_limit');
  settings.reset('pricing', 'lock_after_free_limit');
});

// n distinct words ('w1'…'wn'), so nothing is lost to deduping.
const words = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => prefix + (i + 1));

describe('settings: the quota knobs', () => {
  it('defaults to a 20-word quota that is enforced', () => {
    expect(settings.get('pricing', 'free_word_limit')).toBe(20);
    expect(settings.get('pricing', 'lock_after_free_limit')).toBe(true);
  });

  it('rejects a 0 quota — it would lock every collection at its first word', () => {
    expect(settings.validateValue('pricing', 'free_word_limit', 0)).toBeTruthy();
    expect(() => settings.set('pricing', 'free_word_limit', 0)).toThrow();
  });

  it('rejects a non-integer quota', () => {
    expect(settings.validateValue('pricing', 'free_word_limit', 12.5)).toBeTruthy();
    expect(settings.validateValue('pricing', 'free_word_limit', '20')).toBeTruthy();
  });

  it('accepts a positive integer quota', () => {
    expect(settings.validateValue('pricing', 'free_word_limit', 5)).toBe(null);
    expect(settings.set('pricing', 'free_word_limit', 5)).toBe(5);
  });
});

describe('addWords under the quota', () => {
  it('stores words freely below the quota', () => {
    settings.set('pricing', 'free_word_limit', 5);
    const c = db.createCollection('שירה', { email: 'a@example.com' });
    const r = db.addWords(c.id, words(3));
    expect(r).toMatchObject({ added: 3, skipped: 0, blocked: 0 });
    expect(db.countWords(c.id)).toBe(3);
  });

  it('accepts a batch PARTIALLY: fills the remaining slots, blocks the rest', () => {
    settings.set('pricing', 'free_word_limit', 5);
    const c = db.createCollection('שירה', { email: 'b@example.com' });
    db.addWords(c.id, words(3));
    // 2 slots left, 10 offered -> 2 stored, 8 blocked. The buyer's typing is
    // never thrown away wholesale.
    const r = db.addWords(c.id, words(10, 'x'));
    expect(r).toMatchObject({ added: 2, blocked: 8 });
    expect(db.countWords(c.id)).toBe(5);
  });

  it('refuses every word once the quota is full', () => {
    settings.set('pricing', 'free_word_limit', 4);
    const c = db.createCollection('שירה', { email: 'c@example.com' });
    db.addWords(c.id, words(4));
    const r = db.addWords(c.id, ['נוספת']);
    expect(r).toMatchObject({ added: 0, blocked: 1 });
    expect(db.countWords(c.id)).toBe(4);
  });

  it('counts duplicates as skipped, not blocked — they were never going to store', () => {
    settings.set('pricing', 'free_word_limit', 10);
    const c = db.createCollection('שירה', { email: 'd@example.com' });
    db.addWords(c.id, ['קפה']);
    const r = db.addWords(c.id, ['קפה', 'תה']);
    expect(r).toMatchObject({ added: 1, skipped: 1, blocked: 0 });
  });

  it('a duplicate does not consume a quota slot', () => {
    settings.set('pricing', 'free_word_limit', 3);
    const c = db.createCollection('שירה', { email: 'e@example.com' });
    db.addWords(c.id, ['א']);
    // 'א' is a dupe; 'ב' and 'ג' still fit under the 3-word quota.
    const r = db.addWords(c.id, ['א', 'ב', 'ג']);
    expect(r).toMatchObject({ added: 2, skipped: 1, blocked: 0 });
    expect(db.countWords(c.id)).toBe(3);
  });
});

describe('who the quota applies to', () => {
  it('does not apply once the order is paid — payment is what lifts the gate', () => {
    settings.set('pricing', 'free_word_limit', 3);
    const c = db.createCollection('שירה', { email: 'f@example.com' });
    db.addWords(c.id, words(3));
    expect(db.freeLimit(c.id).locked).toBe(true);
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id);
    expect(db.freeLimit(c.id).locked).toBe(false);
    const r = db.addWords(c.id, ['עוד', 'ועוד']);
    expect(r).toMatchObject({ added: 2, blocked: 0 });
  });

  it('does not apply to collections created before the gate shipped', () => {
    settings.set('pricing', 'free_word_limit', 2);
    const c = db.createCollection('שירה', { email: 'g@example.com' });
    // Older rows carry no `free_limit_applies` stamp at all.
    delete db.getCollection(c.id).free_limit_applies;
    const r = db.addWords(c.id, words(6));
    expect(r).toMatchObject({ added: 6, blocked: 0 });
    expect(db.freeLimit(c.id).locked).toBe(false);
  });

  it('stops blocking when the enforce switch is off, keeping the quota number', () => {
    settings.set('pricing', 'free_word_limit', 2);
    settings.set('pricing', 'lock_after_free_limit', false);
    const c = db.createCollection('שירה', { email: 'h@example.com' });
    const r = db.addWords(c.id, words(6));
    expect(r).toMatchObject({ added: 6, blocked: 0 });
    const fl = db.freeLimit(c.id);
    expect(fl.limit).toBe(2);
    expect(fl.applies).toBe(false);
    expect(fl.locked).toBe(false);
  });
});

describe('freeLimitState projection', () => {
  it('reports remaining slots while below the quota', () => {
    settings.set('pricing', 'free_word_limit', 20);
    const c = db.createCollection('שירה', { email: 'i@example.com' });
    db.addWords(c.id, words(12));
    expect(db.freeLimit(c.id)).toMatchObject({ limit: 20, remaining: 8, locked: false });
  });

  it('never reports a negative remainder', () => {
    settings.set('pricing', 'free_word_limit', 4);
    const c = db.createCollection('שירה', { email: 'j@example.com' });
    db.addWords(c.id, words(4));
    expect(db.freeLimit(c.id).remaining).toBe(0);
  });

  it('falls back to the registry default when the override is corrupt', () => {
    // Bypass validateValue the way a hand-edited settings.json would.
    const c = db.createCollection('שירה', { email: 'k@example.com' });
    const state = db.freeLimitState({ ...db.getCollection(c.id) }, 0);
    expect(state.limit).toBe(20);
  });
});

describe('the one-time "quota reached" email marker', () => {
  it('returns true exactly once, so the mail can never be sent twice', () => {
    const c = db.createCollection('שירה', { email: 'l@example.com' });
    expect(db.markFreeLimitNotified(c.id)).toBe(true);
    expect(db.markFreeLimitNotified(c.id)).toBe(false);
    expect(db.getCollection(c.id).free_limit_notified_at).toBeTruthy();
  });

  it('starts null on a fresh collection', () => {
    const c = db.createCollection('שירה', { email: 'm@example.com' });
    expect(c.free_limit_notified_at).toBe(null);
    expect(c.free_limit_applies).toBe(true);
  });

  it('is a no-op for an unknown collection', () => {
    expect(db.markFreeLimitNotified('nope')).toBe(false);
  });
});

describe('the "quota reached" email body', () => {
  it('names the quota and carries the pay CTA on the owner link', () => {
    const notify = require(path.join(__dirname, '..', '..', 'server', 'notify.js'));
    const c = db.createCollection('שירה', { email: 'n@example.com' });
    const msg = notify.buildFreeLimitReached(c, 'https://dugri.example', 20);
    expect(msg.subject).toContain('20');
    expect(msg.subject).toContain('שירה');
    expect(msg.text).toContain('20');
    // The CTA points at the owner link — the page the pay panel lives on.
    expect(msg.html).toContain(c.owner_token);
    expect(msg.text).toContain(c.owner_token);
  });
});
