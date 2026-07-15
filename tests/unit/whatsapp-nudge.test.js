// @vitest-environment node
// Unit tests for the WhatsApp nudge scheduler pass (app.runWaNudgeScan) in
// server/index.js. The bot is ARMED so the scan runs, but whatsapp.sendMessage is
// spied (no network) and time is INJECTED via the `now` argument so the daily /
// quiet timing is deterministic. groupsDueForNudge + buildTriggerMessage run for
// real against the trigger catalog. Jerusalem is UTC+3 (IDT) for these July dates.
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

let sendCalls;

const WA_TRIGGERS = [
  'group_opened',
  'member_joined',
  'word_added',
  'list_closed',
  'daily_morning',
  'daily_evening',
  'quiet_reminder',
];

const HOUR = 3600 * 1000;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wa-nudge-'));
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
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sendCalls = [];
  // Restore the trigger catalog to defaults, then retire any group left active by
  // an earlier test so each scan only ever sees this test's own group.
  for (const id of WA_TRIGGERS) settings.reset('wa', 'trigger.' + id);
  for (const g of waState.activeGroups()) waState.markClosed(g.groupId);
});

// Create an open collection + a linked group whose activity/creation time is `at`.
function linkedGroup(honoree, groupId, at) {
  const c = db.createCollection(honoree, { phone: '0521234567' });
  waState.linkGroup(groupId, c.id, '972521234567', ['972521234567'], at);
  return c;
}

describe('runWaNudgeScan — daily triggers', () => {
  // 2026-07-15 06:30Z -> 09:30 Jerusalem (hour 9): past the 07:00 morning slot,
  // before the 19:00 evening slot.
  const NOW = Date.parse('2026-07-15T06:30:00.000Z');

  it('fires the morning nudge once the hour has passed, deduped by slot', async () => {
    // Fresh activity so the quiet reminder is NOT also due.
    linkedGroup('שירה', 'nd1@g.us', NOW);
    const sent = await app.runWaNudgeScan(NOW);
    expect(sent).toBe(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].to).toBe('nd1@g.us');
    expect(sendCalls[0].text).toContain('בוקר טוב'); // the daily_morning template
    expect(sendCalls[0].text).toContain('שירה'); // interpolated {honoree}

    // A second pass the same slot must not re-send (slot dedupe).
    sendCalls = [];
    const again = await app.runWaNudgeScan(NOW);
    expect(again).toBe(0);
    expect(sendCalls).toHaveLength(0);
  });

  it('scans MULTIPLE active groups in a single pass', async () => {
    linkedGroup('שירה', 'ndm1@g.us', NOW);
    linkedGroup('דנה', 'ndm2@g.us', NOW);
    const sent = await app.runWaNudgeScan(NOW);
    expect(sent).toBe(2);
    expect(sendCalls.map((s) => s.to).sort()).toEqual(['ndm1@g.us', 'ndm2@g.us']);
  });

  it('a disabled trigger stays silent', async () => {
    linkedGroup('נועה', 'nd2@g.us', NOW);
    for (const id of WA_TRIGGERS) settings.set('wa', 'trigger.' + id, { enabled: false });
    const sent = await app.runWaNudgeScan(NOW);
    expect(sent).toBe(0);
    expect(sendCalls).toHaveLength(0);
  });
});

describe('runWaNudgeScan — quiet reminders', () => {
  const T0 = Date.parse('2026-07-15T09:00:00.000Z'); // 12:00 Jerusalem, inside [9,21]

  beforeEach(() => {
    // Isolate the quiet path: silence the daily triggers.
    settings.set('wa', 'trigger.daily_morning', { enabled: false });
    settings.set('wa', 'trigger.daily_evening', { enabled: false });
  });

  it('spaces quiet reminders by idle_hours and caps at max', async () => {
    // Idle for 100h so the quiet reminder is due.
    linkedGroup('רון', 'nq1@g.us', T0 - 100 * HOUR);

    // 1st reminder fires.
    expect(await app.runWaNudgeScan(T0)).toBe(1);
    // Same instant again -> spacing suppresses it.
    expect(await app.runWaNudgeScan(T0)).toBe(0);
    // +25h (still in window, still idle) -> 2nd reminder.
    expect(await app.runWaNudgeScan(T0 + 25 * HOUR)).toBe(1);
    // +50h -> 3rd reminder (reaches max=3).
    expect(await app.runWaNudgeScan(T0 + 50 * HOUR)).toBe(1);
    // +75h -> capped, no more.
    expect(await app.runWaNudgeScan(T0 + 75 * HOUR)).toBe(0);
    expect(sendCalls.filter((s) => s.to === 'nq1@g.us')).toHaveLength(3);
    for (const s of sendCalls) expect(s.text).toContain('רון');
  });
});

describe('runWaNudgeScan — collection state', () => {
  const NOW = Date.parse('2026-07-15T06:30:00.000Z');

  it('stops nudging and retires the group once the collection is closed', async () => {
    const c = linkedGroup('מאיה', 'nc1@g.us', NOW);
    // Sanity: it would nudge while open.
    expect(await app.runWaNudgeScan(NOW)).toBe(1);
    sendCalls = [];
    // Owner closes the list on the website.
    db.closeCollection(c.id, c.owner_token);
    const sent = await app.runWaNudgeScan(NOW + 24 * HOUR);
    expect(sent).toBe(0);
    expect(sendCalls).toHaveLength(0);
    // The group is retired (dropped from the active set).
    expect(waState.activeGroups().some((g) => g.groupId === 'nc1@g.us')).toBe(false);
  });
});
