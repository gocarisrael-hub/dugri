// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// server/notify.js captures the SMTP_*/NOTIFY_* env vars at require time, so
// each test loads a fresh copy after setting (or clearing) the environment.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, '..', '..', 'server', 'notify.js');
// nodemailer is a server dependency (server/node_modules), so resolve it with a
// require scoped to the server dir — the same cached instance notify.js uses.
const serverRequire = createRequire(modPath);

function loadFresh() {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

const SMTP = {
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_USER: 'owner@dugri.example',
  SMTP_PASS: 'app-password',
  NOTIFY_TO: 'owner@dugri.example',
};

function setSmtp(on) {
  for (const k of Object.keys(SMTP)) {
    if (on) process.env[k] = SMTP[k];
    else delete process.env[k];
  }
}

const collection = {
  id: 'col-1',
  honoree_name: 'שירה',
  owner_token: 'tok-abc',
  order: { version: 'delivery', total: 199 },
  count: 142,
};

afterEach(() => {
  setSmtp(false);
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.NOTIFY_FROM;
  vi.restoreAllMocks();
});

describe('isConfigured', () => {
  it('is false when SMTP env vars are missing', () => {
    setSmtp(false);
    expect(loadFresh().isConfigured()).toBe(false);
  });

  it('is false when only some SMTP vars are set', () => {
    setSmtp(false);
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_USER = 'u';
    expect(loadFresh().isConfigured()).toBe(false);
  });

  it('is true when host, user, pass and NOTIFY_TO are all set', () => {
    setSmtp(true);
    expect(loadFresh().isConfigured()).toBe(true);
  });
});

describe('buildPaidMessage', () => {
  it('includes the honoree name, version, total ₪ and word count in Hebrew', () => {
    process.env.PUBLIC_BASE_URL = 'https://dugri.example';
    const { subject, text } = loadFresh().buildPaidMessage(collection);
    expect(subject).toBe('דוגרי · התקבל תשלום — שירה');
    expect(text).toContain('התקבל תשלום');
    expect(text).toContain('שירה');
    expect(text).toContain('199 ₪');
    expect(text).toContain('משלוח עד הבית');
    expect(text).toContain('142');
    // Owner link (collect.html with id + owner token) when PUBLIC_BASE_URL is set.
    expect(text).toContain('https://dugri.example/collect.html?c=col-1&k=tok-abc');
  });

  it('falls back to a placeholder name and omits the link without PUBLIC_BASE_URL', () => {
    const { subject, text } = loadFresh().buildPaidMessage({
      order: { version: 'pdf', total: 79 },
    });
    expect(subject).toBe('דוגרי · התקבל תשלום — ללא שם');
    expect(text).not.toContain('collect.html');
  });
});

describe('buildFinishedMessage', () => {
  it('uses the finished subject and mentions the order is ready to produce', () => {
    const { subject, text } = loadFresh().buildFinishedMessage(collection);
    expect(subject).toBe('דוגרי · הזמנה מוכנה להפקה — שירה');
    expect(text).toContain('מוכנה להפקה');
    expect(text).toContain('שירה');
  });
});

describe('send* never throw', () => {
  it('sendOrderPaid returns false (no-op) when unconfigured', async () => {
    setSmtp(false);
    await expect(loadFresh().sendOrderPaid(collection)).resolves.toBe(false);
  });

  it('sendOrderFinished returns false and never throws when the transport fails', async () => {
    setSmtp(true);
    const notify = loadFresh();
    // Force the nodemailer transport to reject; the wrapper must swallow it.
    const nodemailer = serverRequire('nodemailer');
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: () => Promise.reject(new Error('smtp down')),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(notify.sendOrderFinished(collection)).resolves.toBe(false);
  });
});
