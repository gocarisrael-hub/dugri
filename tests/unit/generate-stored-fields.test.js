// @vitest-environment node
//
// The generate route must produce what the BUYER bought.
//
// Regression for the טוקיו (`japanese`) "missing age" bug: the route read
// `extra_fields` and `word_font` from the REQUEST BODY alone, defaulting to {}
// and null — but the admin "produce" button posts nothing except `{theme}`. So
// every production run rendered with an empty extra-fields dict and the theme's
// default word font, discarding both of the buyer's choices.
//
// It was invisible rather than loud: `japanese`'s title_lines are
// ["{NAME}'S", "{AGE}S"], and config.py's title_lines() BLANKS any placeholder
// it cannot fill, so the printed card read "HADAR'S" over a lone "S" instead of
// "{AGE}S". Nothing errored; only the finished PDF showed it.
//
// The fake generator here records its full argv next to the output PDF, so these
// tests assert on the exact `--field` / `--word-font` arguments the child was
// spawned with — the actual contract between the route and the renderer.
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
let genDir;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-storedfields-'));
  genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-storedfields-gen-'));
  process.env.GENERATED_DIR = genDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

  // $1=script $2=theme $3=name $4=wordsfile $5=outpdf, then the optional flags.
  // Writes the stub PDF the route expects AND an "<out>.args" sidecar holding
  // one argv entry per line, which is what the assertions below read.
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-storedfields-py-'));
  const fake = path.join(fakeDir, 'fake-generator.sh');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      'out="$5"',
      'printf "%%PDF-1.4 fake" > "$out"',
      'printf "%s\\n" "$@" > "$out.args"',
      'echo "wrote $out (3 pages)"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  process.env.PYTHON = fake;

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'validate.js', 'index.js']) {
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

async function post(urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const key = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;

// The argv the generator was spawned with for this collection.
function argvFor(id) {
  const f = path.join(genDir, id + '.pdf.args');
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split('\n').slice(0, -1);
}

// Every `--field K=V` pair the generator was handed, as a dict.
function fieldsFor(id) {
  const argv = argvFor(id) || [];
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--field') continue;
    const eq = String(argv[i + 1] || '').indexOf('=');
    if (eq > 0) out[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
  }
  return out;
}

// The `--word-font` value, or null when the flag was not passed.
function wordFontFor(id) {
  const argv = argvFor(id) || [];
  const i = argv.indexOf('--word-font');
  return i === -1 ? null : argv[i + 1];
}

// A טוקיו order exactly as the wizard stores one: an English name (the theme is
// english-caps) and the AGE the buyer typed after picking the design.
function tokyoOrder(extra) {
  const c = db.createCollection('Hadar', {
    theme: 'japanese',
    extra_fields: { AGE: '30' },
    word_font: 'Cafe-Regular.ttf',
    ...extra,
  });
  db.addWords(c.id, ['water', 'fire']);
  return c;
}

describe('POST /generate — the buyer’s stored choices reach the generator', () => {
  it('sends the stored AGE even when the body carries no extra_fields', async () => {
    // The exact request the admin "produce" button makes: theme and nothing else.
    const c = tokyoOrder();
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'japanese',
    });
    expect(r.status).toBe(200);
    expect(fieldsFor(c.id)).toEqual({ AGE: '30' });
  });

  it('sends the stored word_font even when the body carries none', async () => {
    const c = tokyoOrder();
    await post(key('/api/admin/collections/' + c.id + '/generate'), { theme: 'japanese' });
    expect(wordFontFor(c.id)).toBe('Cafe-Regular.ttf');
  });

  it('generates from a completely empty body (theme falls back too)', async () => {
    // The whole failure mode in one request: nothing supplied, everything read
    // off the order.
    const c = tokyoOrder();
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {});
    expect(r.status).toBe(200);
    expect(fieldsFor(c.id)).toEqual({ AGE: '30' });
    expect(wordFontFor(c.id)).toBe('Cafe-Regular.ttf');
  });

  it('lets the body OVERRIDE a stored field', async () => {
    const c = tokyoOrder();
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'japanese',
      extra_fields: { AGE: '40' },
      word_font: 'Heebo-Regular.ttf',
    });
    expect(r.status).toBe(200);
    expect(fieldsFor(c.id)).toEqual({ AGE: '40' });
    expect(wordFontFor(c.id)).toBe('Heebo-Regular.ttf');
  });

  it('does NOT let a BLANK body value erase a stored field', async () => {
    // Boundary: an empty string is not an override. Erasing AGE here would print
    // the very card the owner complained about, on an order that had the age.
    const c = tokyoOrder();
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'japanese',
      extra_fields: { AGE: '' },
      word_font: '',
    });
    expect(r.status).toBe(200);
    expect(fieldsFor(c.id)).toEqual({ AGE: '30' });
    expect(wordFontFor(c.id)).toBe('Cafe-Regular.ttf');
  });

  it('keeps stored fields the body does not mention (partial override)', async () => {
    // A multi-field theme: overriding one field must not drop the other two.
    const c = db.createCollection('דנה', {
      theme: 'anniversary',
      extra_fields: { YEARS: '25', NAME1: 'דנה', NAME2: 'רון' },
    });
    db.addWords(c.id, ['מים']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'anniversary',
      extra_fields: { YEARS: '30' },
    });
    expect(r.status).toBe(200);
    expect(fieldsFor(c.id)).toEqual({ YEARS: '30', NAME1: 'דנה', NAME2: 'רון' });
  });

  it('REFUSES an order whose required field is genuinely missing', async () => {
    // Boundary: no AGE anywhere. Producing a card with the age silently stripped
    // is worse than refusing, so this is a 400 + production.state='error' and the
    // generator never runs — the buyer gets a fix-it mail instead of a bad PDF.
    const c = db.createCollection('Hadar', { theme: 'japanese', extra_fields: {} });
    db.addWords(c.id, ['water']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'japanese',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation failed');
    expect(r.body.problems.some((p) => p.includes('AGE'))).toBe(true);
    expect(db.getCollection(c.id).production.state).toBe('error');
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(false);
  });

  it('REFUSES when the stored field is an empty string', async () => {
    // Boundary: present-but-blank is the same as absent, and must not slip
    // through as a stripped title.
    const c = db.createCollection('Hadar', { theme: 'japanese', extra_fields: { AGE: '  ' } });
    db.addWords(c.id, ['water']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'japanese',
    });
    expect(r.status).toBe(400);
    expect(db.getCollection(c.id).production.state).toBe('error');
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(false);
  });

  it('still produces a custom-title order with no extra fields at all', async () => {
    // A custom title replaces the theme-derived one, so its placeholders are
    // never rendered and the extras are genuinely not required. This must keep
    // working — the refusal above is about the DEFAULT title only.
    const c = db.createCollection('Hadar', {
      theme: 'japanese',
      extra_fields: {},
      custom_title: 'HADAR IS 30',
    });
    db.addWords(c.id, ['water']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'japanese',
    });
    expect(r.status).toBe(200);
    expect(argvFor(c.id)).toContain('--title=HADAR IS 30');
  });

  it('renders the same title the buyer previewed (preview/PDF agree)', async () => {
    // The property that actually broke: the preview showed the age because the
    // preview UI posts the fields, while the PDF did not because the produce
    // button does not. Both paths must now resolve to the same title inputs.
    const c = tokyoOrder();
    // What order-summary hands the preview endpoint for this order...
    const summary = await fetch(base + '/api/collections/' + c.id + '/summary?k=' + c.owner_token);
    const previewInputs = (await summary.json()).preview;
    await post(key('/api/admin/collections/' + c.id + '/generate'), { theme: 'japanese' });
    // ...must be exactly what production renders from.
    expect(previewInputs.extra_fields).toEqual(fieldsFor(c.id));
    expect(previewInputs.word_font).toEqual(wordFontFor(c.id));
    expect(previewInputs.name).toBe(argvFor(c.id)[2]); // argv: script, theme, NAME, …
  });
});
