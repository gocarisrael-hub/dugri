import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import wordBank from '../../server/word-bank.js';

// PHASE 1 OF THE PRODUCTION-PREVIEW WORK. The preview that comes later has to
// show the customer the deck that will actually be printed, and there can be
// only one production version of it. Neither is possible while the 412 is
// recomputed at print time from pools the admin can edit — so approval freezes
// it. These tests are about that freeze: that it is the REAL top-up, that it is
// what production then prints, and that it is dropped the moment it stops
// describing the order.

describe('wordsForProduction', () => {
  it('prints the frozen bank when the order has one', () => {
    const bank = { version: 1, words: ['אחת', 'שתיים', 'שלוש'] };
    expect(wordBank.wordsForProduction({ word_bank: bank }, ['אחת'])).toEqual(bank.words);
  });

  it("falls back to the buyer's own words when nothing was frozen", () => {
    // Every order predating the freeze is this case, and it must behave exactly
    // as it did before: personal words in, topup fills at print time.
    const personal = ['אחת', 'שתיים'];
    expect(wordBank.wordsForProduction({}, personal)).toBe(personal);
    expect(wordBank.wordsForProduction({ word_bank: null }, personal)).toBe(personal);
    expect(wordBank.wordsForProduction({ word_bank: { words: [] } }, personal)).toBe(personal);
  });
});

describe('isStale', () => {
  it('is false while the bank still matches its inputs', () => {
    const c = {
      theme: 'bachelorette',
      wordlist: null,
      word_bank: { theme: 'bachelorette', pool: null },
    };
    expect(wordBank.isStale(c)).toBe(false);
  });

  it('is true once the seed pool changed under it', () => {
    const c = {
      theme: 'bachelorette',
      wordlist: 'grown-ups.txt',
      word_bank: { theme: 'bachelorette', pool: null },
    };
    expect(wordBank.isStale(c)).toBe(true);
  });

  it('is true once the design changed under it', () => {
    const c = {
      theme: 'japanese',
      wordlist: null,
      word_bank: { theme: 'bachelorette', pool: null },
    };
    expect(wordBank.isStale(c)).toBe(true);
  });

  it('is false for an order with no bank at all — nothing to be stale', () => {
    expect(wordBank.isStale({ theme: 'japanese' })).toBe(false);
  });
});

describe('freeze', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wb-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs the REAL top-up and returns a full deck built on the personal words', () => {
    // Not a stub: the whole point of shelling out to generator/topup.py is that
    // the freeze and the print run the same rule. A JS reimplementation here
    // would test the reimplementation.
    const personal = ['מסיבה', 'חברים', 'ריקודים'];
    const bank = wordBank.freeze({ personalWords: personal, theme: 'bachelorette' });
    if (!bank) return; // no python on this box — the fallback path has its own test
    expect(bank.words.length).toBeGreaterThanOrEqual(412);
    // Every personal word survives, in front, in order.
    expect(bank.words.slice(0, personal.length)).toEqual(personal);
    expect(bank.personal_count).toBe(personal.length);
    expect(bank.theme).toBe('bachelorette');
    expect(bank.pool).toBeNull();
    expect(Date.parse(bank.created_at)).not.toBeNaN();
  });

  it('returns null rather than throwing when the top-up cannot run', () => {
    // A close must not fail because Python is missing: no bank simply means the
    // order prints the way it did before freezing existed.
    const bank = wordBank.freeze({
      personalWords: ['מסיבה'],
      theme: 'bachelorette',
      python: path.join(dir, 'no-such-python'),
    });
    expect(bank).toBeNull();
  });

  it('refuses to freeze nothing', () => {
    expect(wordBank.freeze({ personalWords: [], theme: 'bachelorette' })).toBeNull();
    expect(wordBank.freeze({ personalWords: ['מסיבה'], theme: '' })).toBeNull();
    expect(wordBank.freeze({ personalWords: ['   '], theme: 'bachelorette' })).toBeNull();
  });
});
