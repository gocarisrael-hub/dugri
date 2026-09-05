// @vitest-environment node
// THE DECK SHE ASKED US NOT TO FILL.
//
// A deck is 412 words and almost nobody writes 412, so the rest come from a seed
// pool. Some buyers do not want them: they want the remaining cards printed
// BLANK — numbered 1-4 and otherwise empty — to laminate and write on at the
// table. This is that choice, end to end.
//
// It is not a control beside the pool menu — it is the LAST ROW OF IT. One
// question ("which of our words go on the rest of your cards?"), one radio group,
// and this is one of the answers.
//
// What has to hold:
//   • it is the OWNER'S to offer: with no label it is not a row at all AND the
//     route refuses it, because a menu that only hides a row is not a menu,
//   • it rides along with the menu and is never the only row — a radio group
//     cannot be un-picked, so a lone decline would be a choice with no way back,
//   • picking a real list un-declines, because they are answers to one question,
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
let wordlists;
let wordBank;
let app;
let pool; // a real pool name, so the menu these tests build is one that works
const BLANK = '__blank__';
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
  wordlists = require(path.join(serverDir, 'wordlists.js'));
  wordBank = require(path.join(serverDir, 'word-bank.js'));
  app = require(path.join(serverDir, 'index.js'));
  pool = wordlists.list()[0].name;
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

// The decline is offered by GIVING IT A LABEL; empty means it is not a row.
const offer = (label) => settings.set('wordlists', 'blank_label', label);
// ...and it only ever rides along with a menu, so most tests need one.
const setMenu = (list) => settings.set('wordlists', 'buyer_options', list);
const aMenu = () => setMenu([{ id: 'jokes', label: 'בדיחות פנימיות', pool, enabled: true }]);

async function pick(id, k, option_id) {
  const res = await realFetch(
    base + '/api/collections/' + id + '/wordlist?k=' + encodeURIComponent(k),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option_id }),
    }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const putNoTopup = (id, k, on) => pick(id, k, on ? BLANK : '');

const BASE_ARGS = {
  theme: 'bachelorette',
  name: 'Shira',
  wordsFile: '/tmp/words.txt',
  outPath: '/tmp/out.pdf',
};

describe('it is the last row of the pool menu', () => {
  it('is served with the pools, under the label the owner gave it', async () => {
    aMenu();
    offer('לא להשלים לי מילים');
    const r = await realFetch(base + '/api/wordlist-options').then((x) => x.json());
    expect(r.options).toEqual([
      { id: 'jokes', label: 'בדיחות פנימיות' },
      { id: BLANK, label: 'לא להשלים לי מילים' },
    ]);
  });

  it('is NEVER the only row — a radio group has no way back out of one', async () => {
    // The menu is what makes the decline undoable: she un-declines by picking a
    // list. Offered alone it would be a one-way door on the last screen.
    setMenu([]);
    offer('לא להשלים לי מילים');
    const r = await realFetch(base + '/api/wordlist-options').then((x) => x.json());
    expect(r.options).toEqual([]);
    aMenu();
  });

  it('with no label it is not a row, and the route REFUSES it', async () => {
    aMenu();
    offer('');
    const c = db.createCollection('בדיקה', {});
    const r = await pick(c.id, c.owner_token, BLANK);
    expect(r.status).toBe(409);
    expect(db.getCollection(c.id).no_topup).toBeFalsy();
    offer('לא להשלים לי מילים');
  });

  it('withdrawn, she can still un-decline an order that already took it', async () => {
    // Otherwise clearing the label traps every order made while it stood: the
    // row is gone, the route refuses, and the deck prints half empty.
    aMenu();
    offer('לא להשלים לי מילים');
    const c = db.createCollection('בדיקה', {});
    await pick(c.id, c.owner_token, BLANK);
    offer('');
    const r = await pick(c.id, c.owner_token, '');
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).no_topup).toBe(false);
    offer('לא להשלים לי מילים');
  });
});

describe('picking it, and picking away from it', () => {
  it('stores the choice and answers with the row she is on', async () => {
    aMenu();
    offer('לא להשלים לי מילים');
    const c = db.createCollection('בדיקה', {});
    const r = await pick(c.id, c.owner_token, BLANK);
    expect(r.status).toBe(200);
    expect(r.body.option_id).toBe(BLANK);
    expect(db.getCollection(c.id).no_topup).toBe(true);
  });

  it('picking a real list un-declines — they answer the same question', async () => {
    aMenu();
    offer('לא להשלים לי מילים');
    const c = db.createCollection('בדיקה', {});
    await pick(c.id, c.owner_token, BLANK);
    const r = await pick(c.id, c.owner_token, 'jokes');
    expect(r.status).toBe(200);
    expect(r.body.option_id).toBe('jokes');
    expect(db.getCollection(c.id).no_topup).toBe(false);
    expect(db.getCollection(c.id).wordlist).toBe(pool);
  });

  it('the declined row is what the sheet reports, over any pool underneath it', async () => {
    // She may have picked a list before changing her mind. We keep the pool (so
    // the row she used to be on is still there), but what is TICKED has to be
    // what we are actually going to print.
    aMenu();
    offer('לא להשלים לי מילים');
    const c = db.createCollection('בדיקה', {});
    await pick(c.id, c.owner_token, 'jokes');
    await pick(c.id, c.owner_token, BLANK);
    expect(db.getCollection(c.id).wordlist).toBe(pool);
    const sheet = await realFetch(
      base + '/api/collections/' + c.id + '?k=' + encodeURIComponent(c.owner_token)
    ).then((x) => x.json());
    expect(sheet.wordlist_option).toBe(BLANK);
  });

  it('is owner-token gated, like every other choice on her sheet', async () => {
    aMenu();
    offer('לא להשלים לי מילים');
    const c = db.createCollection('בדיקה', {});
    const r = await putNoTopup(c.id, 'not-her-token', true);
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).no_topup).toBeFalsy();
  });

  it('is refused once the collection is closed and the deck is in production', async () => {
    aMenu();
    offer('לא להשלים לי מילים');
    const c = db.createCollection('בדיקה', {});
    db.closeCollection(c.id, c.owner_token);
    const r = await putNoTopup(c.id, c.owner_token, true);
    expect(r.status).toBe(409);
    expect(db.getCollection(c.id).no_topup).toBeFalsy();
  });

  it('is on the view the collection page reads, and only for the owner', async () => {
    aMenu();
    offer('לא להשלים לי מילים');
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
