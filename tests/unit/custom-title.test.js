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
    const ti = prev.indexOf('--title');
    expect(ti).toBeGreaterThan(-1);
    // sanitized (inner whitespace collapsed, trimmed) — WYSIWYG vs. what is stored
    expect(prev[ti + 1]).toBe('My Party');
  });

  it('POST /api/preview omits --title when no title is given', async () => {
    const before = readArgvLog().length;
    const r = await post('/api/preview', { theme: 'trip comeback', name: 'Shira' });
    expect(r.status).toBe(200);
    const prev = readArgvLog()
      .slice(before)
      .find((a) => a[0].includes('preview.py'));
    expect(prev).toBeTruthy();
    expect(prev.includes('--title')).toBe(false);
  });

  it('POST /api/preview omits --title for a whitespace-only title', async () => {
    const before = readArgvLog().length;
    await post('/api/preview', { theme: 'trip comeback', name: 'Shira', title: '   ' });
    const prev = readArgvLog()
      .slice(before)
      .find((a) => a[0].includes('preview.py'));
    expect(prev.includes('--title')).toBe(false);
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
    const ti = gen.indexOf('--title');
    expect(ti).toBeGreaterThan(-1);
    expect(gen[ti + 1]).toBe('Custom Deck Title');
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
    expect(gen.includes('--title')).toBe(false);
  });
});
