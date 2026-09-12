// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// HER PHOTO CARD, RENDERED — GET /api/collections/:id/pawn-card.
//
// The picture itself is the generator's job (generator/test_preview_pawn_card.py
// pins that it is the deck's own composition). What this file holds is the
// route around it: who may ask, what it refuses, and what a failed render looks
// like — because the alternatives are a buyer's photos handed to whoever has the
// collection id, and a 500 stack trace on the page she edits her order from.
//
// The generator is deliberately unrunnable here (PYTHON points at nothing),
// so no test in this file spawns Chrome: the render path answers 502 and that
// is itself one of the things worth pinning.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let db;
let app;
let server;
let base;
let dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pawn-card-'));
  process.env.DATA_DIR = dataDir;
  process.env.PYTHON = path.join(dataDir, 'no-such-python');
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
  delete process.env.PYTHON;
});

function ask(id, k) {
  const q = k == null ? '' : '?k=' + encodeURIComponent(k);
  return fetch(base + '/api/collections/' + id + '/pawn-card' + q).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => ({})),
  }));
}

describe('GET /api/collections/:id/pawn-card', () => {
  it('is the OWNER’s alone — no token, wrong token and unknown id all answer 403', async () => {
    const c = db.createCollection('בדיקה', { theme: 'grapefruit' });
    expect((await ask(c.id, null)).status).toBe(403);
    expect((await ask(c.id, 'not-her-token')).status).toBe(403);
    // An unknown id answers the same, so the route cannot be used to learn which
    // collection ids exist.
    expect((await ask('no-such-collection', 'whatever')).status).toBe(403);
  });

  it('refuses a collection with no design behind it, rather than rendering nothing', async () => {
    const c = db.createCollection('בדיקה', {});
    const r = await ask(c.id, c.owner_token);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/theme/);
  });

  it('refuses a theme that is not a real design', async () => {
    const c = db.createCollection('בדיקה', { theme: 'not-a-design' });
    expect((await ask(c.id, c.owner_token)).status).toBe(400);
  });

  it('answers 502 with a message when the render fails, never a stack trace', async () => {
    const c = db.createCollection('בדיקה', { theme: 'grapefruit' });
    const r = await ask(c.id, c.owner_token);
    expect(r.status).toBe(502);
    expect(r.body.error).toBeTruthy();
    // The failure says the PICTURE is missing — it must not read as "you have no
    // photos", which is a different thing and would send her uploading again.
    expect(String(r.body.error)).not.toMatch(/photo(s)? (not|missing)/i);
  });
});

// THE ARGV THE PREVIEW IS SPAWNED WITH.
//
// The card this route renders IS the card the deck prints, so anything the deck
// puts on it has to reach the preview too — the photos, their frames, and the
// ORDER TITLE, which the pawn card carries under the pawns now. A preview that
// resolved the title differently would put a different name on the card than the
// printer does, under a caption promising they are the same.
//
// Asserted on the pure builder rather than through a spawn: the generator is
// deliberately unrunnable in this file, and an argv is exactly the kind of thing
// that drifts silently (#595).
describe('pawnCardArgs', () => {
  const BASE = { theme: 'grapefruit', outDir: '/tmp/out' };

  it('opens with the theme, the honoree and the out dir, in --pawn-card mode', () => {
    const args = app.pawnCardArgs({ ...BASE, name: 'שירה' });
    expect(args.slice(1, 5)).toEqual(['grapefruit', 'שירה', '/tmp/out', '--pawn-card']);
  });

  it('resolves the title exactly as the deck does', () => {
    const args = app.pawnCardArgs({
      ...BASE,
      name: 'שירה',
      extraFields: { AGE: '30' },
      customTitle: 'רווקות',
      gender: 'female',
    });
    expect(args).toContain('--field');
    expect(args).toContain('AGE=30');
    // `=`-joined, so a title starting with '-' is never read as an option.
    expect(args).toContain('--title=רווקות');
    expect(args.join(' ')).toContain('--gender female');
  });

  it('a title starting with a dash is still one token', () => {
    const args = app.pawnCardArgs({ ...BASE, customTitle: '-40' });
    expect(args).toContain('--title=-40');
  });

  it('passes no title arguments for a collection that has none', () => {
    const args = app.pawnCardArgs(BASE);
    expect(args.slice(1, 5)).toEqual(['grapefruit', '', '/tmp/out', '--pawn-card']);
    expect(args.some((a) => String(a).startsWith('--title'))).toBe(false);
    expect(args).not.toContain('--gender');
    expect(args).not.toContain('--field');
  });

  it('pairs every frame with its own photo, never with the next one', () => {
    const args = app.pawnCardArgs({
      ...BASE,
      photos: ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'],
      photoFrames: [null, '1.5,-0.25,0.1', null],
    });
    const pairs = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--photo') pairs.push([args[++i], null]);
      else if (String(args[i]).startsWith('--photo-frame=')) {
        expect(pairs.length).toBeGreaterThan(0);
        expect(pairs[pairs.length - 1][1]).toBe(null);
        pairs[pairs.length - 1][1] = String(args[i]).slice('--photo-frame='.length);
      }
    }
    expect(pairs).toEqual([
      ['/tmp/a.png', null],
      ['/tmp/b.png', '1.5,-0.25,0.1'],
      ['/tmp/c.png', null],
    ]);
  });

  it('the live base card asks for no photos and says how many discs the page covers', () => {
    const args = app.pawnCardArgs({ ...BASE, empty: true, drawn: 2 });
    expect(args).toContain('--no-photos');
    expect(args.join(' ')).toContain('--drawn 2');
    expect(args).not.toContain('--photo');
  });
});
