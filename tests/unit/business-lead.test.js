// @vitest-environment node
// POST /api/business-lead: the homepage's business-inquiry form.
//
// What these tests pin, in order of how much a regression would cost:
//   1. A valid lead is STORED, on disk, before the email is even attempted, and
//      stays stored when the email fails.
//   2. The owner's email goes out, with the company in the subject and the phone
//      as a tel: link.
//   3. Bots are turned away: the honeypot stores and sends nothing, and a client
//      past 5 an hour gets 429.
//   4. Validation: name and company 2..80 chars, an Israeli phone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const express = require(path.join(serverDir, 'node_modules', 'express'));
const leadsPath = path.join(serverDir, 'business-leads.js');
const leads = require(leadsPath);
const { registerBusinessLead } = require(path.join(serverDir, 'routes', 'platform.js'));
const { makeRateLimiter } = require(path.join(serverDir, 'preview-cache.js'));

const VALID = { name: 'דנה כהן', company: 'חברה בע"מ', phone: '052-123-4567' };

beforeEach(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-leads-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BUSINESS_LEAD_RATE_LIMIT;
});

describe('validateLead', () => {
  it('accepts a lead and returns the cleaned fields', () => {
    expect(
      leads.validateLead({ name: '  דנה   כהן ', company: 'חברה', phone: '(052) 123-4567' })
    ).toEqual({
      ok: true,
      lead: { name: 'דנה כהן', company: 'חברה', phone: '0521234567' },
    });
  });

  it.each([
    [{}, { name: 'required', company: 'required', phone: 'required' }],
    [{ ...VALID, name: ' ד ' }, { name: 'too_short' }],
    [{ ...VALID, company: 'א'.repeat(81) }, { company: 'too_long' }],
    [{ ...VALID, name: 12 }, { name: 'required' }],
    [{ ...VALID, phone: '052-123' }, { phone: 'invalid' }],
    [{ ...VALID, phone: '+1 212 555 0100' }, { phone: 'invalid' }],
    [{ ...VALID, phone: 'abc' }, { phone: 'invalid' }],
  ])('refuses %j', (body, errors) => {
    expect(leads.validateLead(body)).toEqual({ ok: false, errors });
  });

  it('takes exactly 2 and exactly 80 characters', () => {
    expect(leads.validateLead({ ...VALID, name: 'דנ', company: 'א'.repeat(80) }).ok).toBe(true);
  });
});

describe('normalizeIlPhone', () => {
  it.each([
    ['0521234567', '0521234567'],
    ['052-123-4567', '0521234567'],
    ['052 123 4567', '0521234567'],
    ['(052)1234567', '0521234567'],
    ['02-1234567', '021234567'],
    ['+972521234567', '0521234567'],
    ['+972-52-123-4567', '0521234567'],
    ['+972 (0)52 123 4567', '0521234567'],
    ['00972521234567', '0521234567'],
    ['+97221234567', '021234567'],
  ])('%s → %s', (input, out) => {
    expect(leads.normalizeIlPhone(input)).toBe(out);
  });

  it.each([
    '',
    '05212345',
    '052123456789',
    '1521234567',
    '+9725212345678',
    '+44 20 7946 0958',
    null,
  ])('refuses %j', (input) => {
    expect(leads.normalizeIlPhone(input)).toBe(null);
  });

  it('builds an international tel: link', () => {
    expect(leads.telHref('0521234567')).toBe('tel:+972521234567');
  });
});

describe('sourceOf', () => {
  it('keeps a path, from the body first, else the Referer', () => {
    expect(leads.sourceOf({ source: '/new.html?utm=x' }, 'https://x.co/other')).toBe(
      '/new.html?utm=x'
    );
    expect(leads.sourceOf({}, 'https://dugri-israel.co.il/new.html#form')).toBe('/new.html');
    expect(leads.sourceOf({}, undefined)).toBe('');
  });
});

describe('the lead store', () => {
  it('stores to disk, newest first, and records the email outcome', () => {
    const a = leads.add({ name: 'א', company: 'ב', phone: '0521234567' }, { source: '/' });
    const b = leads.add({ name: 'ג', company: 'ד', phone: '021234567' });
    expect(JSON.parse(fs.readFileSync(leads.file(), 'utf8')).map((r) => r.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(leads.list().map((r) => r.id)).toEqual([b.id, a.id]);
    expect(a.email).toBe('pending');
    expect(leads.setEmailStatus(a.id, 'sent')).toBe(true);
    expect(leads.list().find((r) => r.id === a.id).email).toBe('sent');
  });

  it('refuses to write over a file it cannot read', () => {
    fs.writeFileSync(leads.file(), '[{"id":"x","na');
    expect(() => leads.add({ name: 'א', company: 'ב', phone: '0521234567' })).toThrow(
      /cannot be read/
    );
    expect(fs.readFileSync(leads.file(), 'utf8')).toBe('[{"id":"x","na');
  });
});

describe('the owner email', () => {
  const loadNotify = () => {
    for (const f of ['notify.js', 'settings.js'])
      delete require.cache[require.resolve(path.join(serverDir, f))];
    return {
      settings: require(path.join(serverDir, 'settings.js')),
      notify: require(path.join(serverDir, 'notify.js')),
    };
  };
  const lead = {
    name: 'דנה <b>',
    company: 'חברה בע"מ',
    phone: '0521234567',
    source: '/new.html',
    created_at: '2026-10-16T09:30:00.000Z',
  };

  it('puts the company in the subject and the phone in a tel: link', () => {
    const { notify } = loadNotify();
    const m = notify.buildBusinessLead(lead);
    expect(m.subject).toBe('פנייה עסקית חדשה: חברה בע"מ');
    expect(m.text).toContain('שם: דנה <b>');
    expect(m.text).toContain('טלפון: 0521234567');
    expect(m.text).toContain('מעמוד: /new.html');
    expect(m.text).toMatch(/נשלח: .*2026/);
    expect(m.html).toContain('href="tel:+972521234567"');
    // Whatever a visitor types is text in the owner's inbox, never markup.
    expect(m.html).toContain('דנה &lt;b&gt;');
    expect(m.html).not.toContain('דנה <b>');
  });

  it('uses the owner-edited subject and intro', () => {
    const { settings, notify } = loadNotify();
    settings.set('email', 'business_lead', {
      subject: 'ליד: {company} ({name})',
      body: 'שורה שלי',
    });
    const m = notify.buildBusinessLead(lead);
    expect(m.subject).toBe('ליד: חברה בע"מ (דנה <b>)');
    expect(m.text.split('\n')[0]).toBe('שורה שלי');
  });
});

// The route on a bare app, with a notify stub and the real store.
function bareApp({ notify, key = () => 'client-1' } = {}) {
  const app = express();
  app.use(express.json());
  registerBusinessLead(app, { clientKey: key, makeRateLimiter, notify, businessLeads: leads });
  return new Promise((resolve) => {
    const server = app.listen(0, () =>
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port })
    );
  });
}
const post = async (base, body, headers = {}) => {
  const res = await fetch(base + '/api/business-lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

describe('POST /api/business-lead', () => {
  let ctx;
  afterEach(() => ctx && ctx.server.close());

  it('stores the lead, answers ok, then emails the owner and records it', async () => {
    const calls = [];
    const notify = { sendBusinessLead: vi.fn(async (rec) => (calls.push(rec), 'sent')) };
    ctx = await bareApp({ notify });
    const r = await post(ctx.base, { ...VALID, source: '/new.html' });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    const [stored] = leads.list();
    expect(stored).toMatchObject({
      name: 'דנה כהן',
      company: 'חברה בע"מ',
      phone: '0521234567',
      source: '/new.html',
    });
    await vi.waitFor(() => expect(leads.list()[0].email).toBe('sent'));
    expect(calls).toEqual([expect.objectContaining({ id: stored.id, phone: '0521234567' })]);
  });

  it('keeps the lead when the email fails', async () => {
    const notify = { sendBusinessLead: vi.fn(async () => 'failed') };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx = await bareApp({ notify });
    expect((await post(ctx.base, VALID)).status).toBe(200);
    await vi.waitFor(() => expect(leads.list()[0].email).toBe('failed'));
    expect(leads.list()).toHaveLength(1);
    expect(errors.mock.calls.flat().join(' ')).toContain('owner email FAILED');
    errors.mockRestore();
  });

  it('answers 400 with a code per bad field, and stores and sends nothing', async () => {
    const notify = { sendBusinessLead: vi.fn() };
    ctx = await bareApp({ notify });
    const r = await post(ctx.base, { name: 'ד', company: '', phone: '123' });
    expect(r).toEqual({
      status: 400,
      body: {
        error: 'invalid',
        fields: { name: 'too_short', company: 'required', phone: 'invalid' },
      },
    });
    expect(leads.list()).toEqual([]);
    expect(notify.sendBusinessLead).not.toHaveBeenCalled();
  });

  it('the honeypot: a filled `website` looks accepted, but nothing is stored or sent', async () => {
    const notify = { sendBusinessLead: vi.fn() };
    ctx = await bareApp({ notify });
    const r = await post(ctx.base, { ...VALID, website: 'http://spam.example' });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(leads.list()).toEqual([]);
    expect(notify.sendBusinessLead).not.toHaveBeenCalled();
    // An empty honeypot is a person.
    expect((await post(ctx.base, { ...VALID, website: '' })).status).toBe(200);
    expect(leads.list()).toHaveLength(1);
  });

  it('5 an hour per client, counting invalid attempts too; then 429; other clients unaffected', async () => {
    let who = 'a';
    const notify = { sendBusinessLead: vi.fn(async () => 'sent') };
    ctx = await bareApp({ notify, key: () => who });
    expect((await post(ctx.base, { ...VALID, phone: 'x' })).status).toBe(400);
    for (let i = 0; i < 4; i++) expect((await post(ctx.base, VALID)).status).toBe(200);
    const r = await post(ctx.base, VALID);
    expect(r).toEqual({ status: 429, body: { error: 'too many attempts' } });
    expect(leads.list()).toHaveLength(4);
    who = 'b';
    expect((await post(ctx.base, VALID)).status).toBe(200);
  });

  it('answers 500 and sends nothing when the lead cannot be stored', async () => {
    fs.writeFileSync(leads.file(), 'not json');
    const notify = { sendBusinessLead: vi.fn() };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx = await bareApp({ notify });
    expect((await post(ctx.base, VALID)).status).toBe(500);
    expect(notify.sendBusinessLead).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

// Through the real server: registered, behind the real JSON parser, and the real
// notify path posting to Resend (fetch stubbed) with the owner as recipient.
describe('the real app', () => {
  it('stores the lead and sends the owner the email through Resend', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.NOTIFY_TO = 'owner@example.com';
    process.env.NOTIFY_FROM = 'orders@example.com';
    const realFetch = globalThis.fetch;
    const resend = [];
    vi.stubGlobal('fetch', async (url, init) => {
      if (String(url).includes('resend')) {
        resend.push(JSON.parse(init.body));
        return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'e1' }) };
      }
      return realFetch(url, init);
    });
    for (const f of ['index.js', 'notify.js', 'settings.js', 'db.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    const app = require(path.join(serverDir, 'index.js'));
    const server = await new Promise((r) => {
      const s = app.listen(0, () => r(s));
    });
    try {
      const base = 'http://127.0.0.1:' + server.address().port;
      const r = await post(base, VALID, { Referer: base + '/new.html' });
      expect(r).toEqual({ status: 200, body: { ok: true } });
      await vi.waitFor(() => expect(leads.list()[0].email).toBe('sent'));
      expect(leads.list()[0].source).toBe('/new.html');
      expect(resend).toHaveLength(1);
      expect(resend[0].to).toEqual(expect.arrayContaining(['owner@example.com']));
      expect(resend[0].subject).toContain('פנייה עסקית חדשה: חברה בע"מ');
      expect(resend[0].html).toContain('tel:+972521234567');
    } finally {
      server.close();
      delete process.env.RESEND_API_KEY;
      delete process.env.NOTIFY_TO;
      delete process.env.NOTIFY_FROM;
    }
  });
});
