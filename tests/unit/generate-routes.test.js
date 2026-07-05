// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boot the real Express app with ADMIN_KEY set and the PYTHON generator replaced
// by a fast, deterministic FAKE binary (a shell script) so no Chrome/Python runs
// in unit tests. The fake writes a stub PDF to the requested output path and
// prints the "(N pages)" line the route parses; a theme containing "uncal" makes
// it fail like an uncalibrated theme.
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
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-generate-'));
  genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-generated-'));
  process.env.GENERATED_DIR = genDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

  // Write the fake generator "python" as an executable shell script.
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-fakepy-'));
  const fake = path.join(fakeDir, 'fake-generator.sh');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      '# $1=script $2=theme $3=name $4=wordsfile $5=outpdf',
      'theme="$2"',
      'out="$5"',
      'case "$theme" in',
      '  *uncal*) echo "theme foo is not calibrated yet" 1>&2; exit 1;;',
      'esac',
      'printf "%%PDF-1.4 fake" > "$out"',
      'echo "wrote $out (3 pages)"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  process.env.PYTHON = fake;

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

async function post(urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const key = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;

function seedWithWords(name, words) {
  const c = db.createCollection(name);
  db.addWords(c.id, words);
  return c;
}

describe('POST /api/admin/collections/:id/generate', () => {
  it('403 without the admin key', async () => {
    const c = seedWithWords('ללא מפתח', ['a', 'b']);
    const r = await post('/api/admin/collections/' + c.id + '/generate', {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(403);
  });

  it('404 for an unknown collection', async () => {
    const r = await post(key('/api/admin/collections/nope/generate'), { theme: 'trip comeback' });
    expect(r.status).toBe(404);
  });

  it('400 when no theme is supplied', async () => {
    const c = seedWithWords('בלי תמה', ['a', 'b']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('theme required');
  });

  it('400 when the collection has no words', async () => {
    const c = db.createCollection('בלי מילים');
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no words to generate');
  });

  it('generates a PDF, records production, returns a keyed link, and serves the file', async () => {
    // 'trip comeback' is an english-caps theme, so the honoree name must be Latin
    // (the pre-production validation rejects a Hebrew name here).
    const c = seedWithWords('Shira', ['מים', 'אש', 'רוח']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(200);
    expect(r.body.production.state).toBe('generated');
    expect(r.body.production.pages).toBe(3);
    expect(r.body.production.pdf_file).toBe(c.id + '.pdf');
    // the response link (admin-facing) is the admin-gated route with the key
    expect(r.body.link).toContain('/api/admin/collections/' + c.id + '/pdf?key=' + ADMIN_KEY);
    // production is persisted (mirrored to the collection) with a capability token
    expect(db.getCollection(c.id).production.state).toBe('generated');
    expect(typeof r.body.production.pdf_token).toBe('string');
    expect(r.body.production.pdf_token.length).toBeGreaterThan(16);
    // the token is NOT the admin key (that would defeat the whole point)
    expect(r.body.production.pdf_token).not.toBe(ADMIN_KEY);
    // the PDF was actually written to GENERATED_DIR
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(true);

    // download it via the admin-gated route
    const dl = await fetch(base + '/api/admin/collections/' + c.id + '/pdf?key=' + ADMIN_KEY);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('application/pdf');

    // and the same route is forbidden without the key
    const noKey = await fetch(base + '/api/admin/collections/' + c.id + '/pdf');
    expect(noKey.status).toBe(403);
  });

  it('serves the PDF over the PUBLIC token route WITHOUT the admin key', async () => {
    const c = seedWithWords('Token', ['a', 'b']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    const token = r.body.production.pdf_token;
    // the customer's capability link (?t=<token>) downloads the file, no key
    const dl = await fetch(base + '/api/collections/' + c.id + '/pdf?t=' + token);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('application/pdf');
  });

  it('the public token route is 403 with a wrong/missing token and never accepts the admin key', async () => {
    const c = seedWithWords('BadToken', ['a', 'b']);
    await post(key('/api/admin/collections/' + c.id + '/generate'), { theme: 'trip comeback' });
    // no token
    expect((await fetch(base + '/api/collections/' + c.id + '/pdf')).status).toBe(403);
    // wrong token
    expect((await fetch(base + '/api/collections/' + c.id + '/pdf?t=nope')).status).toBe(403);
    // the admin key is NOT a valid capability token on the public route
    const asKey = await fetch(base + '/api/collections/' + c.id + '/pdf?t=' + ADMIN_KEY);
    expect(asKey.status).toBe(403);
  });

  it('reuses the same pdf_token across regenerations', async () => {
    const c = seedWithWords('Regen', ['a', 'b']);
    const r1 = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    const r2 = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    expect(r2.body.production.pdf_token).toBe(r1.body.production.pdf_token);
  });

  it('mirrors production onto the order when one exists', async () => {
    const c = seedWithWords('With Order', ['a', 'b']);
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    await post(key('/api/admin/collections/' + c.id + '/generate'), { theme: 'trip comeback' });
    expect(db.getCollection(c.id).order.production.state).toBe('generated');
  });

  it('400 "unknown theme" for a theme that is not a themes.json key', async () => {
    // An unknown theme must be rejected BEFORE validation/generation — otherwise
    // getTheme() is null, validation is skipped, and the generator runs anyway.
    const c = seedWithWords('לא ידוע', ['a', 'b']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'uncal-theme',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('unknown theme');
    // and nothing was generated
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(false);
  });

  it('404 downloading a PDF that was never generated', async () => {
    const c = db.createCollection('אין קובץ');
    const dl = await fetch(base + '/api/admin/collections/' + c.id + '/pdf?key=' + ADMIN_KEY);
    expect(dl.status).toBe(404);
  });
});
