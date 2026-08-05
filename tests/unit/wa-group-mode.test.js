// @vitest-environment node
// How a word-collection group gets OPENED — the ban-safety half of the WhatsApp
// flow (see server/wa-guard.js for the incident this encodes).
//
// Two modes, owner-selected via settings wa.group_mode:
//   invite_link (DEFAULT) — create an EMPTY group and hand the buyer a join LINK
//     by email / their order page. The bot adds nobody and DMs nobody, so there
//     is no "reachout" for WhatsApp to restrict. This is what makes the flow
//     survivable on a fresh SIM.
//   auto_add — the original flow: the buyer is a participant on the create call.
//     Nicer UX, but it is exactly the action the previous number was banned for,
//     so it is opt-in AND still passes through the breaker + daily cap.
//
// The app is booted with the bot armed and global fetch stubbed, so every
// outbound Whapi request is captured and asserted — no real network, no real
// account. What matters in most of these tests is what we DIDN'T send.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
let waState;
let settings;
let guard;
// Every Whapi request the app made during a test: { method, path, body }.
let calls;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wa-mode-'));
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHAPI_TOKEN = 'tok-secret';
  process.env.WHAPI_BASE_URL = 'https://gate.example.test';
  process.env.WHAPI_WEBHOOK_SECRET = 'hook-secret';
  // Email dormant: these tests are about what goes over WhatsApp, and a dormant
  // notify keeps sendGroupInvite a no-op returning false without any network.
  delete process.env.RESEND_API_KEY;

  for (const f of [
    'db.js',
    'settings.js',
    'wa-state.js',
    'wa-guard.js',
    'whatsapp.js',
    'notify.js',
    'index.js',
  ]) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  app = require(path.join(serverDir, 'index.js'));
  db = require(path.join(serverDir, 'db.js'));
  waState = require(path.join(serverDir, 'wa-state.js'));
  settings = require(path.join(serverDir, 'settings.js'));
  guard = require(path.join(serverDir, 'wa-guard.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      const u = String(url);
      const p = u.replace('https://gate.example.test', '');
      calls.push({
        method: (opts && opts.method) || 'GET',
        path: p,
        body: opts && opts.body ? JSON.parse(opts.body) : null,
      });
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (p.includes('/groups/') && p.endsWith('/invite')) {
            return { invite_code: 'INVITE123' };
          }
          if (p === '/groups') return { group_id: '120363999@g.us' };
          if (p === '/messages/text') return { sent: true, id: 'msg-1' };
          return {};
        },
        text: async () => '',
      };
    })
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  calls = [];
  guard.clear();
  settings.reset('wa', 'group_mode');
});

let seq = 0;
function makeCollection(phone = '0521234567') {
  seq += 1;
  return db.createCollection('נועה ' + seq, { email: 'a@b.example', phone });
}

// The requests of one kind the app made, for readable assertions.
const groupCreates = () => calls.filter((c) => c.method === 'POST' && c.path === '/groups');
const textSends = () => calls.filter((c) => c.method === 'POST' && c.path === '/messages/text');

describe('invite_link mode (the default)', () => {
  it('is the default when the owner has set nothing', () => {
    const wa = require(path.join(serverDir, 'whatsapp.js'));
    expect(wa.groupMode()).toBe('invite_link');
  });

  it('creates the group with NO participants — the bot contacts nobody', async () => {
    const c = makeCollection();
    await app.openWhatsappGroup(c, 'https://test.dugri.example');
    expect(groupCreates()).toHaveLength(1);
    expect(groupCreates()[0].body.participants).toEqual([]);
  });

  it('sends NO cold DM to the buyer', async () => {
    const c = makeCollection();
    await app.openWhatsappGroup(c, 'https://test.dugri.example');
    // The only text send allowed is the welcome INTO the group itself.
    for (const s of textSends()) expect(String(s.body.to)).toMatch(/@g\.us$/);
  });

  it('fetches and PERSISTS the join link so the buyer can be given a way in', async () => {
    const c = makeCollection();
    await app.openWhatsappGroup(c, 'https://test.dugri.example');
    expect(waState.inviteLinkForCollection(c.id)).toBe('https://chat.whatsapp.com/INVITE123');
  });

  it('opens a group even when the buyer has NO usable phone — nothing is dialled', async () => {
    // A landline / junk number blocks auto_add (there is nobody to add), but the
    // link flow does not need a number at all.
    const c = makeCollection('03-1234567');
    await app.openWhatsappGroup(c, 'https://test.dugri.example');
    expect(groupCreates()).toHaveLength(1);
    expect(waState.groupForCollection(c.id)).toBe('120363999@g.us');
  });

  it('still opens groups while the breaker is TRIPPED — an empty group is not reachout', async () => {
    guard.trip('account_reachout_restricted');
    const c = makeCollection();
    await app.openWhatsappGroup(c, 'https://test.dugri.example');
    expect(groupCreates()).toHaveLength(1);
    expect(waState.groupForCollection(c.id)).toBe('120363999@g.us');
  });

  it('spends no reachout budget', async () => {
    const before = guard.snapshot().count;
    const c = makeCollection();
    await app.openWhatsappGroup(c, 'https://test.dugri.example');
    expect(guard.snapshot().count).toBe(before);
  });
});

describe('auto_add mode (opt-in, still guarded)', () => {
  beforeEach(() => {
    settings.set('wa', 'group_mode', 'auto_add');
  });

  it('puts the buyer on the create call', async () => {
    const c = makeCollection('0521234567');
    await app.openWhatsappGroup(c, 'https://test.dugri.example');
    expect(groupCreates()).toHaveLength(1);
    expect(groupCreates()[0].body.participants).toEqual(['972521234567']);
  });

  it('counts against the daily reachout budget', async () => {
    const before = guard.snapshot().count;
    const c = makeCollection();
    await app.openWhatsappGroup(c, 'https://test.dugri.example');
    expect(guard.snapshot().count).toBe(before + 1);
  });

  it('opens NO group at all while the breaker is tripped, and makes no request', async () => {
    guard.trip('account_reachout_restricted');
    const c = makeCollection();
    await app.openWhatsappGroup(c, 'https://test.dugri.example');
    expect(groupCreates()).toHaveLength(0);
    expect(waState.groupForCollection(c.id)).toBeNull();
  });

  it('stops once the daily cap is spent', async () => {
    const max = guard.snapshot().max;
    for (let i = 0; i < max; i++) guard.recordReachout();
    const c = makeCollection();
    await app.openWhatsappGroup(c, 'https://test.dugri.example');
    expect(groupCreates()).toHaveLength(0);
  });
});

describe('settings validation', () => {
  it('accepts only the two known modes', () => {
    expect(() => settings.set('wa', 'group_mode', 'auto_add')).not.toThrow();
    expect(() => settings.set('wa', 'group_mode', 'invite_link')).not.toThrow();
    // A typo must be REFUSED rather than silently falling back at read time —
    // otherwise the owner believes they enabled a mode that never took effect.
    expect(() => settings.set('wa', 'group_mode', 'autoadd')).toThrow();
    expect(() => settings.set('wa', 'group_mode', true)).toThrow();
  });

  it('bounds the daily reachout cap', () => {
    expect(() => settings.set('wa', 'reachout_daily_max', 10)).not.toThrow();
    expect(() => settings.set('wa', 'reachout_daily_max', 0)).not.toThrow();
    expect(() => settings.set('wa', 'reachout_daily_max', -1)).toThrow();
    expect(() => settings.set('wa', 'reachout_daily_max', 2.5)).toThrow();
    expect(() => settings.set('wa', 'reachout_daily_max', 10000)).toThrow();
    settings.reset('wa', 'reachout_daily_max');
  });

  it('the cap the guard enforces follows the owner setting', () => {
    settings.set('wa', 'reachout_daily_max', 2);
    expect(guard.snapshot().max).toBe(2);
    settings.reset('wa', 'reachout_daily_max');
  });
});
