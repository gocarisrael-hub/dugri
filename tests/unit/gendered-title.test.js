// @vitest-environment node
//
// GENDERED TITLES: threading the honoree's gender from the stored order to the
// generator, so a Hebrew title's "{m:בן|f:בת}" marker resolves to the word that
// belongs on THIS buyer's cards.
//
// The reported defect: "ברוקלין" (birthday-boys-basketball) hardcoded בן in its
// title, so a girl's deck printed the masculine word on all 200 cards and on the
// board. The gender was already captured and validated on every order — it just
// never reached the renderer.
//
// The marker itself is resolved in generator/config.py (covered by
// generator/test_config.py) and validated in server/templates.js (covered by
// tests/unit/template-title.test.js). What is covered HERE is the WIRING: that
// the value the generator receives is the one stored on the order.
//
// The generator is replaced by a fake that RECORDS its argv, so the exact CLI
// args can be asserted without running Python or Chrome.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

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
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-gtitle-'));
  process.env.GENERATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-gtitle-gen-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

  // Fake "python": append its own argv (one JSON array per line) to argvLog, then
  // behave enough like each real script for the route to succeed.
  argvLog = path.join(process.env.DATA_DIR, 'argv.log');
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-gtitle-py-'));
  const fake = path.join(fakeDir, 'fake.js');
  fs.writeFileSync(
    fake,
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'const argv = process.argv.slice(2);',
      'fs.appendFileSync(' + JSON.stringify(argvLog) + ', JSON.stringify(argv) + "\\n");',
      'const script = argv[0] || "";',
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
  const shim = path.join(fakeDir, 'shim.sh');
  fs.writeFileSync(
    shim,
    ['#!/bin/sh', 'exec "' + process.execPath + '" "' + fake + '" "$@"', ''].join('\n'),
    { mode: 0o755 }
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

// The value passed as `--gender <value>`, or undefined when the flag is absent.
function genderArg(argv) {
  const i = argv.indexOf('--gender');
  return i === -1 ? undefined : argv[i + 1];
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

function runOf(before, script) {
  return readArgvLog()
    .slice(before)
    .find((a) => a[0].includes(script));
}

describe('generate: the gender comes from the STORED order', () => {
  // The one that matters. The admin "produce" button posts an empty body, so a
  // gender read from the request would always be absent and every deck would
  // print the template's default — i.e. the original bug, unchanged. (This is
  // the same defect `extra_fields` has on this route: body-only, no fallback.)
  for (const g of ['female', 'male']) {
    it(`forwards --gender ${g} for an order stored with it`, async () => {
      const c = db.createCollection('Shira', { gender: g });
      db.addWords(c.id, ['a', 'b', 'c']);
      const before = readArgvLog().length;
      const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
        theme: 'trip comeback',
      });
      expect(r.status).toBe(200);
      const gen = runOf(before, 'order_to_pdf.py');
      expect(gen).toBeTruthy();
      expect(genderArg(gen)).toBe(g);
    });
  }

  it('omits --gender when the order has none, letting the TEMPLATE default win', () => {
    // Not a server-side guess: the flag is simply absent and config.py falls back
    // to the form the template writes first.
    const c = db.createCollection('Shira', {});
    expect(c.gender).toBe(null);
    db.addWords(c.id, ['a', 'b', 'c']);
    const before = readArgvLog().length;
    return post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    }).then(() => {
      const gen = runOf(before, 'order_to_pdf.py');
      expect(gen).toBeTruthy();
      expect(genderArg(gen)).toBeUndefined();
    });
  });

  it('IGNORES a gender in the request body — the order is the only source', async () => {
    // An admin re-generating must not be able to flip the honoree's gender by
    // hand-posting one; the stored order is what the buyer chose.
    const c = db.createCollection('Dani', { gender: 'male' });
    db.addWords(c.id, ['a', 'b', 'c']);
    const before = readArgvLog().length;
    await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
      gender: 'female',
    });
    expect(genderArg(runOf(before, 'order_to_pdf.py'))).toBe('male');
  });
});

describe('preview: the gender comes from the request (no order exists yet)', () => {
  // The wizard previews BEFORE the collection is created, so here the body IS
  // the source — narrowed to the same two values db.createCollection accepts.
  it('forwards --gender from the body', async () => {
    for (const g of ['female', 'male']) {
      const before = readArgvLog().length;
      const r = await post('/api/preview', {
        theme: 'trip comeback',
        name: 'Shira' + g,
        gender: g,
      });
      expect(r.status).toBe(200);
      expect(genderArg(runOf(before, 'preview.py'))).toBe(g);
    }
  });

  it('omits --gender for a missing or unrecognized value', async () => {
    for (const [n, g] of [
      ['NoGender', undefined],
      ['BadGender', 'other'],
      ['TrueGender', true],
    ]) {
      const before = readArgvLog().length;
      const r = await post('/api/preview', { theme: 'trip comeback', name: n, gender: g });
      expect(r.status).toBe(200);
      expect(genderArg(runOf(before, 'preview.py'))).toBeUndefined();
    }
  });

  it('does NOT serve one gender a card rendered for the other', async () => {
    // Same name, same theme, different gender = different printed words, so the
    // two must be separate cache entries and BOTH must reach the renderer.
    const before = readArgvLog().length;
    await post('/api/preview', { theme: 'trip comeback', name: 'CacheKey', gender: 'female' });
    await post('/api/preview', { theme: 'trip comeback', name: 'CacheKey', gender: 'male' });
    const runs = readArgvLog()
      .slice(before)
      .filter((a) => a[0].includes('preview.py'));
    expect(runs.map(genderArg)).toEqual(['female', 'male']);
    // ...and a repeat of the first IS still cached (no third render).
    const mid = readArgvLog().length;
    await post('/api/preview', { theme: 'trip comeback', name: 'CacheKey', gender: 'female' });
    expect(readArgvLog().length).toBe(mid);
  });
});

describe('the order summary carries the gender back to the confirmation page', () => {
  it('includes it in the preview block pay-success re-posts verbatim', async () => {
    const c = db.createCollection('שירה', { gender: 'female', theme: 'trip comeback' });
    const res = await fetch(
      base + '/api/collections/' + c.id + '/summary?k=' + encodeURIComponent(c.owner_token)
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    // Without this the confirmation page would re-render the SAME order with no
    // gender and show a card whose title differs from the one being printed.
    expect(body.preview.gender).toBe('female');
  });
});
