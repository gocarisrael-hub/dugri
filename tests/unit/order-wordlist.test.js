// @vitest-environment node
// A per-order seed-pool override: the owner picks, in the order edit dialog,
// which word pool tops this deck up when the buyer hasn't sent enough words.
// It replaces the THEME's pool only — the buyer's own words still come first and
// generic-350 is still the backstop, so an override can neither drop a word nor
// leave a deck short.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const realFetch = globalThis.fetch;

let db;
let wordlists;
let app;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wl-'));
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  for (const f of ['db.js', 'settings.js', 'wordlists.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  wordlists = require(path.join(serverDir, 'wordlists.js'));
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

const KEY = '?key=test-admin-key';
async function patch(id, body) {
  const res = await realFetch(base + '/api/admin/collections/' + id + KEY, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
// A pool that really exists, so the test isn't asserting against a fixture that
// could drift away from the shipped content.
function anExistingPool() {
  const all = wordlists.list();
  expect(all.length).toBeGreaterThan(0);
  return all[0].name;
}

describe('storing the override', () => {
  it('accepts a pool that exists', async () => {
    const pool = anExistingPool();
    const c = db.createCollection('שירה');
    const r = await patch(c.id, { honoree_name: 'שירה', wordlist: pool });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).wordlist).toBe(pool);
  });

  it('REFUSES a pool that does not exist', async () => {
    const c = db.createCollection('שירה');
    const r = await patch(c.id, { honoree_name: 'שירה', wordlist: 'no-such-pool.txt' });
    // Caught at the door, not at generate time: a typo that only surfaces when
    // the owner presses "produce" silently ships a deck of the wrong filler.
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('unknown wordlist');
    expect(db.getCollection(c.id).wordlist).toBeFalsy();
  });

  it('clears back to the theme default with an empty value', async () => {
    const pool = anExistingPool();
    const c = db.createCollection('שירה');
    await patch(c.id, { honoree_name: 'שירה', wordlist: pool });
    const r = await patch(c.id, { honoree_name: 'שירה', wordlist: '' });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).wordlist).toBe(null);
  });

  it('leaves the stored value alone when the field is absent', async () => {
    const pool = anExistingPool();
    const c = db.createCollection('שירה');
    await patch(c.id, { honoree_name: 'שירה', wordlist: pool });
    await patch(c.id, { honoree_name: 'שירה חדשה' });
    expect(db.getCollection(c.id).wordlist).toBe(pool);
  });

  it('refuses a traversal attempt like any other unknown name', async () => {
    const c = db.createCollection('שירה');
    for (const bad of ['../../etc/passwd', '/etc/passwd', '..%2Fsecret.txt']) {
      const r = await patch(c.id, { honoree_name: 'שירה', wordlist: bad });
      expect(r.status).toBe(400);
    }
    expect(db.getCollection(c.id).wordlist).toBeFalsy();
  });
});

describe('a fresh order has no override', () => {
  it('so production uses the theme pool, exactly as before this existed', () => {
    const c = db.createCollection('שירה');
    expect(c.wordlist).toBeUndefined();
    expect(db.getCollection(c.id).wordlist).toBeFalsy();
  });
});
