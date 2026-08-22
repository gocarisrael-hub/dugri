// @vitest-environment node
// AN AUTHORED LIST KEEPS ITS REPEATS.
//
// A customer who writes her list in FOURS is not sending a word pool, she is
// sending the CARDS: "אושפלאו · בשר · אורז · שישי" is one card she composed. Then
// a clue reused on another card ("אוכל" on the food card and again on the
// Friday-dinner card) is deliberate, and dropping it does not shorten her list by
// one — it shifts every card after the first repeat and rewrites the rest of the
// deck. The owner hit this on a real 108-card list: 433 entries went in and 307
// came out, and cards 2..108 were no longer the ones she wrote.
//
// The switch is the ORDER she already picks per order: `exact` means her
// arrangement is authoritative, and her repeats are part of that arrangement.
// Everywhere else a repeat is still a slip — two contributors sending the same
// word — and two identical words on one card is a printed mistake.
//
// The same rule has to hold at all three layers or they disagree about what the
// deck is: this file covers the STORE; generator/test_card_order.py covers the
// packer and the top-up.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let dir;
let db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-authored-'));
  process.env.DATA_DIR = dir;
  for (const f of ['db.js', 'settings.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  // The free-word quota is not what these tests are about; a 400-word authored
  // list would otherwise be refused at word 21.
  settings.set('pricing', 'lock_after_free_limit', false);
  db = require(path.join(serverDir, 'db.js'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const words = (id) => db.listWords(id).map((w) => w.text);

function authored() {
  const c = db.createCollection('סבתא', { theme: 'birthday-girls' });
  db.adminUpdateCollection(c.id, { card_order: 'exact' });
  return c;
}

describe('a normal collection', () => {
  it('still drops a repeat — there it is a slip', () => {
    const c = db.createCollection('רגילה', { theme: 'birthday-girls' });
    const r = db.addWords(c.id, ['אוכל', 'גינה', 'אוכל']);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(1);
    expect(words(c.id)).toEqual(['אוכל', 'גינה']);
  });

  it('drops it across separate batches too', () => {
    const c = db.createCollection('רגילה2', { theme: 'birthday-girls' });
    db.addWords(c.id, ['אוכל']);
    expect(db.addWords(c.id, ['אוכל']).skipped).toBe(1);
    expect(words(c.id)).toEqual(['אוכל']);
  });
});

describe('an authored list (card_order = exact)', () => {
  it('keeps a repeat, in the place she put it', () => {
    const c = authored();
    const r = db.addWords(c.id, ['אוכל', 'גינה', 'אוכל']);
    expect(r.added).toBe(3);
    expect(r.skipped).toBe(0);
    expect(words(c.id)).toEqual(['אוכל', 'גינה', 'אוכל']);
  });

  it('keeps her cards intact, four by four', () => {
    const c = authored();
    const cards = [
      ['אושפלאו', 'בשר', 'אורז', 'שישי'],
      ['ארוחת שישי', 'אוכל', 'משפחה', 'מסורת'],
      ['שמן באוכל', 'בישול', 'אוכל', 'ארוחת שישי'],
    ];
    db.addWords(c.id, cards.flat());
    // Every entry survives, so card N is still the four she wrote as card N.
    expect(words(c.id)).toEqual(cards.flat());
    expect(db.countWords(c.id)).toBe(12);
  });

  it('keeps repeats across batches, not just within one', () => {
    const c = authored();
    db.addWords(c.id, ['אוכל', 'גינה']);
    expect(db.addWords(c.id, ['אוכל']).added).toBe(1);
    expect(words(c.id)).toEqual(['אוכל', 'גינה', 'אוכל']);
  });

  it('still refuses what is refused for everyone', () => {
    // The exemption is about REPEATS, not about the rules that keep a card
    // printable: an emoji, pointed Hebrew and an over-length entry are still out.
    const c = authored();
    const r = db.addWords(c.id, ['בסדר', '🎉', 'שָׁלוֹם', 'x'.repeat(200)]);
    expect(r.added).toBe(1);
    expect(r.emoji).toBe(1);
    expect(r.niqqud).toBe(1);
    expect(r.tooLong).toBe(1);
    expect(words(c.id)).toEqual(['בסדר']);
  });

  it('goes back to dropping repeats if the order is changed away from exact', () => {
    // The switch is read when the words arrive, so this is about the NEXT batch:
    // what is already stored stays as she sent it.
    const c = authored();
    db.addWords(c.id, ['אוכל', 'אוכל']);
    db.adminUpdateCollection(c.id, { card_order: 'random' });
    expect(db.addWords(c.id, ['אוכל']).skipped).toBe(1);
    expect(words(c.id)).toEqual(['אוכל', 'אוכל']);
  });
});
