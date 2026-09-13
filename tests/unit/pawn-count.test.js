// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// THE "HOW MANY PLAYERS?" CONTROL, in the wizard's pawns step.
//
// The deck is always 104 cards. Four players fill one pawn card, and each pawn
// card comes out of the word cards' share — four words. The page has to say the
// same thing about that as the server does, and it cannot fetch it: the wizard
// has no collection yet, so the arithmetic is written out in site/options.html.
//
// Which is exactly why this file exists. Every number the buyer is shown is
// checked against server/db.js's own, so the two cannot drift into a page that
// promises room the deck does not have.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const db = require(path.join(root, 'server', 'db.js'));

const html = fs.readFileSync(path.join(root, 'site', 'options.html'), 'utf8');

// The wizard is one enormous inline script; pulling the few declarations this
// covers out of it beats booting the whole page in jsdom (which wants fetch,
// feature flags and a design catalogue before it will run at all).
function wizardValue(name) {
  const m = html.match(new RegExp('const ' + name + ' = ([^;]+);'));
  if (!m) throw new Error('site/options.html no longer declares ' + name);
  return JSON.parse(m[1].replace(/'/g, '"'));
}

const DECK_CARDS = wizardValue('DECK_CARDS');
const PER_CARD = wizardValue('PER_CARD');
const PLAYER_COUNTS = wizardValue('PLAYER_COUNTS');

// site/options.html's pawnPlan, transcribed. Kept deliberately close to the page
// so a change there is visible as a diff against this.
function plan(players) {
  const cards = players / PER_CARD;
  return {
    players,
    cards,
    wordCards: DECK_CARDS - cards,
    words: (DECK_CARDS - cards) * PER_CARD,
  };
}

describe('the wizard and the server agree about the deck', () => {
  it('offers exactly the counts the server accepts', () => {
    expect(PLAYER_COUNTS[0]).toBe(db.PLAYERS_MIN);
    expect(PLAYER_COUNTS[PLAYER_COUNTS.length - 1]).toBe(db.PLAYERS_MAX);
    // Every step is a whole pawn card — half a card has nowhere to print.
    for (const n of PLAYER_COUNTS) expect(n % PER_CARD).toBe(0);
    // …and the server would not move any of them.
    for (const n of PLAYER_COUNTS) expect(db.sanitizePlayers(n)).toBe(n);
  });

  it('counts the deck the same way', () => {
    expect(DECK_CARDS).toBe(db.DECK_CARDS);
    for (const n of PLAYER_COUNTS) {
      expect(plan(n).cards).toBe(db.pawnCardsFor({ players: n }));
      expect(plan(n).words).toBe(db.deckWordsFor({ players: n }));
    }
  });

  it('never shows a ceiling the deck cannot hold', () => {
    // The one failure that matters: a page promising room the server will refuse.
    for (const n of PLAYER_COUNTS) {
      expect(plan(n).words).toBeLessThanOrEqual(db.deckWordsFor({ players: n }));
    }
  });

  it('is the standard deck at its default', () => {
    expect(plan(PLAYER_COUNTS[0]).words).toBe(db.DECK_WORDS);
    expect(plan(PLAYER_COUNTS[0]).cards).toBe(1);
  });

  it('costs exactly one word card — four words — per four players', () => {
    for (let i = 1; i < PLAYER_COUNTS.length; i++) {
      const before = plan(PLAYER_COUNTS[i - 1]);
      const after = plan(PLAYER_COUNTS[i]);
      expect(after.players - before.players).toBe(PER_CARD);
      expect(after.cards - before.cards).toBe(1);
      expect(before.words - after.words).toBe(PER_CARD);
    }
  });

  it('keeps the deck the same size at every count', () => {
    for (const n of PLAYER_COUNTS) {
      expect(plan(n).cards + plan(n).wordCards).toBe(DECK_CARDS);
    }
  });
});

describe('the step is built for the biggest deck', () => {
  it('sizes its slot arrays to the largest count, not to four', () => {
    // The arrays hold every slot the biggest deck can take, so switching counts
    // moves no state: a photo in slot 6 is still there after a trip down to 4
    // and back up to 12.
    expect(html).toMatch(/const PAWN_MAX = PLAYER_COUNTS\[PLAYER_COUNTS\.length - 1\]/);
  });

  it('ships four slots in the markup and clones the rest', () => {
    // One definition of what a slot is. Four are written out (the default deck
    // renders without JS having to build anything); the other twelve are copies.
    const slots = html.match(/<label class="pawn-slot"/g) || [];
    expect(slots).toHaveLength(db.PLAYERS_MIN);
    expect(html).toContain('growPawnGrid');
  });

  it('sends only the slots this deck has', () => {
    // She may have filled eight and gone back to four. The deck prints four, so
    // four is what is uploaded — and which four is hers to see, not whichever
    // arrived first.
    expect(html).toMatch(/pawnFiles\s*\n?\s*\.slice\(0, pawnPlayers\)/);
  });

  it('sends the count with the order, not after it', () => {
    // So her word ceiling is right from the first word rather than moved under
    // her once the list has started.
    expect(html).toMatch(/players: pawnPlayers,/);
  });
});
