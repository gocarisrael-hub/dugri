// @vitest-environment node
//
// THE NOTE IS GONE FOR EVERY TEMPLATE — proved by sweeping them, not by spot-check.
//
// The wizard's rendered preview used to print, under "כך זה ייראה עם השם:",
//
//     שם החוגג/ת צריך להיות באנגלית (בהתאם לעיצוב): "חגי תשרי"
//
// whenever the buyer's text was in a different script from the theme's
// `name_form`. Since the buyer types the whole title herself, the `name` the
// preview route receives is only the order's LABEL (the title's first line) and
// is printed on nothing — so on every Latin-scripted template the sentence
// warned every Hebrew-speaking buyer about text her card does not contain.
//
// The removal it replaces was per-template and therefore kept coming back: the
// note is driven by `name_form`, which lives in generator/themes.json in the
// image AND in DATA_DIR/templates/themes.json on the Railway volume, and clearing
// the flag in the repo does nothing for a template that only exists on the
// volume. So this file does not check that any particular template is quiet. It
// asserts the ROUTE HAS NO WARNING TO GIVE:
//
//   1. every theme the merged themes.json knows about (both layers) — no warning;
//   2. an owner template that exists ONLY on the volume layer, with the most
//      warning-prone name_form there is — no warning;
//   3. a name in every script, matching and mismatching — no warning;
//   4. nothing anywhere in the response body carries the sentence's wording.
//
// The pre-production check that produces the same sentence is deliberately still
// alive (validateOrderForProduction gates a pre-typed-title order, whose deck
// really does print a composed name) — asserted at the bottom so a future removal
// of the route's call cannot be mistaken for a removal of that gate.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const themesPath = path.join(__dirname, '..', '..', 'generator', 'themes.json');

// The wording of the note, split into the two fragments it is built from
// (server/validate.js composes 'שם החוגג/ת צריך להיות ב' + label + ' (בהתאם
// לעיצוב): "…"'). Matching on the fragments rather than the whole sentence means
// a reworded note is still caught.
const NOTE_STEM = 'שם החוגג/ת צריך להיות';
const NOTE_TAIL = 'בהתאם לעיצוב';

// A theme key that exists ONLY in the owner store (the DATA_DIR volume layer),
// with name_form 'english-caps' — the setting most likely to trip the check.
const VOLUME_THEME = 'volume-only-template';

let app;
let validate;
let server;
let base;
let dataDir;
let shippedThemes;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-nonote-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_KEY = 'test-admin-key';
  // The sweep is one cache-missing render per theme per name; give the preview
  // bucket room so a 429 can never masquerade as "no warning".
  process.env.PREVIEW_RATE_LIMIT = '2000';

  shippedThemes = JSON.parse(fs.readFileSync(themesPath, 'utf8'));

  // The volume layer. validate.loadThemes lays this over the shipped themes, so
  // the route resolves VOLUME_THEME exactly as it does an owner-uploaded one in
  // production — no template directory needed, since the render is faked below.
  fs.mkdirSync(path.join(dataDir, 'templates'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'templates', 'themes.json'),
    JSON.stringify({
      [VOLUME_THEME]: {
        display_he: 'תבנית מהוולום',
        language: 'english',
        name_form: 'english-caps',
        extra_fields: [],
        title_lines: ["{NAME}'S PARTY"],
      },
    })
  );

  // Same fast fake "python" the preview unit tests use: writes stand-in PNGs and
  // prints the JSON line the route parses, so no Chrome and no generator run.
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-nonote-py-'));
  const fake = path.join(fakeDir, 'fake-preview.sh');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      '# $1=script $2=theme $3=name $4=outdir  then optional flags',
      'outdir="$4"',
      'printf CARD > "$outdir/card.png"',
      'printf BOARD > "$outdir/board.png"',
      'printf \'{"card":"%s/card.png","board":"%s/board.png"}\\n\' "$outdir" "$outdir"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  process.env.PYTHON = fake;

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'validate.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  require(path.join(serverDir, 'db.js'));
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

async function preview(body) {
  const res = await fetch(base + '/api/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Every template the running server can resolve: the shipped layer plus the
// volume-only one. Read through the SERVER's own merge, so a theme added to
// either layer is swept without this file being edited.
function allThemeKeys() {
  return Object.keys(validate.loadThemes());
}

describe('the name-language note is impossible on EVERY template', () => {
  it('sweeps every theme in the merged themes.json (both layers)', async () => {
    const keys = allThemeKeys();
    // Sanity: the sweep must actually cover the shipped catalogue plus the
    // volume-only template. A silently empty list would pass every assertion.
    expect(keys.length).toBe(Object.keys(shippedThemes).length + 1);
    expect(keys).toContain(VOLUME_THEME);

    for (const theme of keys) {
      // Hebrew, Latin and mixed — one of these is the "wrong" script for every
      // possible name_form, so each theme is tested against a mismatching name
      // whatever it declares.
      for (const name of ['חגי תשרי', 'HAGAI', 'חגי HAGAI']) {
        const r = await preview({ theme, name, title: '' });
        expect(r.status, theme + ' / ' + name).toBe(200);
        expect(r.body.warning, theme + ' / ' + name).toBeUndefined();
        const json = JSON.stringify(r.body);
        expect(json.includes(NOTE_STEM), theme + ' / ' + name).toBe(false);
        expect(json.includes(NOTE_TAIL), theme + ' / ' + name).toBe(false);
      }
    }
  });

  it('stays quiet for a template that exists ONLY on the volume', async () => {
    // The failure this guards: clearing name_form in the repo's themes.json looks
    // like a fix, and does nothing for a template the repo has never seen.
    expect(validate.getTheme(VOLUME_THEME).name_form).toBe('english-caps');
    const r = await preview({ theme: VOLUME_THEME, name: 'חגי תשרי', title: '' });
    expect(r.status).toBe(200);
    expect(r.body.warning).toBeUndefined();
  });

  it('stays quiet with a typed title too (the real wizard payload)', async () => {
    for (const theme of allThemeKeys()) {
      const r = await preview({ theme, name: 'חגי תשרי', title: 'חגי תשרי\nחוגג 40' });
      expect(r.status, theme).toBe(200);
      expect(r.body.warning, theme).toBeUndefined();
    }
  });

  it('is not merely cached away — a cache HIT carries no warning either', async () => {
    // The route answers a cache hit on a separate code path that used to splice
    // the freshly computed warning back in. Ask twice for the same inputs.
    const req = { theme: 'bachelorette', name: 'חגי תשרי', title: '' };
    const first = await preview(req);
    const second = await preview(req);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.warning).toBeUndefined();
    expect(second.body.warning).toBeUndefined();
  });
});

describe('the PRE-PRODUCTION gate is a different thing, and still there', () => {
  // Not the buyer's screen: an order placed before the buyer typed her own title
  // still prints a name composed into the theme's title template, so a Hebrew
  // name on a Latin design is a genuine refusal there, with a reason attached.
  it('still refuses a legacy (title-less) order whose name is the wrong script', () => {
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'חגי תשרי' },
      { name_form: 'english-caps', extra_fields: [] },
      ['word']
    );
    expect(problems.some((p) => p.includes(NOTE_STEM))).toBe(true);
  });

  it('says nothing about the name once the order carries its own title', () => {
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'חגי תשרי', custom_title: 'חגי תשרי\nחוגג 40' },
      { name_form: 'english-caps', extra_fields: [] },
      ['word']
    );
    expect(problems.some((p) => p.includes(NOTE_STEM))).toBe(false);
  });
});
