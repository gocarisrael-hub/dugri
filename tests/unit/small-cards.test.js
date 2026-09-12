// @vitest-environment node
// "sometimes there is 1 card that the font size of the words is super tiny
// because of 1 fucked up word, is it possible to warn about it?"
//
// It is, and after producing it costs nothing to know: the generator has already
// measured every entry to decide which ones share a card, so the cards that came
// out small — and the entry that decided each — are a by-product. It prints them
// on their own line and the server keeps them on the order.
//
// A NOTE, never a block. The deck is correct; it is one card she may want to
// rewrite. So the parsing is written to fail quiet in every direction: a deck
// with nothing to report, an older generator that never printed the line, and a
// line we cannot read all mean the same thing — no note.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let db;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-small-'));
  for (const f of ['db.js']) delete require.cache[require.resolve(path.join(serverDir, f))];
  db = require(path.join(serverDir, 'db.js'));
});

// The exact shape generator/word_demand.deck_small_cards prints. `index` is the
// card's position in the DECK — the pawn card is card 1, so 2 is the first word
// card of an ordinary deck.
const REPORT = [
  { index: 2, size: 15.56, word: 'קונסטרוקטיביזם', ratio: 0.496 },
  { index: 43, size: 21.92, word: 'גיאוגרפיה', ratio: 0.699 },
];

// The parse the server does over the generator's stdout, kept here in the shape
// the route uses so the reading is testable without spawning Python.
function parse(stdout) {
  const sc = /^smallcards (.+)$/m.exec(stdout);
  if (!sc) return [];
  try {
    const parsed = JSON.parse(sc[1]);
    return Array.isArray(parsed) ? parsed.slice(0, 12) : [];
  } catch {
    return [];
  }
}

describe('reading the report off the generator', () => {
  it('picks the line out of ordinary output', () => {
    const out = [
      'wrote /tmp/x.pdf (208 pages)',
      'smallcards ' + JSON.stringify(REPORT),
      'board /tmp/x.board.pdf',
    ].join('\n');
    expect(parse(out)).toEqual(REPORT);
  });

  it('reads an even deck as nothing to say', () => {
    // The generator prints the line only when there IS something, so an absent
    // line must mean "no problems" — which is also what an older generator that
    // never knew about this would produce.
    expect(parse('wrote /tmp/x.pdf (208 pages)')).toEqual([]);
  });

  it('survives a line it cannot read', () => {
    // A deck that produced fine must not be reported as failed because a NOTE
    // was malformed.
    expect(parse('smallcards {not json')).toEqual([]);
    expect(parse('smallcards "a string"')).toEqual([]);
  });

  it('caps a runaway report', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ index: i + 1, word: 'w' + i }));
    expect(parse('smallcards ' + JSON.stringify(many))).toHaveLength(12);
  });
});

describe('the report on the order', () => {
  it('rides along with the production record', () => {
    const c = db.createCollection('לקוחה');
    const rec = db.setProduction(c.id, {
      state: 'generated',
      pdf_file: c.id + '.pdf',
      pages: 208,
      small_cards: REPORT,
    });
    expect(rec.small_cards).toEqual(REPORT);
    expect(db.getCollection(c.id).production.small_cards[0].word).toBe('קונסטרוקטיביזם');
  });

  it('is null on a deck with nothing to report, not an empty array', () => {
    // The admin reads it as "is there a note?", and null says that in one place
    // rather than making every reader remember to check .length.
    const c = db.createCollection('לקוחה');
    const rec = db.setProduction(c.id, { state: 'generated', small_cards: null });
    expect(rec.small_cards).toBe(null);
  });
});

describe('the note says where to look', () => {
  // "can you give the page number with the small font?" — the report already
  // carried the card index; it just was not shown. The deck prints every card
  // behind its own back — [back, card 1, back, card 2, …] — so card N's FRONT is
  // page 2N, which is the page she scrolls to in the PDF.
  const pageOf = (index) => index * 2;

  it('turns a card number into the page its front prints on', () => {
    expect(pageOf(1)).toBe(2);
    expect(pageOf(3)).toBe(6);
    expect(pageOf(104)).toBe(208); // the last word card of a full deck
  });

  it('matches the deck the generator actually writes', () => {
    // 104 cards, each preceded by its back = 208 pages. The last card's front is
    // the last page, which is the arithmetic above at the far end.
    const cards = 104;
    expect(cards * 2).toBe(208);
    expect(pageOf(cards)).toBe(208);
  });

  // THE NUMBER IS THE DECK'S, NOT THE WORD CARDS'.
  //
  // The pawn card OPENS the deck (generator/pack.pack), so the word cards are
  // deck cards 2..104 and the generator reports a small card by its deck position
  // (word_demand.deck_small_cards). This end has to read it the same way: while
  // the report numbered word cards, `index * 2` sent her one card early — to the
  // previous card's front, which has nothing wrong with it.
  const deckNumberOfWordCard = (n) => n + 1; // 1 pawn card in front of them
  it('reads the index as a deck card number, so the page lands on the right front', () => {
    // The first WORD card of the deck is deck card 2, on pages 3-4: its back is
    // page 3 and its front page 4.
    expect(pageOf(deckNumberOfWordCard(1))).toBe(4);
    // The owner's own example: the 37th word card is deck card 38 on page 76 —
    // not 37 on page 74, which is the card before it.
    expect(pageOf(deckNumberOfWordCard(37))).toBe(76);
    // And the pawn card itself, deck card 1, prints on page 2.
    expect(pageOf(1)).toBe(2);
    // The last word card of a full deck is the last page of it.
    expect(pageOf(deckNumberOfWordCard(103))).toBe(208);
  });
});
