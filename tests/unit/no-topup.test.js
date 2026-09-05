// @vitest-environment node
// THE DECK SHE ASKED US NOT TO FILL.
//
// A deck is 412 words and almost nobody writes 412, so the rest come from a seed
// pool. Some buyers do not want them: they want the remaining cards printed
// BLANK — numbered 1-4 and otherwise empty — to laminate and write on at the
// table. This is that choice, end to end.
//
// What has to hold:
//   • it is the OWNER'S to offer: switched off, the control never renders AND the
//     route refuses it, because a switch that only hides a control is not one,
//   • it is the buyer's to make while her collection is open, and nobody's after
//     it closes,
//   • it DISCARDS a frozen word bank, which was frozen with our filler in it,
//   • the freeze on a no-fill order stores her words and nothing else,
//   • and it reaches the generator — on the customer's deck and on the print
//     shop's file, which are the same deck asked for twice.
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
let settings;
let wordBank;
let app;
let server;
let base;
let dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-notopup-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_KEY = 'test-admin-key';
  for (const f of ['db.js', 'settings.js', 'wordlists.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  settings = require(path.join(serverDir, 'settings.js'));
  wordBank = require(path.join(serverDir, 'word-bank.js'));
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
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const offer = (on) => settings.set('wordlists', 'blank_option', on);

async function putNoTopup(id, k, no_topup) {
  const res = await realFetch(
    base + '/api/collections/' + id + '/no-topup?k=' + encodeURIComponent(k),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ no_topup }),
    }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const BASE_ARGS = {
  theme: 'bachelorette',
  name: 'Shira',
  wordsFile: '/tmp/words.txt',
  outPath: '/tmp/out.pdf',
};

describe('the owner decides whether it is offered at all', () => {
  it('is offered by default, alongside whatever pool menu she has built', async () => {
    offer(true);
    const r = await realFetch(base + '/api/wordlist-options').then((x) => x.json());
    expect(r.blank).toBe(true);
  });

  it('switched off, the menu says so', async () => {
    offer(false);
    const r = await realFetch(base + '/api/wordlist-options').then((x) => x.json());
    expect(r.blank).toBe(false);
    offer(true);
  });

  it('switched off, the route REFUSES it — hiding the control is not enough', async () => {
    offer(false);
    const c = db.createCollection('בדיקה', {});
    const r = await putNoTopup(c.id, c.owner_token, true);
    expect(r.status).toBe(409);
    expect(db.getCollection(c.id).no_topup).toBeFalsy();
    offer(true);
  });

  it('switched off, she can still UNSET one she already had', async () => {
    // Otherwise the switch traps every order that took the offer while it stood:
    // the control is gone, the route refuses, and the deck prints half empty.
    offer(true);
    const c = db.createCollection('בדיקה', {});
    await putNoTopup(c.id, c.owner_token, true);
    offer(false);
    const r = await putNoTopup(c.id, c.owner_token, false);
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).no_topup).toBe(false);
    offer(true);
  });
});

describe('PUT /api/collections/:id/no-topup', () => {
  it('stores the choice and answers with it', async () => {
    const c = db.createCollection('בדיקה', {});
    const r = await putNoTopup(c.id, c.owner_token, true);
    expect(r.status).toBe(200);
    expect(r.body.no_topup).toBe(true);
    expect(db.getCollection(c.id).no_topup).toBe(true);
  });

  it('is owner-token gated, like every other choice on her sheet', async () => {
    const c = db.createCollection('בדיקה', {});
    const r = await putNoTopup(c.id, 'not-her-token', true);
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).no_topup).toBeFalsy();
  });

  it('is refused once the collection is closed and the deck is in production', async () => {
    const c = db.createCollection('בדיקה', {});
    db.closeCollection(c.id, c.owner_token);
    const r = await putNoTopup(c.id, c.owner_token, true);
    expect(r.status).toBe(409);
    expect(db.getCollection(c.id).no_topup).toBeFalsy();
  });

  it('leaves her seed-pool pick alone, so un-ticking gives it back', async () => {
    const c = db.createCollection('בדיקה', {});
    db.adminUpdateCollection(c.id, { wordlist: 'generic-350.txt' });
    await putNoTopup(c.id, c.owner_token, true);
    expect(db.getCollection(c.id).wordlist).toBe('generic-350.txt');
    await putNoTopup(c.id, c.owner_token, false);
    expect(db.getCollection(c.id).wordlist).toBe('generic-350.txt');
  });

  it('is on the view the collection page reads, and only for the owner', async () => {
    const c = db.createCollection('בדיקה', {});
    await putNoTopup(c.id, c.owner_token, true);
    const mine = await realFetch(
      base + '/api/collections/' + c.id + '?k=' + encodeURIComponent(c.owner_token)
    ).then((x) => x.json());
    expect(mine.no_topup).toBe(true);
    // A guest adding words is not shown how the deck is being filled — it is
    // not her decision and not her business.
    const guest = await realFetch(base + '/api/collections/' + c.id).then((x) => x.json());
    expect(guest.no_topup).toBeUndefined();
  });
});

describe('the frozen word bank', () => {
  it('is discarded when she changes her mind — it holds filler she no longer wants', () => {
    const c = db.createCollection('בדיקה', {});
    db.setWordBank(c.id, { theme: 'bachelorette', pool: null, words: ['אחת'] });
    db.setNoTopupForOwner(c.id, c.owner_token, true);
    expect(db.getCollection(c.id).word_bank).toBeUndefined();
  });

  it('survives re-saving the SAME answer, which changes no input', () => {
    const c = db.createCollection('בדיקה', {});
    db.setNoTopupForOwner(c.id, c.owner_token, true);
    db.setWordBank(c.id, { theme: 'bachelorette', pool: null, words: ['אחת'] });
    db.setNoTopupForOwner(c.id, c.owner_token, true);
    expect(db.getCollection(c.id).word_bank).toBeTruthy();
  });

  it('goes stale when the order and the bank disagree about being filled', () => {
    const filled = { theme: 'bachelorette', pool: null, no_topup: false };
    expect(wordBank.isStale({ theme: 'bachelorette', word_bank: filled })).toBe(false);
    expect(wordBank.isStale({ theme: 'bachelorette', no_topup: true, word_bank: filled })).toBe(
      true
    );
  });

  it('a no-fill bank cannot go stale from a pool it never read', () => {
    // The pool is not one of its inputs, so changing it must not throw away a
    // bank that is still exactly right.
    const bank = { theme: 'bachelorette', pool: null, no_topup: true };
    expect(
      wordBank.isStale({
        theme: 'bachelorette',
        no_topup: true,
        wordlist: 'grown-ups.txt',
        word_bank: bank,
      })
    ).toBe(false);
  });

  it('freezes HER WORDS and no filler', () => {
    const bank = wordBank.freeze({
      personalWords: ['חתונה', '  חתונה ', 'ירח דבש'],
      theme: 'bachelorette',
      pool: null,
      noTopup: true,
    });
    // Python may be absent on a dev box; the freeze is best-effort by design and
    // a null there is the documented "print it the old way", not a failure.
    if (!bank) return;
    expect(bank.words).toEqual(['חתונה', 'ירח דבש']);
    expect(bank.no_topup).toBe(true);
    expect(bank.personal_count).toBe(2);
  });

  it('still fills an ordinary order to a full deck', () => {
    const bank = wordBank.freeze({
      personalWords: ['חתונה', 'ירח דבש'],
      theme: 'bachelorette',
      pool: null,
    });
    if (!bank) return;
    expect(bank.no_topup).toBe(false);
    expect(bank.words.length).toBeGreaterThan(400);
  });
});

describe('the choice reaches the generator', () => {
  it('is a bare flag on the argv', () => {
    expect(app.orderArgs({ ...BASE_ARGS, noTopup: true })).toContain('--no-topup');
  });

  it('says nothing at all for an ordinary order', () => {
    // Every past order must produce the argv it always did, or "the same words
    // give the same deck" stops being true across this change.
    const plain = app.orderArgs(BASE_ARGS);
    for (const noTopup of [null, undefined, false, '']) {
      expect(app.orderArgs({ ...BASE_ARGS, noTopup })).toEqual(plain);
    }
  });

  it('is on the print shop file too, not just the customer download', () => {
    const full = { ...BASE_ARGS, noTopup: true };
    const customer = app.orderArgs({ ...full, outPath: '/tmp/deck.pdf' });
    const press = app.orderArgs({ ...full, outPath: '/tmp/deck.press.partial' });
    expect(customer).toContain('--no-topup');
    expect(press).toContain('--no-topup');
  });
});

describe('the owner can set it on the order herself', () => {
  it('takes it over the phone, through the admin edit', async () => {
    const c = db.createCollection('בדיקה', {});
    const res = await realFetch(base + '/api/admin/collections/' + c.id + '?key=test-admin-key', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ no_topup: true }),
    });
    expect(res.status).toBe(200);
    expect(db.getCollection(c.id).no_topup).toBe(true);
  });

  it('and can still set it after the collection has closed, when the buyer cannot', async () => {
    const c = db.createCollection('בדיקה', {});
    db.closeCollection(c.id, c.owner_token);
    await realFetch(base + '/api/admin/collections/' + c.id + '?key=test-admin-key', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ no_topup: true }),
    });
    expect(db.getCollection(c.id).no_topup).toBe(true);
  });
});
