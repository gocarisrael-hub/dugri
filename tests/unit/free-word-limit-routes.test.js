// @vitest-environment node
// The free word quota at the HTTP layer: POST /api/collections/:id/words must
// enforce it server-side (a client-side lock is bypassable), report a partial
// batch honestly, project the quota state onto the public view, and fire the
// "you filled the quota" email exactly once. Boots the real app with email
// captured through a stubbed Resend fetch.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { vi } from 'vitest';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;
let app;
let db;
let settings;
let server;
let base;
const sent = [];

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-freelimit-routes-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.NOTIFY_TO = 'owner@dugri.example';
  process.env.NOTIFY_FROM = 'Dugri <orders@dugri.example>';
  delete process.env.WHATSAPP_ENABLED;

  for (const f of ['db.js', 'settings.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  settings.set('pricing', 'free_word_limit', 5);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (server) server.close();
});

beforeEach(() => {
  sent.length = 0;
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function get(urlPath) {
  const res = await realFetch(base + urlPath);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
// Creating a collection itself fires the owner + buyer "new order" emails, so
// drain them before each quota assertion — this suite only cares about the
// quota mail.
async function newCollection(email = 'buyer@example.com') {
  const r = await post('/api/collections', { honoree_name: 'שירה', email });
  await new Promise((res) => setTimeout(res, 40));
  sent.length = 0;
  return r.body;
}
const words = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => prefix + (i + 1));
async function waitForMails(n, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (sent.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return sent;
}

describe('POST /words enforces the quota', () => {
  it('adds normally below the quota, without disclosing the quota', async () => {
    const c = await newCollection();
    const r = await post('/api/collections/' + c.id + '/words', { words: words(3) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 3, blocked: 0, count: 3 });
    expect(r.body.free_limit_locked).toBe(false);
    // The buyer must not be able to see the cap coming.
    expect(r.body).not.toHaveProperty('free_word_limit');
  });

  it('takes a batch partially, reporting what the quota refused', async () => {
    const c = await newCollection();
    await post('/api/collections/' + c.id + '/words', { words: words(3) });
    const r = await post('/api/collections/' + c.id + '/words', { words: words(10, 'x') });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 2, blocked: 8, count: 5, free_limit_locked: true });
  });

  it('refuses a further add with 402 once the quota is full', async () => {
    const c = await newCollection();
    await post('/api/collections/' + c.id + '/words', { words: words(5) });
    const r = await post('/api/collections/' + c.id + '/words', { words: ['עוד'] });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('free_limit_reached');
    // Locked, so the number rides along (count already equals it). What matters
    // is that the PAGE never renders it — see the e2e spec.
    expect(r.body.free_word_limit).toBe(5);
    // Nothing slipped through.
    expect((await get('/api/collections/' + c.id)).body.count).toBe(5);
  });

  it('lets the words back in once the order is paid', async () => {
    const c = await newCollection();
    await post('/api/collections/' + c.id + '/words', { words: words(5) });
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id);
    const r = await post('/api/collections/' + c.id + '/words', { words: ['אחרי', 'תשלום'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 2, blocked: 0, free_limit_locked: false });
  });
});

describe('GET /api/collections/:id withholds the limit until the lock', () => {
  it('sends no quota number while the collection is still open', async () => {
    const c = await newCollection();
    const v = (await get('/api/collections/' + c.id)).body;
    expect(v.free_limit_locked).toBe(false);
    // The surprise only works if the cap is unknowable in advance — a buyer
    // reading the Network tab must not find it BEFORE reaching it.
    expect(v).not.toHaveProperty('free_word_limit');
  });

  it('sends it once locked — by then `count` already is the number', async () => {
    const c = await newCollection();
    await post('/api/collections/' + c.id + '/words', { words: words(5) });
    const v = (await get('/api/collections/' + c.id)).body;
    expect(v.free_limit_locked).toBe(true);
    expect(v.free_word_limit).toBe(5);
    expect(v.count).toBe(5);
  });

  it('a partially-blocked add reports what was refused', async () => {
    // The page needs this to tell the buyer how many of their pasted words did
    // not make it — without it a 40-word paste silently loses 35.
    const c = await newCollection();
    await post('/api/collections/' + c.id + '/words', { words: words(3) });
    const r = await post('/api/collections/' + c.id + '/words', { words: words(40, 'x') });
    expect(r.body.blocked).toBe(38);
    expect(r.body.added).toBe(2);
  });

  it('releases a collection that was ALREADY locked, once it is paid', async () => {
    const c = await newCollection();
    // Fill the quota FIRST so the collection is genuinely locked — asserting
    // "not locked" on an empty collection would pass even if the paid exemption
    // were broken, since 0 words never reaches a limit of 5.
    await post('/api/collections/' + c.id + '/words', { words: words(5) });
    expect((await get('/api/collections/' + c.id)).body.free_limit_locked).toBe(true);
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id);
    const v = (await get('/api/collections/' + c.id)).body;
    expect(v.free_limit_locked).toBe(false);
    // And the lock is really gone, not just reported gone.
    const r = await post('/api/collections/' + c.id + '/words', { words: ['אחרי', 'התשלום'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 2, blocked: 0 });
  });
});

describe('the quota-reached email', () => {
  it('fires once when the quota fills, to the buyer, with the pay link', async () => {
    const c = await newCollection('quota@example.com');
    await post('/api/collections/' + c.id + '/words', { words: words(5) });
    const mails = await waitForMails(1);
    const mail = mails.find((m) => m.to === 'quota@example.com');
    expect(mail).toBeTruthy();
    expect(mail.subject).toContain('5');
    expect(mail.text).toContain(c.owner_token);
  });

  it('does not fire again when more words are attempted', async () => {
    const c = await newCollection('once@example.com');
    await post('/api/collections/' + c.id + '/words', { words: words(5) });
    await waitForMails(1);
    sent.length = 0;
    await post('/api/collections/' + c.id + '/words', { words: ['שוב'] });
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.filter((m) => m.to === 'once@example.com')).toHaveLength(0);
  });

  it('does not fire while the collection is still below the quota', async () => {
    const c = await newCollection('below@example.com');
    await post('/api/collections/' + c.id + '/words', { words: words(4) });
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.filter((m) => m.to === 'below@example.com')).toHaveLength(0);
  });
});
