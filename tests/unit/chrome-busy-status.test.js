// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// generator/chrome.py caps how many headless Chrome runs may be in flight at
// once (each costs ~120 processes against the container's 1000-process ceiling).
// A run that could not get a slot never started: nothing is broken, nothing is
// half-written, and retrying works. That must NOT reach the caller as a 500 —
// a 500 sends the next person hunting a crash that did not happen, and it is
// what an owner-facing "generation failed" alert would be raised on.
//
// Both Chrome-spawning routes are covered here: the OWNER's produce button and
// the PUBLIC preview endpoint. The public one is the reason the cap exists at
// all — anyone browsing designs can drive it.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'busy-admin-key';
// The real text generator/chrome.py raises when every slot is taken; the status
// mapping keys off it, so the fixture must reproduce it verbatim.
const BUSY =
  'all 4 render slots were busy for 240s, so this render never started. ' +
  'Raise DUGRI_CHROME_MAX_CONCURRENT or DUGRI_CHROME_SLOT_WAIT_S.';

let app;
let db;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-busy-'));
  process.env.GENERATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-busy-gen-'));
  process.env.ADMIN_KEY = ADMIN_KEY;

  // One fake "python" standing in for BOTH entrypoints. It fails like a
  // slot-starved generator when the honoree name says so, and otherwise
  // succeeds — the deck path writing a stub PDF + page line, the preview path
  // writing stub PNGs + the JSON line the route parses.
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-busy-py-'));
  const fake = path.join(fakeDir, 'fake.sh');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      '# generate: $1=script $2=theme $3=name $4=wordsfile $5=outpdf',
      '# preview:  $1=script $2=theme $3=name $4=outdir',
      'case "$3" in',
      `  *BUSY*) echo "${BUSY}" 1>&2; exit 1 ;;`,
      '  *OOPS*) echo "Chrome could not render the deck (exit 5)" 1>&2; exit 1 ;;',
      'esac',
      'case "$1" in',
      '  *preview*)',
      '    printf "CARD" > "$4/card.png"',
      `    printf '{"card":"%s/card.png"}\\n' "$4"`,
      '    ;;',
      '  *)',
      '    printf "%%PDF-1.4 fake" > "$5"',
      '    echo "wrote $5 (3 pages)"',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  process.env.PYTHON = fake;

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'validate.js', 'settings.js', 'index.js']) {
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
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: await res.json().catch(() => ({})),
  };
}

const key = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;

describe('a render that could not get a Chrome slot', () => {
  it('generate answers 503 + Retry-After, not 500', async () => {
    const c = db.createCollection('BUSY', { theme: 'trip comeback' });
    db.addWords(c.id, ['מים', 'אש', 'רוח']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(503);
    expect(r.retryAfter).toBeTruthy();
    // The reason has to survive to the caller, or a 503 is indistinguishable
    // from the platform's own overload page.
    expect(r.body.detail).toMatch(/render slots were busy/);
  });

  it('preview answers 503 + Retry-After, not 500', async () => {
    const r = await post('/api/preview', { theme: 'trip comeback', name: 'BUSY' });
    expect(r.status).toBe(503);
    expect(r.retryAfter).toBeTruthy();
    expect(r.body.detail).toMatch(/render slots were busy/);
  });

  it('an ordinary generator failure is still a 500', async () => {
    // The 503 must be specific to the cap. Widening it would hide real breakage
    // behind a status that reads as "try again in a moment".
    const c = db.createCollection('OOPS', { theme: 'trip comeback' });
    db.addWords(c.id, ['מים', 'אש', 'רוח']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(500);
    expect(r.retryAfter).toBeNull();
  });

  it('a healthy generation is untouched', async () => {
    // So the 503 above cannot be an artefact of the harness.
    const c = db.createCollection('FINE', { theme: 'trip comeback' });
    db.addWords(c.id, ['מים', 'אש', 'רוח']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(200);
    expect(r.retryAfter).toBeNull();
  });
});
