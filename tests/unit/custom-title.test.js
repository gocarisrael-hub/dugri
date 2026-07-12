// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// F7 custom title: the OPTIONAL free-form title that overrides the theme-derived
// title on the cards + board. This covers (1) db sanitization and (2) the server
// threading it to the generator (--title) on BOTH the preview and generate hops.
//
// For the threading we replace the PYTHON generator with a fake that RECORDS its
// argv to a file, so we can assert the exact CLI args without running Chrome.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
let app;
let db;
let server;
let base;
let argvLog;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-ctitle-'));
  process.env.GENERATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-ctitle-gen-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

  // Fake "python": append its own argv (one JSON array per line) to argvLog, then
  // behave enough like each real script for the route to succeed:
  //  - order_to_pdf.py (arg[4]=out.pdf): write a stub PDF + print "(N pages)".
  //  - preview.py      (arg[3]=out_dir): write a 1x1 PNG "card" + print its JSON.
  argvLog = path.join(process.env.DATA_DIR, 'argv.log');
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-ctitle-py-'));
  const fake = path.join(fakeDir, 'fake.js');
  fs.writeFileSync(
    fake,
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'const argv = process.argv.slice(2);',
      'fs.appendFileSync(' + JSON.stringify(argvLog) + ', JSON.stringify(argv) + "\\n");',
      'const script = argv[0] || "";',
      // 1x1 transparent PNG
      'const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");',
      'if (script.indexOf("preview.py") !== -1) {',
      '  const outDir = argv[3];',
      '  const card = path.join(outDir, "card.png");',
      '  fs.writeFileSync(card, PNG);',
      '  process.stdout.write(JSON.stringify({ card }) + "\\n");',
      '} else {',
      '  const out = argv[4];',
      '  fs.writeFileSync(out, "%PDF-1.4 fake");',
      '  process.stdout.write("wrote " + out + " (3 pages)\\n");',
      '}',
      '',
    ].join('\n')
  );
  process.env.PYTHON = process.execPath; // node runs the fake script
  // index.js spawns `${PYTHON} <script.py> ...`; prepend the fake so node executes
  // it and treats the real .py path as argv[0] (which the fake inspects). We do
  // that by pointing PYTHON at a wrapper node script via a tiny shim.
  const shim = path.join(fakeDir, 'shim.sh');
  fs.writeFileSync(
    shim,
    ['#!/bin/sh', 'exec "' + process.execPath + '" "' + fake + '" "$@"', ''].join('\n'),
    {
      mode: 0o755,
    }
  );
  process.env.PYTHON = shim;

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
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
});

function readArgvLog() {
  if (!fs.existsSync(argvLog)) return [];
  return fs
    .readFileSync(argvLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// F7 passes the title as a SINGLE token `--title=<value>` (not `--title` + value)
// so a value that starts with '-' can't be mis-parsed by python argparse as an
// option. These helpers read that single-token form out of a captured argv.
function titleArg(argv) {
  const t = argv.find((a) => typeof a === 'string' && a.startsWith('--title='));
  return t === undefined ? undefined : t.slice('--title='.length);
}
function hasTitleArg(argv) {
  return argv.some((a) => typeof a === 'string' && a.startsWith('--title'));
}

async function post(urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const key = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;

describe('db.sanitizeCustomTitle', () => {
  it('treats missing / empty / whitespace-only input as absent (null)', () => {
    expect(db.sanitizeCustomTitle(null)).toBe(null);
    expect(db.sanitizeCustomTitle(undefined)).toBe(null);
    expect(db.sanitizeCustomTitle('')).toBe(null);
    expect(db.sanitizeCustomTitle('   ')).toBe(null);
    expect(db.sanitizeCustomTitle('\n  \n')).toBe(null);
  });

  it('trims and collapses inner whitespace, dropping blank lines', () => {
    expect(db.sanitizeCustomTitle('  ליאת   חוגגת   40  ')).toBe('ליאת חוגגת 40');
    expect(db.sanitizeCustomTitle('שורה 1\n\n  שורה 2  ')).toBe('שורה 1\nשורה 2');
    expect(db.sanitizeCustomTitle('a\r\nb')).toBe('a\nb');
  });

  it('caps the total length', () => {
    const long = 'x'.repeat(400);
    expect(db.sanitizeCustomTitle(long).length).toBe(120);
  });

  it('keeps a leading dash verbatim (the generator handles it dash-safely)', () => {
    expect(db.sanitizeCustomTitle('-40')).toBe('-40');
    expect(db.sanitizeCustomTitle('  -רווקות  ')).toBe('-רווקות');
  });

  it('caps at the emoji boundary without splitting an astral surrogate pair', () => {
    // 119 plain chars + a 2-UTF-16-unit emoji: a naive slice(0,120) would cut the
    // emoji in half and leave a lone surrogate. Capping by code point keeps the
    // emoji whole as the 120th code point.
    const out = db.sanitizeCustomTitle('x'.repeat(119) + '😀' + 'y'.repeat(50));
    const cps = Array.from(out); // iterates by code point
    expect(cps.length).toBe(120); // 119 x's + the whole emoji
    expect(out.endsWith('😀')).toBe(true);
    // no element is a lone surrogate (a bisected pair would be a length-1 D800–DFFF)
    const lone = cps.some((ch) => ch.length === 1 && ch >= '\uD800' && ch <= '\uDFFF');
    expect(lone).toBe(false);
  });
});

describe('createCollection custom_title', () => {
  it('stores a sanitized custom title', () => {
    const c = db.createCollection('שירה', { custom_title: '  מסיבת   הפתעה  ' });
    expect(c.custom_title).toBe('מסיבת הפתעה');
  });

  it('stores null when the custom title is absent or whitespace-only', () => {
    expect(db.createCollection('א').custom_title).toBe(null);
    expect(db.createCollection('ב', { custom_title: '   ' }).custom_title).toBe(null);
  });
});

describe('server threads the custom title to the generator', () => {
  it('POST /api/preview forwards --title with the sanitized title', async () => {
    const before = readArgvLog().length;
    const r = await post('/api/preview', {
      theme: 'trip comeback',
      name: 'Shira',
      title: '  My   Party  ',
    });
    expect(r.status).toBe(200);
    const runs = readArgvLog().slice(before);
    const prev = runs.find((a) => a[0].includes('preview.py'));
    expect(prev).toBeTruthy();
    // sanitized (inner whitespace collapsed, trimmed) — WYSIWYG vs. what is stored
    expect(titleArg(prev)).toBe('My Party');
  });

  it('POST /api/preview forwards a dash-leading title as one --title= token (argparse-safe)', async () => {
    const before = readArgvLog().length;
    const r = await post('/api/preview', {
      theme: 'trip comeback',
      name: 'Shira',
      title: '-רווקות',
    });
    expect(r.status).toBe(200);
    const prev = readArgvLog()
      .slice(before)
      .find((a) => a[0].includes('preview.py'));
    expect(prev).toBeTruthy();
    // MUST be the single-token form so python argparse never reads '-רווקות' as an option
    expect(prev.some((a) => a === '--title=-רווקות')).toBe(true);
    expect(prev.includes('--title')).toBe(false); // never the two-token form
    expect(titleArg(prev)).toBe('-רווקות');
  });

  it('POST /api/preview omits --title when no title is given', async () => {
    const before = readArgvLog().length;
    const r = await post('/api/preview', { theme: 'trip comeback', name: 'Shira' });
    expect(r.status).toBe(200);
    const prev = readArgvLog()
      .slice(before)
      .find((a) => a[0].includes('preview.py'));
    expect(prev).toBeTruthy();
    expect(hasTitleArg(prev)).toBe(false);
  });

  it('POST /api/preview omits --title for a whitespace-only title', async () => {
    const before = readArgvLog().length;
    await post('/api/preview', { theme: 'trip comeback', name: 'Shira', title: '   ' });
    const prev = readArgvLog()
      .slice(before)
      .find((a) => a[0].includes('preview.py'));
    expect(hasTitleArg(prev)).toBe(false);
  });

  it('generate forwards the collection stored custom_title as --title', async () => {
    const c = db.createCollection('Shira', { custom_title: 'Custom Deck Title' });
    db.addWords(c.id, ['a', 'b', 'c']);
    const before = readArgvLog().length;
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(200);
    const gen = readArgvLog()
      .slice(before)
      .find((a) => a[0].includes('order_to_pdf.py'));
    expect(gen).toBeTruthy();
    expect(titleArg(gen)).toBe('Custom Deck Title');
  });

  it('generate omits --title when the collection has no custom title', async () => {
    const c = db.createCollection('Shira', {});
    db.addWords(c.id, ['a', 'b', 'c']);
    const before = readArgvLog().length;
    await post(key('/api/admin/collections/' + c.id + '/generate'), { theme: 'trip comeback' });
    const gen = readArgvLog()
      .slice(before)
      .find((a) => a[0].includes('order_to_pdf.py'));
    expect(gen).toBeTruthy();
    expect(hasTitleArg(gen)).toBe(false);
  });
});
