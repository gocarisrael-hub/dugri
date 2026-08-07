// @vitest-environment node
// The admin message preview. The load-bearing property is that a preview renders
// through the SAME pure builders the real send path uses — the moment it renders
// its own copy of a message, it stops being evidence about what customers get.
// So these tests assert the wiring (every kind resolves, owner overrides show up,
// a disabled WhatsApp trigger is reported as disabled) rather than re-asserting
// the mail markup, which notify's own suite already covers.
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
const ADMIN_KEY = 'preview-admin-key';
const qs = '?key=' + encodeURIComponent(ADMIN_KEY);

let app;
let db;
let settings;
let preview;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-preview-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHAPI_TOKEN = 'tok';
  process.env.WHAPI_WEBHOOK_SECRET = 'sec';
  process.env.WHAPI_BASE_URL = 'https://gate.example.test';

  for (const f of [
    'db.js',
    'settings.js',
    'wa-state.js',
    'whatsapp.js',
    'notify.js',
    'message-preview.js',
    'index.js',
  ]) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  settings = require(path.join(serverDir, 'settings.js'));
  preview = require(path.join(serverDir, 'message-preview.js'));
  app = require(path.join(serverDir, 'index.js'));

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  if (server) server.close();
});

beforeEach(() => {
  settings.reset('wa', 'trigger.group_opened');
  settings.reset('email', 'buyer_confirmation');
});

describe('listKinds', () => {
  it('includes every email kind and every WhatsApp trigger in the registry', () => {
    const kinds = preview.listKinds({ settings });
    const ids = kinds.map((k) => k.id);
    for (const k of preview.EMAIL_KINDS) expect(ids).toContain(k.id);
    // Derived from the registry, so a trigger added later is previewable for free.
    const triggerIds = Object.keys(settings.REGISTRY.wa)
      .filter((k) => k.startsWith('trigger.'))
      .map((k) => k.slice('trigger.'.length));
    expect(triggerIds.length).toBeGreaterThan(0);
    for (const t of triggerIds) {
      const found = kinds.find((k) => k.channel === 'whatsapp' && k.id === t);
      expect(found, 'missing whatsapp preview for ' + t).toBeTruthy();
    }
  });
});

describe('settings key mapping', () => {
  it('points every editable kind at the settings key it is actually built from', () => {
    const kinds = preview.listKinds({ settings });
    const byId = (channel, id) => kinds.find((k) => k.channel === channel && k.id === id);
    // The preview id and the stored key deliberately differ here (the key keeps
    // its historical name) — the whole reason the mapping is explicit. Editing
    // through the wrong key would save into a different message.
    expect(byId('email', 'owner_order_created').settings).toEqual({
      section: 'email',
      key: 'order_paid',
    });
    expect(byId('email', 'owner_custom_order').settings).toEqual({
      section: 'email',
      key: 'custom_order_alert',
    });
    expect(byId('whatsapp', 'group_opened').settings).toEqual({
      section: 'wa',
      key: 'trigger.group_opened',
    });
    // Composed in code — no template to edit, and the UI must be told so rather
    // than offering an editor that saves nothing.
    expect(byId('email', 'system_alert').settings).toBeNull();
  });

  it('every advertised settings key exists in the registry', () => {
    for (const k of preview.listKinds({ settings })) {
      if (!k.settings) continue;
      expect(
        settings.hasKey(k.settings.section, k.settings.key),
        'bad settings key for ' + k.channel + '/' + k.id
      ).toBe(true);
    }
  });

  // The guard for the bug that prompted this: a message was added (the free-word
  // quota mail) and shipped to real customers while the preview page never listed
  // it, so the owner had no way to see it. Every registry entry of kind 'email' IS
  // a customer- or owner-facing message, so every one of them must be previewable.
  // If this fails, add the message to EMAIL_KINDS — do not weaken the assertion.
  it('EVERY email template in the registry is previewable', () => {
    const previewable = new Set(
      preview
        .listKinds({ settings })
        .filter((k) => k.channel === 'email' && k.settings)
        .map((k) => k.settings.key)
    );
    const templates = Object.keys(settings.REGISTRY.email).filter(
      (key) => settings.REGISTRY.email[key].kind === 'email'
    );
    expect(templates.length).toBeGreaterThan(0);
    for (const key of templates) {
      expect(previewable.has(key), 'email.' + key + ' has no entry in EMAIL_KINDS').toBe(true);
    }
  });
});

describe('render', () => {
  it('every catalogued kind renders without throwing and produces content', () => {
    for (const k of preview.listKinds({ settings })) {
      const out = preview.render(k.channel, k.id, { settings, baseUrl: 'https://x.example' });
      expect(out, 'no render for ' + k.id).toBeTruthy();
      expect(out.channel).toBe(k.channel);
      // Something must be renderable, or the preview shows a blank panel.
      expect(Boolean(out.text || out.html), 'empty preview for ' + k.id).toBe(true);
    }
  });

  it('renders the free-word-quota mail with the LIVE limit, not a hardcoded one', () => {
    settings.set('pricing', 'free_word_limit', 35);
    try {
      const out = preview.render('email', 'free_limit_reached', {
        settings,
        baseUrl: 'https://x.example',
      });
      expect(out.audience).toBe('buyer');
      expect(out.text).toContain('35');
      expect(out.html).toContain('35');
    } finally {
      settings.reset('pricing', 'free_word_limit');
    }
  });

  it("renders a reminder from the owner's reminder list, using the first enabled one", () => {
    settings.set('reminders', 'list', [
      {
        id: 'off-one',
        enabled: false,
        text: 'תזכורת כבויה על {honoree}',
        channels: { email: true, whatsapp: false },
        every_days: 1,
        weekdays: null,
        only_if_idle_hours: null,
        window: [8, 21],
        max_total: 3,
      },
      {
        id: 'live-one',
        enabled: true,
        text: 'עוד לא מאוחר להוסיף מילים על {honoree}!',
        channels: { email: true, whatsapp: false },
        every_days: 1,
        weekdays: null,
        only_if_idle_hours: null,
        window: [8, 21],
        max_total: 3,
      },
    ]);
    try {
      const out = preview.render('email', 'reminder_list', {
        settings,
        baseUrl: 'https://x.example',
      });
      // The ENABLED reminder is what a real send would use, so it is what the
      // owner must be shown — and {honoree} is interpolated, not left literal.
      expect(out.text).toContain('עוד לא מאוחר להוסיף מילים על שירה');
      expect(out.text).not.toContain('תזכורת כבויה');
      expect(out.text).not.toContain('{honoree}');
      // Its text is per-reminder, not a registry template, so there is no key to
      // edit from the preview — the list is edited on the texts page.
      expect(out.settings).toBeNull();
    } finally {
      settings.reset('reminders', 'list');
    }
  });

  it('renders the branded HTML shell with logo and CTA for a buyer mail', () => {
    const out = preview.render('email', 'buyer_confirmation', {
      settings,
      baseUrl: 'https://x.example',
      productImageUrl: 'https://x.example/assets/designs/d1/store.webp',
    });
    expect(out.html).toContain('<!DOCTYPE html>');
    expect(out.html).toContain('https://x.example'); // hosted logo origin
    expect(out.html).toContain('store.webp'); // hero product photo
    expect(out.subject).toBeTruthy();
  });

  it('reflects an owner text override — the point of previewing at all', () => {
    const tpl = settings.get('email', 'buyer_confirmation');
    settings.set('email', 'buyer_confirmation', { ...tpl, subject: 'נושא מותאם 123' });
    const out = preview.render('email', 'buyer_confirmation', {
      settings,
      baseUrl: 'https://x.example',
    });
    expect(out.subject).toContain('נושא מותאם 123');
  });

  it('reports a DISABLED WhatsApp trigger as disabled but STILL shows its text', () => {
    const t = settings.get('wa', 'trigger.group_opened');
    settings.set('wa', 'trigger.group_opened', { ...t, enabled: false, text: 'שלום {honoree}' });
    const out = preview.render('whatsapp', 'group_opened', {
      settings,
      baseUrl: 'https://x.example',
    });
    expect(out.channel).toBe('whatsapp');
    expect(out.enabled).toBe(false);
    // A blank panel is the wrong answer when the owner is reading the text to
    // decide whether to enable it — and several triggers ship disabled.
    expect(out.text).toContain('שירה'); // {honoree} interpolated from the sample
  });

  it('returns null for an unknown id', () => {
    expect(preview.render('email', 'no-such-message', { settings })).toBeNull();
  });

  it('reports an email whose own switch is OFF as disabled', () => {
    const tpl = settings.get('email', 'buyer_confirmation');
    settings.set('email', 'buyer_confirmation', { ...tpl, enabled: false });
    const out = preview.render('email', 'buyer_confirmation', { settings });
    // The text still renders (the owner is reading it to decide), but the preview
    // must not imply a message that never sends is live.
    expect(out.enabled).toBe(false);
    expect(out.html).toBeTruthy();
  });
});

// Rendering an UNSAVED edit is the whole point of an editable preview: the owner
// must see the real mail before committing text that goes to customers. The
// load-bearing property is that it renders through the same builders WITHOUT
// touching the store — a draft that leaked into settings would change live sends
// on every keystroke.
describe('render with an unsaved draft', () => {
  it('renders an email draft without storing it', () => {
    const before = settings.get('email', 'buyer_confirmation');
    const out = preview.render('email', 'buyer_confirmation', {
      settings,
      baseUrl: 'https://x.example',
      draft: {
        section: 'email',
        key: 'buyer_confirmation',
        value: { enabled: true, subject: 'טיוטה {honoree}', body: 'שלום {honoree}, זו טיוטה' },
      },
    });
    expect(out.subject).toBe('טיוטה שירה'); // tokens interpolate as in a real send
    expect(out.html).toContain('זו טיוטה');
    // The store is untouched — and the next un-drafted render proves it.
    expect(settings.get('email', 'buyer_confirmation')).toEqual(before);
    const stored = preview.render('email', 'buyer_confirmation', { settings });
    expect(stored.subject).not.toContain('טיוטה');
  });

  it('renders a WhatsApp trigger draft, including its unsaved on/off switch', () => {
    const out = preview.render('whatsapp', 'group_opened', {
      settings,
      baseUrl: 'https://x.example',
      draft: {
        section: 'wa',
        key: 'trigger.group_opened',
        value: { enabled: false, text: 'טיוטה על {honoree}' },
      },
    });
    expect(out.text).toBe('טיוטה על שירה');
    expect(out.enabled).toBe(false);
    expect(settings.get('wa', 'trigger.group_opened').text).not.toContain('טיוטה');
  });

  it('merges the draft OVER the stored value so fields the editor omits survive', () => {
    // The editor sends { enabled, subject, body } / { enabled, text }; a bare
    // replace would strip siblings the builders read (a trigger's timing).
    const merged = preview
      .draftStore(settings, {
        section: 'wa',
        key: 'trigger.payment_reminder',
        value: { text: 'רק טקסט' },
      })
      .get('wa', 'trigger.payment_reminder');
    expect(merged.text).toBe('רק טקסט');
    expect(merged.timing).toEqual(settings.get('wa', 'trigger.payment_reminder').timing);
  });

  it('leaves OTHER keys reading straight through the real store', () => {
    const store = preview.draftStore(settings, {
      section: 'email',
      key: 'buyer_confirmation',
      value: { subject: 'טיוטה' },
    });
    expect(store.get('email', 'footer')).toEqual(settings.get('email', 'footer'));
    expect(() => store.get('email', 'no-such-key')).toThrow();
  });

  it('restores the real store even when a builder throws mid-render', () => {
    // withSettings swaps a module-level binding; a throw that skipped the restore
    // would leave every later email rendering from a stale draft.
    const notify = require(path.join(serverDir, 'notify.js'));
    const fake = { get: () => ({}), interpolate: (s) => s, REGISTRY: settings.REGISTRY };
    expect(() =>
      notify.withSettings(fake, () => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    const out = preview.render('email', 'buyer_confirmation', { settings });
    expect(out.subject).toContain('שירה');
  });
});

describe('admin routes', () => {
  it('both routes reject without the admin key', async () => {
    expect((await realFetch(base + '/api/admin/message-preview')).status).toBe(403);
    expect(
      (await realFetch(base + '/api/admin/message-preview/email/buyer_confirmation')).status
    ).toBe(403);
  });

  it('lists kinds', async () => {
    const r = await realFetch(base + '/api/admin/message-preview' + qs);
    const d = await r.json();
    expect(r.status).toBe(200);
    expect(Array.isArray(d.kinds)).toBe(true);
    expect(d.kinds.some((k) => k.channel === 'email')).toBe(true);
    expect(d.kinds.some((k) => k.channel === 'whatsapp')).toBe(true);
  });

  it('renders against the SAMPLE order by default and flags it as a sample', async () => {
    const r = await realFetch(base + '/api/admin/message-preview/email/buyer_confirmation' + qs);
    const d = await r.json();
    expect(r.status).toBe(200);
    expect(d.sample).toBe(true);
    expect(d.html).toContain('<!DOCTYPE html>');
    // A preview must never carry a real customer into a screenshot.
    expect(d.html).toContain(preview.SAMPLE_COLLECTION.honoree_name);
  });

  it('renders a REAL collection when asked, using its own data', async () => {
    const c = db.createCollection('רותם-אמיתי', {
      email: 'real@example.com',
      phone: '0521234567',
    });
    const r = await realFetch(
      base + '/api/admin/message-preview/email/buyer_confirmation' + qs + '&collection=' + c.id
    );
    const d = await r.json();
    expect(r.status).toBe(200);
    expect(d.sample).toBe(false);
    expect(d.html).toContain('רותם-אמיתי');
  });

  it('renders a POSTed draft and stores nothing', async () => {
    const before = settings.get('email', 'buyer_confirmation');
    const r = await realFetch(base + '/api/admin/message-preview/email/buyer_confirmation' + qs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft: {
          section: 'email',
          key: 'buyer_confirmation',
          value: { enabled: true, subject: 'טיוטה מהדפדפן', body: 'גוף טיוטה' },
        },
      }),
    });
    const d = await r.json();
    expect(r.status).toBe(200);
    expect(d.draft).toBe(true);
    expect(d.subject).toBe('טיוטה מהדפדפן');
    expect(d.html).toContain('גוף טיוטה');
    expect(settings.get('email', 'buyer_confirmation')).toEqual(before);
  });

  it('POST without a draft is just a render of the stored message', async () => {
    const r = await realFetch(base + '/api/admin/message-preview/email/buyer_confirmation' + qs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const d = await r.json();
    expect(r.status).toBe(200);
    expect(d.draft).toBe(false);
    expect(d.subject).toBe(
      settings
        .get('email', 'buyer_confirmation')
        .subject.replace('{honoree}', preview.SAMPLE_COLLECTION.honoree_name)
    );
  });

  it('rejects a draft the settings API itself would reject, with the same reason', async () => {
    // A preview that happily rendered a value Save then refuses would be telling
    // the owner their text is fine when it can never be stored.
    const bad = await realFetch(base + '/api/admin/message-preview/email/buyer_confirmation' + qs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft: { section: 'email', key: 'buyer_confirmation', value: { subject: 5, body: 'x' } },
      }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('subject must be a string');

    const unknown = await realFetch(
      base + '/api/admin/message-preview/email/buyer_confirmation' + qs,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: { section: 'email', key: 'nope', value: {} } }),
      }
    );
    expect(unknown.status).toBe(400);
  });

  it('the draft route rejects without the admin key', async () => {
    const r = await realFetch(base + '/api/admin/message-preview/email/buyer_confirmation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: null }),
    });
    expect(r.status).toBe(403);
  });

  it('404s an unknown message id and an unknown collection', async () => {
    expect((await realFetch(base + '/api/admin/message-preview/email/nope' + qs)).status).toBe(404);
    const r = await realFetch(
      base + '/api/admin/message-preview/email/buyer_confirmation' + qs + '&collection=missing'
    );
    expect(r.status).toBe(404);
  });
});
