// @vitest-environment node
//
// PRODUCTION ON סיום — the buyer's own route to a produced deck.
//
// The admin generate route is covered in generate-routes.test.js; this file is
// about the three things that are NEW here and that nothing else can check:
//
//   * the gate. It is the collection's owner_token, never the admin key — the
//     buyer must be able to finish her own order without a master secret.
//   * the queue. Every buyer pressing סיום now starts a headless-Chrome deck
//     render, and this box dies at a handful of them (generator/chrome.py has
//     the measurements). One render per order, two at once, a short queue, and
//     an honest "busy" past that.
//   * the failure. Closing and producing are two requests on purpose: whatever
//     the renderer does, the order stays CLOSED. Losing the close would lose the
//     frozen word bank and the "we've started" mail with it.
//
// Like generate-routes.test.js it boots the real Express app with a FAKE python,
// so nothing here spawns Chrome. The fake takes instructions from the honoree
// name: "Slow" sleeps, "Boom" fails. It also appends every run to a log file, so
// a test can assert that a render did NOT happen a second time — which is the
// only way to see single-flight from outside.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;
let db;
let server;
let base;
let genDir;
let runLog;
let deckJobs;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-produce-'));
  genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-produce-gen-'));
  process.env.GENERATED_DIR = genDir;
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  // ONE running, ONE waiting: the smallest shape that still has all three
  // answers in it — running, queued, and busy — so the cap can be driven from a
  // test without holding three slow renders open.
  process.env.DECK_JOB_CONCURRENCY = '1';
  process.env.DECK_JOB_QUEUE = '1';

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-produce-py-'));
  runLog = path.join(fakeDir, 'runs.log');
  fs.writeFileSync(runLog, '');
  process.env.FAKE_RUN_LOG = runLog;
  const fake = path.join(fakeDir, 'fake-generator.sh');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      '# $1=script $2=theme $3=name $4=wordsfile $5=outpdf',
      '# The produce job also asks for the PROOF rasterisation, which is the same',
      '# python but a different script and a completely different argv. Answer it',
      '# the way a box with no ghostscript would — nothing is written, nothing is',
      '# logged, and the job carries on (the proof is best-effort by design).',
      'case "$1" in',
      '  *proof_sheet.py*) echo \'{"error":"no ghostscript here"}\'; exit 0;;',
      'esac',
      'name="$3"',
      'out="$5"',
      'echo "$name" >> "$FAKE_RUN_LOG"',
      'case "$name" in',
      '  *Boom*) echo "the template exploded" 1>&2; exit 1;;',
      'esac',
      'case "$name" in',
      '  *Slow*) sleep 2;;',
      'esac',
      'printf "%%PDF-1.4 fake" > "$out"',
      'printf "%%PDF-1.4 fake board" > "${out%.pdf}.board.pdf"',
      'echo "wrote $out (3 pages)"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  process.env.PYTHON = fake;

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'deck-jobs.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  // The SAME module instance the app holds — the cap is a property of that one
  // registry, so a test that wants to see it empty has to look at it directly.
  deckJobs = require(path.join(serverDir, 'deck-jobs.js'));

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

async function get(urlPath) {
  const res = await fetch(base + urlPath);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function runCount() {
  return fs.readFileSync(runLog, 'utf8').trim().split('\n').filter(Boolean).length;
}

// A collection in the state סיום actually presses from: words in, an order on
// it, paid, and closed. The theme is english-caps, so the honoree name is Latin
// (the pre-production validation refuses a Hebrew one there).
function seedFinished(name) {
  const c = db.createCollection(name, { theme: 'trip comeback' });
  db.addWords(c.id, ['מים', 'אש', 'רוח']);
  db.setOrder(c.id, c.owner_token, { version: 'pickup' });
  db.markPaid(c.id, { method: 'test', charged_total: 199 });
  db.closeCollection(c.id, c.owner_token);
  return c;
}

// Poll the buyer's own status route until the render has settled, the way her
// page does. Returns the final body.
async function settle(c, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const r = await get(`/api/collections/${c.id}/produce?k=${encodeURIComponent(c.owner_token)}`);
    if (r.body.state !== 'running' && r.body.state !== 'queued') return r.body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('the render never settled');
}

describe('POST /api/collections/:id/produce — the gate', () => {
  it('404 for an unknown collection', async () => {
    const r = await post('/api/collections/no-such-order/produce', { owner_token: 'x' });
    expect(r.status).toBe(404);
  });

  it('403 with a missing or wrong owner_token', async () => {
    const c = seedFinished('Gate One');
    expect((await post(`/api/collections/${c.id}/produce`, {})).status).toBe(403);
    expect((await post(`/api/collections/${c.id}/produce`, { owner_token: 'nope' })).status).toBe(
      403
    );
    // and the ADMIN key is not an owner_token — this route knows one secret only
    expect(
      (await post(`/api/collections/${c.id}/produce`, { owner_token: 'test-admin-key' })).status
    ).toBe(403);
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(false);
  });

  it('the status route is gated the same way', async () => {
    const c = seedFinished('Gate Two');
    expect((await get(`/api/collections/${c.id}/produce`)).status).toBe(403);
    expect((await get(`/api/collections/${c.id}/produce?k=nope`)).status).toBe(403);
    expect((await get('/api/collections/no-such-order/produce?k=x')).status).toBe(404);
  });

  it('409 while the list is still open — the deck is rendered from the FROZEN words', async () => {
    const c = db.createCollection('Still Open', { theme: 'trip comeback' });
    db.addWords(c.id, ['מים']);
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    db.markPaid(c.id, { method: 'test', charged_total: 199 });
    const r = await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('open');
  });

  it('409 for an unpaid order — the proof shows every card, which is the product', async () => {
    const c = db.createCollection('Not Paid', { theme: 'trip comeback' });
    db.addWords(c.id, ['מים']);
    db.closeCollection(c.id, c.owner_token);
    const r = await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('unpaid');
    // and the close it was asked about is untouched
    expect(db.getCollection(c.id).status).toBe('closed');
  });
});

describe('POST /api/collections/:id/produce — the render', () => {
  it('produces the deck and hands back the proof link on the SAME capability token', async () => {
    const c = seedFinished('Happy Path');
    const kick = await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    expect(kick.status).toBe(202);
    expect(['running', 'queued']).toContain(kick.body.state);
    // The number the waiting screen says out loud: her deck's cards, four words
    // to a card, from the list production will actually print.
    expect(kick.body.cards).toBeGreaterThan(0);

    const done = await settle(c);
    expect(done.state).toBe('ready');
    const token = db.getCollection(c.id).production.pdf_token;
    expect(typeof token).toBe('string');
    expect(done.proof_url).toBe(
      '/proof.html?c=' + encodeURIComponent(c.id) + '&t=' + encodeURIComponent(token)
    );
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(true);
    expect(db.getCollection(c.id).production.state).toBe('generated');
  });

  it('an order that is already produced answers ready WITHOUT rendering again', async () => {
    const c = seedFinished('Second Tap');
    await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    await settle(c);
    await waitSlotsFree();
    const before = runCount();
    const again = await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    expect(again.status).toBe(200);
    expect(again.body.state).toBe('ready');
    expect(runCount()).toBe(before);
  });

  it('a second press JOINS the render in flight instead of starting another', async () => {
    await waitSlotsFree();
    const c = seedFinished('Slow Join');
    const before = runCount();
    const a = await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    const b = await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    expect(a.status).toBe(202);
    // The re-click is answered, not refused — and it is the SAME job.
    expect(b.status).toBe(202);
    expect(['running', 'queued']).toContain(b.body.state);
    const done = await settle(c);
    expect(done.state).toBe('ready');
    // ONE Chrome pass for two presses. This is the whole point of the module.
    expect(runCount()).toBe(before + 1);
  });
});

// A job stays alive a little past 'ready' — it also rasterises the proof — so a
// test about the CAP has to wait for the slot, not for the deck.
async function waitSlotsFree(tries = 400) {
  for (let i = 0; i < tries; i++) {
    const s = deckJobs.stats();
    if (!s.running && !s.queued) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('a render slot was never released');
}

describe('POST /api/collections/:id/produce — the cap', () => {
  it('queues the second order and tells the third we are busy, having started nothing', async () => {
    await waitSlotsFree();
    const one = seedFinished('Slow Cap One');
    const two = seedFinished('Cap Two');
    const three = seedFinished('Cap Three');

    const r1 = await post(`/api/collections/${one.id}/produce`, { owner_token: one.owner_token });
    expect(r1.body.state).toBe('running');

    // DECK_JOB_CONCURRENCY=1, so this one waits rather than adding a second
    // Chrome to a box that cannot hold it.
    const r2 = await post(`/api/collections/${two.id}/produce`, { owner_token: two.owner_token });
    expect(r2.status).toBe(202);
    expect(r2.body.state).toBe('queued');

    // DECK_JOB_QUEUE=1, so this one is refused — honestly, and retryably.
    const r3 = await post(`/api/collections/${three.id}/produce`, {
      owner_token: three.owner_token,
    });
    expect(r3.status).toBe(503);
    expect(r3.body.state).toBe('busy');
    // NOTHING was started for it, and nothing was recorded…
    expect(await get(`/api/collections/${three.id}/produce?k=${three.owner_token}`)).toMatchObject({
      body: { state: 'idle' },
    });
    // …and the one thing that must survive did: the order is still CLOSED.
    expect(db.getCollection(three.id).status).toBe('closed');

    // The queued one still gets its turn once the slow one is out of the way.
    await settle(one, 400);
    expect((await settle(two, 400)).state).toBe('ready');
    expect(fs.existsSync(path.join(genDir, three.id + '.pdf'))).toBe(false);
  });
});

describe('POST /api/collections/:id/produce — when the render fails', () => {
  it('leaves the order CLOSED, reports the failure, and writes no deck', async () => {
    const c = seedFinished('Boom Order');
    const kick = await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    expect(kick.status).toBe(202);
    const done = await settle(c);
    expect(done.state).toBe('error');
    // THE CLOSE SURVIVES. It happened in its own request and nothing here undoes
    // it — the words stay frozen and the owner can produce the deck by hand.
    expect(db.getCollection(c.id).status).toBe('closed');
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(false);
    // No proof link was minted for a deck that does not exist.
    expect(done.proof_url).toBeUndefined();
  });

  it('a pre-production refusal is a failed job too, and still leaves the order closed', async () => {
    // A Hebrew honoree name on an english-caps theme: validate.js refuses it
    // before anything is spawned. The buyer's run must not email her a fix-it
    // list on top of the "we've started" mail she just got — it records the
    // problem and stops.
    await waitSlotsFree();
    const c = seedFinished('שירה');
    const before = runCount();
    const kick = await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    expect(kick.status).toBe(202);
    const done = await settle(c);
    expect(done.state).toBe('error');
    expect(runCount()).toBe(before); // the generator never ran
    expect(db.getCollection(c.id).status).toBe('closed');
    expect(db.getCollection(c.id).production.state).toBe('error');
  });

  it('a failed render can be retried, and the retry produces the deck', async () => {
    const c = seedFinished('Boom Then Fixed');
    await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    expect((await settle(c)).state).toBe('error');
    // The owner renames the honoree (or fixes the template) and the buyer
    // presses again: a job in a terminal state must not block a fresh attempt.
    db.getCollection(c.id).honoree_name = 'Fixed Order';
    const again = await post(`/api/collections/${c.id}/produce`, { owner_token: c.owner_token });
    expect(again.status).toBe(202);
    expect((await settle(c)).state).toBe('ready');
  });
});
