// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The PRESS routes: the print-shop copy of an order (CMYK, flattened, bleed +
// crop marks). Unlike the customer deck it is a BACKGROUND job — a full
// re-render plus a Ghostscript pass, ~3 minutes for a 208-page deck — so the
// contract under test is the two-call one: POST starts it, GET polls.
//
// Same harness as generate-routes.test.js: the real Express app with ADMIN_KEY
// set and the Python generator replaced by a fast FAKE shell script, so no
// Chrome and no Ghostscript run in a unit test. The fake is driven by the theme
// string: "fail" makes it exit non-zero, "slow" makes it linger long enough for
// a second POST to land mid-build. It records every invocation (one line per
// call in "<out>.calls") and its argv ("<out>.args") so the tests can prove
// both that only ONE child ran and that --press was actually passed.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
let app;
let db;
let server;
let base;
let genDir;
let iccPath;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-press-data-'));
  genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-press-gen-'));
  process.env.GENERATED_DIR = genDir;
  process.env.ADMIN_KEY = ADMIN_KEY;

  // The route refuses to start without a readable ICC profile (a wrong-profile
  // file that LOOKS right is what reaches a print run unnoticed), and the real
  // profile is not in the repo — so point PRESS_ICC at a stand-in that exists.
  iccPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-press-icc-')), 'fake.icc');
  fs.writeFileSync(iccPath, 'not really a profile');
  process.env.PRESS_ICC = iccPath;

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-press-fakepy-'));
  const fake = path.join(fakeDir, 'fake-generator.sh');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      '# $1=script $2=theme $3=name $4=wordsfile $5=outpdf, then --press <icc>',
      'theme="$2"',
      'out="$5"',
      'printf "call\\n" >> "$out.calls"',
      'printf "%s\\n" "$@" > "$out.args"',
      'case "$theme" in',
      '  *fail*) echo "ghostscript exploded" 1>&2; exit 1;;',
      '  *slow*) sleep 1;;',
      'esac',
      'printf "%%PDF-1.4 fake press" > "$out"',
      'echo "wrote $out (3 pages)"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  process.env.PYTHON = fake;

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'settings.js', 'index.js']) {
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

const key = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;
const pressPath = (id) => '/api/admin/collections/' + id + '/press';

async function post(urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function seed(name, words, contact) {
  const c = db.createCollection(name, contact || {});
  if (words && words.length) db.addWords(c.id, words);
  return c;
}

// GET until the job settles (anything other than 202-building), so a test never
// depends on how fast the fake child happens to exit.
async function settle(id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(base + key(pressPath(id)));
    if (res.status !== 202) return res;
    if (Date.now() > deadline) throw new Error('press build never settled');
    await new Promise((r) => setTimeout(r, 40));
  }
}

const callCount = (id) => {
  try {
    return fs
      .readFileSync(path.join(genDir, id + '.press.pdf.calls'), 'utf8')
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0;
  }
};

describe('press routes: the admin gate', () => {
  it('403 without the admin key, on both the start and the poll', async () => {
    const c = seed('No Key', ['a', 'b'], { theme: 'trip comeback' });
    const started = await post(pressPath(c.id), {});
    expect(started.status).toBe(403);
    expect((await fetch(base + pressPath(c.id))).status).toBe(403);
    // and nothing was spawned behind the closed door
    expect(callCount(c.id)).toBe(0);
  });

  it('404 for an unknown collection, on both routes', async () => {
    expect((await post(key(pressPath('nope')), {})).status).toBe(404);
    expect((await fetch(base + key(pressPath('nope')))).status).toBe(404);
  });
});

describe('press routes: what has to be there before a build starts', () => {
  it('400 when the collection has no words', async () => {
    const c = seed('No Words', [], { theme: 'trip comeback' });
    const r = await post(key(pressPath(c.id)), {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no words to generate');
    expect(callCount(c.id)).toBe(0);
  });

  it('400 when neither the body nor the collection carries a theme', async () => {
    const c = seed('No Theme', ['a', 'b']);
    const r = await post(key(pressPath(c.id)), {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('theme required');
    expect(callCount(c.id)).toBe(0);
  });

  it('404 polling a press copy that was never asked for', async () => {
    const c = seed('Never Asked', ['a', 'b'], { theme: 'trip comeback' });
    const res = await fetch(base + key(pressPath(c.id)));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no press pdf');
  });
});

describe('press routes: the happy path', () => {
  it('POST returns 202 at once and the poll eventually hands back the PDF', async () => {
    const c = seed('Press Me', ['מים', 'אש'], { theme: 'trip comeback' });
    const r = await post(key(pressPath(c.id)), {});
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('building');

    const done = await settle(c.id);
    expect(done.status).toBe(200);
    expect(done.headers.get('content-type')).toContain('application/pdf');
    // the download name is the print shop's, not the on-disk one
    expect(done.headers.get('content-disposition')).toContain('dugri-' + c.id + '-press.pdf');
    expect(await done.text()).toContain('fake press');
    expect(fs.existsSync(path.join(genDir, c.id + '.press.pdf'))).toBe(true);

    // The build actually asked for the press variant against the ICC profile —
    // without --press this would silently produce a second customer deck.
    const argv = fs.readFileSync(path.join(genDir, c.id + '.press.pdf.args'), 'utf8').split('\n');
    expect(argv[0]).toContain(path.join('generator', 'order_to_pdf.py'));
    expect(argv[1]).toBe('trip comeback');
    expect(argv[2]).toBe('Press Me');
    expect(argv[4]).toBe(path.join(genDir, c.id + '.press.pdf'));
    expect(argv).toContain('--press');
    expect(argv).toContain(iccPath);
  });

  it('an explicit body theme overrides the stored one', async () => {
    const c = seed('Override', ['a', 'b'], { theme: 'trip comeback' });
    const r = await post(key(pressPath(c.id)), { theme: 'bachelorette' });
    expect(r.status).toBe(202);
    expect((await settle(c.id)).status).toBe(200);
    const argv = fs.readFileSync(path.join(genDir, c.id + '.press.pdf.args'), 'utf8').split('\n');
    expect(argv[1]).toBe('bachelorette');
  });

  it('the finished file keeps being served on later polls', async () => {
    const c = seed('Again', ['a', 'b'], { theme: 'trip comeback' });
    await post(key(pressPath(c.id)), {});
    expect((await settle(c.id)).status).toBe(200);
    const second = await fetch(base + key(pressPath(c.id)));
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toContain('application/pdf');
    // one build, two downloads
    expect(callCount(c.id)).toBe(1);
  });
});

describe('press routes: a build that fails', () => {
  it('reports 409 with the generator detail, then a retry can still succeed', async () => {
    const c = seed('Boom', ['a', 'b'], { theme: 'fail-theme' });
    expect((await post(key(pressPath(c.id)), {})).status).toBe(202);

    const failed = await settle(c.id);
    expect(failed.status).toBe(409);
    const body = await failed.json();
    expect(body.status).toBe('failed');
    expect(body.detail).toContain('ghostscript exploded');
    expect(fs.existsSync(path.join(genDir, c.id + '.press.pdf'))).toBe(false);
    // the in-flight marker is gone, so the button is not stuck on "building"
    expect(fs.existsSync(path.join(genDir, c.id + '.press.building'))).toBe(false);

    // A retry with a working theme must clear the recorded failure — otherwise
    // the poll would keep reporting the old error over a perfectly good file.
    expect((await post(key(pressPath(c.id)), { theme: 'trip comeback' })).status).toBe(202);
    const ok = await settle(c.id);
    expect(ok.status).toBe(200);
    expect(fs.existsSync(path.join(genDir, c.id + '.press.err'))).toBe(false);
  }, 20000);
});

describe('press routes: re-posting mid-build', () => {
  it('does not start a second child, and the poll says "building" until it lands', async () => {
    const c = seed('Slow', ['a', 'b'], { theme: 'slow-theme' });
    expect((await post(key(pressPath(c.id)), {})).status).toBe(202);

    // While the (deliberately slow) child runs, the poll reports building...
    const mid = await fetch(base + key(pressPath(c.id)));
    expect(mid.status).toBe(202);
    expect((await mid.json()).status).toBe('building');

    // ...and a second POST is a no-op, not a second Chrome+Ghostscript pair
    // racing the first for the same output file.
    const again = await post(key(pressPath(c.id)), {});
    expect(again.status).toBe(202);
    expect(again.body.status).toBe('building');

    expect((await settle(c.id)).status).toBe(200);
    expect(callCount(c.id)).toBe(1);
  }, 20000);
});
