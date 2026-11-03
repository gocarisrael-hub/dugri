// @vitest-environment node
// A FREE ORDER NEEDS NO CARD PROVIDER. pay/init used to refuse with 503 before
// reading the request whenever card payment was not configured — so a partner
// voucher (or a 100% coupon) could not complete on a server without a provider,
// even though no card is ever charged for it. Now the refusal waits, for a
// request carrying a code, until a card window is actually about to open.
// Without a code nothing changed: refused first, nothing written.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;
let db;
let server;
let base;
const saved = {};

beforeAll(async () => {
  for (const k of [
    'PELECARD_TERMINAL',
    'PELECARD_USER',
    'PELECARD_PASSWORD',
    'PAYMENT_PROVIDER',
    'PUBLIC_BASE_URL',
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-voucher-nocard-'));
  process.env.ADMIN_KEY = 'test-admin-key';
  for (const f of ['settings.js', 'db.js', 'pelecard.js', 'tranzila.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery']) settings.set('pricing', v + '_enabled', true);
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
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

async function payInit(c, body) {
  const res = await fetch(base + '/api/collections/' + c.id + '/pay/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_token: c.owner_token, ...body }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('pay/init with no card provider', () => {
  it('without a code: 503 first, and no order is written', async () => {
    const c = db.createCollection('בלי כרטיס');
    const r = await payInit(c, { version: 'pickup' });
    expect(r).toEqual({ status: 503, body: { error: 'card payment not configured' } });
    expect(db.getCollection(c.id).order).toBeFalsy();
  });

  it('with a code that does not validate: 503 first, and no order is written', async () => {
    const c = db.createCollection('קוד מומצא');
    const r = await payInit(c, { version: 'pickup', coupon: 'NOT-A-REAL-CODE' });
    expect(r).toEqual({ status: 503, body: { error: 'card payment not configured' } });
    expect(db.getCollection(c.id).order).toBeFalsy();
  });

  it('the owner check comes first: a stranger with a real code gets 403, not a code oracle', async () => {
    const { codes } = db.createVoucherPool({ partner_name: 'P', prefix: 'NOE', count: 1 });
    const c = db.createCollection('זר');
    const r = await fetch(base + '/api/collections/' + c.id + '/pay/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_token: 'wrong', version: 'pickup', coupon: codes[0].code }),
    });
    expect(r.status).toBe(403);
    expect(db.getVoucherByCode(codes[0].code).used_at).toBe(null);
    // A made-up code gets the same 403: the code is never looked at for a stranger.
    const bogus = await fetch(base + '/api/collections/' + c.id + '/pay/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_token: 'wrong', version: 'pickup', coupon: 'NOT-REAL' }),
    });
    expect(bogus.status).toBe(403);
  });

  it('a voucher on one pickup copy still completes, free', async () => {
    const { codes } = db.createVoucherPool({ partner_name: 'P', prefix: 'NOC', count: 2 });
    const c = db.createCollection('שובר');
    const r = await payInit(c, { version: 'pickup', coupon: codes[0].code });
    expect(r).toEqual({ status: 200, body: { free: true, paid: true, total: 0 } });
    expect(db.getVoucherByCode(codes[0].code).order_id).toBe(c.id);
  });

  it('a voucher that leaves money to pay: 503, and the code is neither held nor spent', async () => {
    const { codes } = db.createVoucherPool({ partner_name: 'P', prefix: 'NOD', count: 1 });
    const c = db.createCollection('שובר ועוד עותק');
    const r = await payInit(c, { version: 'pickup', quantity: 2, coupon: codes[0].code });
    expect(r.status).toBe(503);
    const row = db.getVoucherByCode(codes[0].code);
    expect(row.used_at).toBe(null);
    expect(row.held).toBe(null);
  });
  it('wrong voucher guesses count against the client here too (last: it uses up this client)', async () => {
    db.createVoucherPool({ partner_name: 'P', prefix: 'NOF', count: 1 });
    const c = db.createCollection('ניחושים');
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await payInit(c, {
            version: 'pickup',
            coupon: 'NOF-AAAA-BBBB-CCCC-DDD' + 'EFGHJKMNPQR'[i],
          })
        ).status
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 503)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(db.getCollection(c.id).order).toBeFalsy();
  });
});
