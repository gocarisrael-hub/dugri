// @vitest-environment node
// Unit tests for server/wa-guard.js — the reachout circuit breaker, and the way
// server/whatsapp.js consults it.
//
// This module exists because of a real ban (2026-07-27): the bot number was
// restricted for REACHOUT — adding people to groups and DMing them cold — and
// the restriction was made permanent by continuing to retry into it. So the
// behaviours asserted here are the safety contract, not incidental detail:
//
//   1. A bare 429 ("too many requests") is a rate limit and must NOT trip the
//      breaker; a 429 whose details say account_reachout_restricted MUST.
//   2. A trip is STICKY — it survives a process restart, because an auto-reset
//      would resume the exact retrying that escalated the last ban.
//   3. In-group sends are NEVER blocked. They kept working right through the
//      real ban, and gating them would break live orders for no safety gain.
//   4. Creating an EMPTY group is not a reachout (it contacts nobody), so the
//      default invite_link flow keeps working even with the breaker open.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guardPath = path.join(__dirname, '..', '..', 'server', 'wa-guard.js');
const whatsappPath = path.join(__dirname, '..', '..', 'server', 'whatsapp.js');

// Isolate the persisted guard store in a throwaway dir, set BEFORE the first
// require (DATA_DIR is read at module load, like every store in this codebase).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wa-guard-'));
process.env.DATA_DIR = DATA_DIR;

// ALWAYS resolve the guard through require() rather than binding it once: the
// restart test below deliberately drops it from the require cache, after which a
// stale binding would point at an abandoned instance while server/whatsapp.js
// (re-required per test) talks to the new one. require() is cached, so this is a
// cheap lookup that is always the instance actually in force.
function g() {
  return require(guardPath);
}

// Re-require the guard from disk — simulates a process restart reading the same
// file, which is how we prove a trip is durable rather than in-memory only.
function restartGuard() {
  delete require.cache[require.resolve(guardPath)];
  return require(guardPath);
}

const ENV = {
  WHATSAPP_ENABLED: 'true',
  WHAPI_TOKEN: 'tok',
  WHAPI_BASE_URL: 'https://gate.example.test',
};
function loadWhatsapp() {
  Object.assign(process.env, ENV);
  delete require.cache[require.resolve(whatsappPath)];
  return require(whatsappPath);
}
function jsonRes(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => obj };
}

beforeEach(() => {
  g().clear();
});
afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  vi.unstubAllGlobals();
});

describe('classify — a rate limit is not a ban', () => {
  it('treats a BARE 429 as an ordinary rate limit, not a restriction', () => {
    const r = {
      ok: false,
      status: 429,
      data: { error: { code: 429, message: 'too many requests' } },
    };
    expect(g().classify(r)).toBe('ratelimit');
    g().noteResult(r);
    expect(g().snapshot().tripped).toBe(false);
  });

  it('treats 429 + account_reachout_restricted as a RESTRICTION', () => {
    // The exact payload seen in the real incident.
    const r = {
      ok: false,
      status: 429,
      data: {
        error: { code: 429, message: 'too many requests', details: 'account_reachout_restricted' },
      },
    };
    expect(g().classify(r)).toBe('restricted');
  });

  it('treats 401 / 403 as a restriction regardless of body', () => {
    expect(g().classify({ ok: false, status: 401, data: {} })).toBe('restricted');
    expect(g().classify({ ok: false, status: 403, data: {} })).toBe('restricted');
  });

  it('never treats a successful call, a skip, or a TRANSPORT error as a restriction', () => {
    expect(g().classify({ ok: true, status: 200, data: {} })).toBe('ok');
    expect(g().classify({ ok: false, skipped: true })).toBe('ok');
    // A DNS blip / timeout has no HTTP status — it must not disarm the bot.
    expect(g().classify({ ok: false, error: 'fetch failed' })).toBe('ok');
    expect(g().classify(null)).toBe('ok');
  });

  it('catches a ban named in the body under any status', () => {
    expect(g().classify({ ok: false, status: 400, data: { message: 'account is banned' } })).toBe(
      'restricted'
    );
  });
});

describe('the breaker is sticky and durable', () => {
  it('blocks reachout once tripped, and keeps the FIRST reason', () => {
    g().trip('first signal');
    g().trip('later downstream symptom');
    const s = g().snapshot();
    expect(s.tripped).toBe(true);
    expect(s.reason).toBe('first signal');
    expect(g().canReachOut().ok).toBe(false);
    expect(g().canReachOut().reason).toBe('tripped');
  });

  it('SURVIVES a restart — an auto-reset would resume retrying into the ban', () => {
    g().trip('account_reachout_restricted');
    const restarted = restartGuard();
    expect(restarted.snapshot().tripped).toBe(true);
    expect(restarted.canReachOut().ok).toBe(false);
    restarted.clear();
  });

  it('only an explicit clear re-opens it, and that also resets the day count', () => {
    g().recordReachout();
    g().trip('x');
    g().clear();
    const s = g().snapshot();
    expect(s.tripped).toBe(false);
    expect(s.count).toBe(0);
    expect(g().canReachOut().ok).toBe(true);
  });
});

describe('daily cap', () => {
  // Two instants on DIFFERENT Israel-time days. The cap is keyed to the owner's
  // calendar day, not UTC, so it resets when their day does.
  const DAY1 = Date.parse('2026-08-05T09:00:00.000Z');
  const DAY2 = Date.parse('2026-08-06T09:00:00.000Z');

  it('allows exactly `max` reachouts per day, then blocks', () => {
    const max = g().snapshot({ now: DAY1 }).max;
    for (let i = 0; i < max; i++) {
      expect(g().canReachOut({ now: DAY1 }).ok).toBe(true);
      g().recordReachout(DAY1);
    }
    const blocked = g().canReachOut({ now: DAY1 });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('daily_cap');
  });

  it('rolls over on the next Israel day', () => {
    const max = g().snapshot({ now: DAY1 }).max;
    for (let i = 0; i < max; i++) g().recordReachout(DAY1);
    expect(g().canReachOut({ now: DAY1 }).ok).toBe(false);
    expect(g().canReachOut({ now: DAY2 }).ok).toBe(true);
    expect(g().snapshot({ now: DAY2 }).count).toBe(0);
  });

  it('reports remaining budget for the admin readout', () => {
    g().recordReachout(DAY1);
    const s = g().snapshot({ now: DAY1 });
    expect(s.count).toBe(1);
    expect(s.remaining).toBe(s.max - 1);
  });
});

describe('isGroupChat — what counts as reachout', () => {
  it('only a @g.us chat is in-group traffic', () => {
    expect(g().isGroupChat('120363000000000000@g.us')).toBe(true);
    expect(g().isGroupChat('972521234567')).toBe(false);
    expect(g().isGroupChat('972521234567@s.whatsapp.net')).toBe(false);
    expect(g().isGroupChat('')).toBe(false);
    expect(g().isGroupChat(null)).toBe(false);
  });
});

describe('whatsapp.js honours the breaker', () => {
  it('BLOCKS a group create that adds a participant', async () => {
    const wa = loadWhatsapp();
    g().trip('restricted');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await wa.createGroup('subject', ['972521234567']);
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('tripped');
    expect(fetchSpy).not.toHaveBeenCalled(); // never retries into a restriction
  });

  it('ALLOWS an EMPTY group create while tripped — it contacts nobody', async () => {
    const wa = loadWhatsapp();
    g().trip('restricted');
    const fetchSpy = vi.fn(async () => jsonRes({ group_id: '1203@g.us' }));
    vi.stubGlobal('fetch', fetchSpy);
    const r = await wa.createGroup('subject', []);
    expect(r.ok).toBe(true);
    expect(r.groupId).toBe('1203@g.us');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('ALLOWS a send into an existing GROUP while tripped', async () => {
    const wa = loadWhatsapp();
    g().trip('restricted');
    const fetchSpy = vi.fn(async () => jsonRes({ sent: true, id: 'm1' }));
    vi.stubGlobal('fetch', fetchSpy);
    const r = await wa.sendMessage('120363@g.us', 'hello');
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('BLOCKS a cold 1:1 DM while tripped', async () => {
    const wa = loadWhatsapp();
    g().trip('restricted');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await wa.sendMessage('972521234567', 'hello');
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ALLOWS an exempt DM (the owner escalation) while tripped', async () => {
    const wa = loadWhatsapp();
    g().trip('restricted');
    const fetchSpy = vi.fn(async () => jsonRes({ sent: true, id: 'm1' }));
    vi.stubGlobal('fetch', fetchSpy);
    const r = await wa.sendMessage('972521111111', 'breaker tripped', { exempt: true });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('spends the daily budget on the ATTEMPT, not on a successful result', async () => {
    // A restricted account can ACT and still answer not-ok — counting successes
    // would under-count real reachouts and let a loop keep going.
    const wa = loadWhatsapp();
    const before = g().snapshot().count;
    vi.stubGlobal('fetch', async () =>
      jsonRes({ error: { code: 500 } }, { ok: false, status: 500 })
    );
    await wa.sendMessage('972521234567', 'hi');
    expect(g().snapshot().count).toBe(before + 1);
  });

  it('a restriction on ANY call trips the breaker and stops the next reachout', async () => {
    const wa = loadWhatsapp();
    // The restriction surfaces on a routine health probe...
    vi.stubGlobal('fetch', async () => jsonRes({}, { ok: false, status: 401 }));
    await wa.health();
    expect(g().snapshot().tripped).toBe(true);
    // ...and the very next group-open is refused without touching the network.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await wa.createGroup('subject', ['972521234567']);
    expect(r.blocked).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
