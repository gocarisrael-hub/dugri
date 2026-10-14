// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Storage plan phase 1a (docs/storage-plan.md): the store READS words from
// per-collection files when the data file says they are there, and from the data
// file otherwise. The fixture is a store written by the single-file build through
// db.js itself (paid and unpaid orders, held words, an edit, a delete, a deleted
// collection, a coupon); these tests lay it out the way phase 1b writes it and
// check both layouts read back the same. Phase 1b's own tests (the split, the
// word writes, rollback to 1a) are in word-files-split.test.js.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const wordFiles = require(path.join(serverDir, 'word-files.js'));

const freshDb = (dir) => {
  process.env.DATA_DIR = dir;
  for (const f of ['db.js', 'settings.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery']) settings.set('pricing', v + '_enabled', true);
  return require(path.join(serverDir, 'db.js'));
};
const mainFile = (dir) => path.join(dir, 'dugri-data.json');
const readMain = (dir) => JSON.parse(fs.readFileSync(mainFile(dir), 'utf8'));

// What phase 1b will leave on the volume: one file per collection with words,
// and a main file with no `words` / `held_words` but the layout marker.
function splitLayout(toDir) {
  const main = fixture;
  const ids = new Set([...main.words, ...main.held_words].map((w) => w.collection_id));
  fs.mkdirSync(wordFiles.wordsDir(toDir), { recursive: true });
  for (const id of ids) {
    fs.writeFileSync(
      path.join(wordFiles.wordsDir(toDir), `${id}.json`),
      wordFiles.encode(
        id,
        main.words.filter((w) => w.collection_id === id),
        main.held_words.filter((w) => w.collection_id === id)
      )
    );
  }
  const { words, held_words, ...rest } = main;
  fs.writeFileSync(
    mainFile(toDir),
    JSON.stringify({ ...rest, [wordFiles.WORDS_LAYOUT_KEY]: 'files' })
  );
  return { words, held_words };
}

// Everything a caller can see about words, per collection.
const snapshot = (db, ids) =>
  ids.map((id) => ({
    id,
    words: db.listWords(id),
    count: db.countWords(id),
    held: db.listHeldWords(id),
    heldCount: db.countHeldWords(id),
    paid: !!(db.getCollection(id).order || {}).paid,
  }));

const FIXTURE = path.join(__dirname, 'fixtures', 'store-single-file.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const ids = fixture.collections.map((c) => c.id);

// A fresh data dir holding the fixture: the old single-file layout.
const oldLayout = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-words-old-'));
  fs.copyFileSync(FIXTURE, mainFile(dir));
  return dir;
};

let fixtureWords;

beforeAll(() => {
  const db = freshDb(oldLayout());
  const snap = snapshot(db, ids);
  // The fixture is what it says: 5 words on the paid order, 20 + 5 held on the
  // unpaid one past the free quota, 2 on the third, none on the fourth.
  expect(snap.map((x) => [x.count, x.heldCount, x.paid])).toEqual([
    [5, 0, true],
    [20, 5, false],
    [2, 0, false],
    [0, 0, false],
  ]);
  fixtureWords = snap;
});

describe('phase 1a reads both layouts', () => {
  it('reads the split layout to the same words, held words and orders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-words-split-'));
    splitLayout(dir);
    expect(fs.readdirSync(wordFiles.wordsDir(dir)).sort()).toEqual(
      ids
        .slice(0, 3)
        .map((id) => `${id}.json`)
        .sort()
    );
    const db = freshDb(dir);
    expect(snapshot(db, ids)).toEqual(fixtureWords);
    expect(db.listAllCollections().map((c) => [c.id, c.word_count])).toEqual(
      expect.arrayContaining(fixtureWords.map((s) => [s.id, s.count]))
    );
  });

  it('a boot alone writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-words-noop-'));
    splitLayout(dir);
    const before = fs.readFileSync(mainFile(dir), 'utf8');
    freshDb(dir);
    expect(fs.readFileSync(mainFile(dir), 'utf8')).toBe(before);
  });

  it('ignores a .tmp left in the words directory by a write cut short', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-words-tmp-'));
    splitLayout(dir);
    fs.writeFileSync(path.join(wordFiles.wordsDir(dir), `${ids[0]}.json.tmp`), '{"format":1,"col');
    expect(snapshot(freshDb(dir), ids)).toEqual(fixtureWords);
  });

  it('a main file that still has words wins over word files beside it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-words-both-'));
    splitLayout(dir);
    // Stale word files from an earlier split, plus a main file with words again.
    fs.writeFileSync(
      path.join(wordFiles.wordsDir(dir), `${ids[0]}.json`),
      wordFiles.encode(ids[0], [], [])
    );
    fs.copyFileSync(FIXTURE, mainFile(dir));
    expect(snapshot(freshDb(dir), ids)).toEqual(fixtureWords);
  });
});

// A build from before 1a, redeployed onto a split volume, keeps the marker it does
// not know and saves the words it has: none from the files, plus any added since.
describe('a pre-1a build saved over a split volume', () => {
  it('reads the word files AND the words that build added, losing none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-words-pre1a-'));
    splitLayout(dir);
    // What that build's saveDb writes: { ...DEFAULTS, ...parsed }, words from DEFAULTS
    // plus one added since, the marker carried along as an unknown key.
    const main = readMain(dir);
    const added = {
      id: 'added-under-old-build',
      collection_id: ids[3],
      text: 'בזמן החזרה',
      norm: 'בזמן החזרה',
      added_by: null,
      created_at: '2099-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(mainFile(dir), JSON.stringify({ ...main, words: [added], held_words: [] }));
    expect(readMain(dir)[wordFiles.WORDS_LAYOUT_KEY]).toBe('files');

    const db = freshDb(dir);
    expect(snapshot(db, ids.slice(0, 3))).toEqual(fixtureWords.slice(0, 3));
    expect(db.listWords(ids[3]).map((w) => w.text)).toEqual(['בזמן החזרה']);
  });

  it("an edit made under that build wins over the word file's copy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-words-pre1a-edit-'));
    splitLayout(dir);
    const edited = { ...fixture.words.find((w) => w.collection_id === ids[0]), text: 'נערך' };
    fs.writeFileSync(
      mainFile(dir),
      JSON.stringify({ ...readMain(dir), words: [edited], held_words: [] })
    );
    const texts = freshDb(dir)
      .listWords(ids[0])
      .map((w) => w.text);
    expect(texts).toContain('נערך');
    expect(texts).toHaveLength(fixtureWords[0].count);
  });
});

// A split volume whose word files cannot be read must not boot as empty
// collections: the first save would write that emptiness into the main file.
describe('an unreadable split layout stops the boot', () => {
  const broken = (mutate) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-words-bad-'));
    splitLayout(dir);
    mutate(dir);
    const before = fs.readFileSync(mainFile(dir), 'utf8');
    return { dir, before };
  };
  const cases = {
    'the words directory is missing': (dir) =>
      fs.rmSync(wordFiles.wordsDir(dir), { recursive: true }),
    'a word file is cut short': (dir) =>
      fs.writeFileSync(path.join(wordFiles.wordsDir(dir), `${ids[0]}.json`), '{"format":1,"coll'),
    'a word file sits under another collection id': (dir) =>
      fs.renameSync(
        path.join(wordFiles.wordsDir(dir), `${ids[0]}.json`),
        path.join(wordFiles.wordsDir(dir), 'not-this-one.json')
      ),
    'a word file has an unknown format': (dir) =>
      fs.writeFileSync(
        path.join(wordFiles.wordsDir(dir), `${ids[0]}.json`),
        JSON.stringify({ format: 2, collection_id: ids[0], words: [], held_words: [] })
      ),
    'a word inside belongs to another collection': (dir) =>
      fs.writeFileSync(
        path.join(wordFiles.wordsDir(dir), `${ids[0]}.json`),
        wordFiles.encode(ids[0], [{ id: 'w', collection_id: ids[1], text: 'x' }], [])
      ),
    'the layout marker has an unknown value': (dir) => {
      const main = readMain(dir);
      fs.writeFileSync(mainFile(dir), JSON.stringify({ ...main, words_layout: 'sqlite' }));
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    it(`throws when ${name}, and leaves the main file untouched`, () => {
      const { dir, before } = broken(mutate);
      expect(() => freshDb(dir)).toThrow();
      expect(fs.readFileSync(mainFile(dir), 'utf8')).toBe(before);
    });
  }
});

describe('word-files format', () => {
  it('round-trips one collection through encode and decode', () => {
    const w = [{ id: 'a', collection_id: 'c1', text: 'ים', created_at: '2026-10-15T00:00:00Z' }];
    const doc = wordFiles.decode('c1.json', wordFiles.encode('c1', w, []));
    expect(doc).toEqual({ format: 1, collection_id: 'c1', words: w, held_words: [] });
  });

  it('leaves a file without the marker or words alone', () => {
    expect(wordFiles.pickWordSource({ collections: [] }, '/nonexistent')).toEqual({
      collections: [],
    });
    expect(wordFiles.pickWordSource(null, '/nonexistent')).toBe(null);
  });
});
