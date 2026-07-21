// @vitest-environment node
// The owner + buyer "new order" emails AND the WhatsApp word-collection group now
// fire the moment a customer STARTS — a collection is created (honoree + contact +
// design), before any order/payment. Boots the app with email (Resend, captured)
// and the WhatsApp bot armed (impure calls spied), drives POST /api/collections,
// and asserts both emails + the group fire once, and that a later order does NOT
// re-fire (idempotent per collection).
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
let app;
let db;
let waState;
let server;
let base;
const sent = [];
let createCalls;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-coll-created-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.NOTIFY_TO = 'owner@dugri.example';
  process.env.NOTIFY_FROM = 'Dugri <orders@dugri.example>';
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHAPI_TOKEN = 'tok-secret';
  process.env.WHAPI_BASE_URL = 'https://gate.example.test';
  process.env.WHAPI_WEBHOOK_SECRET = 'hook-secret';

  for (const f of ['db.js', 'settings.js', 'wa-state.js', 'whatsapp.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  waState = require(path.join(serverDir, 'wa-state.js'));
  const whatsapp = require(path.join(serverDir, 'whatsapp.js'));
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('api.resend.com')) {
        const msg = opts && opts.body ? JSON.parse(opts.body) : {};
        sent.push({
          to: Array.isArray(msg.to) ? msg.to[0] : msg.to,
          subject: msg.subject,
          text: msg.text,
        });
        return { ok: true, status: 200, text: async () => '{"id":"stub"}' };
      }
      throw new Error('unexpected fetch ' + u);
    })
  );
  vi.spyOn(whatsapp, 'createGroup').mockImplementation(async () => {
    createCalls.push(1);
    return { ok: true, groupId: 'g-new@g.us', data: { group_id: 'g-new@g.us', invite_code: 'X' } };
  });
  vi.spyOn(whatsapp, 'sendMessage').mockResolvedValue({ ok: true, sent: true, messageId: 'm1' });
  vi.spyOn(whatsapp, 'getInviteLink').mockResolvedValue({
    ok: true,
    inviteLink: 'https://chat.whatsapp.com/X',
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (server) server.close();
});

beforeEach(() => {
  sent.length = 0;
  createCalls = [];
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function waitForMails(n, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (sent.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return sent;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('collection creation (a lead starts) fires the full treatment', () => {
  it('POST /api/collections sends owner + buyer emails and opens the group', async () => {
    const r = await post('/api/collections', {
      honoree_name: 'נועה',
      email: 'buyer@example.com',
      phone: '0521234567',
      design: 'מסיבת רווקות',
      theme: 'bachelorette',
    });
    expect(r.status).toBe(201);

    const mails = await waitForMails(2);
    const owner = mails.find((m) => m.subject.includes('התקבלה הזמנה חדשה'));
    const buyer = mails.find((m) => m.subject.includes('ההזמנה שלכם התקבלה'));
    expect(owner.to).toBe('owner@dugri.example');
    expect(buyer.to).toBe('buyer@example.com');

    // Group opened at the START — no order/payment yet.
    await tick();
    expect(createCalls).toHaveLength(1);
    expect(waState.groupForCollection(r.body.id)).toBe('g-new@g.us');
    expect(db.getCollection(r.body.id).order).toBe(null); // still no order
  });

  it('a later order on that collection does NOT re-notify (idempotent)', async () => {
    const r = await post('/api/collections', {
      honoree_name: 'רון',
      email: 'ron@example.com',
      phone: '0521112222',
      theme: 'bachelorette',
    });
    await waitForMails(2);
    await tick();
    expect(createCalls).toHaveLength(1);

    sent.length = 0;
    createCalls = [];
    // The buyer now places the order (picks a version) — must NOT fire again.
    const o = await post('/api/collections/' + r.body.id + '/order', {
      owner_token: r.body.owner_token,
      version: 'pdf',
    });
    expect(o.status).toBe(200);
    await tick();
    expect(sent).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
  });
});
