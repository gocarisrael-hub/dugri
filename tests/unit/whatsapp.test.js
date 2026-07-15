// @vitest-environment node
// server/whatsapp.js captures the WHAPI_* / WHATSAPP_ENABLED env vars at require
// time (same dormant-module pattern as pelecard.js), so each test loads a fresh
// copy after setting or clearing the environment. The Whapi REST calls are the
// only impure part: we stub the global fetch and assert the exact request shape,
// and confirm that with the env unset NO fetch happens at all (CI-safe — nothing
// here ever touches a real network).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, '..', '..', 'server', 'whatsapp.js');

function loadFresh() {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

const ENV = {
  WHATSAPP_ENABLED: 'true',
  WHAPI_TOKEN: 'tok-secret',
  WHAPI_BASE_URL: 'https://gate.example.test',
  WHAPI_WEBHOOK_SECRET: 'hook-secret',
};

function setEnv(on) {
  for (const k of Object.keys(ENV)) {
    if (on) process.env[k] = ENV[k];
    else delete process.env[k];
  }
}

// Minimal fetch Response stub (only what whapiRequest touches).
function jsonRes(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => obj };
}

afterEach(() => {
  setEnv(false);
  vi.unstubAllGlobals();
});

// A stub settings module for the pure builders, so tests need no DATA_DIR and are
// fully hermetic. Mirrors the real settings.get/interpolate contract.
function fakeSettings(catalog) {
  return {
    get(section, key) {
      if (section !== 'wa') throw new Error('unexpected section ' + section);
      if (!Object.prototype.hasOwnProperty.call(catalog, key)) {
        throw new Error('unknown settings key: ' + section + '.' + key);
      }
      return JSON.parse(JSON.stringify(catalog[key]));
    },
    interpolate(template, values) {
      return String(template == null ? '' : template).replace(
        /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,
        (m, t) =>
          values && Object.prototype.hasOwnProperty.call(values, t) && values[t] != null
            ? String(values[t])
            : m
      );
    },
  };
}

describe('isConfigured', () => {
  it('is false when env is unset', () => {
    setEnv(false);
    expect(loadFresh().isConfigured()).toBe(false);
  });

  it('is false when enabled but the token is missing', () => {
    setEnv(false);
    process.env.WHATSAPP_ENABLED = 'true';
    expect(loadFresh().isConfigured()).toBe(false);
  });

  it('is false when the token is set but not enabled', () => {
    setEnv(false);
    process.env.WHAPI_TOKEN = 'tok-secret';
    expect(loadFresh().isConfigured()).toBe(false);
  });

  it('treats falsey WHATSAPP_ENABLED spellings as off', () => {
    setEnv(true);
    for (const v of ['false', '0', 'no', 'off', '']) {
      process.env.WHATSAPP_ENABLED = v;
      expect(loadFresh().isConfigured()).toBe(false);
    }
  });

  it('is true when enabled + token + base url are present', () => {
    setEnv(true);
    expect(loadFresh().isConfigured()).toBe(true);
  });
});

describe('impure calls are no-ops when unconfigured (no fetch happens)', () => {
  it('createGroup / sendMessage / getInviteLink never call fetch', async () => {
    setEnv(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const wa = loadFresh();

    const g = await wa.createGroup('Party', ['9721']);
    const s = await wa.sendMessage('123@g.us', 'hi');
    const i = await wa.getInviteLink('123@g.us');

    expect(fetchMock).not.toHaveBeenCalled();
    for (const r of [g, s, i]) {
      expect(r.ok).toBe(false);
      expect(r.skipped).toBe(true);
    }
  });
});

describe('createGroup issues the right request', () => {
  it('POSTs /groups under the base URL with Bearer auth + JSON body and parses the id', async () => {
    setEnv(true);
    const fetchMock = vi.fn(async () => jsonRes({ id: '120363@g.us', subject: 'Party' }));
    vi.stubGlobal('fetch', fetchMock);
    const wa = loadFresh();

    const res = await wa.createGroup('Party', ['9721', 9722]);

    expect(res.ok).toBe(true);
    expect(res.groupId).toBe('120363@g.us');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gate.example.test/groups');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-secret');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ subject: 'Party', participants: ['9721', '9722'] });
  });

  it('returns a soft failure (no throw) on a non-200', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ error: 'nope' }, { ok: false, status: 400 }))
    );
    const res = await loadFresh().createGroup('Party', ['9721']);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  it('returns a soft failure (no throw) on a network error', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      })
    );
    const res = await loadFresh().createGroup('Party', ['9721']);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
  });
});

describe('sendMessage issues the right request', () => {
  it('POSTs /messages/text with { to, body } and parses the message id', async () => {
    setEnv(true);
    const fetchMock = vi.fn(async () => jsonRes({ sent: true, message: { id: 'msg-1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await loadFresh().sendMessage('120363@g.us', 'שלום');

    expect(res.ok).toBe(true);
    expect(res.sent).toBe(true);
    expect(res.messageId).toBe('msg-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gate.example.test/messages/text');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-secret');
    expect(JSON.parse(init.body)).toEqual({ to: '120363@g.us', body: 'שלום' });
  });

  it('is soft on a thrown fetch', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      })
    );
    const res = await loadFresh().sendMessage('x', 'y');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('down');
  });
});

describe('getInviteLink issues the right request', () => {
  it('GETs /groups/{id}/invite and builds the full link from the code', async () => {
    setEnv(true);
    const fetchMock = vi.fn(async () => jsonRes({ invite_code: 'ABC123' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await loadFresh().getInviteLink('120363@g.us');

    expect(res.ok).toBe(true);
    expect(res.inviteCode).toBe('ABC123');
    expect(res.inviteLink).toBe('https://chat.whatsapp.com/ABC123');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gate.example.test/groups/120363%40g.us/invite');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok-secret');
    // A GET carries no JSON body / content-type.
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('prefers a full invite_link when Whapi supplies one', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes({ invite_code: 'X', invite_link: 'https://chat.whatsapp.com/FULL' })
      )
    );
    const res = await loadFresh().getInviteLink('g');
    expect(res.inviteLink).toBe('https://chat.whatsapp.com/FULL');
  });

  it('is soft on a non-200', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({}, { ok: false, status: 404 }))
    );
    const res = await loadFresh().getInviteLink('g');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });
});

describe('splitWords', () => {
  it('splits on newlines and commas, not spaces', () => {
    const wa = loadFresh();
    expect(wa.splitWords('Tel Aviv\nחבר טוב,בדיחה פנימית')).toEqual([
      'Tel Aviv',
      'חבר טוב',
      'בדיחה פנימית',
    ]);
  });

  it('trims, drops empties, and dedupes (first occurrence wins, order kept)', () => {
    const wa = loadFresh();
    expect(wa.splitWords('  a ,, b ,\n a \n\n,c,')).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for null/empty', () => {
    const wa = loadFresh();
    expect(wa.splitWords(null)).toEqual([]);
    expect(wa.splitWords('')).toEqual([]);
    expect(wa.splitWords('   \n , ')).toEqual([]);
  });

  it('caps at MAX_WORDS (500)', () => {
    const wa = loadFresh();
    const many = Array.from({ length: 800 }, (_, i) => 'w' + i).join(',');
    const out = wa.splitWords(many);
    expect(out.length).toBe(wa.MAX_WORDS);
    expect(wa.MAX_WORDS).toBe(500);
  });
});

describe('parseWebhook', () => {
  it('normalizes an inbound text message', () => {
    const wa = loadFresh();
    const ev = wa.parseWebhook({
      messages: [
        {
          id: 'm1',
          from_me: false,
          type: 'text',
          chat_id: '120363@g.us',
          from: '972500000000',
          from_name: 'דנה',
          text: { body: 'שלום, עולם' },
        },
      ],
      event: { type: 'messages', event: 'post' },
    });
    expect(ev).toEqual({
      kind: 'message',
      groupId: '120363@g.us',
      from: '972500000000',
      fromName: 'דנה',
      text: 'שלום, עולם',
    });
  });

  it('normalizes a participants-added event', () => {
    const wa = loadFresh();
    const ev = wa.parseWebhook({
      groups_participants: [
        {
          group_id: '120363@g.us',
          action: 'add',
          participants: ['972511111111', { id: '972522222222', name: 'רון' }],
        },
      ],
      event: { type: 'groups', event: 'put' },
    });
    expect(ev).toEqual({
      kind: 'participants_added',
      groupId: '120363@g.us',
      added: [
        { id: '972511111111', name: '' },
        { id: '972522222222', name: 'רון' },
      ],
    });
  });

  it('ignores our own outgoing (from_me) messages', () => {
    const wa = loadFresh();
    expect(
      wa.parseWebhook({ messages: [{ from_me: true, type: 'text', text: { body: 'hi' } }] })
    ).toEqual({ kind: 'ignore' });
  });

  it('ignores non-text / system messages', () => {
    const wa = loadFresh();
    expect(
      wa.parseWebhook({ messages: [{ from_me: false, type: 'image', chat_id: 'g' }] })
    ).toEqual({ kind: 'ignore' });
  });

  it('ignores empty-body messages', () => {
    const wa = loadFresh();
    expect(
      wa.parseWebhook({ messages: [{ from_me: false, type: 'text', text: { body: '   ' } }] })
    ).toEqual({ kind: 'ignore' });
  });

  it('ignores unknown / empty payloads', () => {
    const wa = loadFresh();
    expect(wa.parseWebhook(null).kind).toBe('ignore');
    expect(wa.parseWebhook({}).kind).toBe('ignore');
    expect(wa.parseWebhook({ statuses: [{}] }).kind).toBe('ignore');
  });

  it('ignores a non-"add" participant action', () => {
    const wa = loadFresh();
    expect(
      wa.parseWebhook({
        groups_participants: [{ group_id: 'g', action: 'remove', participants: ['x'] }],
      }).kind
    ).toBe('ignore');
  });
});

describe('buildTriggerMessage (pure, injectable settings)', () => {
  const catalog = {
    'trigger.group_opened': {
      enabled: true,
      text: 'קבוצה ל-{honoree} נפתחה: {link}',
    },
    'trigger.word_added': { enabled: false, text: 'יש {count} מילים' },
  };

  it('interpolates the enabled trigger text from settings', () => {
    const wa = loadFresh();
    const out = wa.buildTriggerMessage(
      'group_opened',
      { honoree: 'שירה', link: 'https://x' },
      { settings: fakeSettings(catalog) }
    );
    expect(out.enabled).toBe(true);
    expect(out.text).toBe('קבוצה ל-שירה נפתחה: https://x');
  });

  it('returns text=null for a disabled trigger (stays silent)', () => {
    const wa = loadFresh();
    const out = wa.buildTriggerMessage(
      'word_added',
      { count: 5 },
      { settings: fakeSettings(catalog) }
    );
    expect(out.enabled).toBe(false);
    expect(out.text).toBe(null);
  });

  it('returns text=null for an unknown trigger without throwing', () => {
    const wa = loadFresh();
    const out = wa.buildTriggerMessage('nope', {}, { settings: fakeSettings(catalog) });
    expect(out.enabled).toBe(false);
    expect(out.text).toBe(null);
  });

  it('works against the real settings defaults (no DATA_DIR needed)', () => {
    const wa = loadFresh();
    const out = wa.buildTriggerMessage('group_opened', { honoree: 'דני', link: 'L' });
    expect(out.enabled).toBe(true);
    expect(out.text).toContain('דני');
    expect(out.text).toContain('L');
  });
});

describe('groupsDueForNudge (pure)', () => {
  const catalog = {
    'trigger.daily_morning': { enabled: true, text: 'בוקר', timing: { hour: 7 } },
    'trigger.daily_evening': { enabled: true, text: 'ערב', timing: { hour: 19 } },
    'trigger.quiet_reminder': {
      enabled: true,
      text: 'שקט',
      timing: { idle_hours: 24, max: 3, window: [9, 21] },
    },
  };
  // 07:30 Asia/Jerusalem (UTC+3 in July) => 04:30 UTC (daily_morning hour).
  const morning = Date.UTC(2026, 6, 15, 4, 30);
  // 10:00 Asia/Jerusalem => 07:00 UTC — inside the quiet window [9,21), but not a
  // daily-nudge hour, so only quiet_reminder can fire here.
  const midday = Date.UTC(2026, 6, 15, 7, 0);

  it('fires the daily_morning nudge at its configured hour when the slot is fresh', () => {
    const wa = loadFresh();
    const due = wa.groupsDueForNudge(
      [{ groupId: 'g1', last_activity_at: new Date(morning).toISOString(), nudge_slots: {} }],
      { now: morning, settings: fakeSettings(catalog) }
    );
    const daily = due.filter((d) => d.triggerId === 'daily_morning');
    expect(daily).toEqual([
      { groupId: 'g1', triggerId: 'daily_morning', slotKey: '2026-07-15:daily_morning' },
    ]);
  });

  it('does not re-fire a daily nudge whose slot already ran', () => {
    const wa = loadFresh();
    const due = wa.groupsDueForNudge(
      [
        {
          groupId: 'g1',
          last_activity_at: new Date(morning).toISOString(),
          nudge_slots: { '2026-07-15:daily_morning': true },
        },
      ],
      { now: morning, settings: fakeSettings(catalog) }
    );
    expect(due.some((d) => d.triggerId === 'daily_morning')).toBe(false);
  });

  it('skips closed groups entirely', () => {
    const wa = loadFresh();
    const due = wa.groupsDueForNudge(
      [
        {
          groupId: 'g1',
          closed: true,
          last_activity_at: new Date(0).toISOString(),
          nudge_slots: {},
        },
      ],
      { now: morning, settings: fakeSettings(catalog) }
    );
    expect(due).toEqual([]);
  });

  it('fires quiet_reminder when idle past the window, capped by max, inside the hour window', () => {
    const wa = loadFresh();
    const twoDaysAgo = morning - 48 * 3600 * 1000;
    const due = wa.groupsDueForNudge(
      [
        {
          groupId: 'g1',
          last_activity_at: new Date(twoDaysAgo).toISOString(),
          nudge_slots: {},
          quiet: { count: 1 },
        },
      ],
      { now: midday, settings: fakeSettings(catalog) }
    );
    expect(due.some((d) => d.triggerId === 'quiet_reminder')).toBe(true);
  });

  it('does not fire quiet_reminder once the max cap is reached', () => {
    const wa = loadFresh();
    const twoDaysAgo = midday - 48 * 3600 * 1000;
    const due = wa.groupsDueForNudge(
      [
        {
          groupId: 'g1',
          last_activity_at: new Date(twoDaysAgo).toISOString(),
          nudge_slots: {},
          quiet: { count: 3 },
        },
      ],
      { now: midday, settings: fakeSettings(catalog) }
    );
    expect(due.some((d) => d.triggerId === 'quiet_reminder')).toBe(false);
  });

  it('suppresses a disabled trigger', () => {
    const wa = loadFresh();
    const off = {
      'trigger.daily_morning': { enabled: false, text: 'בוקר', timing: { hour: 7 } },
      'trigger.daily_evening': { enabled: false, text: 'ערב', timing: { hour: 19 } },
      'trigger.quiet_reminder': {
        enabled: false,
        text: 'שקט',
        timing: { idle_hours: 24, max: 3, window: [9, 21] },
      },
    };
    const due = wa.groupsDueForNudge(
      [{ groupId: 'g1', last_activity_at: new Date(0).toISOString(), nudge_slots: {} }],
      { now: morning, settings: fakeSettings(off) }
    );
    expect(due).toEqual([]);
  });
});

describe('verifyWebhookSecret', () => {
  it('accepts the configured secret and rejects a wrong / missing one', () => {
    setEnv(true);
    const wa = loadFresh();
    expect(wa.verifyWebhookSecret('hook-secret')).toBe(true);
    expect(wa.verifyWebhookSecret('nope')).toBe(false);
    expect(wa.verifyWebhookSecret('')).toBe(false);
    expect(wa.verifyWebhookSecret(undefined)).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    setEnv(false);
    const wa = loadFresh();
    expect(wa.verifyWebhookSecret('anything')).toBe(false);
  });
});
