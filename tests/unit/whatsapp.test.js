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

describe('health probes the live channel connection', () => {
  it('is a no-op (no fetch) when unconfigured', async () => {
    setEnv(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const h = await loadFresh().health();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h).toMatchObject({ ok: false, skipped: true, connection: 'off' });
  });

  it('GETs /health under the base URL with Bearer auth', async () => {
    setEnv(true);
    const fetchMock = vi.fn(async () => jsonRes({ status: { text: 'AUTH' } }));
    vi.stubGlobal('fetch', fetchMock);
    await loadFresh().health();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gate.example.test/health');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok-secret');
  });

  it('reports connected for an authenticated status text', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ status: { text: 'AUTH' } }))
    );
    const h = await loadFresh().health();
    expect(h).toMatchObject({ ok: true, connection: 'connected', state: 'auth' });
  });

  it('reports connected when an account/user object is present regardless of text', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ status: { text: 'weird' }, user: { id: '9720@c.us' } }))
    );
    const h = await loadFresh().health();
    expect(h.connection).toBe('connected');
  });

  it('reports disconnected for a QR status text (phone unpaired)', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ status: { text: 'QR' } }))
    );
    const h = await loadFresh().health();
    expect(h).toMatchObject({ ok: true, connection: 'disconnected', state: 'qr' });
  });

  it('stays unknown (never guesses) for an unrecognised status text', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ status: { text: 'SYNCING' } }))
    );
    const h = await loadFresh().health();
    expect(h).toMatchObject({ ok: true, connection: 'unknown', state: 'syncing' });
  });

  it('accepts a bare string status (not an object)', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ status: 'connected' }))
    );
    const h = await loadFresh().health();
    expect(h.connection).toBe('connected');
  });

  it('reports connection:error (no throw) on a non-200', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({}, { ok: false, status: 401 }))
    );
    const h = await loadFresh().health();
    expect(h).toMatchObject({ ok: false, connection: 'error', httpStatus: 401 });
  });

  it('reports connection:error (no throw) on a network error', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      })
    );
    const h = await loadFresh().health();
    expect(h).toMatchObject({ ok: false, connection: 'error' });
    expect(h.error).toContain('boom');
  });

  it('never returns the token or secret in the payload', async () => {
    setEnv(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ status: { text: 'AUTH' } }))
    );
    const h = await loadFresh().health();
    const flat = JSON.stringify(h);
    expect(flat).not.toContain('tok-secret');
    expect(flat).not.toContain('hook-secret');
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
    // Whapi wants the RAW group id in the path — the "@" must NOT be %40-encoded.
    expect(url).toBe('https://gate.example.test/groups/120363@g.us/invite');
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
  it('normalizes an inbound group text message', () => {
    const wa = loadFresh();
    const { events } = wa.parseWebhook({
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
    expect(events).toEqual([
      {
        kind: 'message',
        groupId: '120363@g.us',
        from: '972500000000',
        fromName: 'דנה',
        text: 'שלום, עולם',
        id: 'm1',
      },
    ]);
  });

  it('returns BOTH messages from a batched body (no message dropped)', () => {
    const wa = loadFresh();
    const { events } = wa.parseWebhook({
      messages: [
        { from_me: false, type: 'text', chat_id: '1@g.us', from: 'a', text: { body: 'one' } },
        { from_me: false, type: 'text', chat_id: '1@g.us', from: 'b', text: { body: 'two' } },
      ],
    });
    expect(events.map((e) => e.text)).toEqual(['one', 'two']);
    expect(events.every((e) => e.kind === 'message')).toBe(true);
  });

  it('surfaces a participants-add AND a message from the SAME body', () => {
    const wa = loadFresh();
    const { events } = wa.parseWebhook({
      groups_participants: [{ group_id: '1@g.us', action: 'add', participants: ['x'] }],
      messages: [
        { from_me: false, type: 'text', chat_id: '1@g.us', from: 'a', text: { body: 'hi' } },
      ],
    });
    expect(events).toHaveLength(2);
    // Participant events come first so a new member is greeted before words process.
    expect(events[0].kind).toBe('participants_added');
    expect(events[1]).toMatchObject({ kind: 'message', text: 'hi' });
  });

  it('normalizes a participants-added event', () => {
    const wa = loadFresh();
    const { events } = wa.parseWebhook({
      groups_participants: [
        {
          group_id: '120363@g.us',
          action: 'add',
          participants: ['972511111111', { id: '972522222222', name: 'רון' }],
        },
      ],
      event: { type: 'groups', event: 'put' },
    });
    expect(events).toMatchObject([
      {
        kind: 'participants_added',
        groupId: '120363@g.us',
        added: [
          { id: '972511111111', name: '' },
          { id: '972522222222', name: 'רון' },
        ],
      },
    ]);
    // A stable, non-empty event id is attached for at-least-once de-dupe.
    expect(typeof events[0].id).toBe('string');
    expect(events[0].id.length).toBeGreaterThan(0);
  });

  it('drops a 1:1 DM (chat id not @g.us) — not group word input', () => {
    const wa = loadFresh();
    const { events } = wa.parseWebhook({
      messages: [
        {
          from_me: false,
          type: 'text',
          chat_id: '972500000000@s.whatsapp.net',
          from: '972500000000',
          text: { body: 'a DM to the bot' },
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it('accepts a camelCase groupId on the message branch', () => {
    const wa = loadFresh();
    const { events } = wa.parseWebhook({
      messages: [
        { from_me: false, type: 'text', groupId: '9@g.us', from: 'a', text: { body: 'w' } },
      ],
    });
    expect(events).toEqual([
      { kind: 'message', groupId: '9@g.us', from: 'a', fromName: '', text: 'w', id: '' },
    ]);
  });

  it('drops a message with an empty/missing id (never emits groupId:"")', () => {
    const wa = loadFresh();
    const { events } = wa.parseWebhook({
      messages: [{ from_me: false, type: 'text', chat_id: '', from: 'a', text: { body: 'w' } }],
    });
    expect(events).toEqual([]);
  });

  it('drops our own outgoing (from_me) messages', () => {
    const wa = loadFresh();
    expect(
      wa.parseWebhook({
        messages: [{ from_me: true, type: 'text', chat_id: '1@g.us', text: { body: 'hi' } }],
      })
    ).toEqual({ events: [] });
  });

  it('drops non-text / system messages', () => {
    const wa = loadFresh();
    expect(
      wa.parseWebhook({ messages: [{ from_me: false, type: 'image', chat_id: '1@g.us' }] })
    ).toEqual({ events: [] });
  });

  it('drops empty-body messages', () => {
    const wa = loadFresh();
    expect(
      wa.parseWebhook({
        messages: [{ from_me: false, type: 'text', chat_id: '1@g.us', text: { body: '   ' } }],
      })
    ).toEqual({ events: [] });
  });

  it('returns { events: [] } for unknown / empty / undefined payloads', () => {
    const wa = loadFresh();
    expect(wa.parseWebhook(null)).toEqual({ events: [] });
    expect(wa.parseWebhook(undefined)).toEqual({ events: [] });
    expect(wa.parseWebhook({})).toEqual({ events: [] });
    expect(wa.parseWebhook({ statuses: [{}] })).toEqual({ events: [] });
  });

  it('drops a non-"add" participant action', () => {
    const wa = loadFresh();
    expect(
      wa.parseWebhook({
        groups_participants: [{ group_id: '1@g.us', action: 'remove', participants: ['x'] }],
      })
    ).toEqual({ events: [] });
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
  // 09:00 Asia/Jerusalem => 06:00 UTC — PAST the daily_morning hour (7), used to
  // prove same-day catch-up when a tick missed the exact target hour.
  const nineAm = Date.UTC(2026, 6, 15, 6, 0);
  const H = 3600 * 1000;

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

  it('catches up the daily nudge later the same day when the exact hour was missed', () => {
    const wa = loadFresh();
    // Tick at 09:00, target 07:00, slot not yet recorded → still due (catch-up).
    const due = wa.groupsDueForNudge(
      [{ groupId: 'g1', last_activity_at: new Date(nineAm).toISOString(), nudge_slots: {} }],
      { now: nineAm, settings: fakeSettings(catalog) }
    );
    expect(due.some((d) => d.triggerId === 'daily_morning')).toBe(true);
  });

  it("does not catch up once that day's slot is recorded", () => {
    const wa = loadFresh();
    const due = wa.groupsDueForNudge(
      [
        {
          groupId: 'g1',
          last_activity_at: new Date(nineAm).toISOString(),
          nudge_slots: { '2026-07-15:daily_morning': true },
        },
      ],
      { now: nineAm, settings: fakeSettings(catalog) }
    );
    expect(due.some((d) => d.triggerId === 'daily_morning')).toBe(false);
  });

  it('does not fire a daily nudge before its target hour', () => {
    const wa = loadFresh();
    // 06:00 Jerusalem => 03:00 UTC, before the 07:00 target.
    const sixAm = Date.UTC(2026, 6, 15, 3, 0);
    const due = wa.groupsDueForNudge(
      [{ groupId: 'g1', last_activity_at: new Date(sixAm).toISOString(), nudge_slots: {} }],
      { now: sixAm, settings: fakeSettings(catalog) }
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

  it('fires quiet_reminder immediately for a brand-new idle group (last_at null)', () => {
    const wa = loadFresh();
    const due = wa.groupsDueForNudge(
      [
        {
          groupId: 'g1',
          last_activity_at: new Date(midday - 48 * H).toISOString(),
          nudge_slots: {},
          quiet: { count: 0, last_at: null },
        },
      ],
      { now: midday, settings: fakeSettings(catalog) }
    );
    expect(due.some((d) => d.triggerId === 'quiet_reminder')).toBe(true);
  });

  it('spaces quiet reminders — not due again until idle_hours since the last one', () => {
    const wa = loadFresh();
    // Last quiet reminder only 2h ago (< idle_hours 24) → NOT due yet this tick.
    const recent = wa.groupsDueForNudge(
      [
        {
          groupId: 'g1',
          last_activity_at: new Date(midday - 48 * H).toISOString(),
          nudge_slots: {},
          quiet: { count: 1, last_at: new Date(midday - 2 * H).toISOString() },
        },
      ],
      { now: midday, settings: fakeSettings(catalog) }
    );
    expect(recent.some((d) => d.triggerId === 'quiet_reminder')).toBe(false);

    // Last quiet reminder 25h ago (>= idle_hours) → due again.
    const spaced = wa.groupsDueForNudge(
      [
        {
          groupId: 'g1',
          last_activity_at: new Date(midday - 48 * H).toISOString(),
          nudge_slots: {},
          quiet: { count: 1, last_at: new Date(midday - 25 * H).toISOString() },
        },
      ],
      { now: midday, settings: fakeSettings(catalog) }
    );
    expect(spaced.some((d) => d.triggerId === 'quiet_reminder')).toBe(true);
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

describe('partial-config boot warning', () => {
  it('warns (once, no secret value logged) when enabled+token but no webhook secret', () => {
    setEnv(false);
    process.env.WHATSAPP_ENABLED = 'true';
    process.env.WHAPI_TOKEN = 'tok-secret';
    // WHAPI_WEBHOOK_SECRET intentionally unset.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadFresh(); // warning fires at module load
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0].join(' ');
    expect(logged).toContain('WHAPI_WEBHOOK_SECRET');
    // Never leak the token or a secret value into logs.
    expect(logged).not.toContain('tok-secret');
    warn.mockRestore();
  });

  it('does not warn when fully configured', () => {
    setEnv(true); // includes WHAPI_WEBHOOK_SECRET
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadFresh();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not warn when fully dormant (nothing set)', () => {
    setEnv(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadFresh();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
