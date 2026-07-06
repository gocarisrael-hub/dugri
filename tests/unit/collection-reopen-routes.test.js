// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boot the real Express app with ADMIN_KEY set so the admin reopen route is live.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';

let app;
let db;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-reopen-routes-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['db.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
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

async function post(urlPath) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const key = (p) => `${p}?key=${ADMIN_KEY}`;

describe('POST /api/admin/collections/:id/reopen', () => {
  it('403 without the admin key', async () => {
    const c = db.createCollection('לקוח');
    db.closeCollection(c.id, c.owner_token);
    expect((await post('/api/admin/collections/' + c.id + '/reopen')).status).toBe(403);
    // Still closed — the unauthorized call must not have changed anything.
    expect(db.effectiveStatus(db.getCollection(c.id))).toBe('closed');
  });

  it('404 for an unknown collection', async () => {
    const r = await post(key('/api/admin/collections/no-such-id/reopen'));
    expect(r.status).toBe(404);
  });

  it('reopens a closed collection with the admin key', async () => {
    const c = db.createCollection('לקוח');
    db.closeCollection(c.id, c.owner_token);
    const r = await post(key('/api/admin/collections/' + c.id + '/reopen'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 'open' });
    // The collection now accepts words again.
    expect(db.addWords(c.id, ['מילה'], null)).toMatchObject({ added: 1 });
  });
});
