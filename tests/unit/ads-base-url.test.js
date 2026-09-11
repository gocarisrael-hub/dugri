// @vitest-environment node
//
// The ad report hands the page the site's PUBLIC address.
//
// The link builder on /admin-ads.html used the address the admin happened to be
// open at, and the owner reaches the admin through the Railway hostname as often
// as through the real domain — so the link she pasted into her Instagram bio
// pointed at *.up.railway.app. It WORKED, which is what made it dangerous:
// nothing anywhere would have told her it was the wrong address.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
const PUBLIC = 'https://dugri-israel.co.il';

let server;
let base;

function boot(publicBaseUrl) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-ads-base-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  if (publicBaseUrl) process.env.PUBLIC_BASE_URL = publicBaseUrl;
  else delete process.env.PUBLIC_BASE_URL;
  for (const f of ['db.js', 'settings.js', 'attribution.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  return require(path.join(serverDir, 'index.js'));
}

async function listen(app) {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
}

afterAll(() => {
  if (server) server.close();
  delete process.env.PUBLIC_BASE_URL;
});

describe('with a public base url configured', () => {
  beforeAll(async () => {
    await listen(boot(PUBLIC + '/'));
  });

  it('reports the real domain, trailing slash trimmed', async () => {
    const r = await fetch(base + '/api/admin/ads?key=' + ADMIN_KEY);
    const body = await r.json();
    expect(body.base_url).toBe(PUBLIC);
    // Still the report it always was.
    expect(body).toHaveProperty('rows');
    expect(body).toHaveProperty('totals');
  });

  it('does not leak the address to a caller without the admin key', async () => {
    expect((await fetch(base + '/api/admin/ads')).status).toBe(403);
  });
});

describe('with none configured', () => {
  beforeAll(async () => {
    if (server) server.close();
    await listen(boot(null));
  });

  // null, not an empty string or the request's own host: the page falls back to
  // its own origin only when it can tell the server truly has no answer.
  it('says so plainly rather than guessing a host', async () => {
    const r = await fetch(base + '/api/admin/ads?key=' + ADMIN_KEY);
    expect((await r.json()).base_url).toBeNull();
  });
});
