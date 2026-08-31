// @vitest-environment node
//
// THE BUYER'S PROOF IS A SWITCH THE OWNER HOLDS.
//
// proof.html — every page of the produced deck, read out of the PDF — has been
// live since it was built, and the owner asked to be able to turn it off. That
// makes it the first `features` flag that DEFAULTS ON: a default of false would
// have taken a working feature away from every buyer the day the key appeared.
//
// Four things have to hold, and each is one test below:
//   1. On (the default), nothing about the proof changes.
//   2. Off, a buyer is refused — and told WHY, since "switched off" and "bad
//      link" owe her completely different sentences.
//   3. Off, the produce answers carry no proof_url, so collect.html stops
//      sending her to a page that would refuse her.
//   4. Off, the OWNER can still read the proof on her admin key. She hid it from
//      buyers, not from herself: this is the last look at a deck before print.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
let settings;
let server;
let base;
let genDir;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-proofflag-'));
  genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-proofflaggen-'));
  process.env.GENERATED_DIR = genDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  // A python that cannot exist: every proof here is written by hand, so a test
  // that accidentally triggers a BUILD fails loudly instead of shelling out.
  process.env.PYTHON = path.join(os.tmpdir(), 'no-such-python-for-proof-flag-tests');

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'proof.js', 'settings.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  // Required AFTER index so both hold the same instance — index.js reads the
  // flag through this exact module, so a set() here is what the routes see.
  settings = require(path.join(serverDir, 'settings.js'));
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

// Every test states the flag it needs; this is the shipped state between them.
beforeEach(() => {
  settings.reset('features', 'deck_proof');
});

// A produced order with a proof already on disk: the state a buyer arrives in.
function produced(name, pages = 3) {
  const c = db.createCollection(name);
  db.addWords(c.id, ['אחת', 'שתיים']);
  db.setProduction(c.id, { state: 'generated' });
  const rec = db.getCollection(c.id);
  const prod = (rec.order && rec.order.production) || rec.production;
  fs.writeFileSync(path.join(genDir, c.id + '.pdf'), '%PDF-1.4 deck');
  const pd = path.join(genDir, c.id + '.proof');
  fs.mkdirSync(pd, { recursive: true });
  const files = [];
  for (let n = 1; n <= pages; n++) {
    const f = String(n).padStart(4, '0') + '.webp';
    fs.writeFileSync(path.join(pd, f), 'RIFFwebp');
    files.push(f);
  }
  fs.writeFileSync(path.join(pd, 'proof.json'), JSON.stringify({ pages, files, width: 320 }));
  return { c, token: prod && prod.pdf_token, owner: rec.owner_token, pages };
}

const get = (p, opts) => fetch(base + p, opts);

describe('features.deck_proof — ON (the default)', () => {
  it('defaults to true, so the proof works exactly as it did before the switch', async () => {
    expect(settings.get('features', 'deck_proof')).toBe(true);
    const { c, token, owner } = produced('הדר בת 30', 4);

    const manifest = await get('/api/collections/' + c.id + '/proof?t=' + token);
    expect(manifest.status).toBe(200);
    expect((await manifest.json()).pages).toBe(4);

    const page = await get('/api/collections/' + c.id + '/proof/2?t=' + token);
    expect(page.status).toBe(200);

    const state = await get('/api/collections/' + c.id + '/produce?k=' + owner);
    const body = await state.json();
    expect(body.state).toBe('ready');
    expect(body.proof_url).toContain('/proof.html?c=' + c.id);
  });
});

describe('features.deck_proof — OFF', () => {
  it('refuses the buyer, and says it is switched off rather than blaming her link', async () => {
    const { c, token } = produced('דנה בת 40');
    settings.set('features', 'deck_proof', false);

    const manifest = await get('/api/collections/' + c.id + '/proof?t=' + token);
    expect(manifest.status).toBe(403);
    expect((await manifest.json()).error).toBe('off');

    const page = await get('/api/collections/' + c.id + '/proof/1?t=' + token);
    expect(page.status).toBe(403);
    expect((await page.json()).error).toBe('off');
  });

  it('still checks the token FIRST — a stranger learns nothing about the order', async () => {
    const { c } = produced('רותי בת 50');
    settings.set('features', 'deck_proof', false);
    // A wrong token is 'forbidden', not 'off': the flag is the owner's business,
    // and the answer to a guessed link must not change with it.
    const r = await get('/api/collections/' + c.id + '/proof?t=not-the-token');
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('forbidden');
  });

  it('drops proof_url from the produce answer, leaving the deck ready', async () => {
    const { c, owner } = produced('נועה בת 60');
    settings.set('features', 'deck_proof', false);
    const r = await get('/api/collections/' + c.id + '/produce?k=' + owner);
    const body = await r.json();
    // READY still — the deck is made either way; only her way in is withheld.
    expect(body.state).toBe('ready');
    expect(body.proof_url).toBeUndefined();
  });

  it('lets the OWNER through on the admin key, and hands it to her page', async () => {
    const { c, token } = produced('שירה בת 30');
    settings.set('features', 'deck_proof', false);

    const mine = await get('/api/collections/' + c.id + '/proof?t=' + token + '&key=' + ADMIN_KEY);
    expect(mine.status).toBe(200);
    const page = await get(
      '/api/collections/' + c.id + '/proof/1?t=' + token + '&key=' + ADMIN_KEY
    );
    expect(page.status).toBe(200);

    // …and her own admin link carries the key onward, or the page it lands on
    // would ask the gate again without one.
    const red = await get('/api/admin/collections/' + c.id + '/proof?key=' + ADMIN_KEY, {
      redirect: 'manual',
    });
    expect(red.status).toBe(302);
    const loc = red.headers.get('location');
    expect(loc).toContain('/proof.html?c=' + c.id);
    expect(loc).toContain('key=' + ADMIN_KEY);

    // A WRONG key is not a key: a buyer cannot guess her way past the switch.
    const forged = await get('/api/collections/' + c.id + '/proof?t=' + token + '&key=nope');
    expect(forged.status).toBe(403);
    expect((await forged.json()).error).toBe('off');
  });

  it('comes straight back when she switches it on again', async () => {
    const { c, token } = produced('יעל בת 40');
    settings.set('features', 'deck_proof', false);
    expect((await get('/api/collections/' + c.id + '/proof?t=' + token)).status).toBe(403);
    settings.set('features', 'deck_proof', true);
    expect((await get('/api/collections/' + c.id + '/proof?t=' + token)).status).toBe(200);
  });
});
