// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// THE LIVE PAWN CARD — GET /api/collections/:id/pawn-card?live=1&n=N.
//
// The collection page draws the buyer's photos onto the card ITSELF, so what it
// asks the server for is the card WITHOUT them. "Without her photos" is not "with
// four empty discs": the printed card tops a short list up from the shipped Dugri
// pawns, so an order with two photos prints two faces and two pawns. A base card
// with four bare discs therefore promised her an empty circle where a pawn
// prints, under a caption reading "this is exactly how the card will be printed".
//
// `n` is how many discs the page will cover; the generator leaves those bare and
// fills the rest. That makes it part of the picture, so it is also part of the
// CACHE KEY — a photo added or removed has to re-render, while one cached card
// per (design, count) is what keeps the render out of the drag loop.
//
// The generator is stubbed by a fake PYTHON that records its argv: the picture is
// the generator's job (generator/test_preview_pawn_card.py pins that the pawns
// land in the right slots), and what this file holds is the glue in between —
// which is exactly where a count can be dropped without anything going red.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let db;
let server;
let base;
let dataDir;
let argvLog;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pawn-live-'));
  argvLog = path.join(dataDir, 'argv.log');
  // A stand-in for python3 itself: it is handed preview.py and its arguments
  // exactly as the real interpreter is, writes the PNG the route expects to read
  // back, and prints the JSON preview.py prints — so the route's happy path runs
  // for real. Everything it was ASKED goes to a log this test then reads.
  const stub = path.join(dataDir, 'fake-python');
  fs.writeFileSync(
    stub,
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
// argv: [preview.py, theme, name, outDir, ...flags] — the CLI's own order.
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + '\\n');
const outDir = argv[3];
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'pawns-empty.png');
fs.writeFileSync(
  out,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64'
  )
);
process.stdout.write(JSON.stringify({
  pawns: out,
  slots: [{ n: 1, x: 0, y: 0, w: 0.3, h: 0.2 }],
  viewBox: [0, 0, 223.92, 312],
  disc_fill: 0.9,
  filter: '<filter id="sticker-halo"><feMorphology radius="1.5"/></filter>',
}));
`
  );
  fs.chmodSync(stub, 0o755);
  process.env.DATA_DIR = dataDir;
  process.env.PYTHON = stub;
  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  db = require(path.join(serverDir, 'db.js'));
  const app = require(path.join(serverDir, 'index.js'));
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
  delete process.env.PYTHON;
});

beforeEach(() => {
  fs.writeFileSync(argvLog, '');
});

function runs() {
  return fs
    .readFileSync(argvLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// A flag's value as the child was given it, or null when it was not asked for.
function argOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i < 0 ? null : argv[i + 1];
}
const drawnOf = (argv) => argOf(argv, '--drawn');

async function askLive(id, k, n, card) {
  let q = n == null ? '' : '&n=' + encodeURIComponent(n);
  if (card != null) q += '&card=' + encodeURIComponent(card);
  const r = await fetch(
    base + '/api/collections/' + id + '/pawn-card?live=1' + q + '&k=' + encodeURIComponent(k)
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

describe('the live pawn card carries the pawns the page will not draw', () => {
  it('passes the disc count straight through to the generator', async () => {
    const c = db.createCollection('בדיקה', { theme: 'grapefruit' });
    const r = await askLive(c.id, c.owner_token, 2);
    expect(r.status).toBe(200);
    expect(r.body.card).toMatch(/^data:image\/png/);
    const argv = runs();
    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain('--no-photos');
    expect(drawnOf(argv[0])).toBe('2');
    // …and nothing of HERS goes with it: this render is the card alone, which is
    // what lets one picture serve every buyer on that design with that count.
    expect(argv[0]).not.toContain('--photo');
    // …which is why it is cached on the DESIGN and the count alone: a second
    // buyer on the same design with the same number of photos is looking at the
    // same picture, and pays nothing for it.
    const other = db.createCollection('בדיקה', { theme: 'grapefruit' });
    expect((await askLive(other.id, other.owner_token, 2)).status).toBe(200);
    expect(runs()).toHaveLength(1);
  });

  it('re-renders when the count changes, and only then', async () => {
    // Its own design, so the cache above (which is shared, and rightly) cannot
    // answer for it and hide the very thing this is testing.
    const c = db.createCollection('בדיקה', { theme: 'bachelorette' });
    await askLive(c.id, c.owner_token, 1);
    await askLive(c.id, c.owner_token, 1);
    // The same card twice: one render, and the second answer came from the cache.
    expect(runs()).toHaveLength(1);
    // A photo added or removed IS a different card — one more pawn on it, or one
    // fewer — so it must not be served from the entry above.
    await askLive(c.id, c.owner_token, 2);
    expect(runs().map(drawnOf)).toEqual(['1', '2']);
    // …and the first count is still cached, so going back is free.
    await askLive(c.id, c.owner_token, 1);
    expect(runs()).toHaveLength(2);
  });

  it('holds the count inside the four slots the card has', async () => {
    const c = db.createCollection('בדיקה', { theme: 'japanese' });
    // A number out of range is not an error — it is a query string, and anyone
    // with the owner link can type one. It is clamped to what a card can hold, so
    // the worst it can do is ask for a picture that already exists.
    await askLive(c.id, c.owner_token, 9);
    await askLive(c.id, c.owner_token, -3);
    await askLive(c.id, c.owner_token, 'לא מספר');
    // …and no `n` at all means no photos, which is the full generic set of pawns.
    await askLive(c.id, c.owner_token);
    // Two distinct cards behind those four asks: the clamped 4, and 0 three times.
    expect(runs().map(drawnOf)).toEqual(['4', '0']);
  });

  it("hands the page the card's sticker spec with the picture", async () => {
    const c = db.createCollection('בדיקה', { theme: 'birthday-girls' });
    const r = await askLive(c.id, c.owner_token, 1);
    // The page draws her photos through the card's OWN halo filter, in the
    // card's own units — so the spec has to reach it, not stop at the route.
    expect(r.body.viewBox).toEqual([0, 0, 223.92, 312]);
    expect(r.body.disc_fill).toBe(0.9);
    expect(r.body.filter).toContain('id="sticker-halo"');
  });
});

// A BIGGER DECK DEALS THE SHIPPED PAWNS ACROSS ALL OF ITS CARDS. `n` is how many
// of her photos the whole deck carries and `card` which pawn card to draw, so the
// generator can cut that card out of the deck's own deal (build.card_photo_plan):
// card 2 of an eight-player order with two photos carries pawns 3, 4, 1, 2.
describe('each pawn card of a bigger deck is its own picture', () => {
  it('names the card and the deck, and holds the count to the deck', async () => {
    const c = db.createCollection('בדיקה', { theme: 'football-boys', players: 8 });
    await askLive(c.id, c.owner_token, 2, 1);
    await askLive(c.id, c.owner_token, 99, 7);
    const [a, b] = runs();
    expect([argOf(a, '--cards'), argOf(a, '--card'), argOf(a, '--drawn')]).toEqual(['2', '1', '2']);
    // Past the end on both: the last card, and every slot of the deck taken.
    expect([argOf(b, '--card'), argOf(b, '--drawn')]).toEqual(['1', '8']);
  });

  it('caches each card on its own', async () => {
    const c = db.createCollection('בדיקה', { theme: 'trip comeback', players: 12 });
    await askLive(c.id, c.owner_token, 5, 0);
    await askLive(c.id, c.owner_token, 5, 1);
    await askLive(c.id, c.owner_token, 5, 0);
    expect(runs().map((a) => argOf(a, '--card'))).toEqual(['0', '1']);
  });
});

// THE WIZARD'S BASE CARD — before any order exists, so there is no owner token
// and nothing of hers in it: a design, a deck size, a card and a count.
describe('GET /api/pawn-base', () => {
  const askBase = async (q) => {
    const r = await fetch(base + '/api/pawn-base?' + q);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  it('renders the deal for a design with no order at all', async () => {
    const r = await askBase('theme=japanese&players=12&card=2&n=5');
    expect(r.status).toBe(200);
    expect(r.body.card).toMatch(/^data:image\/png/);
    expect(r.body.filter).toContain('sticker-halo');
    const [argv] = runs();
    expect([argOf(argv, '--cards'), argOf(argv, '--card'), argOf(argv, '--drawn')]).toEqual([
      '3',
      '2',
      '5',
    ]);
    // No title and no photos: the tiles show the slots alone.
    // argv is [preview.py, theme, name, outDir, ...]: the name is empty.
    expect(argv[2]).toBe('');
    expect(argv).not.toContain('--photo');
    expect(argv.some((a) => a.startsWith('--title'))).toBe(false);
  });

  it('is one picture for every buyer asking the same question', async () => {
    await askBase('theme=anniversary&players=4&n=1');
    await askBase('theme=anniversary&players=4&n=1');
    expect(runs()).toHaveLength(1);
  });

  it('refuses a design it does not know, without rendering', async () => {
    expect((await askBase('theme=nope&players=4')).status).toBe(400);
    expect(runs()).toHaveLength(0);
  });
});
