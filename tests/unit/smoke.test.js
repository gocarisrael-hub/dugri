// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { runSmoke, isRedesignPage } from '../../scripts/smoke.mjs';

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

// The redesign switch (settings redesign.enabled) is on in staging and
// production, and there "/" serves new.html. Smoke runs after every deploy, so
// it has to pass in both modes and still tell the two home pages apart.
describe('runSmoke in the redesign mode', () => {
  let settings;
  beforeAll(() => {
    settings = require(path.join(__dirname, '..', '..', 'server', 'settings.js'));
    settings.set('redesign', 'enabled', true);
  });
  afterAll(() => settings.reset('redesign', 'enabled'));

  it('passes against the live app with the switch on', async () => {
    // Not vacuous: the home page really is the redesign one here.
    const home = await (await fetch(baseUrl + '/')).text();
    expect(isRedesignPage(home)).toBe(true);
    expect(home).not.toContain('המתנה הכי אישית');
    await expect(runSmoke(baseUrl, { adminKey: ADMIN_KEY })).resolves.toBe(true);
  });
});

describe('the home-page marker follows the mode', () => {
  // A stand-in server that serves one body for every path.
  async function serve(body) {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    return { srv, url: `http://127.0.0.1:${srv.address().port}` };
  }

  it('fails a redesign page that carries only the classic home marker', async () => {
    const { srv, url } = await serve('<html lang="he" class="rd"><title>המתנה הכי אישית</title>');
    try {
      await expect(runSmoke(url, { readyTimeoutMs: 500 })).rejects.toThrow(
        /\[static-page\] .*\/ — missing expected marker "המשחק הכי אישי" \(redesign mode\)/
      );
    } finally {
      srv.close();
    }
  });

  it('fails a classic page that carries only the redesign home marker', async () => {
    const { srv, url } = await serve('<html lang="he"><title>המשחק הכי אישי</title>');
    try {
      await expect(runSmoke(url, { readyTimeoutMs: 500 })).rejects.toThrow(
        /missing expected marker "המתנה הכי אישית" \(classic mode\)/
      );
    } finally {
      srv.close();
    }
  });

  it('reads the mode from the <html> tag only', () => {
    expect(isRedesignPage('<html lang="he" dir="rtl" class="rd">')).toBe(true);
    expect(isRedesignPage("<html class='x rd y'>")).toBe(true);
    expect(isRedesignPage('<html lang="he"><body class="rd">')).toBe(false);
    expect(isRedesignPage('<html class="rdx">')).toBe(false);
    expect(isRedesignPage('no html tag')).toBe(false);
  });
});
