// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

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
    const got = [0, 3, 99, -8, 'nope', null, undefined, NaN, Infinity, -Infinity].map(
      db.sanitizePlayers
    );
    expect(got).toEqual([4, 4, 16, 4, 4, 4, 4, 4, 4, 4]);
    for (const n of got) expect(n % 4).toBe(0);
  });

  it('rounds a count BETWEEN the steps UP, because a pawn card seats four', () => {
    // Nearest was neither consistent nor explicable: it seated 10 and 13 players
    // on twelve pawns but 14 on sixteen. Up is the only rule that always seats
    // everyone she named — 10 players need three pawn cards, 13 need four.
    expect([5, 9, 10, 13, 14].map(db.sanitizePlayers)).toEqual([8, 12, 12, 16, 16]);
    // It costs her the word cards those seats come out of, so the ROUTE answers
    // with the count it stored and the ceiling that goes with it rather than
    // letting the page go on showing the number she typed.
    for (const n of [5, 10, 13]) {
      expect(db.deckWordsFor({ players: n })).toBe(
        db.deckWordsFor({ players: db.sanitizePlayers(n) })
      );
    }
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

  it('answers with the count it STORED when she asked for one between the steps', async () => {
    // She typed 10. Ten players need three pawn cards, so the stored count is 12
    // and her ceiling is 404 — and the response says so, rather than leaving the
    // page showing 10 over a ceiling it cannot explain.
    const c = db.createCollection('בדיקה', {});
    const r = await setPlayers(c.id, c.owner_token, 10);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ players: 12, pawn_cards: 3, deck_words: 404 });
    expect(db.playersFor(db.getCollection(c.id))).toBe(12);
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

  it('tells the PAGE the number, on both surfaces it counts from', async () => {
    // The counter on site/collect.html still counts to a hardcoded 412; the half
    // that fixes it is a separate change to that file. This pins the server side
    // of the contract so the two meet: the ceiling arrives on the collection the
    // page loads AND on every add it posts, from db.deckWordsFor either way.
    const c = withWords(0, 'מונה');
    await setPlayers(c.id, c.owner_token, 16);

    const loaded = await fetch(
      base + '/api/collections/' + c.id + '?k=' + encodeURIComponent(c.owner_token)
    ).then((r) => r.json());
    expect(loaded).toMatchObject({ players: 16, pawn_cards: 4, deck_words: 400 });

    const added = await fetch(base + '/api/collections/' + c.id + '/words', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: ['מילה'], by: 'בדיקה' }),
    }).then((r) => r.json());
    expect(added.deck_words).toBe(400);
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

// Minimal valid image bytes: extFromMagic needs >= 12 bytes and sniffs the magic
// header, so header + padding is accepted exactly like a real file.
function pngWith(tag) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(String(tag).padEnd(8, '.')),
  ]);
}

function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from('--' + boundary + '\r\n'));
    chunks.push(
      Buffer.from(
        'Content-Disposition: form-data; name="' +
          p.name +
          '"; filename="' +
          p.filename +
          '"\r\nContent-Type: application/octet-stream\r\n\r\n'
      )
    );
    chunks.push(p.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return Buffer.concat(chunks);
}

function postPawns(id, k, files) {
  const boundary = '----dugriPlayers' + Math.random().toString(16).slice(2);
  return fetch(base + '/api/collections/' + id + '/pawns?k=' + encodeURIComponent(k), {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body: buildMultipart(boundary, files),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

// Both clients chunk to PAWN_BATCH_MAX (4): the request body is buffered whole and
// POST /api/collections is public, so ONE request stays pinned to what
// PAWN_UPLOAD_LIMIT is sized for while the COLLECTION's total follows its player
// count. Filling a sixteen-player deck is four requests, not one big one.
async function postPawnsChunked(id, k, files, size = 4) {
  const out = [];
  for (let i = 0; i < files.length; i += size) {
    out.push(await postPawns(id, k, files.slice(i, i + size)));
  }
  return out;
}

const photos = (n, tag) =>
  Array.from({ length: n }, (_, i) => ({
    name: tag + i,
    filename: tag + i + '.png',
    data: pngWith(tag + i),
  }));

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

  it('lets a bigger party UPLOAD more than four — the route, not just the store', async () => {
    // THE STORE CHANGE WAS UNREACHABLE. db.addPawnImages was sized by playersFor,
    // but both HTTP writers still hard-capped at four: a 16-player buyer was 400'd
    // at photo five and ended with four, and build.resolve_photos then filled her
    // other twelve slots by cycling the four shipped Dugri pawns — so pawn cards
    // 2, 3 and 4 printed the same four generic faces over again, on the deck she
    // chose the big split for. A cap only one of two writers holds is not a cap.
    const c = db.createCollection('בדיקה', { players: 16 });
    const rs = await postPawnsChunked(c.id, c.owner_token, photos(16, 'big'));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(db.getCollection(c.id).pawn_images).toHaveLength(16);

    // ...and the ceiling is still a ceiling. A seventeenth is not refused with a
    // status — the batch is legal — it is simply not written, and the answer says
    // which files were left out rather than pretending they landed.
    const over = await postPawns(c.id, c.owner_token, photos(1, 'over'));
    expect(over.status).toBe(200);
    expect(over.body.skipped).toMatchObject([{ reason: 'no_room' }]);
    expect(db.getCollection(c.id).pawn_images).toHaveLength(16);

    // And one request may not carry the whole deck, however much room it has:
    // the body is buffered whole, so the BATCH is capped independently.
    const fat = await postPawns(c.id, c.owner_token, photos(5, 'fat'));
    expect(fat.status).toBe(400);
    expect(fat.body.error).toMatch(/per upload/);
  });

  it('still refuses a fifth photo on a standard four-player deck', async () => {
    const c = db.createCollection('בדיקה', {});
    const first = await postPawns(c.id, c.owner_token, photos(4, 'small'));
    expect(first.status).toBe(200);
    expect(db.getCollection(c.id).pawn_images).toHaveLength(4);

    // The fifth has nowhere to go on a four-player deck, and is reported as
    // skipped rather than silently dropped.
    const fifth = await postPawns(c.id, c.owner_token, photos(1, 'fifth'));
    expect(fifth.status).toBe(200);
    expect(fifth.body.skipped).toMatchObject([{ reason: 'no_room' }]);
    expect(db.getCollection(c.id).pawn_images).toHaveLength(4);
  });

  it('the ADMIN reorder does not delete the photos past four', async () => {
    // adminSetPawnImages is a REPLACE, so a hardcoded four there did not refuse a
    // fifth photo — it DELETED photos 5..16 the moment the owner reordered the
    // first four, silently, from a screen whose only stated job was reordering.
    // That is the same "photos already uploaded are KEPT" this change promises.
    const c = db.createCollection('בדיקה', { players: 16 });
    await postPawnsChunked(c.id, c.owner_token, photos(16, 'adm'));
    const stored = db.getCollection(c.id).pawn_images.slice();
    expect(stored).toHaveLength(16);

    const reversed = stored.slice().reverse();
    expect(db.adminSetPawnImages(c.id, reversed)).toEqual(reversed);
    expect(db.getCollection(c.id).pawn_images).toEqual(reversed);

    // Narrowing on purpose still works — that is what the screen is for.
    expect(db.adminSetPawnImages(c.id, reversed.slice(0, 3))).toHaveLength(3);
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

describe('closing a bigger order freezes the bigger deck', () => {
  // THE PRODUCTION PATH, end to end on the Node side: the owner presses סיום,
  // the freeze runs, and what it stores is what the printer prints. The generator
  // half of the same chain is generator/test_order_to_pdf.py; between them they
  // cover what nothing covered before — reverting generator/order_to_pdf.py in
  // its entirety used to red no test at all.
  const close = (id, token) =>
    fetch(base + '/api/collections/' + id + '/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_token: token }),
    }).then((r) => r.status);

  it('freezes to db.deckWordsFor, not to the standard 412', async () => {
    const c = withWords(120, 'פיון');
    await setPlayers(c.id, c.owner_token, 16);
    expect(db.deckWordsFor(db.getCollection(c.id))).toBe(400);

    expect(await close(c.id, c.owner_token)).toBe(200);
    const bank = db.getCollection(c.id).word_bank;
    if (!bank) return; // no python on this box — freeze is best-effort by design
    // 400, not 412. Twelve filler words fewer, which is the trade she made; her
    // own 120 are all still there, in front, because the trade is never hers.
    expect(bank.words).toHaveLength(400);
    expect(bank.deck_words).toBe(400);
    expect(bank.personal_count).toBe(120);
  });

  it('still freezes the standard 412 for a standard order', async () => {
    const c = withWords(120, 'רגיל');
    expect(await close(c.id, c.owner_token)).toBe(200);
    const bank = db.getCollection(c.id).word_bank;
    if (!bank) return;
    expect(bank.words).toHaveLength(412);
  });
});

describe('the number the waiting screen shows', () => {
  it('counts the PAWN cards too', () => {
    // It said ceil(words / 4) — 103 for the standard 104-card deck, which was
    // already one short on main, and would have gone on saying 103 for the
    // 107-card one. She is watching Chrome render every card in the deck, pawn
    // cards included.
    const c = withWords(412, 'ספירה');
    expect(app.cardEstimate(db.getCollection(c.id))).toBe(104);

    const big = withWords(400, 'גדול');
    db.getCollection(big.id).players = 16;
    expect(app.cardEstimate(db.getCollection(big.id))).toBe(104);
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
