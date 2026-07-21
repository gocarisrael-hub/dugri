// @vitest-environment node
// The owner/buyer "order received" emails AND the WhatsApp word-collection group
// now fire when an order is CREATED (not on payment). This boots the app with
// email (Resend) configured AND the WhatsApp bot armed — Resend calls are captured
// (nothing leaves the machine) and the impure Whapi calls are spied — then drives
// POST /api/collections/:id/order and asserts:
//   • both emails + the group fire once, at order creation (no payment involved);
//   • it is idempotent — re-creating/re-setting the order never re-sends or opens
//     a second group.
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
let whatsapp;
let waState;
let server;
let base;

const sent = []; // captured Resend emails
let createCalls;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-order-created-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = 'test-admin-key';
  // Email on.
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.NOTIFY_TO = 'owner@dugri.example';
  process.env.NOTIFY_FROM = 'Dugri <orders@dugri.example>';
  // WhatsApp bot armed.
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
  whatsapp = require(path.join(serverDir, 'whatsapp.js'));
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
  // Spy the impure Whapi calls so the group opens without real network.
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

describe('order creation fires owner + buyer emails and opens the WhatsApp group', () => {
  it('POST /order (no payment) sends both emails and opens the group', async () => {
    const c = db.createCollection('נועה', { email: 'buyer@example.com', phone: '0521234567' });
    const r = await post('/api/collections/' + c.id + '/order', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(r.status).toBe(200);

    const mails = await waitForMails(2);
    const owner = mails.find((m) => m.subject.includes('התקבלה הזמנה חדשה'));
    const buyer = mails.find((m) => m.subject.includes('ההזמנה שלכם התקבלה'));
    expect(owner.to).toBe('owner@dugri.example');
    expect(buyer.to).toBe('buyer@example.com');
    // Order-received wording, no payment claim.
    expect(buyer.text).toContain('קיבלנו את ההזמנה שלך');
    expect(owner.text).not.toContain('תשלום');

    // The WhatsApp group was opened at order creation — no payment happened.
    await tick();
    expect(createCalls).toHaveLength(1);
    expect(waState.groupForCollection(c.id)).toBe('g-new@g.us');
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('is idempotent — re-setting the order does NOT re-send or open a second group', async () => {
    const c = db.createCollection('רון', { email: 'ron@example.com', phone: '0521112222' });
    await post('/api/collections/' + c.id + '/order', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    await waitForMails(2);
    await tick();
    expect(createCalls).toHaveLength(1);

    // Second order-create (e.g. the buyer changes the version) — no new mail/group.
    sent.length = 0;
    createCalls = [];
    const r2 = await post('/api/collections/' + c.id + '/order', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' },
    });
    expect(r2.status).toBe(200);
    await tick();
    expect(sent).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
  });
});
