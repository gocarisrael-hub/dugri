// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// THE DESIGN SWITCH on the collection page: the buyer moves her order to another
// design from the design tab. The rules pinned here are the owner's:
//   - only a design the site offers (shown, with a theme to render from);
//   - the same door as the title: the owner token (?k=), so a link without it —
//     what a friend opening a bare ?c= link holds — cannot switch;
//   - allowed before AND after payment, never once the collection is closed for
//     production;
//   - every design costs the same, so nothing about the order's money moves;
//   - a legacy order (no typed title) cannot move to a design that would refuse it
//     at production.
// The strip's card route renders through the preview generator; a fake "python"
// counts its runs so the cache and single-flight are measured, not assumed.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let server;
let base;
let db;
let root;
let runLog;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dswitch-'));
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify({
      // built-ins (THEME_BY_DESIGN): bachelorette shown, anniversary hidden by the
      // owner, birthday-girls taken off the store
      bachelorette: { slug: 'bachelorette', display_he: 'פריז חדש', name_form: 'english' },
      anniversary: { slug: 'anniversary', display_he: 'סנטוריני', visibility: 'private' },
      'birthday-girls': { slug: 'birthday-girls', display_he: 'קליפורניה', in_store: false },
      // customs: one shown (Hebrew), one shown that needs AGE for a composed title
      'my-custom': { slug: 'my-custom', display_he: 'עיצוב שלי', visibility: 'public' },
      'age-custom': {
        slug: 'age-custom',
        display_he: 'עם גיל',
        visibility: 'public',
        extra_fields: ['AGE'],
      },
      'hidden-custom': { slug: 'hidden-custom', display_he: 'מוסתר', visibility: 'private' },
    }),
    'utf8'
  );

  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dswitch-data-'));
  process.env.GENERATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dswitch-gen-'));
  process.env.TEMPLATE_ROOT = root;
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

  // A fake preview.py: logs one line per run (and the theme it drew), waits a
  // little so concurrent asks overlap, writes a 1x1 PNG card.
  runLog = path.join(process.env.DATA_DIR, 'runs.log');
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dswitch-py-'));
  const fake = path.join(fakeDir, 'fake.js');
  fs.writeFileSync(
    fake,
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'const argv = process.argv.slice(2);',
      'fs.appendFileSync(' + JSON.stringify(runLog) + ', JSON.stringify(argv) + "\\n");',
      'const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");',
      'setTimeout(() => {',
      '  if ((argv[0] || "").indexOf("order_to_pdf.py") !== -1) {',
      '    fs.writeFileSync(argv[4], "%PDF-1.4 fake");',
      '    process.stdout.write("wrote " + argv[4] + " (3 pages)\\n");',
      '  } else if (argv.includes("--pawn-card")) {',
      '    const pawns = path.join(argv[3], "pawns.png");',
      '    fs.writeFileSync(pawns, PNG);',
      '    process.stdout.write(JSON.stringify({ pawns }) + "\\n");',
      '  } else {',
      '    const card = path.join(argv[3], "card.png");',
      '    fs.writeFileSync(card, PNG);',
      '    process.stdout.write(JSON.stringify({ card }) + "\\n");',
      '  }',
      '}, 150);',
      '',
    ].join('\n')
  );
  const shim = path.join(fakeDir, 'shim.sh');
  fs.writeFileSync(shim, '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', {
    mode: 0o755,
  });
  process.env.PYTHON = shim;

  for (const f of [
    'db.js',
    'pelecard.js',
    'notify.js',
    'content.js',
    'templates.js',
    'validate.js',
    'index.js',
  ]) {
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
  fs.rmSync(root, { recursive: true, force: true });
});

function runs() {
  if (!fs.existsSync(runLog)) return [];
  return fs.readFileSync(runLog, 'utf8').trim().split('\n').filter(Boolean);
}

function order(contact = {}) {
  return db.createCollection('שירה', {
    design: 'פריז חדש',
    theme: 'bachelorette',
    color: 'ורוד',
    custom_title: 'לשירה באהבה',
    ...contact,
  });
}

function put(c, design, k = c.owner_token) {
  const q = k == null ? '' : '?k=' + encodeURIComponent(k);
  return fetch(base + '/api/collections/' + c.id + '/design' + q, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ design }),
  });
}

describe('GET /api/collections/:id/designs', () => {
  it('lists exactly what the site offers, by its live name, the current one marked', async () => {
    const c = order();
    const r = await fetch(base + '/api/collections/' + c.id + '/designs?k=' + c.owner_token);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.open).toBe(true);
    const ids = body.designs.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['bachelorette', 'my-custom', 'age-custom']));
    // hidden by the owner (visibility / in_store), or never with a theme entry
    for (const gone of ['marriage', 'birthday', 'hidden-custom', 'japanese', 'kids']) {
      expect(ids).not.toContain(gone);
    }
    const cur = body.designs.find((d) => d.current);
    expect(cur.id).toBe('bachelorette');
    // the admin's rename, not the bundle's built-in name
    expect(cur.name).toBe('פריז חדש');
    expect(cur.language).toBe('hebrew');
    expect(body.designs.every((d) => d.ok)).toBe(true);
  });

  it('is the owner token’s alone', async () => {
    const c = order();
    expect((await fetch(base + '/api/collections/' + c.id + '/designs')).status).toBe(403);
    expect((await fetch(base + '/api/collections/' + c.id + '/designs?k=nope')).status).toBe(403);
  });

  it('marks the designs a LEGACY order (no typed title) could not print on', async () => {
    const c = order({ custom_title: null });
    const r = await fetch(base + '/api/collections/' + c.id + '/designs?k=' + c.owner_token);
    const { designs } = await r.json();
    const age = designs.find((d) => d.id === 'age-custom');
    expect(age.ok).toBe(false);
    expect(age.reason).toMatch(/AGE/);
    expect(designs.find((d) => d.id === 'my-custom').ok).toBe(true);
  });
});

describe('PUT /api/collections/:id/design', () => {
  it('moves the order: theme AND display name together, the old colour dropped', async () => {
    const c = order();
    const r = await put(c, 'my-custom');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, id: 'my-custom', design: 'עיצוב שלי' });
    const after = db.getCollection(c.id);
    expect(after.theme).toBe('my-custom');
    expect(after.design).toBe('עיצוב שלי');
    expect(after.color).toBe(null);
    expect(after.custom_title).toBe('לשירה באהבה');
  });

  it('refuses a design the owner hid, one off the store, and one that does not exist', async () => {
    const c = order();
    for (const id of ['marriage', 'birthday', 'hidden-custom', 'nope', '__proto__', '']) {
      const r = await put(c, id);
      expect(r.status, id).toBe(400);
      expect((await r.json()).error).toBe('design not available');
    }
    expect(db.getCollection(c.id).theme).toBe('bachelorette');
  });

  it('is the owner token’s alone: no token (a bare ?c= link) and a wrong one are 403', async () => {
    const c = order();
    expect((await put(c, 'my-custom', null)).status).toBe(403);
    expect((await put(c, 'my-custom', 'not-the-token')).status).toBe(403);
    // another order's token is not this one's
    const other = order();
    expect((await put(c, 'my-custom', other.owner_token)).status).toBe(403);
    expect(db.getCollection(c.id).theme).toBe('bachelorette');
  });

  it('is allowed after payment and touches nothing about the money', async () => {
    const c = order();
    const live = db.getCollection(c.id);
    live.order = { version: 'pdf', total: 199, paid: true, charged_total: 199 };
    const before = JSON.stringify(live.order);
    const r = await put(c, 'my-custom');
    expect(r.status).toBe(200);
    expect(JSON.stringify(db.getCollection(c.id).order)).toBe(before);
  });

  it('is locked once the collection is closed for production (409), like the title', async () => {
    const c = order();
    db.closeCollection(c.id, c.owner_token);
    const r = await put(c, 'my-custom');
    expect(r.status).toBe(409);
    expect(db.getCollection(c.id).theme).toBe('bachelorette');
    const t = await fetch(base + '/api/collections/' + c.id + '/title?k=' + c.owner_token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_title: 'אחר' }),
    });
    expect(t.status).toBe(409);
    const list = await fetch(base + '/api/collections/' + c.id + '/designs?k=' + c.owner_token);
    expect((await list.json()).open).toBe(false);
  });

  it('refuses a legacy order a design would refuse at production, with the reason', async () => {
    const c = order({ custom_title: null });
    const r = await put(c, 'age-custom');
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('design_misfit');
    expect(body.message).toMatch(/AGE/);
    expect(db.getCollection(c.id).theme).toBe('bachelorette');
  });

  it('drops a frozen word bank on a real change only', async () => {
    const c = order();
    db.setWordBank(c.id, { words: ['א'] });
    await put(c, 'bachelorette');
    expect(db.getCollection(c.id).word_bank).toBeTruthy();
    await put(c, 'my-custom');
    expect(db.getCollection(c.id).word_bank).toBeUndefined();
  });
});

describe('GET /api/collections/:id/design-card', () => {
  it('renders a design with her stored title, once: repeats and concurrent asks are free', async () => {
    const c = order({ custom_title: 'כרטיס אחד' });
    const url = base + '/api/collections/' + c.id + '/design-card?k=' + c.owner_token;
    const before = runs().length;
    const [a, b] = await Promise.all([
      fetch(url + '&design=bachelorette'),
      fetch(url + '&design=bachelorette'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const card = (await a.json()).card;
    expect(card).toMatch(/^data:image\/png;base64,/);
    expect((await b.json()).card).toBe(card);
    // two concurrent asks, one render
    expect(runs().length - before).toBe(1);
    const argv = JSON.parse(runs().at(-1));
    expect(argv).toContain('bachelorette');
    expect(argv).toContain('--title=כרטיס אחד');
    // …and asking again is a cache hit
    expect((await fetch(url + '&design=bachelorette')).status).toBe(200);
    expect(runs().length - before).toBe(1);
    // the same inputs through the tab's own preview are a hit too (a theme the
    // preview route's own themes view knows: it reads the shipped file)
    const p = await fetch(base + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        theme: 'bachelorette',
        name: 'שירה',
        extra_fields: {},
        word_font: null,
        title: 'כרטיס אחד',
        gender: null,
        board: false,
      }),
    });
    expect(p.status).toBe(200);
    expect(runs().length - before).toBe(1);
  });

  it('a new title is a new card', async () => {
    const c = order({ custom_title: 'כותרת ראשונה' });
    const url =
      base + '/api/collections/' + c.id + '/design-card?design=my-custom&k=' + c.owner_token;
    const before = runs().length;
    await fetch(url);
    db.setCustomTitleForOwner(c.id, c.owner_token, 'כותרת שנייה');
    await fetch(url);
    expect(runs().length - before).toBe(2);
  });

  it('is the owner token’s alone, and only for a design the site offers', async () => {
    const c = order();
    const u = base + '/api/collections/' + c.id + '/design-card?design=my-custom';
    expect((await fetch(u)).status).toBe(403);
    const hidden =
      base + '/api/collections/' + c.id + '/design-card?design=hidden-custom&k=' + c.owner_token;
    expect((await fetch(hidden)).status).toBe(400);
  });
});

describe('everything drawn from the design follows the switch', () => {
  const ADMIN = 'test-admin-key';
  // the last generator run, as its argv
  function lastRun() {
    return JSON.parse(runs().at(-1));
  }

  it('the pawn card, the summary the tab previews from, and production', async () => {
    // japanese: a theme the repo's own themes view can render a pawn card from,
    // but not one the test store offers — the order was placed before it left
    const c = order({ theme: 'japanese', design: 'טוקיו', custom_title: 'עוקב' });
    const k = '?k=' + c.owner_token;
    const pawn = () => fetch(base + '/api/collections/' + c.id + '/pawn-card' + k + '&live=1');
    expect((await pawn()).status).toBe(200);
    expect(lastRun()).toContain('japanese');

    expect((await put(c, 'bachelorette')).status).toBe(200);

    // the pawn card: a new key, so a new render, on the NEW design's artwork
    const n = runs().length;
    expect((await pawn()).status).toBe(200);
    expect(runs().length).toBe(n + 1);
    expect(lastRun()).toContain('bachelorette');
    expect(lastRun()).not.toContain('japanese');

    // the summary the design tab's main preview is rendered from
    const sum = await (await fetch(base + '/api/collections/' + c.id + '/summary' + k)).json();
    expect(sum.preview.theme).toBe('bachelorette');
    expect(sum.design).toBe('פריז חדש');

    // the order view the admin table and the page read
    const view = await (await fetch(base + '/api/collections/' + c.id + k)).json();
    expect(view.theme).toBe('bachelorette');

    // production: the generator runs the new theme
    db.addWords(c.id, ['א', 'ב', 'ג']);
    const g = await fetch(base + '/api/admin/collections/' + c.id + '/generate?key=' + ADMIN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(g.status).toBe(200);
    const gen = runs()
      .map((l) => JSON.parse(l))
      .reverse()
      .find((a) => a[0].includes('order_to_pdf.py'));
    expect(gen).toContain('bachelorette');
  });
});
