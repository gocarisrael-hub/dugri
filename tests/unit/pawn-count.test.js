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
  // THE ONE THING SOURCE TEXT IS GOOD FOR. Everything else this file used to
  // assert about site/options.html — `players: pawnPlayers,`, a `.slice(0,
  // pawnPlayers)` spelled exactly that way, the string 'growPawnGrid' — was shape,
  // not behaviour: a rename or a Prettier reflow reds it, and a behaviour change
  // that keeps the text passes. Those moved to where they can actually fail for
  // the right reason: the browser (tests/e2e/pawn-photos.spec.js drives the real
  // control, the real upload and the real order) and the server
  // (tests/unit/pawn-images.test.js drives the routes over HTTP).
  //
  // What stays here is the markup CONTRACT that no runtime test can see: the step
  // ships the default deck's slots as real HTML, so a browser that never runs the
  // clone loop still shows a usable step.
  it('ships the standard deck as markup and grows the rest', () => {
    const slots = html.match(/<label class="pawn-slot"/g) || [];
    expect(slots).toHaveLength(db.PLAYERS_MIN);
  });

  // …and that JS never writes the two nodes the OWNER owns. The content editor
  // applies her wording once, on load; anything that rewrites a [data-edit] node
  // afterwards throws it away, silently, which is exactly what tapping a count
  // button used to do to both of these. The e2e proves the behaviour in a browser;
  // this is the cheap tripwire on the way back in.
  it('never writes the owner-editable copy from the count renderer', () => {
    const fn = html.slice(
      html.indexOf('function renderPawnCount()'),
      html.indexOf('function renderPawnSlot(')
    );
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).not.toContain('options-photos-title');
    expect(fn).not.toContain('pawn-cut');
  });
});
