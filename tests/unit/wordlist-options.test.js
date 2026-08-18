// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// THE BUYER'S WORD-POOL MENU.
//
// A deck is 412 words and almost nobody writes 412, so the rest are drawn from a
// seed pool. Until now the pool was decided FOR the buyer — by her design, or by
// the owner editing the order — and this lets her choose it from her own
// collection page.
//
// What must hold, and why each one matters more than it looks:
//   • the menu is the OWNER'S: she says which pools are offered and what they are
//     called, and a pool she hasn't offered can never be selected,
//   • a disabled option is UNSELECTABLE, not merely hidden — otherwise switching
//     one off would leave it live for anyone who kept the page open,
//   • the pool a customer picks must still EXIST, because a stale name reaches
//     generator/topup.py at print time on an order that is already paid,
//   • picking a different pool DISCARDS the frozen 412-word bank, which was
//     frozen from the old one,
//   • and the pool's file name never leaves the server — she is choosing
//     "בדיחות פנימיות", not "friends-350.txt".
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let db;
let settings;
let wordlists;
let app;
let server;
let base;
let dataDir;
let pool; // a real pool name, taken from whatever the install actually ships

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wlopts-'));
  process.env.DATA_DIR = dataDir;
  for (const f of [
    'db.js',
    'settings.js',
    'wordlists.js',
    'pelecard.js',
    'notify.js',
    'index.js',
  ]) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  db = require(path.join(serverDir, 'db.js'));
  settings = require(path.join(serverDir, 'settings.js'));
  wordlists = require(path.join(serverDir, 'wordlists.js'));
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

const setMenu = (list) => settings.set('wordlists', 'buyer_options', list);
// The pool stored on an order, or null. A collection that has never had one
// carries no `wordlist` field at all (createCollection does not seed it), so a
// refused write leaves `undefined` — which is "no pool", the same as null.
const poolOf = (id) => db.getCollection(id).wordlist || null;

async function putWordlist(id, k, option_id) {
  const res = await fetch(
    base + '/api/collections/' + id + '/wordlist?k=' + encodeURIComponent(k),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option_id }),
    }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('the menu the owner builds', () => {
  it('is empty by default, so no chooser is offered until she builds one', async () => {
    const r = await fetch(base + '/api/wordlist-options').then((x) => x.json());
    expect(r.options).toEqual([]);
  });

  it('shows enabled options by label, and never the pool file name', async () => {
    setMenu([
      { id: 'jokes', label: 'בדיחות פנימיות', pool, enabled: true },
      { id: 'hidden', label: 'עוד לא מוכן', pool, enabled: false },
    ]);
    const r = await fetch(base + '/api/wordlist-options').then((x) => x.json());
    expect(r.options).toEqual([{ id: 'jokes', label: 'בדיחות פנימיות' }]);
    expect(JSON.stringify(r)).not.toContain(pool);
  });

  it('refuses a malformed menu rather than storing it', () => {
    expect(settings.validateValue('wordlists', 'buyer_options', [{ id: 'x' }])).toBeTruthy();
    // A pool name that could escape the pool directory is refused outright.
    expect(
      settings.validateValue('wordlists', 'buyer_options', [
        { id: 'x', label: 'l', pool: '../../etc/passwd', enabled: true },
      ])
    ).toBe('bad pool name');
    for (const bad of ['pool/list.txt', 'pool\\list.txt', '..txt', 'list.txt.bak', '']) {
      expect(
        settings.validateValue('wordlists', 'buyer_options', [
          { id: 'x', label: 'l', pool: bad, enabled: true },
        ])
      ).toBeTruthy();
    }
  });

  // The owner names her pools in Hebrew, with spaces — wordlists.js accepts
  // exactly that, and the menu used to refuse it. A pool she can create, see in
  // the dropdown and pick, and then cannot save, is a dead end with no way out
  // of it from the screen.
  it('accepts any pool name wordlists.js itself would create', () => {
    const named = 'יום הולדת ילדים.txt';
    expect(wordlists.safeName(named)).toBe(named);
    expect(
      settings.validateValue('wordlists', 'buyer_options', [
        { id: 'kids', label: 'ילדים', pool: named, enabled: true },
      ])
    ).toBe(null);
    // …and the one that started it: a real Hebrew-named pool saved onto the menu.
    const created = wordlists.create({ name: 'בדיחות פנימיות', text: 'אחת\nשתיים\nשלוש' });
    expect(created.error).toBeUndefined();
    expect(created.name).toBe('בדיחות פנימיות.txt');
    expect(
      settings.set('wordlists', 'buyer_options', [
        { id: 'jokes', label: 'בדיחות פנימיות', pool: created.name, enabled: true },
      ])
    ).toBeTruthy();
    expect(settings.get('wordlists', 'buyer_options')[0].pool).toBe('בדיחות פנימיות.txt');
  });
});

describe('PUT /api/collections/:id/wordlist', () => {
  it('stores the pool behind the option she picked, and answers with the option', async () => {
    setMenu([{ id: 'jokes', label: 'בדיחות פנימיות', pool, enabled: true }]);
    const c = db.createCollection('בדיקה', {});
    const r = await putWordlist(c.id, c.owner_token, 'jokes');
    expect(r.status).toBe(200);
    expect(r.body.option_id).toBe('jokes');
    // The ORDER holds the pool — that is what the generator needs.
    expect(poolOf(c.id)).toBe(pool);
  });

  it('an empty pick clears it, so the deck fills by her design again', async () => {
    setMenu([{ id: 'jokes', label: 'בדיחות פנימיות', pool, enabled: true }]);
    const c = db.createCollection('בדיקה', {});
    await putWordlist(c.id, c.owner_token, 'jokes');
    const r = await putWordlist(c.id, c.owner_token, '');
    expect(r.status).toBe(200);
    expect(r.body.option_id).toBe(null);
    expect(poolOf(c.id)).toBe(null);
  });

  it('refuses an option that is not on the menu', async () => {
    setMenu([{ id: 'jokes', label: 'בדיחות פנימיות', pool, enabled: true }]);
    const c = db.createCollection('בדיקה', {});
    const r = await putWordlist(c.id, c.owner_token, 'not-a-thing');
    expect(r.status).toBe(400);
    expect(poolOf(c.id)).toBe(null);
  });

  it('refuses a DISABLED option — switching one off makes it unselectable', async () => {
    setMenu([{ id: 'off', label: 'כבוי', pool, enabled: false }]);
    const c = db.createCollection('בדיקה', {});
    const r = await putWordlist(c.id, c.owner_token, 'off');
    expect(r.status).toBe(400);
    expect(poolOf(c.id)).toBe(null);
  });

  it('refuses an option whose pool has since been deleted', async () => {
    setMenu([{ id: 'gone', label: 'רשימה שנמחקה', pool: 'no-such-pool.txt', enabled: true }]);
    const c = db.createCollection('בדיקה', {});
    const r = await putWordlist(c.id, c.owner_token, 'gone');
    expect(r.status).toBe(409);
    expect(poolOf(c.id)).toBe(null);
  });

  it('403 on a wrong owner token', async () => {
    setMenu([{ id: 'jokes', label: 'בדיחות', pool, enabled: true }]);
    const c = db.createCollection('בדיקה', {});
    const r = await putWordlist(c.id, 'nope', 'jokes');
    expect(r.status).toBe(403);
    expect(poolOf(c.id)).toBe(null);
  });

  it('409 once the collection is closed — the 412 are frozen by then', async () => {
    setMenu([{ id: 'jokes', label: 'בדיחות', pool, enabled: true }]);
    const c = db.createCollection('בדיקה', {});
    await putWordlist(c.id, c.owner_token, 'jokes');
    db.closeCollection(c.id, c.owner_token);
    const r = await putWordlist(c.id, c.owner_token, '');
    expect(r.status).toBe(409);
    expect(poolOf(c.id)).toBe(pool);
  });
});

describe('the frozen word bank', () => {
  it('is discarded when the pool changes, and kept when the pick does not', async () => {
    const second = wordlists.list()[1] ? wordlists.list()[1].name : null;
    setMenu([
      { id: 'a', label: 'א', pool, enabled: true },
      ...(second ? [{ id: 'b', label: 'ב', pool: second, enabled: true }] : []),
    ]);
    const c = db.createCollection('בדיקה', {});
    await putWordlist(c.id, c.owner_token, 'a');
    db.addWords(c.id, ['מילה'], 'בדיקה');
    // Stand in for a real freeze — the shape the bank check reads.
    db.getCollection(c.id).word_bank = { version: 1, words: ['מילה'] };

    // Re-picking the SAME option must not cost her the bank.
    await putWordlist(c.id, c.owner_token, 'a');
    expect(db.getCollection(c.id).word_bank).toBeTruthy();

    // A real change must: those 412 were chosen from the old pool.
    if (second) {
      await putWordlist(c.id, c.owner_token, 'b');
      expect(db.getCollection(c.id).word_bank).toBeUndefined();
    }
  });
});

describe('GET /api/collections/:id — the pick', () => {
  it('tells the OWNER which option she is on, and a contributor nothing', async () => {
    setMenu([{ id: 'jokes', label: 'בדיחות', pool, enabled: true }]);
    const c = db.createCollection('בדיקה', {});
    await putWordlist(c.id, c.owner_token, 'jokes');
    const owner = await fetch(
      base + '/api/collections/' + c.id + '?k=' + encodeURIComponent(c.owner_token)
    ).then((r) => r.json());
    expect(owner.wordlist_option).toBe('jokes');
    // Never the pool file name, even to the owner: she picked a label.
    expect(JSON.stringify(owner)).not.toContain(pool);
    const guest = await fetch(base + '/api/collections/' + c.id).then((r) => r.json());
    expect('wordlist_option' in guest).toBe(false);
  });
});
