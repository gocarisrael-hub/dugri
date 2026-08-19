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
//
// It also writes the SECOND artifact — the board, at "<out>.board.pdf" — which is
// the real generator's contract (#233). An honoree name containing "NoBoard"
// skips it, standing in for an order generated before the board was split out of
// the deck.
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
      'case "$3" in',
      '  *NoBoard*) ;;',
      '  *) printf "%%PDF-1.4 fake board" > "${out%.pdf}.board.pdf";;',
      'esac',
      'echo "wrote $out (3 pages)"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  process.env.PYTHON = fake;

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  // Charge path gates on per-version enable flags (only pickup on by default);
  // this test sets a pdf order, so enable every version for this data dir.
  delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
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

  // One-click production: the admin "produce" button posts an empty body, so the
  // route must fall back to the theme the collection already resolved to when the
  // buyer picked their design.
  it("defaults to the collection's stored theme when the body has none", async () => {
    const c = db.createCollection('Stored Theme', { theme: 'trip comeback' });
    db.addWords(c.id, ['מים', 'אש']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {});
    expect(r.status).toBe(200);
    expect(r.body.production.state).toBe('generated');
    // the stored key is what production actually ran with (and was recorded)
    expect(r.body.production.theme).toBe('trip comeback');
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(true);
  });

  it('an explicit body theme still overrides the stored one', async () => {
    const c = db.createCollection('Override Theme', { theme: 'trip comeback' });
    db.addWords(c.id, ['מים', 'אש']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'bachelorette',
    });
    expect(r.status).toBe(200);
    expect(r.body.production.theme).toBe('bachelorette');
  });

  // The fallback must not smuggle a bad key past the guards: an unknown stored
  // theme is rejected by the SAME check an unknown body theme hits, and the
  // validate.js pre-production checks still run on the resolved key.
  it('400 "unknown theme" when the stored theme is not a themes.json key', async () => {
    const c = db.createCollection('Bad Stored', { theme: 'no-such-theme' });
    db.addWords(c.id, ['מים', 'אש']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('unknown theme');
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(false);
  });

  it('still runs the pre-production checks against the stored theme', async () => {
    // 'trip comeback' is english-caps, so a Hebrew honoree name must still be
    // caught — the defaulted theme is validated exactly like a supplied one.
    const c = db.createCollection('שירה', { theme: 'trip comeback' });
    db.addWords(c.id, ['מים', 'אש']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation failed');
    expect(r.body.problems.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(false);
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

// The board is no longer a page inside the deck — it is a second file the order
// must deliver alongside it, over the same two gates as the PDF.
describe('the board artifact', () => {
  it('records board_file on production and returns an admin board link', async () => {
    const c = seedWithWords('Board', ['a', 'b']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(200);
    expect(r.body.production.board_file).toBe(c.id + '.board.pdf');
    expect(r.body.boardLink).toContain(
      '/api/admin/collections/' + c.id + '/board?key=' + ADMIN_KEY
    );
    expect(fs.existsSync(path.join(genDir, c.id + '.board.pdf'))).toBe(true);
    // persisted, so a page reload still offers the board
    expect(db.getCollection(c.id).production.board_file).toBe(c.id + '.board.pdf');
  });

  it('serves the board over the admin route and refuses it without the key', async () => {
    const c = seedWithWords('BoardAdmin', ['a', 'b']);
    await post(key('/api/admin/collections/' + c.id + '/generate'), { theme: 'trip comeback' });
    const dl = await fetch(base + '/api/admin/collections/' + c.id + '/board?key=' + ADMIN_KEY);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('application/pdf');
    // the download name is the customer-facing one, not the on-disk one
    // Named after the order's title now; the point here is that it is the BOARD.
    expect(dl.headers.get('content-disposition')).toContain('-board.pdf');
    expect(dl.headers.get('content-disposition')).toContain(c.id.slice(0, 8));
    expect((await fetch(base + '/api/admin/collections/' + c.id + '/board')).status).toBe(403);
  });

  it('serves the board over the PUBLIC route with the SAME capability token as the deck', async () => {
    const c = seedWithWords('BoardToken', ['a', 'b']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    const token = r.body.production.pdf_token;
    const dl = await fetch(base + '/api/collections/' + c.id + '/board?t=' + token);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('application/pdf');
    // and the token gate behaves exactly like the deck's: no token, wrong token
    // and the admin key are all refused.
    expect((await fetch(base + '/api/collections/' + c.id + '/board')).status).toBe(403);
    expect((await fetch(base + '/api/collections/' + c.id + '/board?t=nope')).status).toBe(403);
    expect((await fetch(base + '/api/collections/' + c.id + '/board?t=' + ADMIN_KEY)).status).toBe(
      403
    );
  });

  // A generator run that produces no board (an un-migrated theme, or an order
  // generated before the split) must still succeed — just without a board.
  it('generation still succeeds when no board file is produced', async () => {
    const c = seedWithWords('NoBoard', ['a', 'b']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(200);
    expect(r.body.production.state).toBe('generated');
    expect(r.body.production.board_file).toBe(null);
    expect(r.body.boardLink).toBe(null);
    // the deck is there; the board routes 404 rather than serving something else
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(true);
    const dl = await fetch(base + '/api/admin/collections/' + c.id + '/board?key=' + ADMIN_KEY);
    expect(dl.status).toBe(404);
    const pub = await fetch(
      base + '/api/collections/' + c.id + '/board?t=' + r.body.production.pdf_token
    );
    expect(pub.status).toBe(404);
  });

  it('404 on the board route for an unknown collection', async () => {
    const dl = await fetch(base + '/api/admin/collections/nope/board?key=' + ADMIN_KEY);
    expect(dl.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// UNDOING a production run. An order lands in the dashboard's
// "הופקו — לשליחה לדפוס" step because a PDF exists; nothing could take it back
// out, so an order produced too early, or produced from the wrong words, was
// stuck in the print queue. Reopening the word list does not help — that step
// asks whether a file was BUILT, not whether the list is open.
describe('DELETE /api/admin/collections/:id/production', () => {
  async function del(urlPath) {
    const res = await fetch(base + urlPath, { method: 'DELETE' });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // Produce for real (the fake generator writes both artifacts), so the files
  // these tests assert about are the ones the route will be deleting.
  async function produced(name) {
    const c = db.createCollection(name, { theme: 'trip comeback' });
    db.addWords(c.id, ['מים', 'אש']);
    db.setOrder(c.id, c.owner_token, { version: 'pickup' }, { admin: true });
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {});
    expect(r.status).toBe(200);
    return c;
  }

  it('403 without the admin key', async () => {
    const c = await produced('NoKeyUndo');
    const r = await del('/api/admin/collections/' + c.id + '/production');
    expect(r.status).toBe(403);
    // and the record is untouched
    expect(db.getCollection(c.id).production.state).toBe('generated');
  });

  it('404 for an unknown collection', async () => {
    const r = await del(key('/api/admin/collections/nope/production'));
    expect(r.status).toBe(404);
  });

  it('409 when nothing was ever produced — there is no run to undo', async () => {
    const c = db.createCollection('NeverProduced', { theme: 'trip comeback' });
    db.addWords(c.id, ['מים']);
    const r = await del(key('/api/admin/collections/' + c.id + '/production'));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not produced');
  });

  it('clears BOTH mirrors of the record, so nothing still reads as produced', async () => {
    const c = await produced('UndoMe');
    const r = await del(key('/api/admin/collections/' + c.id + '/production'));
    expect(r.status).toBe(200);
    expect(r.body.cleared.state).toBe('generated');

    const after = db.getCollection(c.id);
    // Every reader falls back from one mirror to the other; leaving either
    // behind would keep the order in the print queue for half the code.
    expect(after.production).toBeUndefined();
    expect(after.order.production).toBeUndefined();
  });

  it('deletes the deck, the board and the press files it referred to', async () => {
    const c = await produced('Files');
    const deck = path.join(genDir, c.id + '.pdf');
    const board = path.join(genDir, c.id + '.board.pdf');
    expect(fs.existsSync(deck)).toBe(true);
    expect(fs.existsSync(board)).toBe(true);

    expect((await del(key('/api/admin/collections/' + c.id + '/production'))).status).toBe(200);

    // The /pdf routes serve whatever is on disk WITHOUT consulting the record,
    // so a surviving file beside a cleared record is a deck the shop could still
    // be sent. Both have to go.
    expect(fs.existsSync(deck)).toBe(false);
    expect(fs.existsSync(board)).toBe(false);
    expect(fs.existsSync(path.join(genDir, c.id + '.press.pdf'))).toBe(false);
  });

  it('and the download route stops answering with a stale file', async () => {
    const c = await produced('Download');
    const before = await fetch(base + key('/api/admin/collections/' + c.id + '/pdf'));
    expect(before.status).toBe(200);
    await del(key('/api/admin/collections/' + c.id + '/production'));
    const after = await fetch(base + key('/api/admin/collections/' + c.id + '/pdf'));
    expect(after.status).toBe(404);
  });

  it('REFUSES once the order was stamped as sent to the printer', async () => {
    const c = await produced('AtPrinter');
    db.setOrderSentToPrint(c.id, true);
    const r = await del(key('/api/admin/collections/' + c.id + '/production'));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('stamped');
    // The deck is at the shop: the record AND the file both survive, or the
    // dashboard would disagree with the world.
    expect(db.getCollection(c.id).production.state).toBe('generated');
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(true);
  });

  it('…and once it is marked ready', async () => {
    const c = await produced('IsReady');
    db.setOrderSentToPrint(c.id, true);
    db.setOrderReady(c.id, true);
    const r = await del(key('/api/admin/collections/' + c.id + '/production'));
    expect(r.status).toBe(409);
    expect(r.body.detail).toContain('מוכן');
  });

  it('un-stamping first is what unblocks it — the reverse order the toggles use', async () => {
    const c = await produced('ReverseOrder');
    db.setOrderSentToPrint(c.id, true);
    expect((await del(key('/api/admin/collections/' + c.id + '/production'))).status).toBe(409);
    db.setOrderSentToPrint(c.id, false);
    expect((await del(key('/api/admin/collections/' + c.id + '/production'))).status).toBe(200);
  });

  it('the order can be produced again afterwards — the point of undoing it', async () => {
    const c = await produced('Again');
    await del(key('/api/admin/collections/' + c.id + '/production'));
    const again = await post(key('/api/admin/collections/' + c.id + '/generate'), {});
    expect(again.status).toBe(200);
    expect(again.body.production.state).toBe('generated');
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(true);
  });
});
