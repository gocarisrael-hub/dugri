// @vitest-environment node
// Proves the WhatsApp bot is DORMANT / CI-safe: with WHATSAPP_ENABLED + WHAPI_TOKEN
// UNSET, whatsapp.isConfigured() is false, so the webhook does no work, the nudge
// scan is a no-op, and NOTHING ever touches the network — even though a webhook
// secret is present (the one thing that lets verifyWebhookSecret pass). fetch is a
// spy that would record any call; we assert it is never invoked.
import { it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;

let app;
let db;
let waState;
let whatsapp;
let server;
let base;
let fetchSpy;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wa-dormant-'));
  // NOTE: intentionally NO WHATSAPP_ENABLED / WHAPI_TOKEN -> isConfigured() false.
  delete process.env.WHATSAPP_ENABLED;
  delete process.env.WHAPI_TOKEN;
  process.env.WHAPI_WEBHOOK_SECRET = 'hook-secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

  for (const f of ['db.js', 'settings.js', 'wa-state.js', 'whatsapp.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  require(path.join(serverDir, 'settings.js'));
  waState = require(path.join(serverDir, 'wa-state.js'));
  whatsapp = require(path.join(serverDir, 'whatsapp.js'));
  app = require(path.join(serverDir, 'index.js'));

  // A recording spy: any network call would show up here.
  fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal('fetch', fetchSpy);

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (server) server.close();
});

beforeEach(() => {
  fetchSpy.mockClear();
});

async function webhook(body, secret = 'hook-secret') {
  const qs = secret == null ? '' : '?secret=' + encodeURIComponent(secret);
  const res = await realFetch(base + '/api/whatsapp/webhook' + qs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

it('the bot is not configured', () => {
  expect(whatsapp.isConfigured()).toBe(false);
});

it('the webhook accepts a valid secret but does no work (no fetch)', async () => {
  const c = db.createCollection('שירה', { phone: '0521234567' });
  waState.linkGroup('dorm@g.us', c.id, '972521234567', ['972521234567']);
  const r = await webhook({
    messages: [{ chat_id: 'dorm@g.us', type: 'text', text: { body: 'a,b' } }],
  });
  expect(r.status).toBe(200);
  expect(db.listWords(c.id)).toHaveLength(0); // no words collected
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('the webhook rejects a missing secret with 403 (no fetch)', async () => {
  const r = await webhook({ messages: [] }, null);
  expect(r.status).toBe(403);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('runWaNudgeScan is a no-op returning 0 (no fetch)', async () => {
  const c = db.createCollection('נועה', { phone: '0521234567' });
  waState.linkGroup('dorm2@g.us', c.id, '972521234567', ['972521234567']);
  const sent = await app.runWaNudgeScan(Date.now());
  expect(sent).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('openWhatsappGroup opens nothing (no fetch)', async () => {
  const c = db.createCollection('רון', { phone: '0521234567' });
  await app.openWhatsappGroup(c, base);
  expect(waState.groupForCollection(c.id)).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
});
