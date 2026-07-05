// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// Boots the real Express app with a FAST FAKE preview "python" (a shell script)
// so no Chrome/Python runs in unit tests. The fake writes tiny stand-in card +
// board PNGs whose bytes ENCODE the word-font it was invoked with, and prints
// the JSON line of their paths the route parses. That lets us prove the route
// (a) forwards a valid word_font to the generator, (b) drops an unknown one, and
// (c) surfaces the language warning + options.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;
let db;
let validate;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-preview-'));
  process.env.ADMIN_KEY = 'test-admin-key';
  // Give the shared per-IP limiter plenty of headroom for the functional tests;
  // the dedicated rate-limit test below fires enough to exceed it regardless.
  process.env.COUPON_RATE_LIMIT = '40';

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-fakeprev-'));
  const fake = path.join(fakeDir, 'fake-preview.sh');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      '# $1=script $2=theme $3=name $4=outdir  then optional --word-font/--field',
      'theme="$2"; name="$3"; outdir="$4"',
      'shift 4',
      'wf="none"',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --word-font) wf="$2"; shift 2 ;;',
      '    --field) shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'case "$theme" in',
      '  *uncal*) echo "theme x is not calibrated yet" 1>&2; exit 1 ;;',
      'esac',
      'printf "CARDwf:%s" "$wf" > "$outdir/card.png"',
      'printf "BOARDname:%s" "$name" > "$outdir/board.png"',
      'printf \'{"card":"%s/card.png","board":"%s/board.png"}\\n\' "$outdir" "$outdir"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  process.env.PYTHON = fake;

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'validate.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  validate = require(path.join(serverDir, 'validate.js'));
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

async function post(urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Decode a "data:image/png;base64,..." URL back to its underlying text.
function decode(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  return Buffer.from(b64, 'base64').toString('utf8');
}

describe('checkNameLanguage (shared name-language check)', () => {
  const hebrew = { name_form: 'hebrew' };
  const englishCaps = { name_form: 'english-caps' };
  const english = { name_form: 'english' };

  it('passes a matching-script name (returns null)', () => {
    expect(validate.checkNameLanguage('שירה', hebrew)).toBeNull();
    expect(validate.checkNameLanguage('Shira', englishCaps)).toBeNull();
    expect(validate.checkNameLanguage('Shira', english)).toBeNull();
  });

  it('warns when the name is the wrong script for the theme', () => {
    expect(validate.checkNameLanguage('Shira', hebrew)).toMatch(/עברית/);
    expect(validate.checkNameLanguage('שירה', englishCaps)).toMatch(/אנגלית/);
    expect(validate.checkNameLanguage('שירה', english)).toMatch(/אנגלית/);
  });

  it('returns null when there is nothing to check', () => {
    expect(validate.checkNameLanguage('', hebrew)).toBeNull();
    expect(validate.checkNameLanguage('Shira', null)).toBeNull();
    expect(validate.checkNameLanguage('Shira', {})).toBeNull();
  });
});

describe('POST /api/preview', () => {
  it('400 for an unknown theme', async () => {
    const r = await post('/api/preview', { theme: 'nope', name: 'OZ' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('unknown theme');
  });

  it('400 when the name is missing', async () => {
    const r = await post('/api/preview', { theme: 'trip comeback', name: '  ' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('name required');
  });

  it('renders card + board data URLs and returns the 5 font options', async () => {
    const r = await post('/api/preview', { theme: 'trip comeback', name: 'OZ' });
    expect(r.status).toBe(200);
    expect(r.body.card).toMatch(/^data:image\/png;base64,/);
    expect(r.body.board).toMatch(/^data:image\/png;base64,/);
    expect(r.body.word_font_options).toHaveLength(5);
    expect(r.body.word_font_options.map((o) => o.file)).toContain('Fredoka-Medium.ttf');
    // no override -> the generator ran with the theme default (fake reports none)
    expect(r.body.word_font).toBeNull();
    expect(decode(r.body.card)).toBe('CARDwf:none');
  });

  it('forwards a valid picked word_font to the generator', async () => {
    const r = await post('/api/preview', {
      theme: 'trip comeback',
      name: 'OZ',
      word_font: 'Fredoka-Medium.ttf',
    });
    expect(r.status).toBe(200);
    expect(r.body.word_font).toBe('Fredoka-Medium.ttf');
    expect(decode(r.body.card)).toBe('CARDwf:Fredoka-Medium.ttf');
  });

  it('ignores a word_font that is not one of the offered options', async () => {
    const r = await post('/api/preview', {
      theme: 'trip comeback',
      name: 'OZ',
      word_font: '../../etc/passwd',
    });
    expect(r.status).toBe(200);
    expect(r.body.word_font).toBeNull();
    // the generator was invoked WITHOUT any --word-font
    expect(decode(r.body.card)).toBe('CARDwf:none');
  });

  it('returns a language warning for a name that does not fit the theme', async () => {
    const r = await post('/api/preview', { theme: 'trip comeback', name: 'עוז' });
    expect(r.status).toBe(200);
    expect(r.body.warning).toMatch(/אנגלית/);
    // the preview still renders (the warning does not block it)
    expect(r.body.card).toMatch(/^data:image\/png;base64,/);
  });
});

describe('rate limiting (per client IP, like the coupon route)', () => {
  it('eventually 429s under a burst', async () => {
    let sawLimited = false;
    for (let i = 0; i < 60; i++) {
      const r = await post('/api/preview', { theme: 'trip comeback', name: 'OZ' });
      if (r.status === 429) {
        sawLimited = true;
        break;
      }
    }
    expect(sawLimited).toBe(true);
  });
});

describe('createCollection persists word_font', () => {
  it('stores the picked word_font (capped at 80 chars)', () => {
    const c = db.createCollection('שירה', { word_font: 'Fredoka-Medium.ttf' });
    expect(c.word_font).toBe('Fredoka-Medium.ttf');
    const long = db.createCollection('x', { word_font: 'a'.repeat(200) });
    expect(long.word_font.length).toBe(80);
  });

  it('defaults word_font to null when absent or blank', () => {
    expect(db.createCollection('בלי גופן').word_font).toBeNull();
    expect(db.createCollection('y', { word_font: '' }).word_font).toBeNull();
  });
});
