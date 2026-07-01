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

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-gender-'));
  db = require(serverDbPath);
});

describe('createCollection gender passthrough', () => {
  it("stores gender 'female'", () => {
    const c = db.createCollection('שירה', { gender: 'female' });
    expect(c.gender).toBe('female');
  });

  it("stores gender 'male'", () => {
    const c = db.createCollection('דני', { gender: 'male' });
    expect(c.gender).toBe('male');
  });

  it('defaults to null when gender is absent', () => {
    const c = db.createCollection('בלי מגדר');
    expect(c.gender).toBe(null);
  });

  it('rejects any value other than male/female (stores null)', () => {
    expect(db.createCollection('x', { gender: 'other' }).gender).toBe(null);
    expect(db.createCollection('y', { gender: '' }).gender).toBe(null);
    expect(db.createCollection('z', { gender: true }).gender).toBe(null);
  });
});
