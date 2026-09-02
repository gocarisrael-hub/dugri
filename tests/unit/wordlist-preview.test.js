// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// THE WORDS THEMSELVES, IN PUBLIC.
//
// The wizard offers the filler pools by LABEL only — "רווקות", "משפחתי" — and
// that label is a promise about roughly 300 of the 412 words that will be
// printed on her cards. /api/wordlist-preview is that promise itemised, and
// site/wordlists.html is what reads it.
//
// It widens what leaves the server, so what matters here is the edge of it:
//   • only a pool the owner has ENABLED as a buyer option is readable — this
//     route must never become a way to read any file in the pool directory,
//   • a disabled option is unreadable, not merely unlisted, exactly like the
//     menu it mirrors,
//   • the pool FILE NAME still never leaves the server,
//   • and one broken entry costs its own list, not the whole page.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let settings;
let wordlists;
let app;
let server;
let base;
let dataDir;
let pool;
let secretPool; // a real pool that is NOT on the menu

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wlprev-'));
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
  require(path.join(serverDir, 'db.js'));
  settings = require(path.join(serverDir, 'settings.js'));
  wordlists = require(path.join(serverDir, 'wordlists.js'));
  app = require(path.join(serverDir, 'index.js'));
  const all = wordlists.list();
  pool = all[0].name;
  secretPool = (all[1] || all[0]).name;
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
const preview = () => fetch(base + '/api/wordlist-preview').then((r) => r.json());

describe('what the page can read', () => {
  it('is empty before the owner builds a menu — nothing to choose between, nothing to show', async () => {
    setMenu([]);
    expect((await preview()).lists).toEqual([]);
  });

  it('returns every word of an offered list, with its label and count', async () => {
    setMenu([{ id: 'jokes', label: 'בדיחות פנימיות', pool, enabled: true }]);
    const { lists } = await preview();
    expect(lists).toHaveLength(1);
    expect(lists[0].id).toBe('jokes');
    expect(lists[0].label).toBe('בדיחות פנימיות');
    // The words are the point: the whole pool, not a sample.
    const real = wordlists.read(pool).words;
    expect(lists[0].words).toEqual(real);
    // …and the count is the server's own, so the page cannot disagree with it.
    expect(lists[0].count).toBe(real.length);
  });

  it('never leaks the pool file name behind a list', async () => {
    setMenu([{ id: 'jokes', label: 'בדיחות פנימיות', pool, enabled: true }]);
    const body = JSON.stringify(await preview());
    // She is choosing "בדיחות פנימיות", not "friends-350.txt" — the production
    // name is not hers to learn, here any more than on the menu.
    expect(body).not.toContain(pool);
  });
});

describe('the edge of it', () => {
  it('will not read a pool that is not on the menu', async () => {
    // The route takes an OPTION, never a pool name, so a pool the owner has not
    // offered is unreachable — this is the property that stops it becoming a
    // reader for the whole pool directory.
    setMenu([{ id: 'jokes', label: 'בדיחות פנימיות', pool, enabled: true }]);
    const { lists } = await preview();
    expect(lists.map((l) => l.label)).toEqual(['בדיחות פנימיות']);
    if (secretPool !== pool) {
      expect(JSON.stringify(lists)).not.toContain(secretPool);
    }
  });

  it('will not read a DISABLED option — switching one off hides its words too', async () => {
    setMenu([
      { id: 'on', label: 'מוצג', pool, enabled: true },
      { id: 'off', label: 'כבוי', pool: secretPool, enabled: false },
    ]);
    const { lists } = await preview();
    expect(lists.map((l) => l.id)).toEqual(['on']);
  });

  it('skips a list whose pool has gone missing, and still serves the rest', async () => {
    // A menu entry can outlive its file. One broken entry must cost its own list
    // and not the other five — a 500 here is a blank page for everybody.
    setMenu([
      { id: 'ok', label: 'קיימת', pool, enabled: true },
      { id: 'gone', label: 'נעלמה', pool: 'no-such-pool.txt', enabled: true },
    ]);
    const res = await fetch(base + '/api/wordlist-preview');
    expect(res.status).toBe(200);
    const { lists } = await res.json();
    expect(lists.map((l) => l.id)).toEqual(['ok']);
  });

  it('is never cached — an edited list must not keep serving yesterday’s words', async () => {
    // Same rule as the pricing APIs: an in-app browser holding this would show a
    // list the owner has since changed.
    const res = await fetch(base + '/api/wordlist-preview');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('needs no key — this is a page a shopper reads before she has an order', async () => {
    setMenu([{ id: 'jokes', label: 'בדיחות פנימיות', pool, enabled: true }]);
    const res = await fetch(base + '/api/wordlist-preview');
    expect(res.status).toBe(200);
  });
});

describe('it agrees with the menu the wizard shows', () => {
  it('offers exactly the lists the chooser offers, in the same order', async () => {
    // Two doors onto one decision: if they disagreed, she would read one list and
    // pick another.
    setMenu([
      { id: 'a', label: 'ראשונה', pool, enabled: true },
      { id: 'b', label: 'שנייה', pool: secretPool, enabled: true },
      { id: 'c', label: 'כבויה', pool, enabled: false },
    ]);
    const menu = await fetch(base + '/api/wordlist-options').then((r) => r.json());
    const { lists } = await preview();
    expect(lists.map((l) => ({ id: l.id, label: l.label }))).toEqual(menu.options);
  });
});
