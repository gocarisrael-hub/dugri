// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

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

  it('leaves no leftover temp file after a successful write', () => {
    db.createCollection('דני', {}); // another saveDb()
    const leftovers = fs.readdirSync(dataDir).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

// The store is written COMPACT (no indentation): it is rewritten whole on every
// save, with the server frozen while it happens. The file already on the
// production volume is the old indented one, and the first save after a deploy
// must read it and carry every row across.
describe('the compact data file', () => {
  const freshDb = (dir) => {
    process.env.DATA_DIR = dir;
    for (const f of ['db.js', 'settings.js']) {
      delete require.cache[require.resolve(path.join(path.dirname(serverDbPath), f))];
    }
    const settings = require(path.join(path.dirname(serverDbPath), 'settings.js'));
    settings.set('pricing', 'pdf_enabled', true);
    return require(serverDbPath);
  };

  it('reads the old indented file and rewrites it compact, losing nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pretty-'));
    const file = path.join(dir, 'dugri-data.json');
    const before = freshDb(dir);
    const c = before.createCollection('שירה', { email: 'shira@example.com' });
    before.addWords(c.id, ['ים', 'קפה של בוקר'], 'דנה');
    before.setOrder(c.id, c.owner_token, { version: 'pdf' });
    before.markPaid(c.id, { method: 'tranzila', transaction_id: 'tx-1' });
    // The file exactly as every earlier build wrote it.
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(old, null, 2), 'utf8');
    expect(fs.readFileSync(file, 'utf8')).toContain('\n  "collections"');

    const after = freshDb(dir);
    expect(after.getCollection(c.id).order.paid).toBe(true);
    expect(after.listWords(c.id).map((w) => w.text)).toEqual(['ים', 'קפה של בוקר']);

    const d = after.createCollection('דנה', {}); // the first save after a deploy
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('\n');
    const disk = JSON.parse(raw);
    // Every top-level key and every row of the old file is still there.
    for (const key of Object.keys(old)) expect(disk).toHaveProperty(key);
    expect(disk.collections.map((x) => x.id)).toEqual([c.id, d.id]);
    expect(disk.collections[0]).toEqual({ ...old.collections[0] });
    // Words live in per-collection files now (server/word-files.js), compact too.
    // The indented OLD layout, words inside, is the fixture of word-files-split.test.js.
    const wordsRaw = fs.readFileSync(path.join(dir, 'words', `${c.id}.json`), 'utf8');
    expect(wordsRaw).not.toContain('\n');
    expect(JSON.parse(wordsRaw).words.map((w) => w.text)).toEqual(['ים', 'קפה של בוקר']);
  });

  // A process killed in the middle of a save — a redeploy, an OOM — at each of
  // the two points it can die: half-way through writing the temp file, and after
  // the temp file is written but before the rename. Either way the next boot
  // must read the last complete store, and the next save must succeed.
  it.each([
    ['half-way through writing the temp file', 'write'],
    ['after the temp file, before the rename', 'rename'],
  ])('a save killed %s leaves the last complete store', (_label, point) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-kill-'));
    const script = `
      const fs = require('fs');
      process.env.DATA_DIR = ${JSON.stringify(dir)};
      const db = require(${JSON.stringify(serverDbPath)});
      db.createCollection('ראשונה', {});
      if (${JSON.stringify(point)} === 'write') {
        const real = fs.writeFileSync;
        fs.writeFileSync = (f, data) => {
          real(f, String(data).slice(0, String(data).length >> 1));
          process.exit(137);
        };
      } else {
        fs.renameSync = () => process.exit(137);
      }
      db.createCollection('שנייה', {});
      process.exit(0); // not reached: the save above dies first
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(r.status).toBe(137);
    // The interrupted save left its temp file behind, and nothing else changed.
    expect(fs.existsSync(path.join(dir, 'dugri-data.json.tmp'))).toBe(true);

    const names = () =>
      JSON.parse(fs.readFileSync(path.join(dir, 'dugri-data.json'), 'utf8')).collections.map(
        (x) => x.honoree_name
      );
    expect(names()).toEqual(['ראשונה']);
    const db2 = freshDb(dir);
    db2.createCollection('שלישית', {});
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([]);
    expect(names()).toEqual(['ראשונה', 'שלישית']);
  });

  // Saves are SYNCHRONOUS: when a mutator returns, the row is in the file. So a
  // route that answers after the mutator has already persisted what it answers.
  it('a payment is on disk when markPaid returns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-paid-'));
    const db2 = freshDb(dir);
    const c = db2.createCollection('שירה', {});
    expect(db2.setOrder(c.id, c.owner_token, { version: 'pdf' })).toBeTruthy();
    db2.markPaid(c.id, { method: 'tranzila', transaction_id: 'tx-9' });
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'dugri-data.json'), 'utf8'));
    const row = disk.collections.find((x) => x.id === c.id);
    expect(row.order.version).toBe('pdf');
    expect(row.order.paid).toBe(true);
  });
});

// The same promise at the HTTP edge: by the time a buyer's browser has the answer
// to "create my collection" or "place my order", that row is already in the file
// a restart would read back.
describe('what a route acknowledges is already on disk', () => {
  let server;
  let base;
  let dir;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-ack-'));
    process.env.DATA_DIR = dir;
    const serverDir = path.dirname(serverDbPath);
    for (const f of ['db.js', 'settings.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    require(path.join(serverDir, 'settings.js')).set('pricing', 'pdf_enabled', true);
    const app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });
  afterAll(() => server && server.close());

  const post = async (p, body) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const onDisk = (id) =>
    JSON.parse(fs.readFileSync(path.join(dir, 'dugri-data.json'), 'utf8')).collections.find(
      (x) => x.id === id
    );

  it('a created collection and a placed order', async () => {
    const r = await post('/api/collections', { honoree_name: 'נועה', email: 'n@example.com' });
    expect(r.status).toBe(201);
    expect(onDisk(r.body.id)).toBeTruthy();
    const o = await post('/api/collections/' + r.body.id + '/order', {
      owner_token: r.body.owner_token,
      version: 'pdf',
    });
    expect(o.status).toBe(200);
    expect(onDisk(r.body.id).order.version).toBe('pdf');
  });
});
