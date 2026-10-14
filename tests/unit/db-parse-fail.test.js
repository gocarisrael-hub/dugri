// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// A data file that exists but cannot be parsed must stop the boot. The store used
// to start EMPTY instead, and its first save renamed the emptiness over the real
// file: every order and word gone, on a volume with no backups. Now the boot
// throws, the file is left byte-for-byte, and a copy is kept aside.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const serverDbPath = path.join(serverDir, 'db.js');

const mainFile = (dir) => path.join(dir, 'dugri-data.json');
const copies = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('dugri-data.unreadable-'));

const freshDb = (dir) => {
  process.env.DATA_DIR = dir;
  for (const f of ['db.js', 'settings.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  require(path.join(serverDir, 'settings.js')).set('pricing', 'pdf_enabled', true);
  return require(serverDbPath);
};

// A real store, then the bad bytes over it.
const withBadFile = (bytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-parse-'));
  const db = freshDb(dir);
  db.createCollection('שירה', {});
  fs.writeFileSync(mainFile(dir), bytes);
  return dir;
};

describe('a data file that will not parse', () => {
  const real = '{"collections":[{"id":"c1","honoree_name":"שירה"}],"words":[{"id":"w1","colle';
  const cases = {
    'cut short': real,
    empty: '',
    'not JSON at all': '\u0000\u0001garbage',
    'JSON null': 'null',
    'a JSON list': '[]',
    'a JSON string': '"collections"',
  };
  for (const [name, bytes] of Object.entries(cases)) {
    it(`${name}: refuses to boot, writes nothing over it, keeps a copy`, () => {
      const dir = withBadFile(bytes);
      const errors = [];
      const orig = console.error;
      console.error = (m) => errors.push(String(m));
      try {
        expect(() => freshDb(dir)).toThrow(/REFUSING TO BOOT/);
      } finally {
        console.error = orig;
      }
      expect(errors.join('\n')).toContain('REFUSING TO BOOT');
      expect(fs.readFileSync(mainFile(dir), 'utf8')).toBe(bytes);
      expect(fs.existsSync(`${mainFile(dir)}.tmp`)).toBe(false);
      const [copy] = copies(dir);
      expect(copies(dir)).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, copy), 'utf8')).toBe(bytes);
    });
  }

  it('a restart loop keeps one copy, not one per boot', () => {
    const dir = withBadFile(real);
    const quiet = console.error;
    console.error = () => {};
    try {
      for (let i = 0; i < 3; i++) expect(() => freshDb(dir)).toThrow();
    } finally {
      console.error = quiet;
    }
    expect(copies(dir)).toHaveLength(1);
  });

  it('a file it cannot read refuses too', () => {
    if (process.getuid && process.getuid() === 0) return; // root reads anything
    const dir = withBadFile('{"collections":[]}');
    fs.chmodSync(mainFile(dir), 0o000);
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(() => freshDb(dir)).toThrow(/REFUSING TO BOOT/);
    } finally {
      console.error = quiet;
      fs.chmodSync(mainFile(dir), 0o644);
    }
    expect(fs.readFileSync(mainFile(dir), 'utf8')).toBe('{"collections":[]}');
  });

  // The server process itself dies: nothing between db.js and the listener
  // swallows the throw and serves on an empty store.
  it('the server does not start', () => {
    const dir = withBadFile(real);
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `process.env.DATA_DIR=${JSON.stringify(dir)}; require(${JSON.stringify(path.join(serverDir, 'index.js'))});`,
      ],
      { encoding: 'utf8', timeout: 60000 }
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('REFUSING TO BOOT');
    expect(fs.readFileSync(mainFile(dir), 'utf8')).toBe(real);
  });
});

describe('the cases that still boot', () => {
  it('no data file: a new, empty store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-parse-new-'));
    const db = freshDb(dir);
    const c = db.createCollection('חדשה', {});
    expect(freshDb(dir).getCollection(c.id)).toBeTruthy();
    expect(copies(dir)).toEqual([]);
  });

  it('a valid file, even an empty object, loads', () => {
    const dir = withBadFile('{}');
    const db = freshDb(dir);
    expect(db.listAllCollections()).toEqual([]);
    expect(copies(dir)).toEqual([]);
  });
});
