// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// HOW MANY PLAYERS THE DECK IS LAID OUT FOR.
//
// The deck is always 104 cards. Four players fill one pawn card, and each pawn
// card costs a word card — four words. So the buyer's word ceiling is not a
// constant any more, it is a function of a choice she makes in the pawns step:
//
//     4 players   1 pawn card   103 word cards   412 words
//     8 players   2 pawn cards  102 word cards   408 words
//    12 players   3 pawn cards  101 word cards   404 words
//    16 players   4 pawn cards  100 word cards   400 words
//
// This file covers the store and the route. The deck itself is
// generator/test_pack.py and generator/test_build_deck.py; the two are a pair,
// and the arithmetic is duplicated on purpose so a change to one fails here.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let db;
let app;
let server;
let base;
let dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-players-'));
  process.env.DATA_DIR = dataDir;
  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setPlayers(id, k, players) {
  return fetch(base + '/api/collections/' + id + '/players?k=' + encodeURIComponent(k), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ players }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

function withWords(n, tag) {
  const c = db.createCollection('בדיקה', { theme: 'bachelorette' });
  // Past the free quota, which is a different gate with a different answer and
  // not what this file is about: an unpaid collection stops at 20 words, and
  // every ceiling here is in the hundreds.
  db.getCollection(c.id).free_limit_applies = false;
  if (n > 0) {
    db.addWords(
      c.id,
      Array.from({ length: n }, (_, i) => tag + i),
      'בדיקה'
    );
  }
  return c;
}

describe('the deck split', () => {
  it('is four players and one pawn card unless she says otherwise', () => {
    const c = db.createCollection('בדיקה', {});
    expect(c.players).toBe(4);
    expect(db.playersFor(c)).toBe(4);
    expect(db.pawnCardsFor(c)).toBe(1);
    expect(db.deckWordsFor(c)).toBe(412);
  });

  it('costs exactly one word card per four players', () => {
    for (const [players, cards, words] of [
      [4, 1, 412],
      [8, 2, 408],
      [12, 3, 404],
      [16, 4, 400],
    ]) {
      const c = { players };
      expect(db.pawnCardsFor(c)).toBe(cards);
      expect(db.deckWordsFor(c)).toBe(words);
      // …and the deck itself never changes size.
      expect(cards + words / 4).toBe(db.DECK_CARDS);
    }
  });

  it('reads an order placed before the choice existed as the standard deck', () => {
    // No `players` key at all — every collection in the store today.
    expect(db.deckWordsFor({})).toBe(db.DECK_WORDS);
    expect(db.playersFor({})).toBe(4);
  });

  it('coerces anything unusable to a legal count', () => {
    const got = [0, 3, 5, 13, 99, -8, 'nope', null, undefined, NaN].map(db.sanitizePlayers);
    expect(got).toEqual([4, 4, 4, 12, 16, 4, 4, 4, 4, 4]);
    for (const n of got) expect(n % 4).toBe(0);
  });
});

describe('PUT /api/collections/:id/players', () => {
  it('is the OWNER’s alone', async () => {
    const c = db.createCollection('בדיקה', {});
    expect((await setPlayers(c.id, 'not-her-token', 8)).status).toBe(403);
    // An unknown id answers the same, so the route cannot be used to learn which
    // collection ids exist.
    expect((await setPlayers('no-such-collection', 'whatever', 8)).status).toBe(403);
  });

  it('stores the count and answers with what it leaves for words', async () => {
    const c = db.createCollection('בדיקה', {});
    const r = await setPlayers(c.id, c.owner_token, 12);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ players: 12, pawn_cards: 3, deck_words: 404 });
    expect(db.playersFor(db.getCollection(c.id))).toBe(12);
  });

  it('refuses once the collection is closed, like the title and the pawn views', async () => {
    const c = db.createCollection('בדיקה', {});
    db.closeCollection(c.id, c.owner_token);
    const r = await setPlayers(c.id, c.owner_token, 8);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('closed');
    expect(db.playersFor(db.getCollection(c.id))).toBe(4);
  });
});

describe('raising the count when the words are already in', () => {
  it('refuses, and says how many to delete', async () => {
    // 410 words: fits the standard deck (412), not a 12-player one (404).
    const c = withWords(410, 'מילה');
    const r = await setPlayers(c.id, c.owner_token, 12);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      error: 'words',
      players: 12,
      pawn_cards: 3,
      deck_words: 404,
      words: 410,
      remove: 6,
      current: 4,
    });
    // …and nothing moved.
    expect(db.playersFor(db.getCollection(c.id))).toBe(4);
  });

  it('the number it asks for is exactly the number that makes it fit', async () => {
    const c = withWords(410, 'שוב');
    const refused = await setPlayers(c.id, c.owner_token, 12);
    const words = db.listWords(c.id).slice(0, refused.body.remove);
    for (const w of words) db.deleteWord(c.id, w.id, c.owner_token);
    const r = await setPlayers(c.id, c.owner_token, 12);
    expect(r.status).toBe(200);
    expect(r.body.players).toBe(12);
  });

  it('lets her go right up to the new ceiling but not one word past it', async () => {
    const exact = withWords(408, 'בדיוק');
    expect((await setPlayers(exact.id, exact.owner_token, 8)).status).toBe(200);

    const over = withWords(409, 'אחת-יותר');
    const r = await setPlayers(over.id, over.owner_token, 8);
    expect(r.status).toBe(409);
    expect(r.body.remove).toBe(1);
  });

  it('never refuses LOWERING the count — fewer pawns is more room', async () => {
    const c = withWords(0, 'ריק');
    db.getCollection(c.id).free_limit_applies = false;
    await setPlayers(c.id, c.owner_token, 16);
    db.addWords(
      c.id,
      Array.from({ length: 400 }, (_, i) => 'מ' + i),
      'בדיקה'
    );
    const r = await setPlayers(c.id, c.owner_token, 4);
    expect(r.status).toBe(200);
    expect(db.deckWordsFor(db.getCollection(c.id))).toBe(412);
  });
});

describe('the word ceiling follows the split', () => {
  it('stops accepting words at THIS deck’s size, not the standard one', async () => {
    const c = db.createCollection('בדיקה', {});
    db.getCollection(c.id).free_limit_applies = false;
    await setPlayers(c.id, c.owner_token, 16); // 400 words
    const r = db.addWords(
      c.id,
      Array.from({ length: 405 }, (_, i) => 'מילה' + i),
      'בדיקה'
    );
    expect(db.countWords(c.id)).toBe(400);
    // Refused for the DECK being full, which is a different answer from the
    // payment quota and says so.
    expect(r.full).toBe(5);
  });

  it('grandfathers a list already past the new ceiling rather than trimming it', () => {
    // The words are her guests'. A count she can no longer reach is refused at
    // the door (above); one already stored is never deleted to make room.
    const c = withWords(412, 'ותיק');
    c.players = 16; // as if set before the guard existed
    expect(db.countWords(c.id)).toBe(412);
    expect(db.deckWordsFor(c)).toBe(400);
  });
});

describe('the photo slots follow the split too', () => {
  it('accepts as many photos as she has players', () => {
    const c = db.createCollection('בדיקה', {});
    const paths = Array.from(
      { length: 10 },
      (_, i) => '/content-uploads/' + String(i).padStart(16, 'a') + '.png'
    );
    db.addPawnImages(c.id, c.owner_token, paths);
    expect(db.getCollection(c.id).pawn_images).toHaveLength(4);

    const big = db.createCollection('בדיקה', { players: 12 });
    db.addPawnImages(big.id, big.owner_token, paths);
    expect(db.getCollection(big.id).pawn_images).toHaveLength(10);
  });

  it('keeps photos she already sent when the count comes back down', async () => {
    const c = db.createCollection('בדיקה', { players: 8 });
    const paths = Array.from(
      { length: 8 },
      (_, i) => '/content-uploads/' + String(i).padStart(15, 'b') + '1.png'
    );
    db.addPawnImages(c.id, c.owner_token, paths);
    expect(db.getCollection(c.id).pawn_images).toHaveLength(8);
    await setPlayers(c.id, c.owner_token, 4);
    // Still all eight on record — the deck prints the first four, and she gets
    // the rest back the moment she changes her mind. A slider does not delete a
    // customer's photographs.
    expect(db.getCollection(c.id).pawn_images).toHaveLength(8);
  });
});

describe('what the generator is told', () => {
  const BASE = {
    theme: 'bachelorette',
    name: 'Shira',
    wordsFile: '/tmp/w.txt',
    outPath: '/tmp/out.pdf',
  };

  it('is the number of PAWN CARDS, not players', () => {
    const args = app.orderArgs({ ...BASE, pawnCards: 3 });
    const i = args.indexOf('--pawn-cards');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('3');
  });

  it('says nothing at all for a standard deck', () => {
    // An order placed before the choice existed produces byte-for-byte the argv
    // it always did.
    expect(app.orderArgs({ ...BASE, pawnCards: 1 })).toEqual(app.orderArgs(BASE));
    expect(app.orderArgs(BASE)).not.toContain('--pawn-cards');
  });
});
