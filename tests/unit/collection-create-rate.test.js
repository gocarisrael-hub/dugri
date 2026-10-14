// @vitest-environment node
//
// CREATING A COLLECTION IS LIMITED PER CLIENT. POST /api/collections is
// unauthenticated; every call writes an order into the JSON-file DB and returns
// an owner_token, which is also a fresh pay/init budget. Before this limit a
// script could mint them without end.
//
// Keyed by clientKey() (the address our own proxy saw), so rotating
// X-Forwarded-For does not buy a new bucket, and a second real client keeps its
// own. Refused BEFORE validation, so a flood of malformed bodies is bounded too.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const LIMIT = 3;

let app;
let server;
let base;
let db;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-coll-rate-'));
  process.env.COLLECTION_CREATE_RATE_LIMIT = String(LIMIT);
  process.env.PAYMENT_PROXY_HOPS = '1';
  for (const f of ['db.js', 'settings.js', 'attribution.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  require(path.join(serverDir, 'settings.js'));
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
  delete process.env.COLLECTION_CREATE_RATE_LIMIT;
  delete process.env.PAYMENT_PROXY_HOPS;
});

async function create(xff, body = { honoree_name: 'Shira' }) {
  const res = await fetch(base + '/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('POST /api/collections per client', () => {
  it('creates up to the limit, then refuses without creating anything', async () => {
    const statuses = [];
    for (let i = 0; i < LIMIT; i++) {
      // A rotating left entry is the caller's own writing; the right one is ours.
      statuses.push((await create(`10.0.0.${i}, 203.0.113.10`)).status);
    }
    expect(statuses).toEqual(Array(LIMIT).fill(201));
    const before = db.listAllCollections().length;
    const refused = await create('10.9.9.9, 203.0.113.10');
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'too many attempts' });
    expect(refused.body.owner_token).toBeUndefined();
    expect(db.listAllCollections().length).toBe(before);
  });

  it('counts malformed requests too, before validation', async () => {
    const statuses = [];
    for (let i = 0; i < LIMIT + 1; i++) {
      statuses.push((await create('203.0.113.20', {})).status);
    }
    expect(statuses).toEqual([...Array(LIMIT).fill(400), 429]);
  });

  it('another real client keeps its own budget', async () => {
    expect((await create('203.0.113.30')).status).toBe(201);
  });
});
