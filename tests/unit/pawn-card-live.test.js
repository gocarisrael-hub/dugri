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
process.stdout.write(JSON.stringify({ pawns: out, slots: [{ n: 1, x: 0, y: 0, w: 0.3, h: 0.2 }] }));
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

// `--drawn` as the child was given it, or null when it was not asked for at all.
function drawnOf(argv) {
  const i = argv.indexOf('--drawn');
  return i < 0 ? null : argv[i + 1];
}

async function askLive(id, k, n) {
  const q = n == null ? '' : '&n=' + encodeURIComponent(n);
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
});
