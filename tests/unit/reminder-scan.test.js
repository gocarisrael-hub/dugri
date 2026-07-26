// @vitest-environment node
// Unit tests for the owner-reminder-list scheduler pass (app.runReminderListScan)
// in server/index.js. The scan is COLLECTION-based (so it drives email too, not
// only a WhatsApp group). The bot is ARMED and whatsapp.sendMessage is spied (no
// network); notify.sendReminderEmail is spied for the email channel; time is
// INJECTED via `now`. The pure engine (server/reminders.js) runs for real. This is
// what replaced the fixed daily/quiet WhatsApp triggers.
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
let settings;
let waState;
let whatsapp;
let notify;

let sendCalls;
let emailSpy;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// 2026-07-15T06:30Z -> 09:30 Asia/Jerusalem (UTC+3), hour 9, inside a [8,21] window.
const NOW = Date.parse('2026-07-15T06:30:00.000Z');

// A reminder we can spread + tweak. WhatsApp channel, no idle gate, fires daily.
const R = {
  id: 'morning',
  enabled: true,
  text: 'בוקר טוב! עוד זמן להוסיף מילים על {honoree}:\n{link}',
  channels: { email: false, whatsapp: true },
  every_days: 1,
  weekdays: null,
  only_if_idle_hours: null,
  window: [8, 21],
  max_total: 3,
};

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-rem-scan-'));
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHAPI_TOKEN = 'tok-secret';
  process.env.WHAPI_BASE_URL = 'https://gate.example.test';
  process.env.WHAPI_WEBHOOK_SECRET = 'hook-secret';
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

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      throw new Error('unexpected fetch ' + url);
    })
  );
  vi.spyOn(whatsapp, 'sendMessage').mockImplementation(async (to, text) => {
    sendCalls.push({ to, text });
    return { ok: true, sent: true, messageId: 'm' };
  });
  // notify is dormant in tests (no RESEND env); force isConfigured true + spy the
  // email send so the email channel is exercisable without a network.
  vi.spyOn(notify, 'isConfigured').mockReturnValue(true);
  emailSpy = vi.spyOn(notify, 'sendReminderEmail').mockResolvedValue(true);
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sendCalls = [];
  emailSpy.mockClear();
  emailSpy.mockResolvedValue(true);
  whatsapp.sendMessage.mockImplementation(async (to, text) => {
    sendCalls.push({ to, text });
    return { ok: true, sent: true, messageId: 'm' };
  });
  // Full isolation: drop every collection + retire every group so each test's scan
  // sees only what it creates, and reset the reminder list to empty (silent).
  for (const c of db.listAllCollections()) db.deleteCollection(c.id);
  for (const g of waState.activeGroups()) waState.markClosed(g.groupId);
  settings.set('reminders', 'list', []);
});

// An open collection (+ optional linked WhatsApp group). db.lastActivityMs (used
// by only_if_idle_hours) reads the collection's created_at (no words), so anchor
// it to `at` — createCollection stamps real now, which the injected NOW predates.
function seed(honoree, { groupId, at = NOW, email } = {}) {
  const c = db.createCollection(honoree, { phone: '0521234567', email });
  c.created_at = new Date(at).toISOString();
  if (groupId) waState.linkGroup(groupId, c.id, '972521234567', ['972521234567'], at);
  return c;
}

describe('runReminderListScan — WhatsApp delivery', () => {
  it('sends a due reminder to the collection group, deduped by every_days', async () => {
    const c = seed('שירה', { groupId: 'g1@g.us' });
    settings.set('reminders', 'list', [R]);
    const sent = await app.runReminderListScan(NOW);
    expect(sent).toBe(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].to).toBe('g1@g.us');
    expect(sendCalls[0].text).toContain('שירה'); // {honoree}
    expect(sendCalls[0].text).toContain('collect.html?c=' + c.id); // {link}
    // A second pass the same day is suppressed (every_days spacing recorded).
    sendCalls = [];
    expect(await app.runReminderListScan(NOW)).toBe(0);
    expect(sendCalls).toHaveLength(0);
    // A day later it fires again.
    expect(await app.runReminderListScan(NOW + 25 * HOUR)).toBe(1);
  });

  it('caps at max_total over the reminder lifetime', async () => {
    seed('דנה', { groupId: 'g2@g.us' });
    settings.set('reminders', 'list', [{ ...R, max_total: 2 }]);
    expect(await app.runReminderListScan(NOW)).toBe(1);
    expect(await app.runReminderListScan(NOW + DAY + HOUR)).toBe(1); // 2nd
    expect(await app.runReminderListScan(NOW + 3 * DAY)).toBe(0); // capped at 2
  });

  it('only_if_idle_hours suppresses an active collection, allows an idle one', async () => {
    // Active: last activity (creation) 2h ago -> not idle enough (needs 20h).
    seed('רון', { groupId: 'g3@g.us', at: NOW - 2 * HOUR });
    settings.set('reminders', 'list', [{ ...R, only_if_idle_hours: 20 }]);
    expect(await app.runReminderListScan(NOW)).toBe(0);
    // Idle: creation 30h ago.
    seed('גיל', { groupId: 'g4@g.us', at: NOW - 30 * HOUR });
    expect(await app.runReminderListScan(NOW)).toBe(1);
    expect(sendCalls.at(-1).to).toBe('g4@g.us');
  });

  it('a disabled reminder sends nothing', async () => {
    seed('נועה', { groupId: 'g5@g.us' });
    settings.set('reminders', 'list', [{ ...R, enabled: false }]);
    expect(await app.runReminderListScan(NOW)).toBe(0);
    expect(sendCalls).toHaveLength(0);
  });

  it('does NOT re-fire when a delivered send returns not-ok (records on attempt)', async () => {
    // Regression for the hourly-spam loop: a restricted account can DELIVER yet
    // return not-ok. The reminder must still be recorded so it does not re-send.
    seed('תמר', { groupId: 'g6@g.us' });
    settings.set('reminders', 'list', [R]);
    whatsapp.sendMessage.mockImplementationOnce(async (to, text) => {
      sendCalls.push({ to, text });
      return { ok: false, error: 'whapi http 429' };
    });
    const first = await app.runReminderListScan(NOW);
    expect(sendCalls).toHaveLength(1); // attempted
    expect(first).toBe(0); // not a clean send
    sendCalls = [];
    expect(await app.runReminderListScan(NOW)).toBe(0); // no re-fire same day
    expect(sendCalls).toHaveLength(0);
  });

  it('a closed collection gets no reminders', async () => {
    const c = seed('מאיה', { groupId: 'g7@g.us' });
    settings.set('reminders', 'list', [R]);
    db.closeCollection(c.id, c.owner_token);
    expect(await app.runReminderListScan(NOW)).toBe(0);
    expect(sendCalls).toHaveLength(0);
  });
});

describe('runReminderListScan — email delivery', () => {
  it('emails the buyer when the email channel is on, even with NO WhatsApp group', async () => {
    const c = seed('אורי', { email: 'buyer@example.com' }); // no group
    settings.set('reminders', 'list', [{ ...R, channels: { email: true, whatsapp: false } }]);
    const sent = await app.runReminderListScan(NOW);
    expect(sent).toBe(1);
    expect(sendCalls).toHaveLength(0); // no WhatsApp
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0][0].id).toBe(c.id); // the collection
    expect(emailSpy.mock.calls[0][1]).toContain('{honoree}'); // raw text (notify interpolates)
  });

  it('a both-channels reminder sends over WhatsApp AND email', async () => {
    seed('לין', { groupId: 'g8@g.us', email: 'buyer@example.com' });
    settings.set('reminders', 'list', [{ ...R, channels: { email: true, whatsapp: true } }]);
    expect(await app.runReminderListScan(NOW)).toBe(1);
    expect(sendCalls).toHaveLength(1);
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });
});
