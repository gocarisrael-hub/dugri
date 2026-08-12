// @vitest-environment node
// The per-order CARD ORDER: how one order's words are laid onto its cards.
// The owner picks it in the order edit dialog, beside the seed pool —
// 'personal-first' opens the deck with the buyer's own words, 'by-script' keeps
// Hebrew cards and Latin cards apart, and the default is the blend every deck
// has had until now. The arrangement rule itself lives in generator/pack.py and
// has its own tests; everything here is about the choice REACHING it — stored on
// the order, refused when it isn't real, and on the argv of BOTH the customer's
// deck and the print shop's file, which are the same deck asked for twice.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const realFetch = globalThis.fetch;

let db;
let app;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-card-order-'));
  process.env.ADMIN_KEY = 'test-admin-key';
  for (const f of ['db.js', 'settings.js', 'wordlists.js', 'notify.js', 'index.js']) {
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

const KEY = '?key=test-admin-key';
async function patch(id, body) {
  const res = await realFetch(base + '/api/admin/collections/' + id + KEY, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const BASE_ARGS = {
  theme: 'bachelorette',
  name: 'Shira',
  wordsFile: '/tmp/words.txt',
  outPath: '/tmp/out.pdf',
};

describe('the choice reaches the generator', () => {
  it('is one token, so a value can never be read as a flag', () => {
    for (const order of db.CARD_ORDERS) {
      const args = app.orderArgs({ ...BASE_ARGS, cardOrder: order });
      expect(args).toContain('--order=' + order);
    }
  });

  it('says nothing at all for the default', () => {
    // An order that never touched this must produce the argv it always did —
    // otherwise "the same words give the same deck" stops being true across the
    // change, and every past order's deck moves.
    const plain = app.orderArgs(BASE_ARGS);
    for (const cardOrder of [null, undefined, '', 'random']) {
      expect(app.orderArgs({ ...BASE_ARGS, cardOrder })).toEqual(
        cardOrder === 'random' ? [...plain, '--order=random'] : plain
      );
    }
  });

  it('drops a value the generator does not know rather than passing it on', () => {
    // argparse would reject it and kill the run; the door above refuses it
    // first, so this is the last line of defence, not the only one.
    for (const bad of ['alphabetical', 'personal_first', 'BY-SCRIPT', 42, {}]) {
      expect(app.orderArgs({ ...BASE_ARGS, cardOrder: bad })).toEqual(app.orderArgs(BASE_ARGS));
    }
  });

  it('is on the print shop file too, not just the customer download', () => {
    // The bug this guards is the one the owner found from the outside once
    // already: the press route building its own shorter argv, so the file the
    // print shop prints is not the deck she approved.
    const full = { ...BASE_ARGS, cardOrder: 'by-script' };
    const customer = app.orderArgs({ ...full, outPath: '/tmp/deck.pdf' });
    const press = app.orderArgs({ ...full, outPath: '/tmp/deck.press.partial' });
    expect(customer).toContain('--order=by-script');
    expect(press).toContain('--order=by-script');
    const diffs = customer
      .map((a, i) => [a, press[i]])
      .filter(([a, b]) => a !== b)
      .flat();
    expect(diffs).toEqual(['/tmp/deck.pdf', '/tmp/deck.press.partial']);
  });
});

describe('the choice on the order', () => {
  it('is stored from the admin dialog', async () => {
    const c = db.createCollection('לקוחה');
    const r = await patch(c.id, { card_order: 'personal-first' });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).card_order).toBe('personal-first');
  });

  it('clears back to the default with an empty value', async () => {
    const c = db.createCollection('לקוחה');
    await patch(c.id, { card_order: 'by-script' });
    await patch(c.id, { card_order: '' });
    expect(db.getCollection(c.id).card_order).toBe(null);
  });

  it('refuses an order it cannot produce', async () => {
    const c = db.createCollection('לקוחה');
    const r = await patch(c.id, { card_order: 'alphabetical' });
    expect(r.status).toBe(400);
    expect(db.getCollection(c.id).card_order).toBeFalsy();
  });

  it('is left alone by an edit that never mentions it', async () => {
    // PATCH semantics: saving the dialog after changing only the title must not
    // reset the deck's arrangement.
    const c = db.createCollection('לקוחה');
    await patch(c.id, { card_order: 'by-script' });
    await patch(c.id, { custom_title: 'החגיגה של שירה' });
    expect(db.getCollection(c.id).card_order).toBe('by-script');
  });

  it('does NOT throw away a frozen word bank', async () => {
    // The seed pool does, and must: change the pool and the stored 412 are no
    // longer what the order's inputs produce. The card order is different — the
    // same 412 words print either way, only their arrangement changes — so the
    // owner can switch it after the bank is frozen without costing the order the
    // list the customer approved.
    const c = db.createCollection('לקוחה');
    db.setWordBank(c.id, { words: ['אחת', 'שתיים', 'שלוש'] });
    expect(db.getCollection(c.id).word_bank).toBeTruthy();
    await patch(c.id, { card_order: 'personal-first' });
    const after = db.getCollection(c.id);
    expect(after.card_order).toBe('personal-first');
    expect(after.word_bank).toBeTruthy();
    expect(after.word_bank.words).toEqual(['אחת', 'שתיים', 'שלוש']);
  });
});
