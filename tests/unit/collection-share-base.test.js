// @vitest-environment node
//
// THE SHARE LINK'S DOMAIN COMES FROM THE SERVER. collect.html builds the link the
// owner sends her friends from `share_base` in GET /api/collections/:id, which
// is PUBLIC_BASE_URL. It used to be location.origin, so an owner who opened her
// page through the Railway host shared https://dugri-production.up.railway.app.
// Every viewer gets it (it is the site's public address, nothing private), and
// null where PUBLIC_BASE_URL is unset so the page falls back to its own origin.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let server;
let base;
let db;
const savedBase = process.env.PUBLIC_BASE_URL;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-share-base-'));
  for (const f of ['db.js', 'settings.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  require(path.join(serverDir, 'settings.js'));
  db = require(path.join(serverDir, 'db.js'));
  const app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
  if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = savedBase;
});

async function view(c, k) {
  const r = await fetch(base + '/api/collections/' + c.id + (k ? '?k=' + k : ''));
  return r.json();
}

describe('share_base in the collection view', () => {
  it('is PUBLIC_BASE_URL without a trailing slash, for the owner and for a friend', async () => {
    process.env.PUBLIC_BASE_URL = 'https://dugri-israel.co.il/';
    const c = db.createCollection('Shira', {});
    expect((await view(c, c.owner_token)).share_base).toBe('https://dugri-israel.co.il');
    expect((await view(c)).share_base).toBe('https://dugri-israel.co.il');
  });

  it('follows the environment (staging gets staging)', async () => {
    process.env.PUBLIC_BASE_URL = 'https://dugri-staging.up.railway.app';
    const c = db.createCollection('Noa', {});
    expect((await view(c)).share_base).toBe('https://dugri-staging.up.railway.app');
  });

  it('is null when unset, and never taken from the request', async () => {
    delete process.env.PUBLIC_BASE_URL;
    const c = db.createCollection('Dana', {});
    const r = await fetch(base + '/api/collections/' + c.id, {
      headers: { 'X-Forwarded-Host': 'evil.example', Host: 'evil.example' },
    });
    expect((await r.json()).share_base).toBe(null);
  });
});
