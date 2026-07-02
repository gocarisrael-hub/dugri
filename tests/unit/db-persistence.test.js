// @vitest-environment node
// Covers the latency-incident fix in server/db.js: writes are now coalesced,
// asynchronous, atomic (temp + rename), compact JSON, durable on shutdown, and
// hot read paths use an in-memory collection_id -> words index.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// db.js is CommonJS and writes a JSON file under DATA_DIR — point it at a
// throwaway temp dir (set before require) so the test never touches real data.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDbPath = path.join(__dirname, '..', '..', 'server', 'db.js');

let db;
let DB_FILE;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-persist-'));
  db = require(serverDbPath);
  DB_FILE = db.__test.DB_FILE;
});

afterEach(() => {
  vi.useRealTimers();
});

function readFile() {
  return fs.readFileSync(DB_FILE, 'utf8');
}

describe('coalesced writes', () => {
  it('collapses a burst of many saves into roughly one write per interval', async () => {
    vi.useFakeTimers();
    // Stub the actual disk I/O so the throttle behavior is observed
    // deterministically under fake timers (real fs promises wouldn't settle
    // inside advanceTimersByTimeAsync).
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue();
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockResolvedValue();

    // 50 rapid word-adds (each calls saveDb internally) inside one interval.
    const c = db.createCollection('burst');
    for (let i = 0; i < 50; i++) {
      db.addWords(c.id, [`w${i}`]);
    }

    // Before the throttle window elapses nothing has been written yet.
    expect(writeSpy).not.toHaveBeenCalled();

    // Advancing past the interval performs a single trailing flush for the
    // whole burst, not one write per save.
    await vi.advanceTimersByTimeAsync(1100);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(db.__test.isDirty()).toBe(false);

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
    renameSpy.mockRestore();
  });

  it('a dirty change during an in-flight flush schedules a follow-up write', async () => {
    vi.useFakeTimers();
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue();
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockResolvedValue();

    const c = db.createCollection('followup');
    await vi.advanceTimersByTimeAsync(1100); // first flush
    expect(writeSpy).toHaveBeenCalledTimes(1);

    db.addWords(c.id, ['later']); // dirty again after the first flush
    await vi.advanceTimersByTimeAsync(1100); // second, trailing flush
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(db.__test.isDirty()).toBe(false);

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
    renameSpy.mockRestore();
  });

  it('always persists the last change (trailing flush)', async () => {
    const c = db.createCollection('trailing');
    db.addWords(c.id, ['first']);
    db.addWords(c.id, ['second']);
    await db.__test.flushNow();

    const onDisk = JSON.parse(readFile());
    const texts = onDisk.words.filter((w) => w.collection_id === c.id).map((w) => w.text);
    expect(texts).toContain('first');
    expect(texts).toContain('second');
    expect(db.__test.isDirty()).toBe(false);
  });
});

describe('atomic + compact write', () => {
  it('writes to a temp file then renames over DB_FILE (never a truncated file)', async () => {
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    const writeSpy = vi.spyOn(fs.promises, 'writeFile');

    db.createCollection('atomic');
    await db.__test.flushNow();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [tmpArg] = writeSpy.mock.calls[0];
    const [renameFrom, renameTo] = renameSpy.mock.calls[0];
    // Wrote to a temp path, renamed that same temp path onto the real DB file.
    expect(tmpArg).not.toBe(DB_FILE);
    expect(tmpArg).toContain('.tmp');
    expect(renameFrom).toBe(tmpArg);
    expect(renameTo).toBe(DB_FILE);

    renameSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('produces compact JSON (no pretty-print indentation)', async () => {
    db.createCollection('compact');
    await db.__test.flushNow();
    const raw = readFile();
    // Pretty-printed output would contain newline + two-space indentation.
    expect(raw).not.toMatch(/\n {2}"/);
    // Sanity: still valid JSON that round-trips.
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe('round-trip durability', () => {
  it('re-loads what was written (compact file parses back)', async () => {
    const c = db.createCollection('roundtrip');
    db.addWords(c.id, ['alpha', 'beta']);
    await db.__test.flushNow();

    const reloaded = db.__test.reload();
    const found = reloaded.collections.find((x) => x.id === c.id);
    expect(found).toBeTruthy();
    expect(found.honoree_name).toBe('roundtrip');
    const texts = reloaded.words.filter((w) => w.collection_id === c.id).map((w) => w.text);
    expect(texts.sort()).toEqual(['alpha', 'beta']);
  });

  it('flushSync persists synchronously when dirty (shutdown path)', () => {
    const c = db.createCollection('shutdown');
    db.addWords(c.id, ['persist-me']);
    expect(db.__test.isDirty()).toBe(true);
    db.__test.flushSync();
    expect(db.__test.isDirty()).toBe(false);
    const onDisk = JSON.parse(readFile());
    const texts = onDisk.words.filter((w) => w.collection_id === c.id).map((w) => w.text);
    expect(texts).toContain('persist-me');
  });
});

describe('collection_id word index', () => {
  it('stays correct across add, delete-word, and delete-collection', () => {
    const c = db.createCollection('idx');
    db.addWords(c.id, ['one', 'two', 'three']);
    expect(
      db.__test
        .wordIndexFor(c.id)
        .map((w) => w.text)
        .sort()
    ).toEqual(['one', 'three', 'two']);
    // Index count matches listWords / listAllCollections word_count.
    expect(db.listWords(c.id).length).toBe(3);
    expect(db.listAllCollections().find((x) => x.id === c.id).word_count).toBe(3);

    // Delete one word: index shrinks and no longer contains it.
    const wid = db.listWords(c.id).find((w) => w.text === 'two').id;
    expect(db.deleteWord(c.id, wid, c.owner_token)).toBe(true);
    expect(
      db.__test
        .wordIndexFor(c.id)
        .map((w) => w.text)
        .sort()
    ).toEqual(['one', 'three']);
    expect(db.listWords(c.id).length).toBe(2);

    // Dedupe uses the index: re-adding an existing word is skipped.
    const r = db.addWords(c.id, ['one', 'four']);
    expect(r).toEqual({ added: 1, skipped: 1 });

    // Delete the whole collection: index entry is removed entirely.
    expect(db.deleteCollection(c.id)).toBe(true);
    expect(db.__test.wordIndexFor(c.id)).toEqual([]);
  });

  it('mirrors _db.words exactly after a fresh reload (rebuild)', async () => {
    const c = db.createCollection('rebuild');
    db.addWords(c.id, ['x', 'y']);
    await db.__test.flushNow();
    const reloaded = db.__test.reload();
    const expected = reloaded.words.filter((w) => w.collection_id === c.id).length;
    expect(db.__test.wordIndexFor(c.id).length).toBe(expected);
  });
});
