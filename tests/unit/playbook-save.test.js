import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regression guard for the ENOENT bug: server/playbook.js save() did the atomic
// tmp-write+rename without first ensuring DATA_DIR exists, so persisting a note
// threw ENOENT on `<DATA_DIR>/playbook-notes.json.tmp` whenever the data dir had
// not been created yet (the admin-playbook e2e only trips this when .e2e-data is
// absent, which a full CI run doesn't guarantee — so guard it here directly).

describe('playbook save() ensures DATA_DIR exists', () => {
  const dirs = [];
  const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
  afterEach(() => {
    // Restore the env BEFORE removing the temp dirs, so nothing that runs after
    // this test resolves DATA_DIR to a just-deleted path.
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('persists an added note even when DATA_DIR does not exist yet', async () => {
    const dir = path.join(
      os.tmpdir(),
      `dugri-playbook-${process.pid}-${Math.floor(Math.random() * 1e9)}`
    );
    dirs.push(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);

    vi.resetModules();
    process.env.DATA_DIR = dir;
    const playbook = (await import('../../server/playbook.js')).default;

    // add() → save() must not throw ENOENT and must actually persist the note.
    const TITLE = 'unit-mkdir-' + Math.floor(Math.random() * 1e9);
    expect(() => playbook.add({ section: 'בדיקות', title: TITLE, body: 'x' })).not.toThrow();

    // Read the file back and assert the ADDED note is there — importing the
    // module seeds+writes a file on its own, so `existsSync` alone would pass
    // even if add()'s persistence were broken. Checking the title proves add()
    // wrote through to disk.
    const file = path.join(dir, 'playbook-notes.json');
    expect(fs.existsSync(file)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.some((n) => n.title === TITLE)).toBe(true);
  });
});
