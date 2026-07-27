// @vitest-environment node
//
// The owner-editable seed word pools ("wordlists"). The ONE thing that must never
// break here is persistence: content/wordlists is baked into the ephemeral Docker
// image, so every write has to land under DATA_DIR (the Railway volume) and
// SHADOW the shipped file rather than mutate it. These tests boot the real Express
// app (like tests/unit/generate-routes.test.js) with DATA_DIR pointed at a temp
// dir, and assert the store's guards from both sides — module and HTTP.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const SHIPPED_DIR = path.join(__dirname, '..', '..', 'content', 'wordlists');

const ADMIN_KEY = 'test-admin-key';
let app;
let store;
let server;
let base;
let dataDir;
let storeDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wordlists-'));
  storeDir = path.join(dataDir, 'wordlists');
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'wordlists.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  store = require(path.join(serverDir, 'wordlists.js'));
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

// Each test starts from an empty volume store — so "did this write land on the
// volume?" is always an unambiguous question.
beforeEach(() => {
  fs.rmSync(storeDir, { recursive: true, force: true });
});

const key = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;

async function req(method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// A theme map fixture, so the delete/linkage guards are tested against known
// values instead of whatever generator/themes.json happens to hold today.
const THEMES = {
  'trip comeback': { display_he: 'טיול', wordlist: 'friends-350.txt' },
  bachelorette: { display_he: 'רווקות', wordlist: 'bachelorette-350.txt' },
  japanese: { display_he: 'יפני' }, // names none -> implicitly generic-350.txt
};

describe('wordlists store — persistence (DATA_DIR, not the image)', () => {
  it('the shipped baseline is visible without any volume store at all', () => {
    const all = store.list(THEMES);
    const generic = all.find((w) => w.name === 'generic-350.txt');
    expect(generic).toBeTruthy();
    expect(generic.source).toBe('shipped');
    expect(generic.count).toBe(350);
    expect(fs.existsSync(storeDir)).toBe(false);
  });

  it('creating a list writes it under DATA_DIR and NOWHERE else', () => {
    const rec = store.create({ name: 'retirement-test', text: 'פנסיה\nמסיבה\nעוגה' });
    expect(rec.name).toBe('retirement-test.txt');
    expect(rec.source).toBe('custom');
    expect(rec.words).toEqual(['פנסיה', 'מסיבה', 'עוגה']);
    // on the persistent volume...
    expect(fs.existsSync(path.join(storeDir, 'retirement-test.txt'))).toBe(true);
    // ...and never in the image's read-only baseline
    expect(fs.existsSync(path.join(SHIPPED_DIR, 'retirement-test.txt'))).toBe(false);
  });

  it('a fresh store instance re-reads what was written (survives a restart)', () => {
    store.create({ name: 'persist-test', text: 'א\nב' });
    delete require.cache[require.resolve(path.join(serverDir, 'wordlists.js'))];
    const reloaded = require(path.join(serverDir, 'wordlists.js'));
    expect(reloaded.read('persist-test.txt').words).toEqual(['א', 'ב']);
  });
});

describe('wordlists store — copy-on-write over a shipped list', () => {
  it('editing a shipped list copies it to DATA_DIR and leaves the image untouched', () => {
    const before = fs.readFileSync(path.join(SHIPPED_DIR, 'generic-350.txt'), 'utf8');

    const rec = store.update('generic-350.txt', { text: 'מילה אחת\nמילה שתיים' });
    expect(rec.source).toBe('override');
    expect(rec.words).toEqual(['מילה אחת', 'מילה שתיים']);

    // the override exists on the volume
    expect(fs.existsSync(path.join(storeDir, 'generic-350.txt'))).toBe(true);
    // and the shipped original is byte-for-byte unchanged
    expect(fs.readFileSync(path.join(SHIPPED_DIR, 'generic-350.txt'), 'utf8')).toBe(before);

    // the override is what a reader (and the generator) now resolves to
    expect(store.resolveWordlist('generic-350.txt').abs).toBe(
      path.join(storeDir, 'generic-350.txt')
    );
    expect(store.list(THEMES).find((w) => w.name === 'generic-350.txt').source).toBe('override');
  });

  it('revert drops the override so the shipped original is live again', () => {
    store.update('generic-350.txt', { text: 'רק זה' });
    const rec = store.revert('generic-350.txt');
    expect(rec.source).toBe('shipped');
    expect(rec.count).toBe(350);
    expect(fs.existsSync(path.join(storeDir, 'generic-350.txt'))).toBe(false);
  });

  it('revert is refused when there is nothing to revert', () => {
    expect(store.revert('generic-350.txt').httpStatus).toBe(409);
    store.create({ name: 'own-list', text: 'א' });
    expect(store.revert('own-list.txt').httpStatus).toBe(409);
  });
});

describe('wordlists store — delete guards', () => {
  it('refuses to delete a list a theme still references, and names the themes', () => {
    const r = store.remove('friends-350.txt', THEMES);
    expect(r.httpStatus).toBe(409);
    expect(r.error).toContain('trip comeback');
    expect(r.themes).toEqual(['trip comeback']);
    expect(fs.existsSync(path.join(SHIPPED_DIR, 'friends-350.txt'))).toBe(true);
  });

  it('counts a theme that names NO wordlist as a user of generic-350.txt', () => {
    expect(store.themesUsing('generic-350.txt', THEMES)).toEqual(['japanese']);
    const r = store.remove('generic-350.txt', THEMES);
    expect(r.httpStatus).toBe(409);
    expect(r.error).toContain('japanese');
  });

  it('refuses to delete an unreferenced SHIPPED list and explains the redeploy', () => {
    // family-350.txt ships but no theme in the fixture points at it.
    expect(store.themesUsing('family-350.txt', THEMES)).toEqual([]);
    const r = store.remove('family-350.txt', THEMES);
    expect(r.httpStatus).toBe(409);
    expect(r.error).toContain('תחזור');
    expect(fs.existsSync(path.join(SHIPPED_DIR, 'family-350.txt'))).toBe(true);
  });

  it('refuses to delete a shipped list even when it has been edited (an override)', () => {
    store.update('family-350.txt', { text: 'א\nב' });
    const r = store.remove('family-350.txt', THEMES);
    expect(r.httpStatus).toBe(409);
    // the override survives — delete must not silently become a revert
    expect(fs.existsSync(path.join(storeDir, 'family-350.txt'))).toBe(true);
  });

  it('deletes an unreferenced owner-created list', () => {
    store.create({ name: 'throwaway', text: 'א\nב' });
    expect(store.remove('throwaway.txt', THEMES)).toEqual({ ok: true, name: 'throwaway.txt' });
    expect(fs.existsSync(path.join(storeDir, 'throwaway.txt'))).toBe(false);
  });
});

describe('wordlists store — paste parsing, dedup, normalization', () => {
  it('splits a pasted blob on newlines AND commas', () => {
    expect(store.parseWords('אחת, שתיים\nשלוש,ארבע')).toEqual(['אחת', 'שתיים', 'שלוש', 'ארבע']);
  });

  it('trims, collapses inner whitespace and drops blank lines', () => {
    expect(store.parseWords('  אחת  \n\n\n  שתיים   שלוש  \n')).toEqual(['אחת', 'שתיים שלוש']);
  });

  it('dedups case/space-insensitively, preserving first-seen order', () => {
    expect(store.parseWords(['Water', 'water', ' WATER ', 'Fire'])).toEqual(['Water', 'Fire']);
    expect(store.parseWords('מים\n מים \nאש')).toEqual(['מים', 'אש']);
  });

  it('uses the SAME dedup key as generator/topup.py _norm', () => {
    expect(store.normKey('  Two   Words  ')).toBe('two words');
  });

  it('caps a single word and the total list length', () => {
    expect(store.parseWords(['x'.repeat(200)])[0].length).toBe(store.MAX_WORD_LEN);
    const many = Array.from({ length: store.MAX_WORDS + 50 }, (_, i) => 'w' + i);
    expect(store.parseWords(many).length).toBe(store.MAX_WORDS);
  });

  it('append adds one word without disturbing existing order, and rejects a dup', () => {
    store.create({ name: 'append-test', text: 'אחת\nשתיים' });
    expect(store.update('append-test.txt', { append: 'שלוש' }).words).toEqual([
      'אחת',
      'שתיים',
      'שלוש',
    ]);
    expect(store.update('append-test.txt', { append: ' שתיים ' }).httpStatus).toBe(409);
  });

  it('refuses to save an empty list (a wiped textarea is never a valid save)', () => {
    store.create({ name: 'empty-test', text: 'אחת' });
    expect(store.update('empty-test.txt', { text: '   \n\n ' }).httpStatus).toBe(400);
    expect(store.read('empty-test.txt').words).toEqual(['אחת']);
  });
});

describe('wordlists store — name validation / traversal', () => {
  it('rejects every traversal shape rather than stripping it', () => {
    for (const bad of [
      '../db.json',
      '../../etc/passwd',
      'sub/dir.txt',
      '..\\win.txt',
      '..',
      '.txt',
      '',
      '   ',
      null,
    ]) {
      expect(store.safeName(bad)).toBeNull();
    }
  });

  it('accepts the shipped names and appends a missing .txt', () => {
    expect(store.safeName('generic-350.txt')).toBe('generic-350.txt');
    expect(store.safeName('hadar list.txt')).toBe('hadar list.txt');
    expect(store.safeName('retirement-350')).toBe('retirement-350.txt');
    expect(store.safeName('GENERIC-350.TXT')).toBe('GENERIC-350.txt');
    expect(store.safeName('רשימה חדשה')).toBe('רשימה חדשה.txt');
  });

  it('a traversal name never writes outside the store', () => {
    const r = store.create({ name: '../escaped', text: 'א' });
    expect(r.httpStatus).toBe(400);
    expect(fs.existsSync(path.join(dataDir, 'escaped.txt'))).toBe(false);
    expect(store.read('../generic-350.txt')).toBeNull();
    expect(store.update('../../x.txt', { text: 'א' }).httpStatus).toBe(400);
    expect(store.remove('../../x.txt').httpStatus).toBe(400);
  });

  it('create refuses a name that already exists (shipped or custom)', () => {
    expect(store.create({ name: 'generic-350.txt', text: 'א' }).httpStatus).toBe(409);
    store.create({ name: 'dupe-test', text: 'א' });
    expect(store.create({ name: 'dupe-test', text: 'ב' }).httpStatus).toBe(409);
  });
});

describe('admin wordlist routes', () => {
  it('every route is 403 without the admin key', async () => {
    expect((await req('GET', '/api/admin/wordlists')).status).toBe(403);
    expect((await req('GET', '/api/admin/wordlists/generic-350.txt')).status).toBe(403);
    expect((await req('POST', '/api/admin/wordlists', { name: 'x' })).status).toBe(403);
    expect((await req('PUT', '/api/admin/wordlists/generic-350.txt', { text: 'a' })).status).toBe(
      403
    );
    expect((await req('DELETE', '/api/admin/wordlists/generic-350.txt')).status).toBe(403);
    expect((await req('POST', '/api/admin/wordlists/generic-350.txt/revert')).status).toBe(403);
    // and the volume store was never touched by any of them
    expect(fs.existsSync(storeDir)).toBe(false);
  });

  it('GET lists every pool plus the read-only theme linkage', async () => {
    const r = await req('GET', key('/api/admin/wordlists'));
    expect(r.status).toBe(200);
    const generic = r.body.wordlists.find((w) => w.name === 'generic-350.txt');
    expect(generic.count).toBe(350);
    expect(generic.source).toBe('shipped');
    // linkage comes from the real generator/themes.json
    expect(r.body.themes.length).toBeGreaterThan(0);
    for (const t of r.body.themes) expect(t.wordlist).toMatch(/\.txt$/);
  });

  it('GET one pool returns its words; 404 for unknown/unsafe names', async () => {
    const r = await req('GET', key('/api/admin/wordlists/generic-350.txt'));
    expect(r.status).toBe(200);
    expect(r.body.words.length).toBe(350);
    expect((await req('GET', key('/api/admin/wordlists/nope.txt'))).status).toBe(404);
    expect(
      (await req('GET', key('/api/admin/wordlists/' + encodeURIComponent('../x')))).status
    ).toBe(404);
  });

  it('POST creates a list on the volume and GET reads it back', async () => {
    const r = await req('POST', key('/api/admin/wordlists'), {
      name: 'route-created',
      text: 'אחת, שתיים\nשלוש',
    });
    expect(r.status).toBe(201);
    expect(r.body.words).toEqual(['אחת', 'שתיים', 'שלוש']);
    expect(fs.existsSync(path.join(storeDir, 'route-created.txt'))).toBe(true);
    const g = await req('GET', key('/api/admin/wordlists/route-created.txt'));
    expect(g.body.source).toBe('custom');
  });

  it('PUT with a pasted blob replaces; PUT with append adds one word', async () => {
    await req('POST', key('/api/admin/wordlists'), { name: 'route-edit', text: 'א' });
    const replaced = await req('PUT', key('/api/admin/wordlists/route-edit.txt'), {
      text: 'ב\nג',
    });
    expect(replaced.body.words).toEqual(['ב', 'ג']);
    const appended = await req('PUT', key('/api/admin/wordlists/route-edit.txt'), {
      append: 'ד',
    });
    expect(appended.body.words).toEqual(['ב', 'ג', 'ד']);
  });

  it('PUT on a SHIPPED list copy-on-writes and never edits the image', async () => {
    const before = fs.readFileSync(path.join(SHIPPED_DIR, 'kids-birthday-350.txt'), 'utf8');
    const r = await req('PUT', key('/api/admin/wordlists/kids-birthday-350.txt'), {
      text: 'בלון\nעוגה',
    });
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('override');
    expect(fs.readFileSync(path.join(SHIPPED_DIR, 'kids-birthday-350.txt'), 'utf8')).toBe(before);
    // and revert puts it back
    const rev = await req('POST', key('/api/admin/wordlists/kids-birthday-350.txt/revert'));
    expect(rev.body.source).toBe('shipped');
    expect(rev.body.count).toBe(350);
  });

  it('DELETE is refused for a referenced list with the theme names in the message', async () => {
    // generic-350.txt is referenced by several real themes in generator/themes.json
    const r = await req('DELETE', key('/api/admin/wordlists/generic-350.txt'));
    expect(r.status).toBe(409);
    expect(r.body.themes.length).toBeGreaterThan(0);
    expect(r.body.error).toContain(r.body.themes[0]);
  });

  it('DELETE removes an owner-created list only', async () => {
    await req('POST', key('/api/admin/wordlists'), { name: 'route-del', text: 'א' });
    expect((await req('DELETE', key('/api/admin/wordlists/route-del.txt'))).status).toBe(200);
    expect(fs.existsSync(path.join(storeDir, 'route-del.txt'))).toBe(false);
    expect((await req('DELETE', key('/api/admin/wordlists/route-del.txt'))).status).toBe(404);
  });

  it('POST rejects a traversal name with 400 and writes nothing', async () => {
    const r = await req('POST', key('/api/admin/wordlists'), {
      name: '../../pwned',
      text: 'א',
    });
    expect(r.status).toBe(400);
    expect(fs.existsSync(path.join(dataDir, '..', 'pwned.txt'))).toBe(false);
  });
});
