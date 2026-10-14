// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// Storage plan phase 1b (docs/storage-plan.md): the boot split moves words out of
// the data file into DATA_DIR/words/<collection id>.json, and every word change
// from then on writes only that collection's file. The rules these tests hold it
// to: nothing acknowledged is lost; the old single-file layout still loads; a
// process killed at any step of the split or of a save boots back to a complete
// store; and a build rolled back to 1a still reads what 1b wrote.
//
// The fixture is a store written by the single-file build through db.js itself:
// a paid order with an edited and a deleted word, an unpaid order past the free
// quota (20 words, 5 held), a pickup order, an empty order, a deleted collection
// and a coupon.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const serverDbPath = path.join(serverDir, 'db.js');
const wordFiles = require(path.join(serverDir, 'word-files.js'));

const FIXTURE = path.join(__dirname, 'fixtures', 'store-single-file.json');
const fixtureRaw = fs.readFileSync(FIXTURE, 'utf8');
const fixture = JSON.parse(fixtureRaw);
const ids = fixture.collections.map((c) => c.id);
const [PAID, HELD, PICKUP] = ids;

const mainFile = (dir) => path.join(dir, 'dugri-data.json');
const readMain = (dir) => JSON.parse(fs.readFileSync(mainFile(dir), 'utf8'));
const wordDir = (dir) => wordFiles.wordsDir(dir);
const wordFileNames = (dir) =>
  fs.existsSync(wordDir(dir)) ? fs.readdirSync(wordDir(dir)).sort() : [];
const readWordFile = (dir, id) =>
  JSON.parse(fs.readFileSync(path.join(wordDir(dir), `${id}.json`), 'utf8'));

const oldLayout = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-split-'));
  fs.copyFileSync(FIXTURE, mainFile(dir));
  return dir;
};

const freshDb = (dir) => {
  process.env.DATA_DIR = dir;
  for (const f of ['db.js', 'settings.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery']) settings.set('pricing', v + '_enabled', true);
  return require(serverDbPath);
};

// Each collection's words and held words, exactly as the fixture holds them.
const expectedFromFixture = (id) => ({
  words: fixture.words.filter((w) => w.collection_id === id),
  held_words: fixture.held_words.filter((w) => w.collection_id === id),
});

// Everything a caller can see about words, per collection.
const snapshot = (db) =>
  ids.map((id) => ({
    id,
    words: db.listWords(id),
    held: db.listHeldWords(id),
    count: db.countWords(id),
    heldCount: db.countHeldWords(id),
  }));

// Runs `body` in a child process against `dir`, with fs patched so the process
// dies (exit 137, like a redeploy's SIGKILL) at `point`. Returns the exit status.
function killAt(dir, point, body) {
  const script = `
    const fs = require('fs');
    const path = require('path');
    process.env.DATA_DIR = ${JSON.stringify(dir)};
    const settings = require(${JSON.stringify(path.join(serverDir, 'settings.js'))});
    settings.set('pricing', 'pdf_enabled', true);
    const point = ${JSON.stringify(point)};
    const isWordTmp = (f) => String(f).includes('/words/') && String(f).endsWith('.json.tmp');
    const isMain = (f) => String(f).endsWith('dugri-data.json');
    const isMainTmp = (f) => String(f).endsWith('dugri-data.json.tmp');
    const die = () => process.exit(137);
    const real = { ...fs };
    let armed = ${JSON.stringify(!body)};
    fs.copyFileSync = (a, b) => (armed && point === 'backup' ? die() : real.copyFileSync(a, b));
    fs.writeFileSync = (f, data, enc) => {
      if (armed && ((point === 'word-write' && isWordTmp(f)) || (point === 'main-write' && isMainTmp(f)))) {
        real.writeFileSync(f, String(data).slice(0, String(data).length >> 1));
        die();
      }
      return real.writeFileSync(f, data, enc);
    };
    let renames = 0;
    fs.renameSync = (a, b) => {
      if (armed && point === 'word-rename' && isWordTmp(a) && ++renames === 2) die();
      if (armed && point === 'main-rename' && isMain(b)) die();
      real.renameSync(a, b);
      if (armed && point === 'after-main' && isMain(b)) die();
    };
    fs.unlinkSync = (f) => (armed && point === 'unlink' ? die() : real.unlinkSync(f));
    const db = require(${JSON.stringify(serverDbPath)});
    armed = true;
    ${body || ''}
    process.exit(0);
  `;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }).status;
}

describe('the boot split', () => {
  it('moves every word out of the old single-file layout, and nothing else changes', () => {
    const dir = oldLayout();
    const db = freshDb(dir);

    // The main file: no words, the marker, every other key exactly as it was.
    const main = readMain(dir);
    expect(main).not.toHaveProperty('words');
    expect(main).not.toHaveProperty('held_words');
    expect(main[wordFiles.WORDS_LAYOUT_KEY]).toBe('files');
    const { words: _w, held_words: _h, ...rest } = fixture;
    const { [wordFiles.WORDS_LAYOUT_KEY]: _m, ...mainRest } = main;
    expect(mainRest).toEqual(rest);

    // One word file per collection with words, each exactly the fixture's.
    expect(wordFileNames(dir)).toEqual([PAID, HELD, PICKUP].map((id) => `${id}.json`).sort());
    for (const id of [PAID, HELD, PICKUP]) {
      expect(readWordFile(dir, id)).toEqual({
        format: 1,
        collection_id: id,
        ...expectedFromFixture(id),
      });
    }

    // The data file as it was before the split, byte for byte.
    const backups = fs.readdirSync(dir).filter((n) => n.startsWith('dugri-data.backup-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).toBe(fixtureRaw);

    // And the store reads the same as before the split.
    expect(snapshot(db)).toEqual(snapshot(freshDb(dir)));
    expect(db.getCollection(PAID).order.paid).toBe(true);
  });

  it('runs once: a second boot writes nothing and takes no second backup', () => {
    const dir = oldLayout();
    freshDb(dir);
    // settings.json is rewritten by freshDb's own setup, not by the store.
    const stamps = () =>
      fs
        .readdirSync(dir)
        .filter((n) => n.startsWith('dugri-data'))
        .map((n) => [n, fs.statSync(path.join(dir, n)).mtimeMs]);
    const before = stamps();
    const files = wordFileNames(dir).map((n) =>
      fs.readFileSync(path.join(wordDir(dir), n), 'utf8')
    );
    freshDb(dir);
    expect(stamps()).toEqual(before);
    expect(
      wordFileNames(dir).map((n) => fs.readFileSync(path.join(wordDir(dir), n), 'utf8'))
    ).toEqual(files);
  });

  it('a new store starts in the split layout and boots again', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-split-new-'));
    const db = freshDb(dir);
    const c = db.createCollection('חדשה', {});
    expect(readMain(dir)[wordFiles.WORDS_LAYOUT_KEY]).toBe('files');
    expect(wordFileNames(dir)).toEqual([]);
    db.addWords(c.id, ['ראשונה'], null);
    expect(
      freshDb(dir)
        .listWords(c.id)
        .map((w) => w.text)
    ).toEqual(['ראשונה']);
  });

  // A process killed at each step of the split. Up to the main file's rename the
  // data file is byte-identical to the fixture, so the next boot redoes the
  // split from the start; after it, the split is done. Either way the next boot
  // ends with every word.
  it.each([
    ['while taking the backup', 'backup'],
    ['half-way through a word file', 'word-write'],
    ['between two word files', 'word-rename'],
    ['while deleting a stale word file', 'unlink'],
    ['half-way through the main file', 'main-write'],
    ['before the main file is renamed', 'main-rename'],
    ['right after the main file is renamed', 'after-main'],
  ])('a split killed %s boots back to every word', (_label, point) => {
    const dir = oldLayout();
    // A stale file from an earlier split, so there is something to delete.
    fs.mkdirSync(wordDir(dir));
    fs.writeFileSync(
      path.join(wordDir(dir), 'stale-collection.json'),
      wordFiles.encode('stale-collection', [], [])
    );
    expect(killAt(dir, point, null)).toBe(137);
    if (point !== 'after-main') expect(fs.readFileSync(mainFile(dir), 'utf8')).toBe(fixtureRaw);

    const db = freshDb(dir);
    for (const id of ids) {
      expect(db.listWords(id)).toEqual(
        [...expectedFromFixture(id).words].sort((a, b) => a.created_at.localeCompare(b.created_at))
      );
      expect(db.countHeldWords(id)).toBe(expectedFromFixture(id).held_words.length);
    }
    expect(readMain(dir)).not.toHaveProperty('words');
    expect(wordFileNames(dir)).toEqual([PAID, HELD, PICKUP].map((id) => `${id}.json`).sort());
  });

  it('refuses to split when the word files do not read back, and leaves the data file', () => {
    const dir = oldLayout();
    // Every word file reads back one word short, as a bad disk would serve it.
    const script = `
      const fs = require('fs');
      process.env.DATA_DIR = ${JSON.stringify(dir)};
      const real = fs.readFileSync;
      fs.readFileSync = (f, enc) => {
        const out = real(f, enc);
        if (!String(f).includes('/words/')) return out;
        const doc = JSON.parse(out);
        doc.words.pop();
        return JSON.stringify(doc);
      };
      require(${JSON.stringify(serverDbPath)});
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('read back different');
    expect(fs.readFileSync(mainFile(dir), 'utf8')).toBe(fixtureRaw);
  });
});

describe('after the split, what a call acknowledges is on disk', () => {
  // Every word mutator, then a fresh boot from disk alone must see what memory saw.
  it('addWords, editWord, deleteWord, held words released by payment, deleteCollection', () => {
    const dir = oldLayout();
    const db = freshDb(dir);
    // Each mutator names its collection (touchWords); none may fall back on
    // saveDb's rewrite-everything safety net.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const paid = db.getCollection(PAID);
    const held = db.getCollection(HELD);

    db.addWords(PAID, ['מילה חדשה'], 'דנה');
    const [first, second] = db.listWords(PAID);
    db.editWord(PAID, first.id, 'ים התיכון', paid.owner_token);
    // Checked on its own: an in-place edit changes no count, so nothing but
    // editWord's own touchWords can get it to disk.
    expect(
      freshDb(dir)
        .listWords(PAID)
        .map((w) => w.text)
    ).toContain('ים התיכון');
    expect(db.deleteWord(PAID, second.id, paid.owner_token)).toBe(true);
    expect(snapshot(freshDb(dir))).toEqual(snapshot(db));

    // Paying releases the held words into the list (releaseHeld inside markPaid).
    expect(db.setOrder(HELD, held.owner_token, { version: 'pdf' })).toBeTruthy();
    db.markPaid(HELD, { method: 'tranzila', transaction_id: 'tx-held' });
    expect(db.countHeldWords(HELD)).toBe(0);
    expect(db.countWords(HELD)).toBe(25);
    expect(snapshot(freshDb(dir))).toEqual(snapshot(db));
    expect(readWordFile(dir, HELD).held_words).toEqual([]);

    // Deleting a word down to none keeps an empty file: a missing file would let
    // a stale one, or none, stand for the collection.
    const pickup = db.getCollection(PICKUP);
    for (const w of db.listWords(PICKUP)) db.deleteWord(PICKUP, w.id, pickup.owner_token);
    expect(readWordFile(dir, PICKUP).words).toEqual([]);

    expect(db.deleteCollection(PAID)).toBe(true);
    expect(wordFileNames(dir)).not.toContain(`${PAID}.json`);
    const again = freshDb(dir);
    expect(again.getCollection(PAID)).toBeFalsy();
    expect(again.listWords(PAID)).toEqual([]);
    expect(snapshot(again)).toEqual(snapshot(db));
    expect(errors.mock.calls.flat().join(' ')).not.toContain('touchWords');
    errors.mockRestore();
  });

  it('a word change writes only its own collection file; an order change writes no word file', () => {
    const dir = oldLayout();
    const db = freshDb(dir);
    const read = () =>
      Object.fromEntries(
        wordFileNames(dir).map((n) => [n, fs.readFileSync(path.join(wordDir(dir), n), 'utf8')])
      );
    const before = read();
    db.addWords(PICKUP, ['עוד מילה'], null);
    const after = read();
    for (const n of Object.keys(before)) {
      if (n === `${PICKUP}.json`) expect(after[n]).not.toBe(before[n]);
      else expect(after[n]).toBe(before[n]);
    }
    const mtimes = () =>
      wordFileNames(dir).map((n) => fs.statSync(path.join(wordDir(dir), n)).mtimeMs);
    const m0 = mtimes();
    const pickup = db.getCollection(PICKUP);
    db.markPaid(PICKUP, { method: 'tranzila', transaction_id: 'tx-pickup' });
    expect(readMain(dir).collections.find((c) => c.id === PICKUP).order.paid).toBe(true);
    expect(pickup.order.paid).toBe(true);
    expect(mtimes()).toEqual(m0);
    expect(fs.readFileSync(mainFile(dir), 'utf8')).not.toContain('"words"');
  });
});

describe('a save killed part-way, after the split', () => {
  // addWords writes the word file, then the main file. Killed anywhere, the next
  // boot has the old store or the new one: the half-written temp is never read.
  it.each([
    ['half-way through the word file', 'word-write', false],
    ['half-way through the main file', 'main-write', true],
    ['before the main file is renamed', 'main-rename', true],
  ])('addWords killed %s', (_label, point, wordLanded) => {
    const dir = oldLayout();
    freshDb(dir);
    expect(
      killAt(dir, point, `db.addWords(${JSON.stringify(PICKUP)}, ['נהרג באמצע'], null);`)
    ).toBe(137);
    const db = freshDb(dir);
    const texts = db.listWords(PICKUP).map((w) => w.text);
    // The call never returned, so nothing was acknowledged; the word is either
    // wholly there or wholly not, and every other word is.
    expect(texts.includes('נהרג באמצע')).toBe(wordLanded);
    expect(db.countWords(PAID)).toBe(5);
    expect(db.countWords(HELD)).toBe(20);
    expect(db.countHeldWords(HELD)).toBe(5);
    db.addWords(PICKUP, ['אחרי'], null);
    expect(
      freshDb(dir)
        .listWords(PICKUP)
        .map((w) => w.text)
    ).toContain('אחרי');
    expect(wordFileNames(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('deleteCollection killed between the main file and the unlink leaves no orphan behind', () => {
    const dir = oldLayout();
    freshDb(dir);
    expect(killAt(dir, 'unlink', `db.deleteCollection(${JSON.stringify(PAID)});`)).toBe(137);
    expect(wordFileNames(dir)).toContain(`${PAID}.json`); // the orphan
    const db = freshDb(dir);
    expect(db.getCollection(PAID)).toBeFalsy();
    expect(wordFileNames(dir)).not.toContain(`${PAID}.json`);
    db.createCollection('אחרי', {});
    expect(fs.readFileSync(mainFile(dir), 'utf8')).not.toContain(PAID);
  });
});

// Rolling back to 1a after 1b has split the volume. 1a's loadDb is JSON.parse of
// the main file through wordFiles.pickWordSource (unchanged by 1b), and its saveDb
// writes JSON.stringify of the whole store, words included, with the marker gone.
describe('rollback to the 1a build', () => {
  const as1a = (dir) => wordFiles.pickWordSource(readMain(dir), dir);

  it('1a reads every word of a split volume', () => {
    const dir = oldLayout();
    const db = freshDb(dir);
    const store = as1a(dir);
    for (const id of ids) {
      expect(store.words.filter((w) => w.collection_id === id)).toEqual(
        expectedFromFixture(id).words
      );
      expect(store.held_words.filter((w) => w.collection_id === id)).toEqual(
        expectedFromFixture(id).held_words
      );
    }
    expect(store.collections).toEqual(readMain(dir).collections);
    expect(snapshot(db).length).toBe(4);
  });

  it('words changed under 1a survive the redeploy back to 1b; stale word files lose', () => {
    const dir = oldLayout();
    freshDb(dir);
    // 1a boots, deletes PICKUP's words, adds one to PAID, and saves.
    const store = as1a(dir);
    store.words = store.words.filter((w) => w.collection_id !== PICKUP);
    store.words.push({
      id: 'under-1a',
      collection_id: PAID,
      text: 'נוסף בזמן החזרה',
      norm: 'נוסף בזמן החזרה',
      added_by: null,
      created_at: '2099-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(mainFile(dir), JSON.stringify(store));
    expect(readMain(dir)).not.toHaveProperty(wordFiles.WORDS_LAYOUT_KEY);
    // The word files still hold the pre-rollback words.
    expect(readWordFile(dir, PICKUP).words).toHaveLength(2);

    const db = freshDb(dir);
    expect(db.listWords(PAID).map((w) => w.text)).toContain('נוסף בזמן החזרה');
    expect(db.listWords(PICKUP)).toEqual([]);
    expect(wordFileNames(dir)).not.toContain(`${PICKUP}.json`);
    expect(readMain(dir)).not.toHaveProperty('words');
    expect(snapshot(freshDb(dir))).toEqual(snapshot(db));
  });
});
