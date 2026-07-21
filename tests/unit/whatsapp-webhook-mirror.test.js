// @vitest-environment node
// The webhook mirror: when WHATSAPP_MIRROR_WEBHOOK_URL is set (on the entry env,
// e.g. production), each inbound webhook is COPIED to that URL (e.g. staging's
// webhook) so a group created there can also collect words. A request that is
// itself a mirror (mirror=1) is NOT re-forwarded, so there are no loops. Boots the
// app with the bot armed + a mirror URL configured, stubs global fetch to capture
// the mirror POST (an unmapped group is a no-op, so the ONLY outbound fetch is the
// mirror), and drives the webhook.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;
const MIRROR_URL = 'https://staging.example/api/whatsapp/webhook?secret=stg-secret';
let app;
let server;
let base;
let fetchCalls;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wh-mirror-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHAPI_TOKEN = 'tok-secret';
  process.env.WHAPI_BASE_URL = 'https://gate.example.test';
  process.env.WHAPI_WEBHOOK_SECRET = 'hook-secret';
  process.env.WHATSAPP_MIRROR_WEBHOOK_URL = MIRROR_URL;

  for (const f of ['db.js', 'settings.js', 'wa-state.js', 'whatsapp.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      fetchCalls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    })
  );

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
  delete process.env.WHATSAPP_MIRROR_WEBHOOK_URL;
});

beforeEach(() => {
  fetchCalls = [];
});

async function postWebhook(query, body) {
  const res = await realFetch(base + '/api/whatsapp/webhook' + query, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status };
}

const MSG = {
  messages: [
    {
      id: 'm1',
      chat_id: '120363000000000000@g.us',
      from: '972500000099',
      type: 'text',
      text: { body: 'שלום' },
      from_me: false,
    },
  ],
};

// Let the fire-and-forget mirror fetch run.
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('WhatsApp webhook mirror', () => {
  it('copies an inbound webhook to the mirror URL with mirror=1 and the same body', async () => {
    const r = await postWebhook('?secret=hook-secret', MSG);
    expect(r.status).toBe(200);
    await tick();
    const mirror = fetchCalls.find((c) => c.url.includes('staging.example'));
    expect(mirror).toBeTruthy();
    expect(mirror.url).toBe(MIRROR_URL + '&mirror=1'); // marker appended
    expect(mirror.body).toEqual(MSG); // full payload forwarded
  });

  it('does NOT re-forward a request that is already a mirror (mirror=1) — no loop', async () => {
    const r = await postWebhook('?secret=hook-secret&mirror=1', MSG);
    expect(r.status).toBe(200);
    await tick();
    expect(fetchCalls.some((c) => c.url.includes('staging.example'))).toBe(false);
  });

  it('does not mirror a request rejected for a bad secret (403 before mirror)', async () => {
    const r = await postWebhook('?secret=WRONG', MSG);
    expect(r.status).toBe(403);
    await tick();
    expect(fetchCalls.some((c) => c.url.includes('staging.example'))).toBe(false);
  });
});
