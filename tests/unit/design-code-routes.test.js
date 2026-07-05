// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boot the real Express app with ADMIN_KEY set so the admin design-code routes
// are live. A small COUPON_RATE_LIMIT (shared limiter) keeps the rate-limit test
// cheap — the public /api/design-code/validate endpoint is throttled per IP by
// the same limiter the coupon oracle uses.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';

let app;
let db;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-design-code-routes-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.COUPON_RATE_LIMIT = '8';
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

async function post(urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function del(urlPath) {
  const res = await fetch(base + urlPath, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(urlPath) {
  const res = await fetch(base + urlPath);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const key = (p) => `${p}?key=${ADMIN_KEY}`;

describe('admin design-code CRUD auth', () => {
  it('403 with a wrong key, happy path with the right key', async () => {
    expect((await get('/api/admin/design-codes?key=wrong')).status).toBe(403);
    expect(
      (await post('/api/admin/design-codes?key=wrong', { code: 'X', design_id: 'neon' })).status
    ).toBe(403);

    // create
    const created = await post(key('/api/admin/design-codes'), {
      code: 'vipneon',
      design_id: 'neon',
      valid_until: null,
    });
    expect(created.status).toBe(201);
    expect(created.body.design_code.code).toBe('VIPNEON');
    expect(created.body.design_code.design_id).toBe('neon');
    const id = created.body.design_code.id;

    // list contains it
    const list = await get(key('/api/admin/design-codes'));
    expect(list.status).toBe(200);
    expect(list.body.design_codes.some((c) => c.id === id)).toBe(true);

    // toggle active off
    const toggled = await post(key('/api/admin/design-codes/' + id), { active: false });
    expect(toggled.status).toBe(200);
    expect(toggled.body.design_code.active).toBe(false);

    // delete
    expect((await del(key('/api/admin/design-codes/' + id))).status).toBe(200);
    expect((await del(key('/api/admin/design-codes/' + id))).status).toBe(404); // gone
  });

  it('400 on invalid input / duplicate code', async () => {
    expect(
      (await post(key('/api/admin/design-codes'), { code: 'ok', design_id: 'neon' })).status
    ).toBe(400); // too short
    expect((await post(key('/api/admin/design-codes'), { code: 'NODESIGN' })).status).toBe(400);
    await post(key('/api/admin/design-codes'), { code: 'DUP', design_id: 'neon' });
    const dup = await post(key('/api/admin/design-codes'), { code: 'dup', design_id: 'neon' });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe('duplicate');
  });

  it('404 toggling a missing code', async () => {
    expect((await post(key('/api/admin/design-codes/nope'), { active: true })).status).toBe(404);
  });
});

describe('POST /api/design-code/validate (public unlock)', () => {
  it('unlocks the mapped design and counts the use', async () => {
    await post(key('/api/admin/design-codes'), { code: 'UNLOCK1', design_id: 'neon' });
    const r = await post('/api/design-code/validate', { code: 'unlock1' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ valid: true, design: 'neon' });
    // The unlock was counted on the code.
    expect(db.getDesignCodeByCode('UNLOCK1').uses).toBe(1);
  });

  it('returns valid:false + reason for an unknown code (no leak)', async () => {
    const r = await post('/api/design-code/validate', { code: 'GHOSTCODE' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ valid: false, reason: 'not_found' });
  });

  it('rate-limits by client IP once the per-IP budget is exhausted', async () => {
    await post(key('/api/admin/design-codes'), { code: 'RLCODE', design_id: 'neon' });
    let saw429 = false;
    for (let i = 0; i < 30; i++) {
      const r = await post('/api/design-code/validate', { code: 'RLCODE' });
      if (r.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});
