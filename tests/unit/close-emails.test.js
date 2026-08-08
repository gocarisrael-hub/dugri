// @vitest-environment node
// Closing word collection is the handover: the buyer is done, we start producing.
// Pressing "סיום — התחילו להפיק" on collect.html hits POST /api/collections/:id/close,
// and BOTH sides must hear about it from that one transition — the owner that a
// list is ready to produce (order_finished), and the BUYER that we have their
// words and have started (buyer_production_started).
//
// The buyer half is new: it replaced the old pdf_ready "your file is ready,
// download it" mail, which was written for the digital-only phase. So the
// assertions here are as much about WHO gets what as about the send firing.
//
// Boots the app with Resend configured and stubs fetch, so every send is captured
// and nothing leaves the machine.
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
let server;
let base;
const sent = []; // captured Resend emails

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-close-mail-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.NOTIFY_TO = 'owner@dugri.example';
  process.env.NOTIFY_FROM = 'Dugri <orders@dugri.example>';
  delete process.env.WHATSAPP_ENABLED;

  for (const f of ['db.js', 'settings.js', 'wa-state.js', 'whatsapp.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
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
  sent.length = 0;
});

async function closeCollection(id, ownerToken) {
  const res = await realFetch(base + '/api/collections/' + id + '/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner_token: ownerToken }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Both mails are fire-and-forget, so wait for them rather than racing the response.
async function waitForMails(n, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (sent.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return sent;
}
const tick = () => new Promise((r) => setTimeout(r, 40));

function openCollection(name, email) {
  const c = db.createCollection(name, { email, phone: '0521234567' });
  db.addWords(c.id, ['אחת', 'שתיים', 'שלוש'], 'tester');
  return c;
}

describe('closing word collection emails both sides', () => {
  it('emails the OWNER "ready to produce" and the BUYER "we have started"', async () => {
    const c = openCollection('נועה', 'buyer@example.com');
    const r = await closeCollection(c.id, c.owner_token);
    expect(r.status).toBe(200);
    expect(db.effectiveStatus(db.getCollection(c.id))).toBe('closed');

    const mails = await waitForMails(2);
    const owner = mails.find((m) => m.to === 'owner@dugri.example');
    const buyer = mails.find((m) => m.to === 'buyer@example.com');
    expect(owner).toBeTruthy();
    expect(buyer).toBeTruthy();
    expect(owner.subject).toContain('מוכנה להפקה');
    // The buyer's mail confirms we got the list and echoes the count back.
    expect(buyer.subject).toContain('מתחילים להכין');
    expect(buyer.text).toContain('נועה');
    expect(buyer.text).toContain('3');
    // And it hands them nothing to download — that mail is gone.
    expect(buyer.text).not.toContain('/pdf?');
  });

  it('does NOT re-send when an already-closed collection is closed again', async () => {
    const c = openCollection('רון', 'ron@example.com');
    await closeCollection(c.id, c.owner_token);
    await waitForMails(2);
    sent.length = 0;

    const again = await closeCollection(c.id, c.owner_token);
    expect(again.status).toBe(200);
    await tick();
    // Only the real open->closed transition notifies; a double-click must not
    // mail the customer twice.
    expect(sent).toHaveLength(0);
  });

  it('still emails the owner when the buyer left no address', async () => {
    const c = openCollection('גיל', '');
    await closeCollection(c.id, c.owner_token);
    const mails = await waitForMails(1);
    await tick();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('owner@dugri.example');
  });

  it('refuses to close (and mails nothing) without the owner token', async () => {
    const c = openCollection('דנה', 'dana@example.com');
    const r = await closeCollection(c.id, 'wrong-token');
    expect(r.status).toBe(403);
    await tick();
    expect(sent).toHaveLength(0);
    expect(db.effectiveStatus(db.getCollection(c.id))).toBe('open');
  });
});
