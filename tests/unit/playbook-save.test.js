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
  afterEach(() => {
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

    // Should NOT throw ENOENT, and should create the dir + persist the file.
    expect(() => playbook.add({ section: 'בדיקות', title: 'unit-mkdir', body: 'x' })).not.toThrow();
    expect(fs.existsSync(path.join(dir, 'playbook-notes.json'))).toBe(true);
  });
});
