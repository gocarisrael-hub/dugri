// @vitest-environment node
// THE BOUNDARY HAS TO TRAVEL.
//
// 'personal-first' prints the buyer's own words on the opening cards and the
// pool's behind them. Which words are hers is not written on any word — it is a
// COUNT, "the first N of this list" — and the list production prints is usually
// a frozen word bank: her 240 words with the pool's 172 already joined on. The
// generator measures that boundary itself when it is handed her raw list, and on
// a bank that measurement answers "all 412 are hers", so the split does nothing
// and the deck prints blended. Nothing errors. The owner found it from the
// outside: "i try to say to him first costumer words and then ours and it still
// comes the pdf not like this".
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;
let db;
let wordBank;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pcount-'));
  for (const f of ['db.js', 'word-bank.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  wordBank = require(path.join(serverDir, 'word-bank.js'));
  app = require(path.join(serverDir, 'index.js'));
});

const BASE = {
  theme: 'birthday-girls',
  name: 'שירה',
  wordsFile: '/tmp/words.txt',
  outPath: '/tmp/out.pdf',
};

// A collection carrying a frozen bank shaped like the real one: hers first.
function withBank(personalCount, total = 412) {
  const words = Array.from({ length: total }, (_, i) =>
    i < personalCount ? 'שלה' + i : 'מהמאגר' + i
  );
  return { word_bank: { version: 1, personal_count: personalCount, words } };
}

describe('the boundary the server hands the generator', () => {
  it('is the bank’s own count', () => {
    expect(wordBank.personalCountForProduction(withBank(240))).toBe(240);
  });

  it('is null when there is no bank — the generator measures her raw list itself', () => {
    expect(wordBank.personalCountForProduction({})).toBe(null);
    expect(wordBank.personalCountForProduction(null)).toBe(null);
  });

  it('is null for a bank frozen before the count was recorded', () => {
    // Old rows exist. A missing count must mean "measure it", never "split at 0"
    // — which would put every word in the filler group.
    const c = withBank(240);
    delete c.word_bank.personal_count;
    expect(wordBank.personalCountForProduction(c)).toBe(null);
  });

  it('is null when the count would swallow the whole deck', () => {
    // A boundary equal to the length is the no-op that caused this bug; saying
    // "nothing to split on" is the honest answer, not a 412 nobody can act on.
    expect(wordBank.personalCountForProduction(withBank(412, 412))).toBe(null);
    expect(wordBank.personalCountForProduction(withBank(0))).toBe(null);
  });
});

describe('the boundary is measured on the FROZEN list, not on the input', () => {
  it('counts the leading frozen words that are hers', () => {
    expect(wordBank.personalSpan(['א', 'ב', 'מאגר1', 'מאגר2'], ['א', 'ב'])).toBe(2);
  });

  it('survives her list being deduped by the top-up', () => {
    // "שלום" twice, and "שלום " with a space, are ONE frozen word. Counting her
    // input instead would put the boundary three words into the filler.
    const frozen = ['שלום', 'ריקוד', 'מאגר1', 'מאגר2'];
    const hers = ['שלום', 'שלום ', 'שָלום'.replace('ָ', ''), 'ריקוד'];
    expect(wordBank.personalSpan(frozen, hers)).toBe(2);
  });

  it('is case-insensitive the same way the top-up is', () => {
    expect(wordBank.personalSpan(['Shira', 'pool1'], ['shira'])).toBe(1);
  });

  it('is 0 when nothing of hers survived at the front', () => {
    expect(wordBank.personalSpan(['pool1', 'pool2'], ['שלה'])).toBe(0);
  });
});

describe('the argv', () => {
  it('carries the boundary as one token', () => {
    const args = app.orderArgs({ ...BASE, cardOrder: 'personal-first', personalCount: 240 });
    expect(args).toContain('--order=personal-first');
    expect(args).toContain('--personal-count=240');
  });

  it('says nothing when there is no boundary to say', () => {
    const plain = app.orderArgs(BASE);
    for (const personalCount of [null, undefined, 0, -1, 1.5, '240']) {
      expect(app.orderArgs({ ...BASE, personalCount })).toEqual(plain);
    }
  });

  it('reaches the print shop file too', () => {
    // The press file is the same deck asked for twice; a boundary on one and not
    // the other means the shop prints a different arrangement from the approved.
    const full = { ...BASE, cardOrder: 'personal-first', personalCount: 240 };
    const customer = app.orderArgs({ ...full, outPath: '/tmp/deck.pdf' });
    const press = app.orderArgs({ ...full, outPath: '/tmp/deck.press.partial' });
    expect(press).toContain('--personal-count=240');
    const diffs = customer
      .map((a, i) => [a, press[i]])
      .filter(([a, b]) => a !== b)
      .flat();
    expect(diffs).toEqual(['/tmp/deck.pdf', '/tmp/deck.press.partial']);
  });
});

describe('a real order', () => {
  it('freezes a bank whose count points at the end of HER words', () => {
    // The store side, end to end: what setWordBank keeps is what production
    // reads back.
    const c = db.createCollection('לקוחה');
    const words = Array.from({ length: 412 }, (_, i) => (i < 240 ? 'שלה' + i : 'מאגר' + i));
    db.setWordBank(c.id, { words, personal_count: 240, theme: 'birthday-girls', pool: null });
    const stored = db.getCollection(c.id);
    expect(wordBank.personalCountForProduction(stored)).toBe(240);
    expect(wordBank.wordsForProduction(stored, ['משהו'])).toHaveLength(412);
  });
});
