// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pressPdf, rgbDeckPdf, truncate } from './press-pdf-fixture.js';

// The PRESS routes: the print-shop copy of an order (CMYK, flattened, bleed +
// crop marks). Unlike the customer deck it is a BACKGROUND job — a full
// re-render plus a Ghostscript pass, ~3 minutes for a 208-page deck — so the
// contract under test is the two-call one: POST starts it, GET polls.
//
// Same harness as generate-routes.test.js: the real Express app with ADMIN_KEY
// set and the Python generator replaced by a fast FAKE shell script, so no
// Chrome and no Ghostscript run in a unit test. The fake is driven by the theme
// string, and it reproduces the real pipeline's SHAPE, which is where the
// defects live:
//   *slow*      writes the RGB deck to its output path, lingers, then replaces
//               it with the press copy — exactly what Chrome-then-Ghostscript
//               does, and the reason a mid-build download used to hand over a
//               complete, openable, WRONG file.
//   *rgb*       finishes successfully having produced only the RGB deck.
//   *truncated* leaves a half-written file behind, like a killed Chrome.
//   *fail*      exits non-zero.
// It records every invocation ("<out>.calls") and its argv ("<out>.args") so
// the tests can prove both that only ONE child ran and that --press was passed.
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
  // The artifacts the fake copies into place: real PDFs, differing exactly
  // where the real ones differ.
  const pressFixture = path.join(fakeDir, 'press.pdf');
  const rgbFixture = path.join(fakeDir, 'rgb.pdf');
  const cutFixture = path.join(fakeDir, 'cut.pdf');
  fs.writeFileSync(pressFixture, pressPdf());
  fs.writeFileSync(rgbFixture, rgbDeckPdf());
  fs.writeFileSync(cutFixture, truncate(pressPdf()));

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
      // A long traceback whose MESSAGE is on the last line, like the real
      // generator's — the reported detail has to keep that end, not the frames.
      '  *fail*) i=0; while [ $i -lt 60 ]; do echo "  File \\"/app/generator/build.py\\", line $i" 1>&2; i=$((i+1)); done; echo "ghostscript exploded" 1>&2; exit 1;;',
      // The RGB deck lands FIRST and stays there for the whole render, which is
      // the window every mid-build download used to fall into.
      `  *slow*) cp "${rgbFixture}" "$out"; sleep 1; cp "${pressFixture}" "$out";;`,
      `  *rgb*) cp "${rgbFixture}" "$out";;`,
      `  *truncated*) cp "${cutFixture}" "$out";;`,
      `  *) cp "${pressFixture}" "$out";;`,
      'esac',
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
// Where the build writes, and where the finished copy is published.
const partialFile = (id) => path.join(genDir, id + '.press.partial.pdf');
const pressFile = (id) => path.join(genDir, id + '.press.pdf');
const rejectedFile = (id) => path.join(genDir, id + '.press.rejected.pdf');

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

// Wait until the child has actually written something to its output path, so a
// mid-build assertion is made at a moment when a complete file IS sitting
// there — not before the race has opened.
async function untilPartialExists(id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(partialFile(id))) {
    if (Date.now() > deadline) throw new Error('the build never wrote its partial file');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const callCount = (id) => {
  try {
    return fs
      .readFileSync(partialFile(id) + '.calls', 'utf8')
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0;
  }
};

const argv = (id) => fs.readFileSync(partialFile(id) + '.args', 'utf8').split('\n');

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
    expect(r.body.theme).toBe('trip comeback');

    const done = await settle(c.id);
    expect(done.status).toBe(200);
    expect(done.headers.get('content-type')).toContain('application/pdf');
    // the download name is the print shop's, not the on-disk one
    expect(done.headers.get('content-disposition')).toContain('dugri-' + c.id + '-press.pdf');
    const got = Buffer.from(await done.arrayBuffer());
    expect(got.equals(pressPdf())).toBe(true);
    expect(fs.existsSync(pressFile(c.id))).toBe(true);
    // the working copy is renamed into place, not left beside the deliverable
    expect(fs.existsSync(partialFile(c.id))).toBe(false);

    // The build actually asked for the press variant against the ICC profile —
    // without --press this would silently produce a second customer deck — and
    // it rendered to the PARTIAL path, never to the path downloads are served
    // from.
    const args = argv(c.id);
    expect(args[0]).toContain(path.join('generator', 'order_to_pdf.py'));
    expect(args[1]).toBe('trip comeback');
    expect(args[2]).toBe('Press Me');
    expect(args[4]).toBe(partialFile(c.id));
    expect(args).toContain('--press');
    expect(args).toContain(iccPath);
  });

  it('an explicit body theme overrides the stored one', async () => {
    const c = seed('Override', ['a', 'b'], { theme: 'trip comeback' });
    const r = await post(key(pressPath(c.id)), { theme: 'bachelorette' });
    expect(r.status).toBe(202);
    expect((await settle(c.id)).status).toBe(200);
    expect(argv(c.id)[1]).toBe('bachelorette');
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

// THE DEFECT, first half: a download that lands while a build is running.
describe('press routes: downloading DURING a build', () => {
  it('says "building" even though a complete PDF is sitting at the build path', async () => {
    const c = seed('Mid Build', ['a', 'b'], { theme: 'slow-theme' });
    expect((await post(key(pressPath(c.id)), {})).status).toBe(202);
    await untilPartialExists(c.id);

    // The intermediate really is there, really is a valid PDF, and really is
    // the wrong artifact: no CMYK, no TrimBox, no OutputIntent.
    const intermediate = fs.readFileSync(partialFile(c.id));
    expect(intermediate.subarray(0, 5).toString()).toBe('%PDF-');
    expect(intermediate.includes('/TrimBox')).toBe(false);
    // ...and it is not at the download path at all.
    expect(fs.existsSync(pressFile(c.id))).toBe(false);

    const mid = await fetch(base + key(pressPath(c.id)));
    expect(mid.status).toBe(202);
    const body = await mid.json();
    expect(body.status).toBe('building');
    expect(body.theme).toBe('slow-theme');
    expect(typeof body.elapsedMs).toBe('number');

    // And when it finishes, what lands is the press copy, not the intermediate.
    const done = await settle(c.id);
    expect(done.status).toBe(200);
    expect(Buffer.from(await done.arrayBuffer()).equals(pressPdf())).toBe(true);
  }, 20000);

  it('never serves the PREVIOUS build while a new one is running', async () => {
    // A finished press copy exists, then a rebuild starts. Serving the old file
    // mid-rebuild would hand over the artwork the owner just replaced.
    const c = seed('Rebuild', ['a', 'b'], { theme: 'trip comeback' });
    await post(key(pressPath(c.id)), {});
    expect((await settle(c.id)).status).toBe(200);
    expect(fs.existsSync(pressFile(c.id))).toBe(true);

    expect((await post(key(pressPath(c.id)), { theme: 'slow-theme' })).status).toBe(202);
    expect(fs.existsSync(pressFile(c.id))).toBe(false);
    const mid = await fetch(base + key(pressPath(c.id)));
    expect(mid.status).toBe(202);
    expect((await settle(c.id)).status).toBe(200);
  }, 20000);
});

// THE DEFECT, second half: two press builds racing on one order.
describe('press routes: a second POST while one is in flight', () => {
  it('re-posting the SAME theme is idempotent — one child, still building', async () => {
    const c = seed('Same Theme', ['a', 'b'], { theme: 'slow-theme' });
    expect((await post(key(pressPath(c.id)), {})).status).toBe(202);
    await untilPartialExists(c.id);

    const again = await post(key(pressPath(c.id)), {});
    expect(again.status).toBe(202);
    expect(again.body.status).toBe('building');
    expect(again.body.theme).toBe('slow-theme');

    expect((await settle(c.id)).status).toBe(200);
    // not a second Chrome+Ghostscript pair racing the first for one path
    expect(callCount(c.id)).toBe(1);
  }, 20000);

  it('a DIFFERENT theme is refused, loudly, and never resolves to the other file', async () => {
    // This is the one that shipped the wrong artwork: the second request used
    // to be dropped on the floor with a 202, and the poll that followed found
    // the FIRST theme's file at this order's press path and downloaded it.
    const c = seed('Two Themes', ['a', 'b'], { theme: 'slow-theme' });
    expect((await post(key(pressPath(c.id)), {})).status).toBe(202);
    await untilPartialExists(c.id);

    const other = await post(key(pressPath(c.id)), { theme: 'bachelorette' });
    expect(other.status).toBe(409);
    expect(other.body.theme).toBe('slow-theme');
    expect(other.body.requested).toBe('bachelorette');
    expect(other.body.detail).toContain('slow-theme');
    // no second child, and no half-started build for the refused theme
    expect(callCount(c.id)).toBe(1);

    // The first build finishes and serves ITS OWN artwork; the refused request
    // got an error, not somebody else's file.
    const done = await settle(c.id);
    expect(done.status).toBe(200);
    expect(argv(c.id)[1]).toBe('slow-theme');

    // Once nothing is in flight the other theme can be built normally.
    expect((await post(key(pressPath(c.id)), { theme: 'trip comeback' })).status).toBe(202);
    expect((await settle(c.id)).status).toBe(200);
    expect(argv(c.id)[1]).toBe('trip comeback');
  }, 25000);
});

// THE GATE: what the child produced has to BE the press copy.
describe('press routes: verifying the artifact before publishing it', () => {
  it('refuses to publish a build that produced the RGB deck', async () => {
    const c = seed('Still RGB', ['a', 'b'], { theme: 'rgb-theme' });
    expect((await post(key(pressPath(c.id)), {})).status).toBe(202);

    const failed = await settle(c.id);
    expect(failed.status).toBe(409);
    const body = await failed.json();
    expect(body.status).toBe('failed');
    expect(body.detail).toContain('NOT a press copy');
    expect(body.detail).toContain('DeviceCMYK');
    // nothing at the download path — a plausible wrong file is the failure
    // this whole route exists to prevent
    expect(fs.existsSync(pressFile(c.id))).toBe(false);
    // ...but the evidence is kept, out of reach of every download route
    expect(fs.existsSync(rejectedFile(c.id))).toBe(true);
    expect(fs.existsSync(partialFile(c.id))).toBe(false);
  }, 20000);

  it('refuses to publish a truncated file (a killed render)', async () => {
    const c = seed('Killed', ['a', 'b'], { theme: 'truncated-theme' });
    expect((await post(key(pressPath(c.id)), {})).status).toBe(202);

    const failed = await settle(c.id);
    expect(failed.status).toBe(409);
    const body = await failed.json();
    expect(body.detail).toContain('truncated');
    expect(fs.existsSync(pressFile(c.id))).toBe(false);
  }, 20000);
});

describe('press routes: a build that fails', () => {
  it('reports 409 with the generator detail, then a retry can still succeed', async () => {
    const c = seed('Boom', ['a', 'b'], { theme: 'fail-theme' });
    expect((await post(key(pressPath(c.id)), {})).status).toBe(202);

    const failed = await settle(c.id);
    expect(failed.status).toBe(409);
    const body = await failed.json();
    expect(body.status).toBe('failed');
    // The reported detail is the END of the failure, where the message is —
    // 800 characters of stack frames tell the owner nothing.
    expect(body.detail).toContain('ghostscript exploded');
    expect(body.detail.length).toBeLessThanOrEqual(800);
    expect(fs.existsSync(pressFile(c.id))).toBe(false);
    // the in-flight marker is gone, so the button is not stuck on "building"
    expect(fs.existsSync(path.join(genDir, c.id + '.press.building'))).toBe(false);

    // A retry with a working theme must clear the recorded failure — otherwise
    // the poll would keep reporting the old error over a perfectly good file.
    expect((await post(key(pressPath(c.id)), { theme: 'trip comeback' })).status).toBe(202);
    const ok = await settle(c.id);
    expect(ok.status).toBe(200);
    expect(fs.existsSync(path.join(genDir, c.id + '.press.err'))).toBe(false);
  }, 20000);

  it('reports an interrupted build honestly instead of "no press pdf"', async () => {
    // A marker older than the whole timeout budget with no file and no error is
    // a container restart mid-build: the child is never coming back and its
    // close handler never ran.
    const c = seed('Interrupted', ['a', 'b'], { theme: 'trip comeback' });
    const marker = path.join(genDir, c.id + '.press.building');
    fs.writeFileSync(marker, JSON.stringify({ started: 0, theme: 'trip comeback' }));
    fs.utimesSync(marker, new Date(0), new Date(0));

    const res = await fetch(base + key(pressPath(c.id)));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe('interrupted');
    expect(body.detail).toContain('נקטעה');

    // ...and a stale marker does not block a fresh build.
    expect((await post(key(pressPath(c.id)), {})).status).toBe(202);
    expect((await settle(c.id)).status).toBe(200);
  }, 20000);
});
