// @vitest-environment node
// The admin settings API on the real Express app: GET returns the registry
// shape, POST stores an override (and persists), DELETE resets, a bad
// section/key is 400, and a missing/wrong admin key is 403. The app is required
// (which does NOT listen — that is guarded by require.main===module) and bound to
// an ephemeral port only for the duration of the test.
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
let app;
let server;
let base;
let dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-settings-routes-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['settings.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.DATA_DIR;
  delete process.env.ADMIN_KEY;
});

const url = (p) => base + p;

describe('GET /api/admin/settings', () => {
  it('403 without the admin key', async () => {
    const res = await fetch(url('/api/admin/settings'));
    expect(res.status).toBe(403);
  });

  it('returns defaults, overrides, effective and the registry with the key', async () => {
    const res = await fetch(url('/api/admin/settings?key=' + ADMIN_KEY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('defaults');
    expect(body).toHaveProperty('overrides');
    expect(body).toHaveProperty('effective');
    expect(body).toHaveProperty('registry');
    // Registry advertises tokens + kind per key.
    expect(body.registry.email.order_paid).toEqual({ tokens: ['honoree'], kind: 'email' });
    expect(body.effective.email.order_paid.subject).toBe('דוגרי · התקבל תשלום — {honoree}');
  });
});

describe('POST /api/admin/settings', () => {
  it('403 without the admin key', async () => {
    const res = await fetch(url('/api/admin/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'email', key: 'order_paid', value: { subject: 'x' } }),
    });
    expect(res.status).toBe(403);
  });

  it('400 on an unknown section/key', async () => {
    const res = await fetch(url('/api/admin/settings?key=' + ADMIN_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'email', key: 'nope', value: { subject: 'x' } }),
    });
    expect(res.status).toBe(400);
  });

  it('sets an override and persists it to disk', async () => {
    const value = { subject: 'שולם — {honoree}', body: 'תודה {honoree}' };
    const res = await fetch(url('/api/admin/settings?key=' + ADMIN_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'email', key: 'order_paid', value }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effective).toEqual(value);
    // Persisted under DATA_DIR.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    expect(onDisk.email.order_paid).toEqual(value);
    // Reflected in a subsequent GET.
    const get = await fetch(url('/api/admin/settings?key=' + ADMIN_KEY));
    const gb = await get.json();
    expect(gb.effective.email.order_paid.subject).toBe('שולם — {honoree}');
    expect(gb.overrides.email.order_paid).toEqual(value);
  });
});

describe('DELETE /api/admin/settings', () => {
  it('403 without the admin key', async () => {
    const res = await fetch(url('/api/admin/settings'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'email', key: 'order_paid' }),
    });
    expect(res.status).toBe(403);
  });

  it('400 on an unknown section/key', async () => {
    const res = await fetch(url('/api/admin/settings?key=' + ADMIN_KEY), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'bogus', key: 'order_paid' }),
    });
    expect(res.status).toBe(400);
  });

  it('resets a key back to its default', async () => {
    // (order_paid was overridden by the POST test above.)
    const res = await fetch(url('/api/admin/settings?key=' + ADMIN_KEY), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'email', key: 'order_paid' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effective.subject).toBe('דוגרי · התקבל תשלום — {honoree}');
    const get = await fetch(url('/api/admin/settings?key=' + ADMIN_KEY));
    const gb = await get.json();
    expect(gb.overrides.email).toBeUndefined();
  });
});
