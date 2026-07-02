// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runSmoke } from '../../scripts/smoke.mjs';

// Boot the REAL Express app in-process against an isolated temp DATA_DIR and
// with NO PeleCard credentials, then run the live smoke script against it. This
// proves runSmoke passes end-to-end without touching real data or any gateway.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverIndexPath = path.join(__dirname, '..', '..', 'server', 'index.js');

const ADMIN_KEY = 'smoke-test-admin-key';

let server;
let baseUrl;

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-smoke-'));
  process.env.DATA_DIR = dataDir;
  // ADMIN_KEY enables the admin hard-delete route so cleanup can run.
  process.env.ADMIN_KEY = ADMIN_KEY;
  // Ensure the payment flag resolves to a boolean `false` (no creds set).
  delete process.env.PELECARD_TERMINAL;
  delete process.env.PELECARD_USER;
  delete process.env.PELECARD_PASSWORD;

  // server/index.js exports the app and guards app.listen behind
  // `require.main === module`, so requiring it does not auto-listen.
  const app = require(serverIndexPath);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

// How many collections currently exist per the admin list.
async function collectionCount() {
  const res = await fetch(baseUrl + `/api/admin/collections?key=${ADMIN_KEY}`);
  const body = await res.json();
  return body.collections.length;
}

describe('runSmoke against the live app', () => {
  it('passes all checks (static pages, API round-trip, payment flag)', async () => {
    await expect(runSmoke(baseUrl, { adminKey: ADMIN_KEY })).resolves.toBe(true);
  });

  it('cleans up the collection it created (none left behind)', async () => {
    // Start from a clean slate, run smoke with the admin key, and assert the
    // SMOKE TEST collection it created was hard-deleted afterward.
    expect(await collectionCount()).toBe(0);
    await runSmoke(baseUrl, { adminKey: ADMIN_KEY });
    expect(await collectionCount()).toBe(0);
  });

  it('leaves the collection when no admin key is available', async () => {
    // Without a key there's no cleanup path, so the smoke collection persists.
    delete process.env.SMOKE_ADMIN_KEY;
    const before = await collectionCount();
    await runSmoke(baseUrl);
    expect(await collectionCount()).toBe(before + 1);
    // Clean it up ourselves so later assertions aren't affected.
    const list = await (await fetch(baseUrl + `/api/admin/collections?key=${ADMIN_KEY}`)).json();
    for (const c of list.collections) {
      await fetch(baseUrl + `/api/admin/collections/${c.id}?key=${ADMIN_KEY}`, {
        method: 'DELETE',
      });
    }
  });

  it('rejects when pointed at a dead URL', async () => {
    // Port 1 is not listening — readiness never succeeds. Use a tiny timeout so
    // the test fails fast instead of waiting the full 90s budget.
    await expect(
      runSmoke('http://127.0.0.1:1', { readyTimeoutMs: 200, readyIntervalMs: 50 })
    ).rejects.toThrow(/SMOKE FAILED/);
  });
});
