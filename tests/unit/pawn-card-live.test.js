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
  fallbacks: ['data:image/svg+xml;base64,PHN2Zy8+', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
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

describe('the live pawn card is the design with every disc bare', () => {
  it('asks the generator for the bare card, and nothing of hers', async () => {
    const c = db.createCollection('בדיקה', { theme: 'grapefruit' });
    const r = await askLive(c.id, c.owner_token, 2);
    expect(r.status).toBe(200);
    expect(r.body.card).toMatch(/^data:image\/png/);
    const argv = runs();
    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain('--no-photos');
    // All four discs bare: the page draws her photos AND the shipped pawns.
    expect(drawnOf(argv[0])).toBe('4');
    expect(argv[0]).not.toContain('--photo');
    // …which is why a second buyer on the same design pays nothing for it.
    const other = db.createCollection('בדיקה', { theme: 'grapefruit' });
    expect((await askLive(other.id, other.owner_token, 3)).status).toBe(200);
    expect(runs()).toHaveLength(1);
  });

  it('is ONE render whatever her photo count and deck size', async () => {
    // Its own design, so the cache above cannot answer for it. Every photo she
    // added used to be a new Chrome run on the server, per pawn card; the page
    // deals the pawns itself now, so none of these may render twice.
    const c = db.createCollection('בדיקה', { theme: 'bachelorette', players: 16 });
    for (const [n, card] of [
      [0, 0],
      [1, 0],
      [5, 1],
      [16, 3],
      ['לא מספר', 9],
    ]) {
      expect((await askLive(c.id, c.owner_token, n, card)).status).toBe(200);
    }
    expect(runs()).toHaveLength(1);
  });

  it("hands the page the card's sticker spec and its shipped pawns", async () => {
    const c = db.createCollection('בדיקה', { theme: 'birthday-girls' });
    const r = await askLive(c.id, c.owner_token, 1);
    // The page draws through the card's OWN halo filter, in the card's own units,
    // and deals the pawns out of the list the card came with — so all of it has
    // to reach the page, not stop at the route.
    expect(r.body.viewBox).toEqual([0, 0, 223.92, 312]);
    expect(r.body.disc_fill).toBe(0.9);
    expect(r.body.filter).toContain('id="sticker-halo"');
    expect(r.body.fallbacks).toHaveLength(2);
  });
});

// THE WIZARD'S BASE CARD — before any order exists, so there is no owner token
// and nothing of hers in it: the design alone.
describe('GET /api/pawn-base', () => {
  const askBase = async (q) => {
    const r = await fetch(base + '/api/pawn-base?' + q);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  it('renders the bare card for a design with no order at all', async () => {
    const r = await askBase('theme=japanese&players=12&card=2&n=5');
    expect(r.status).toBe(200);
    expect(r.body.card).toMatch(/^data:image\/png/);
    expect(r.body.filter).toContain('sticker-halo');
    expect(r.body.fallbacks).toHaveLength(2);
    const [argv] = runs();
    expect(argOf(argv, '--drawn')).toBe('4');
    // No title and no photos: the tiles show the slots alone.
    // argv is [preview.py, theme, name, outDir, ...]: the name is empty.
    expect(argv[2]).toBe('');
    expect(argv).not.toContain('--photo');
    expect(argv.some((a) => a.startsWith('--title'))).toBe(false);
  });

  it('is one picture for every buyer on the design, whatever they ask', async () => {
    await askBase('theme=anniversary&players=4&n=1');
    await askBase('theme=anniversary&players=16&card=3&n=9');
    expect(runs()).toHaveLength(1);
  });

  it('refuses a design it does not know, without rendering', async () => {
    expect((await askBase('theme=nope&players=4')).status).toBe(400);
    expect(runs()).toHaveLength(0);
  });
});
