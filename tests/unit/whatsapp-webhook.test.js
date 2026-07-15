// @vitest-environment node
// Integration tests for the WhatsApp bot's inbound webhook + the paid-order
// group-open hook (server/index.js). The Express app is booted with the bot
// ARMED (WHATSAPP_* env set) so the routes are live, but every IMPURE Whapi call
// (createGroup / sendMessage / getInviteLink) is spied on the whatsapp module —
// so no request ever reaches a real network. The PURE helpers (verifyWebhookSecret,
// parseWebhook, splitWords, buildTriggerMessage) run for real. Global fetch is
// stubbed to THROW, so any accidental network call fails the test loudly.
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
let settings;
let waState;
let whatsapp;
let notify;
let server;
let base;

// Buyer + bot WhatsApp ids used across the paid-hook tests.
const BUYER_WA = '972521234567';
const BOT_WA = '972500000000';

// Mutable per-test control of the spied Whapi responses + captured calls.
let sendResult;
let createResult;
let inviteResult;
let sendCalls;
let createCalls;
let inviteCalls;

const WA_TRIGGERS = [
  'group_opened',
  'member_joined',
  'word_added',
  'list_closed',
  'daily_morning',
  'daily_evening',
  'quiet_reminder',
];

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wa-hook-'));
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHAPI_TOKEN = 'tok-secret';
  process.env.WHAPI_BASE_URL = 'https://gate.example.test';
  process.env.WHAPI_WEBHOOK_SECRET = 'hook-secret';
  process.env.WHAPI_BOT_WA = BOT_WA;
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

  for (const f of ['db.js', 'settings.js', 'wa-state.js', 'whatsapp.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  settings = require(path.join(serverDir, 'settings.js'));
  waState = require(path.join(serverDir, 'wa-state.js'));
  whatsapp = require(path.join(serverDir, 'whatsapp.js'));
  notify = require(path.join(serverDir, 'notify.js'));
  app = require(path.join(serverDir, 'index.js'));

  // No real network, ever.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      throw new Error('unexpected fetch ' + url);
    })
  );

  // Spy the impure Whapi calls; they read the mutable result vars + record calls.
  vi.spyOn(whatsapp, 'sendMessage').mockImplementation(async (to, text) => {
    sendCalls.push({ to, text });
    return sendResult;
  });
  vi.spyOn(whatsapp, 'createGroup').mockImplementation(async (subject, participants) => {
    createCalls.push({ subject, participants });
    return createResult;
  });
  vi.spyOn(whatsapp, 'getInviteLink').mockImplementation(async (groupId) => {
    inviteCalls.push(groupId);
    return inviteResult;
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
  sendCalls = [];
  createCalls = [];
  inviteCalls = [];
  sendResult = { ok: true, sent: true, messageId: 'm1' };
  createResult = { ok: true, groupId: 'g-new@g.us', data: {} };
  inviteResult = { ok: true, inviteCode: 'INV', inviteLink: 'https://chat.whatsapp.com/INV' };
  // Reset the trigger catalog to defaults so a settings override in one test
  // never leaks into another.
  for (const id of WA_TRIGGERS) settings.reset('wa', 'trigger.' + id);
});

// Post a webhook body with the given secret (defaults to the correct one).
async function webhook(body, secret = 'hook-secret') {
  const qs = secret == null ? '' : '?secret=' + encodeURIComponent(secret);
  const res = await realFetch(base + '/api/whatsapp/webhook' + qs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function msgEvent(groupId, text, { from = '972999888', from_name = 'דנה' } = {}) {
  return { chat_id: groupId, from, from_name, type: 'text', text: { body: text } };
}

describe('POST /api/whatsapp/webhook — secret + dormancy gate', () => {
  it('rejects a missing secret with 403 and does no work', async () => {
    const r = await webhook({ messages: [] }, null);
    expect(r.status).toBe(403);
    expect(sendCalls).toHaveLength(0);
  });

  it('rejects a wrong secret with 403', async () => {
    const r = await webhook({ messages: [] }, 'nope');
    expect(r.status).toBe(403);
  });
});

describe('POST /api/whatsapp/webhook — messages', () => {
  it('ignores a message for an unmapped group (no words, no send)', async () => {
    const r = await webhook({ messages: [msgEvent('unknown@g.us', 'שלום')] });
    expect(r.status).toBe(200);
    expect(sendCalls).toHaveLength(0);
  });

  it('adds words from a mapped group message (db grows)', async () => {
    const c = db.createCollection('שירה', { phone: '0521234567' });
    waState.linkGroup('gA@g.us', c.id, BUYER_WA, [BUYER_WA, BOT_WA]);
    const r = await webhook({ messages: [msgEvent('gA@g.us', 'ריקוד, פיצה, ים')] });
    expect(r.status).toBe(200);
    expect(db.listWords(c.id).map((w) => w.text)).toEqual(['ריקוד', 'פיצה', 'ים']);
    // word_added is disabled by default -> the bot stays silent.
    expect(sendCalls).toHaveLength(0);
  });

  it('adds words from BOTH messages in a batch', async () => {
    const c = db.createCollection('נועה', { phone: '0521234567' });
    waState.linkGroup('gB@g.us', c.id, BUYER_WA, [BUYER_WA, BOT_WA]);
    const r = await webhook({
      messages: [msgEvent('gB@g.us', 'אחת, שתיים'), msgEvent('gB@g.us', 'שלוש, ארבע')],
    });
    expect(r.status).toBe(200);
    expect(db.listWords(c.id)).toHaveLength(4);
  });

  it('buyer close-command closes the collection and fires list_closed', async () => {
    const c = db.createCollection('רון', { phone: '0521234567' });
    db.addWords(c.id, ['a', 'b', 'c'], 'x');
    waState.linkGroup('gC@g.us', c.id, BUYER_WA, [BUYER_WA, BOT_WA]);
    // The close is the primary completion path — it must fire the owner "ready to
    // produce" email exactly like the web /close route (only when email is on).
    const cfgSpy = vi.spyOn(notify, 'isConfigured').mockReturnValue(true);
    const finSpy = vi.spyOn(notify, 'sendOrderFinished').mockResolvedValue(true);
    // The buyer's id arrives as a JID; the message-path buyer check normalizes it.
    const r = await webhook({
      messages: [msgEvent('gC@g.us', 'סיום', { from: BUYER_WA + '@s.whatsapp.net' })],
    });
    expect(r.status).toBe(200);
    expect(db.effectiveStatus(db.getCollection(c.id))).toBe('closed');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].to).toBe('gC@g.us');
    expect(sendCalls[0].text).toContain('רון'); // list_closed interpolates {honoree}
    // Owner "list ready to produce" email fired for THIS collection.
    expect(finSpy).toHaveBeenCalledTimes(1);
    expect(finSpy.mock.calls[0][0].id).toBe(c.id);
    cfgSpy.mockRestore();
    finSpy.mockRestore();
  });

  it('a non-buyer typing the close command does NOT close (words are collected)', async () => {
    const c = db.createCollection('גיל', { phone: '0521234567' });
    waState.linkGroup('gC2@g.us', c.id, BUYER_WA, [BUYER_WA, BOT_WA]);
    const r = await webhook({ messages: [msgEvent('gC2@g.us', 'סיום', { from: '972777' })] });
    expect(r.status).toBe(200);
    expect(db.effectiveStatus(db.getCollection(c.id))).toBe('open');
  });

  it('posts the closed note ONCE for an already-closed collection', async () => {
    const c = db.createCollection('מאיה', { phone: '0521234567' });
    db.closeCollection(c.id, c.owner_token);
    waState.linkGroup('gD@g.us', c.id, BUYER_WA, [BUYER_WA, BOT_WA]);
    // First message after close -> one note.
    await webhook({ messages: [msgEvent('gD@g.us', 'עוד מילה')] });
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].text).toContain('מאיה');
    // Second message -> silent (state-deduped) and no words collected.
    sendCalls = [];
    await webhook({ messages: [msgEvent('gD@g.us', 'ועוד אחת')] });
    expect(sendCalls).toHaveLength(0);
    expect(db.listWords(c.id)).toHaveLength(0);
  });
});

describe('POST /api/whatsapp/webhook — participants_added', () => {
  function joinEvent(groupId, participants) {
    return { groups_participants: [{ action: 'add', group_id: groupId, participants }] };
  }

  it('greets a NEW friend but not the buyer or the bot (JID-form ids)', async () => {
    const c = db.createCollection('תמר', { phone: '0521234567' });
    // initial_members are stored as BARE digits...
    waState.linkGroup('gE@g.us', c.id, BUYER_WA, [BUYER_WA, BOT_WA]);
    // ...but Whapi delivers participant ids as JIDs. The buyer + bot must still be
    // recognised (and skipped) after normalization; only the new friend is greeted.
    const r = await webhook(
      joinEvent('gE@g.us', [
        { id: '972111444@s.whatsapp.net', name: 'רון' },
        { id: BUYER_WA + '@s.whatsapp.net', name: 'קונה' },
        { id: BOT_WA + '@s.whatsapp.net', name: 'בוט' },
      ])
    );
    expect(r.status).toBe(200);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].to).toBe('gE@g.us');
    expect(sendCalls[0].text).toContain('תמר'); // member_joined interpolates {honoree}
  });

  it('does NOT greet into an unmapped group the bot does not own', async () => {
    const r = await webhook(
      joinEvent('foreign@g.us', [{ id: '972111000@s.whatsapp.net', name: 'זר' }])
    );
    expect(r.status).toBe(200);
    expect(sendCalls).toHaveLength(0);
  });

  it('does NOT greet a friend who joins after the list is closed', async () => {
    const c = db.createCollection('ניצן', { phone: '0521234567' });
    db.closeCollection(c.id, c.owner_token);
    waState.linkGroup('gClosedJoin@g.us', c.id, BUYER_WA, [BUYER_WA, BOT_WA]);
    const r = await webhook(
      joinEvent('gClosedJoin@g.us', [{ id: '972111222@s.whatsapp.net', name: 'חבר' }])
    );
    expect(r.status).toBe(200);
    expect(sendCalls).toHaveLength(0);
  });

  it('interpolates {name} with the joining member name', async () => {
    const c = db.createCollection('דנה', { phone: '0521234567' });
    waState.linkGroup('gE2@g.us', c.id, BUYER_WA, [BUYER_WA, BOT_WA]);
    settings.set('wa', 'trigger.member_joined', { enabled: true, text: 'שלום {name}!' });
    await webhook(joinEvent('gE2@g.us', [{ id: '972222', name: 'אורי' }]));
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].text).toBe('שלום אורי!');
  });

  it('a disabled trigger sends nothing', async () => {
    const c = db.createCollection('יעל', { phone: '0521234567' });
    waState.linkGroup('gF@g.us', c.id, BUYER_WA, [BUYER_WA, BOT_WA]);
    settings.set('wa', 'trigger.member_joined', { enabled: false });
    const r = await webhook(joinEvent('gF@g.us', [{ id: '972333', name: 'שני' }]));
    expect(r.status).toBe(200);
    expect(sendCalls).toHaveLength(0);
  });
});

describe('paid hook — openWhatsappGroup', () => {
  it('creates the group, links state (incl. initial members) and fires group_opened', async () => {
    const c = db.createCollection('אביב', { phone: '052-123-4567' });
    await app.openWhatsappGroup(c, base);
    // group created with the buyer as a participant
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].participants).toEqual([BUYER_WA]);
    // linked both directions
    const groupId = waState.groupForCollection(c.id);
    expect(groupId).toBe('g-new@g.us');
    const entry = waState.collectionForGroup(groupId);
    expect(entry.collection_id).toBe(c.id);
    expect(entry.owner_wa).toBe(BUYER_WA);
    // buyer + bot recorded as initial members
    expect(waState.isInitialMember(groupId, BUYER_WA)).toBe(true);
    expect(waState.isInitialMember(groupId, BOT_WA)).toBe(true);
    // group_opened announced to the group
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].to).toBe(groupId);
    expect(sendCalls[0].text).toContain('אביב');
  });

  it('is idempotent — a second call opens no second group', async () => {
    const c = db.createCollection('שקד', { phone: '0521234567' });
    await app.openWhatsappGroup(c, base);
    createCalls = [];
    await app.openWhatsappGroup(c, base);
    expect(createCalls).toHaveLength(0);
  });

  it('privacy block: DMs an invite when the buyer could not be added', async () => {
    createResult = {
      ok: true,
      groupId: 'g-priv@g.us',
      data: { failed_participants: [{ id: BUYER_WA }] },
    };
    const c = db.createCollection('ליאור', { phone: '0521234567' });
    await app.openWhatsappGroup(c, base);
    const groupId = waState.groupForCollection(c.id);
    expect(inviteCalls).toEqual([groupId]);
    // A DM to the BUYER carrying the invite link.
    const dm = sendCalls.find((s) => s.to === BUYER_WA);
    expect(dm).toBeTruthy();
    expect(dm.text).toContain('https://chat.whatsapp.com/INV');
    expect(waState.collectionForGroup(groupId).invite_dm_sent).toBe(true);
  });

  it('escalates to an owner alert when the invite DM also fails', async () => {
    createResult = {
      ok: true,
      groupId: 'g-esc@g.us',
      data: { failed_participants: [{ id: BUYER_WA }] },
    };
    sendResult = { ok: false, error: 'blocked' }; // every send (incl. the DM) fails
    const alertSpy = vi.spyOn(notify, 'sendSystemAlert').mockResolvedValue(true);
    const c = db.createCollection('נוגה', { phone: '0521234567' });
    await app.openWhatsappGroup(c, base);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(waState.collectionForGroup(waState.groupForCollection(c.id)).invite_dm_sent).toBe(false);
    alertSpy.mockRestore();
  });

  it('does nothing when the buyer has no usable phone', async () => {
    const c = db.createCollection('ללא טלפון'); // no phone
    await app.openWhatsappGroup(c, base);
    expect(createCalls).toHaveLength(0);
    expect(waState.groupForCollection(c.id)).toBeNull();
  });
});

describe('onOrderPaid — WhatsApp is decoupled from email config', () => {
  it('opens the group + fires group_opened even when email is OFF', async () => {
    // Email is unconfigured in this suite (no Resend env) -> notify.isConfigured()
    // is false. The bot is armed. A paid order must STILL open the WhatsApp group.
    expect(notify.isConfigured()).toBe(false);
    const paidSpy = vi.spyOn(notify, 'sendOrderPaid').mockResolvedValue(true);
    const c = db.createCollection('עמית', { phone: '0521234567' });

    app.onOrderPaid(c.id, base, 0);
    // openWhatsappGroup is fire-and-forget; let its microtasks run.
    await new Promise((r) => setTimeout(r, 0));

    expect(createCalls).toHaveLength(1); // group created
    const groupId = waState.groupForCollection(c.id);
    expect(groupId).toBe('g-new@g.us');
    expect(sendCalls.some((s) => s.to === groupId)).toBe(true); // group_opened fired
    expect(paidSpy).not.toHaveBeenCalled(); // email side stayed dormant
    paidSpy.mockRestore();
  });
});
