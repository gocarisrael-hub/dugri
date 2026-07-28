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

  it('404s an unknown message id and an unknown collection', async () => {
    expect((await realFetch(base + '/api/admin/message-preview/email/nope' + qs)).status).toBe(404);
    const r = await realFetch(
      base + '/api/admin/message-preview/email/buyer_confirmation' + qs + '&collection=missing'
    );
    expect(r.status).toBe(404);
  });
});
