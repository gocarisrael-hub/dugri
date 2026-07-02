// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// server/db.js is CommonJS and writes a JSON file under DATA_DIR. Point it at a
// throwaway temp dir (set before require) so the test never touches real data.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDbPath = path.join(__dirname, '..', '..', 'server', 'db.js');

let db;
let dataDir;
const dbFile = () => path.join(dataDir, 'dugri-data.json');

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-atomic-'));
  process.env.DATA_DIR = dataDir;
  db = require(serverDbPath);
});

describe('saveDb writes atomically (temp file + rename)', () => {
  it('persists a valid, parseable data file after a mutation', () => {
    const c = db.createCollection('שירה', {}); // triggers saveDb()
    const raw = fs.readFileSync(dbFile(), 'utf8');
    const parsed = JSON.parse(raw); // throws if truncated/corrupt
    expect(parsed.collections.some((x) => x.id === c.id)).toBe(true);
  });

  it('leaves no leftover *.tmp-* file after a successful write', () => {
    db.createCollection('דני', {}); // another saveDb()
    const leftovers = fs.readdirSync(dataDir).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});
