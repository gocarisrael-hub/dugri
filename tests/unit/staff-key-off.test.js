// @vitest-environment node
//
// THE TWO WAYS THE STAFF KEY MUST NOT EXIST.
//
// Both are about a deployment that has NOT deliberately created a second key,
// and both are checked in their own process because the keys are read once at
// module load. Kept apart from staff-key.test.js for exactly that reason.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const OWNER = 'the-owner-key';

let server;
let base;

// STAFF_KEY set to the SAME string as ADMIN_KEY. This is the dangerous typo: a
// copy-paste that looks like a restriction while handing out the owner's own
// key. It must be dropped, not honoured.
beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-staff-off-'));
  process.env.ADMIN_KEY = OWNER;
  process.env.STAFF_KEY = OWNER;
  for (const f of ['db.js', 'settings.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  require(path.join(serverDir, 'db.js'));
  const app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.STAFF_KEY;
});

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

describe('a staff key equal to the owner key is no staff key at all', () => {
  it('reports the holder as the OWNER, never as staff', async () => {
    const r = await get(`/api/admin/whoami?key=${OWNER}`);
    expect(r.body.role).toBe('owner');
    // …and the server says plainly that no second key is in force, so nobody
    // configures a worker and believes it took.
    expect(r.body.staff_enabled).toBe(false);
  });

  it('leaves the money open to that key, because it IS the owner key', async () => {
    // The failure this guards against is the opposite one: silently treating the
    // owner's own key as restricted and locking her out of her coupons.
    expect((await get(`/api/admin/coupons?key=${OWNER}`)).status).toBe(200);
  });

  it('still refuses a key that is neither', async () => {
    expect((await get('/api/admin/collections?key=guess')).status).toBe(403);
  });
});
