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
let validate;
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

  for (const f of [
    'db.js',
    'pelecard.js',
    'notify.js',
    'wordlists.js',
    'validate.js',
    'index.js',
  ]) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  store = require(path.join(serverDir, 'wordlists.js'));
  validate = require(path.join(serverDir, 'validate.js'));
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

  // NO LIST IS THE SYSTEM'S ANY MORE. A shipped pool cannot be unlinked (it is in
  // the image), so deleting one leaves a tombstone on the volume that masks it.
  it('deletes an unreferenced SHIPPED list by masking it, leaving the image alone', () => {
    // family-350.txt ships but no theme in the fixture points at it.
    expect(store.themesUsing('family-350.txt', THEMES)).toEqual([]);
    expect(store.remove('family-350.txt', THEMES)).toEqual({ ok: true, name: 'family-350.txt' });
    // Gone from every reader…
    expect(store.read('family-350.txt')).toBeNull();
    expect(store.list(THEMES).some((w) => w.name === 'family-350.txt')).toBe(false);
    // …while the image's own copy is untouched (this module never writes there),
    // and the deletion is what lives on the volume.
    expect(fs.existsSync(path.join(SHIPPED_DIR, 'family-350.txt'))).toBe(true);
    expect(fs.existsSync(path.join(storeDir, 'family-350.txt.deleted'))).toBe(true);
  });

  it('deletes an EDITED shipped list from both places at once', () => {
    // combined-416.txt ships and no fixture theme points at it.
    store.update('combined-416.txt', { text: 'א\nב' });
    expect(fs.existsSync(path.join(storeDir, 'combined-416.txt'))).toBe(true);
    expect(store.remove('combined-416.txt', THEMES).ok).toBe(true);
    // The override is unlinked AND the shipped half masked — leaving either would
    // bring the list back, under the same name, with the wrong contents.
    expect(fs.existsSync(path.join(storeDir, 'combined-416.txt'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, 'combined-416.txt.deleted'))).toBe(true);
    expect(store.read('combined-416.txt')).toBeNull();
  });

  it('a deleted name is free again, and creating it there works', () => {
    store.remove('family-350.txt', THEMES);
    expect(store.read('family-350.txt')).toBeNull();
    const rec = store.create({ name: 'family-350', text: 'חדש\nלגמרי' });
    expect(rec.error).toBeUndefined();
    // The tombstone is cleared by the write, or the new list would be hidden by
    // the old deletion — the one ordering bug this design can produce.
    expect(store.read('family-350.txt').words).toEqual(['חדש', 'לגמרי']);
    expect(fs.existsSync(path.join(storeDir, 'family-350.txt.deleted'))).toBe(false);
  });

  it('deletes an owner-created list without leaving a tombstone behind', () => {
    store.create({ name: 'no-marker', text: 'א' });
    expect(store.remove('no-marker.txt', THEMES).ok).toBe(true);
    // Nothing to mask: the file was only ever on the volume.
    expect(fs.existsSync(path.join(storeDir, 'no-marker.txt.deleted'))).toBe(false);
  });

  it('deletes an unreferenced owner-created list', () => {
    store.create({ name: 'throwaway', text: 'א\nב' });
    expect(store.remove('throwaway.txt', THEMES)).toEqual({ ok: true, name: 'throwaway.txt' });
    expect(fs.existsSync(path.join(storeDir, 'throwaway.txt'))).toBe(false);
  });
});

// RENAMING. The owner's rule is that no list is the system's, so every list can be
// renamed — including one that exists only inside the image, where "rename" has to
// mean copy-then-mask because the original cannot be moved.
describe('wordlists store — rename', () => {
  it('renames an owner-created list, keeping its words', () => {
    store.create({ name: 'ישן', text: 'אחת\nשתיים' });
    const rec = store.rename('ישן.txt', 'חדש', THEMES);
    expect(rec.error).toBeUndefined();
    expect(rec.name).toBe('חדש.txt');
    expect(rec.words).toEqual(['אחת', 'שתיים']);
    expect(store.read('ישן.txt')).toBeNull();
    expect(fs.existsSync(path.join(storeDir, 'ישן.txt'))).toBe(false);
  });

  it('renames a SHIPPED list: the words move to the new name, the old one is masked', () => {
    const before = store.read('family-350.txt').words;
    const rec = store.rename('family-350.txt', 'משפחה שלי', THEMES);
    expect(rec.name).toBe('משפחה שלי.txt');
    expect(rec.words).toEqual(before);
    // Old name gone from every reader, image untouched, deletion on the volume.
    expect(store.read('family-350.txt')).toBeNull();
    expect(fs.existsSync(path.join(SHIPPED_DIR, 'family-350.txt'))).toBe(true);
    expect(fs.existsSync(path.join(storeDir, 'family-350.txt.deleted'))).toBe(true);
  });

  it('reports the designs that must be repointed rather than writing them itself', () => {
    // The theme write belongs to the templates module; this returns the names.
    const rec = store.rename('friends-350.txt', 'חברים', THEMES);
    expect(rec.repoint).toEqual(['trip comeback']);
    expect(rec.renamed_from).toBe('friends-350.txt');
  });

  it('refuses a name that is taken, and accepts one that was deleted', () => {
    store.create({ name: 'תפוס', text: 'א' });
    store.create({ name: 'זז', text: 'ב' });
    expect(store.rename('זז.txt', 'תפוס', THEMES).httpStatus).toBe(409);
    // …but a name whose list was deleted is free again.
    store.remove('תפוס.txt', THEMES);
    const rec = store.rename('זז.txt', 'תפוס', THEMES);
    expect(rec.name).toBe('תפוס.txt');
    expect(rec.words).toEqual(['ב']);
  });

  it('refuses an invalid new name and leaves the list where it was', () => {
    store.create({ name: 'שמור', text: 'א' });
    expect(store.rename('שמור.txt', '../../etc/passwd', THEMES).httpStatus).toBe(400);
    expect(store.read('שמור.txt').words).toEqual(['א']);
  });
});

describe('wordlists routes — rename over HTTP', () => {
  it('renames and repoints the designs that used the old name', async () => {
    const r = await req('POST', key('/api/admin/wordlists/family-350.txt/rename'), {
      name: 'הרשימה שלי',
    });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('הרשימה שלי.txt');
    expect(r.body.failed).toEqual([]);
    const listed = await req('GET', key('/api/admin/wordlists'));
    const names = listed.body.wordlists.map((w) => w.name);
    expect(names).toContain('הרשימה שלי.txt');
    expect(names).not.toContain('family-350.txt');
  });

  // A pool no LIVE theme points at (these routes read generator/themes.json, not
  // the fixture above) — the in-use guard is a separate test's subject.
  it('deleting a shipped list over HTTP removes it from the list', async () => {
    const del = await req('DELETE', key('/api/admin/wordlists/kids-birthday-350.txt'));
    expect(del.status).toBe(200);
    const listed = await req('GET', key('/api/admin/wordlists'));
    expect(listed.body.wordlists.map((w) => w.name)).not.toContain('kids-birthday-350.txt');
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

  it('caps the total list length', () => {
    const many = Array.from({ length: store.MAX_WORDS + 50 }, (_, i) => 'w' + i);
    expect(store.parseWords(many).length).toBe(store.MAX_WORDS);
  });

  it('parseWords no longer truncates a long word — splitByLength decides its fate', () => {
    // parseWords deliberately does NOT apply the length cap: it is also used to
    // re-parse a pool's EXISTING words, and filtering there would silently delete
    // the shipped pools' legacy long entries on any re-save.
    expect(store.parseWords(['x'.repeat(200)])[0].length).toBe(200);
  });
});

describe('wordlists store — the per-entry length cap', () => {
  // Literal 25/26 rather than store.MAX_WORD_LEN: describe bodies evaluate before
  // beforeAll has required the module. The first test below pins the literal to
  // the real constant, so these can't quietly stop testing the boundary.
  const AT_LIMIT = 'x'.repeat(25);
  const OVER_LIMIT = 'x'.repeat(26);

  it('shares ONE cap with the collection words (validate.MAX_WORD_LEN)', () => {
    // Pool words are printed on cards exactly like a buyer's own words, so a
    // second, drifting number here would mean filler could be longer than
    // anything a customer is allowed to type.
    expect(store.MAX_WORD_LEN).toBe(validate.MAX_WORD_LEN);
    expect(store.MAX_WORD_LEN).toBe(25);
  });

  it('splitByLength keeps exactly 25 and refuses exactly 26', () => {
    const { kept, tooLong } = store.splitByLength([AT_LIMIT, OVER_LIMIT], []);
    expect(kept).toEqual([AT_LIMIT]);
    expect(tooLong).toEqual([OVER_LIMIT]);
  });

  it('GRANDFATHERS an over-length word that is already in the pool', () => {
    // The shipped pools contain 46 entries over the cap (longest 41 chars) and the
    // admin editor round-trips the whole list on every save. Without this, fixing
    // one typo in a shipped pool would silently delete those 46 words.
    const { kept, tooLong } = store.splitByLength([OVER_LIMIT], [OVER_LIMIT]);
    expect(kept).toEqual([OVER_LIMIT]);
    expect(tooLong).toEqual([]);
  });

  it('a NEW pool holds every word to the cap and reports what it dropped', () => {
    const rec = store.create({ name: 'len-new', text: ['מים', OVER_LIMIT, AT_LIMIT].join('\n') });
    expect(rec.words).toEqual(['מים', AT_LIMIT]);
    expect(rec.too_long).toEqual([OVER_LIMIT]);
    // The owner is told, rather than the pool quietly coming up short.
    expect(rec.warning).toContain('25');
    expect(rec.warning).toMatch(/[֐-׿]/);
  });

  it('re-saving a pool keeps its legacy long words but refuses new ones', () => {
    // Seed a pool that already contains an over-length word (as the shipped ones
    // do), by writing it through a path that predates the cap.
    const legacy = 'ל'.repeat(41);
    store.create({ name: 'len-legacy', text: 'מים' });
    const seeded = store.update('len-legacy.txt', { words: ['מים'] });
    expect(seeded.words).toEqual(['מים']);
    // Simulate the pre-cap file by writing it directly, then re-saving it whole.
    fs.writeFileSync(path.join(storeDir, 'len-legacy.txt'), 'מים\n' + legacy + '\n', 'utf8');

    const resaved = store.update('len-legacy.txt', { words: ['מים', legacy] });
    expect(resaved.words).toEqual(['מים', legacy]); // legacy survives untouched
    expect(resaved.too_long).toEqual([]);

    // ...but a brand-new over-length word in the same save is still refused.
    const withNew = store.update('len-legacy.txt', { words: ['מים', legacy, OVER_LIMIT] });
    expect(withNew.words).toEqual(['מים', legacy]);
    expect(withNew.too_long).toEqual([OVER_LIMIT]);
  });

  it('appending only an over-length word is a 400 that explains itself', () => {
    store.create({ name: 'len-append', text: 'מים' });
    const r = store.update('len-append.txt', { append: OVER_LIMIT });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('25');
    expect(store.read('len-append.txt').words).toEqual(['מים']);
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
