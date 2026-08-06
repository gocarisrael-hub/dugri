// @vitest-environment node
// The admin WhatsApp-group routes: list which collections have a group, open one
// via the bot for a collection that has none, and fetch a clickable invite link
// for one that does. Boots the app with the bot armed and stubs global fetch so
// no real Whapi call is made — the stub is also how we simulate the failure the
// owner actually hits (a 429 / dropped channel) without a live account.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// Captured BEFORE vi.stubGlobal replaces global fetch: the stub exists to
// answer the APP's outbound Whapi calls, so the test's own requests to the
// server must bypass it or they'd be answered by the stub instead.
const realFetch = globalThis.fetch;
const ADMIN_KEY = 'admin-test-key';
let app;
let server;
let base;
let db;
let waState;
// Each test sets this to decide how the stubbed Whapi answers.
let whapiHandler;

const qs = '?key=' + encodeURIComponent(ADMIN_KEY);

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-admin-wa-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHAPI_TOKEN = 'tok-secret';
  process.env.WHAPI_BASE_URL = 'https://gate.example.test';
  process.env.WHAPI_WEBHOOK_SECRET = 'hook-secret';
  delete process.env.WHATSAPP_MIRROR_WEBHOOK_URL;

  for (const f of ['db.js', 'settings.js', 'wa-state.js', 'whatsapp.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  app = require(path.join(serverDir, 'index.js'));
  db = require(path.join(serverDir, 'db.js'));
  waState = require(path.join(serverDir, 'wa-state.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => whapiHandler(String(url), opts))
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
  // Default: every Whapi call succeeds and group creation returns an id.
  whapiHandler = async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.includes('/groups') && url.includes('/invite')) {
        return { invite_code: 'INVITE123' };
      }
      if (url.endsWith('/groups')) return { group_id: '120363999@g.us' };
      return {};
    },
    text: async () => '',
  });
});

function makeCollection(phone = '0521234567') {
  return db.createCollection('נועה', { email: 'a@b.example', phone });
}

describe('GET /api/admin/whatsapp/groups', () => {
  it('rejects without the admin key', async () => {
    const r = await realFetch(base + '/api/admin/whatsapp/groups');
    expect(r.status).toBe(403);
  });

  it('maps collection id -> groupId, and includes CLOSED groups', async () => {
    const open = makeCollection();
    const closed = makeCollection();
    waState.linkGroup('120363001@g.us', open.id, '972521234567', []);
    waState.linkGroup('120363002@g.us', closed.id, '972521234567', []);
    waState.markClosed('120363002@g.us');

    const r = await realFetch(base + '/api/admin/whatsapp/groups' + qs);
    const data = await r.json();
    expect(r.status).toBe(200);
    expect(data.groups[open.id]).toEqual({ groupId: '120363001@g.us', closed: false });
    // A finished order still has a real group the owner may want to post in.
    expect(data.groups[closed.id]).toEqual({ groupId: '120363002@g.us', closed: true });
  });

  it('omits a collection that has no group', async () => {
    const c = makeCollection();
    const r = await realFetch(base + '/api/admin/whatsapp/groups' + qs);
    const data = await r.json();
    expect(data.groups[c.id]).toBeUndefined();
  });
});

describe('POST /api/admin/whatsapp/groups/:cid/open', () => {
  it('rejects without the admin key', async () => {
    const c = makeCollection();
    const r = await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/open', {
      method: 'POST',
    });
    expect(r.status).toBe(403);
  });

  it('404s an unknown collection', async () => {
    const r = await realFetch(base + '/api/admin/whatsapp/groups/nope/open' + qs, {
      method: 'POST',
    });
    expect(r.status).toBe(404);
  });

  it('opens a group and links it to the collection', async () => {
    const c = makeCollection();
    const r = await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/open' + qs, {
      method: 'POST',
    });
    const data = await r.json();
    expect(r.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.groupId).toBe('120363999@g.us');
    // The group must be linked in wa-state, exactly as the automatic hook does —
    // otherwise words typed in it would never reach the collection.
    expect(waState.groupForCollection(c.id)).toBe('120363999@g.us');
  });

  it('409s when the collection already has a group (never opens a second)', async () => {
    const c = makeCollection();
    waState.linkGroup('120363777@g.us', c.id, '972521234567', []);
    const r = await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/open' + qs, {
      method: 'POST',
    });
    expect(r.status).toBe(409);
    expect(waState.groupForCollection(c.id)).toBe('120363777@g.us');
  });

  it('400s with bad_phone when the buyer has no usable IL mobile (auto_add only)', async () => {
    // The buyer's number only matters when the bot is going to ADD them. In the
    // default invite_link mode nobody is dialled, so a landline is no obstacle —
    // this refusal is specific to auto_add.
    const settings = require(path.join(serverDir, 'settings.js'));
    settings.set('wa', 'group_mode', 'auto_add');
    try {
      const c = makeCollection('03-1234567'); // landline, not a mobile
      const r = await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/open' + qs, {
        method: 'POST',
      });
      const data = await r.json();
      expect(r.status).toBe(400);
      expect(data.reason).toBe('bad_phone');
    } finally {
      settings.reset('wa', 'group_mode');
    }
  });

  it('opens a group for a landline buyer in the default invite_link mode', async () => {
    const c = makeCollection('03-1234567');
    const r = await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/open' + qs, {
      method: 'POST',
    });
    const data = await r.json();
    expect(r.status).toBe(200);
    expect(data.ok).toBe(true);
  });

  it('reports the channel connection when Whapi refuses (the 429 case)', async () => {
    const c = makeCollection();
    whapiHandler = async (url) => {
      if (url.includes('/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: { text: 'QR' } }),
          text: async () => '',
        };
      }
      return {
        ok: false,
        status: 429,
        json: async () => ({ message: 'rate limit' }),
        text: async () => '',
      };
    };
    const r = await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/open' + qs, {
      method: 'POST',
    });
    const data = await r.json();
    expect(r.status).toBe(502);
    expect(data.reason).toBe('whapi_failed');
    // Surfacing the dropped channel is the whole point — a bare "failed" leaves
    // the owner with nothing to act on.
    expect(data.connection).toBe('disconnected');
    expect(waState.groupForCollection(c.id)).toBeNull();
  });

  // Regression for a real incident: group creation failed with a bare
  // "whapi http 429", which reads as "rate limit, wait it out". The actual body
  // said account_reachout_restricted — WhatsApp had restricted the bot NUMBER
  // from contacting people, which no env or code change can fix. The log must
  // carry that string or the next occurrence is diagnosed wrong again.
  it("logs Whapi's nested error details, not just the status", async () => {
    const c = makeCollection();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    whapiHandler = async (url) => {
      if (url.includes('/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: { text: 'AUTH' } }),
          text: async () => '',
        };
      }
      return {
        ok: false,
        status: 429,
        // Whapi's real shape, captured from the live API.
        json: async () => ({
          error: {
            code: 429,
            message: 'too many requests',
            details: 'account_reachout_restricted',
          },
        }),
        text: async () => '',
      };
    };
    await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/open' + qs, { method: 'POST' });
    const logged = warn.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(logged).toContain('account_reachout_restricted');
    // The generic wrapper must not displace the actionable part.
    expect(logged).not.toContain('too many requests');
    warn.mockRestore();
  });
});

describe('GET /api/admin/whatsapp/groups/:cid/invite', () => {
  it('rejects without the admin key', async () => {
    const c = makeCollection();
    const r = await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/invite');
    expect(r.status).toBe(403);
  });

  it('404s a collection with no group', async () => {
    const c = makeCollection();
    const r = await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/invite' + qs);
    expect(r.status).toBe(404);
  });

  it('returns a full invite link built from the invite code', async () => {
    const c = makeCollection();
    waState.linkGroup('120363555@g.us', c.id, '972521234567', []);
    const r = await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/invite' + qs);
    const data = await r.json();
    expect(r.status).toBe(200);
    expect(data.groupId).toBe('120363555@g.us');
    expect(data.inviteLink).toContain('INVITE123');
  });

  it('502s when Whapi cannot produce a link', async () => {
    const c = makeCollection();
    waState.linkGroup('120363556@g.us', c.id, '972521234567', []);
    whapiHandler = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => '',
    });
    const r = await realFetch(base + '/api/admin/whatsapp/groups/' + c.id + '/invite' + qs);
    expect(r.status).toBe(502);
  });
});
