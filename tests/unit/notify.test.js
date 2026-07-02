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
  owner_email: 'buyer@example.com',
  design: 'קלאסי',
  color: 'ורוד',
  order: { version: 'delivery', total: 199 },
  count: 142,
};

afterEach(() => {
  setSmtp(false);
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.NOTIFY_FROM;
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
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
    const { subject, text } = loadFresh().buildPaidMessage(collection, 'https://dugri.example');
    expect(subject).toBe('דוגרי · התקבל תשלום — שירה');
    expect(text).toContain('התקבל תשלום');
    expect(text).toContain('שירה');
    expect(text).toContain('199 ₪');
    expect(text).toContain('משלוח עד הבית');
    expect(text).toContain('142');
    // Owner link (collect.html with id + owner token) when a baseUrl is passed.
    expect(text).toContain('https://dugri.example/collect.html?c=col-1&k=tok-abc');
  });

  it('falls back to a placeholder name and omits the link without a baseUrl', () => {
    const { subject, text } = loadFresh().buildPaidMessage({
      order: { version: 'pdf', total: 79 },
    });
    expect(subject).toBe('דוגרי · התקבל תשלום — ללא שם');
    expect(text).not.toContain('collect.html');
  });

  it('shows the REAL charged amount (0 = free), not the pre-coupon total, when amountCharged is passed', () => {
    // A 100%-coupon order: package price is 79 but the customer paid 0.
    const { text } = loadFresh().buildPaidMessage(
      { order: { version: 'pdf', total: 79 } },
      undefined,
      { amountCharged: 0 }
    );
    expect(text).toContain('0 ₪');
    expect(text).toContain('קופון 100%');
    expect(text).not.toContain('79 ₪');
  });

  it('shows the discounted charge for a partial coupon (not the full total)', () => {
    const { text } = loadFresh().buildPaidMessage(
      { order: { version: 'pdf', total: 79 } },
      undefined,
      {
        amountCharged: 40,
      }
    );
    expect(text).toContain('40 ₪');
    expect(text).not.toContain('79 ₪');
  });

  it('shows the full total (no regression) for a no-coupon order when amountCharged equals it', () => {
    const { text } = loadFresh().buildPaidMessage(
      { order: { version: 'pdf', total: 79 } },
      undefined,
      {
        amountCharged: 79,
      }
    );
    expect(text).toContain('79 ₪');
    expect(text).not.toContain('קופון 100%');
  });
});

describe('buildBuyerConfirmation', () => {
  it('has a subject and a Hebrew body with the price, order details and collect link', () => {
    const { subject, text } = loadFresh().buildBuyerConfirmation(
      collection,
      'https://dugri.example'
    );
    expect(subject).toBe('דוגרי · ההזמנה שלכם התקבלה — שירה');
    expect(text).toContain('תודה');
    expect(text).toContain('שירה');
    // Order details: package label + price + chosen design/colour.
    expect(text).toContain('משלוח עד הבית');
    expect(text).toContain('199 ₪');
    expect(text).toContain('קלאסי');
    expect(text).toContain('ורוד');
    // Collect link (collect.html with id + owner token) plus the words prompt.
    expect(text).toContain('הוסיפו את 100+ המילים');
    expect(text).toContain('https://dugri.example/collect.html?c=col-1&k=tok-abc');
  });

  it('falls back to a placeholder name and omits the link without a baseUrl', () => {
    const { subject, text } = loadFresh().buildBuyerConfirmation({
      order: { version: 'pdf', total: 79 },
    });
    expect(subject).toBe('דוגרי · ההזמנה שלכם התקבלה — ללא שם');
    expect(text).toContain('79 ₪');
    expect(text).not.toContain('collect.html');
  });

  it('reads clearly as free (0 ₪, קופון 100%) for a fully-free order, not the package price', () => {
    const { text } = loadFresh().buildBuyerConfirmation(
      { order: { version: 'pdf', total: 79 } },
      undefined,
      { amountCharged: 0 }
    );
    expect(text).toContain('0 ₪');
    expect(text).toContain('קופון 100%');
    expect(text).not.toContain('79 ₪');
  });
});

describe('sendBuyerConfirmation', () => {
  it('returns false (no-op) when SMTP is unconfigured', async () => {
    setSmtp(false);
    await expect(loadFresh().sendBuyerConfirmation(collection)).resolves.toBe(false);
  });

  it('skips gracefully (returns false) when the buyer has no email', async () => {
    setSmtp(true);
    const notify = loadFresh();
    const nodemailer = serverRequire('nodemailer');
    const sendMail = vi.fn(() => Promise.resolve());
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });
    await expect(notify.sendBuyerConfirmation({ ...collection, owner_email: '' })).resolves.toBe(
      false
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends to the buyer address (not NOTIFY_TO) when configured', async () => {
    setSmtp(true);
    const notify = loadFresh();
    const nodemailer = serverRequire('nodemailer');
    const sendMail = vi.fn(() => Promise.resolve());
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });
    await expect(notify.sendBuyerConfirmation(collection, 'https://dugri.example')).resolves.toBe(
      true
    );
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('buyer@example.com');
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

describe('non-prod test marker (RAILWAY_ENVIRONMENT_NAME)', () => {
  // Load notify with SMTP configured + a mocked transporter, then capture the
  // message actually handed to sendMail (after any env marking is applied).
  async function captureSend(fn) {
    setSmtp(true);
    const notify = loadFresh();
    const nodemailer = serverRequire('nodemailer');
    const sendMail = vi.fn(() => Promise.resolve());
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });
    const ok = await fn(notify);
    return { ok, sendMail };
  }

  it('staging: prepends the plain-text subject marker and banners the body', async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    const { ok, sendMail } = await captureSend((n) =>
      n.sendOrderPaid(collection, 'https://d.example')
    );
    expect(ok).toBe(true);
    const sent = sendMail.mock.calls[0][0];
    expect(sent.subject.startsWith('הזמנת בדיקה (staging) — ')).toBe(true);
    // The original subject is still present after the marker.
    expect(sent.subject).toContain('דוגרי · התקבל תשלום — שירה');
    // Banner is the first line of the body, followed by the normal content.
    expect(sent.text.startsWith('זו הזמנת בדיקה מסביבת staging — לא הזמנה אמיתית.\n\n')).toBe(true);
    expect(sent.text).toContain('התקבל תשלום');
    // Plain text only — no HTML body is introduced.
    expect(sent.html).toBeUndefined();
  });

  it('staging: marks every send path (buyer + finished too)', async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    const buyer = await captureSend((n) =>
      n.sendBuyerConfirmation(collection, 'https://d.example')
    );
    expect(buyer.sendMail.mock.calls[0][0].subject).toContain('הזמנת בדיקה (staging) — ');
    expect(buyer.sendMail.mock.calls[0][0].text).toContain('זו הזמנת בדיקה מסביבת staging');

    const finished = await captureSend((n) => n.sendOrderFinished(collection));
    expect(finished.sendMail.mock.calls[0][0].subject).toContain('הזמנת בדיקה (staging) — ');
    expect(finished.sendMail.mock.calls[0][0].text).toContain('זו הזמנת בדיקה מסביבת staging');
  });

  it('production: no marker — subject and body are unchanged', async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    const { sendMail } = await captureSend((n) => n.sendOrderPaid(collection, 'https://d.example'));
    const sent = sendMail.mock.calls[0][0];
    expect(sent.subject).toBe('דוגרי · התקבל תשלום — שירה');
    expect(sent.subject).not.toContain('הזמנת בדיקה');
    expect(sent.text).not.toContain('הזמנת בדיקה');
    expect(sent.text.startsWith('התקבל תשלום')).toBe(true);
    // No HTML body is introduced for the plain-text emails.
    expect(sent.html).toBeUndefined();
  });

  it('Production (any casing): treated as prod — no marker', async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'Production';
    const { sendMail } = await captureSend((n) => n.sendOrderPaid(collection, 'https://d.example'));
    const sent = sendMail.mock.calls[0][0];
    expect(sent.subject).toBe('דוגרי · התקבל תשלום — שירה');
    expect(sent.text).not.toContain('הזמנת בדיקה');
  });

  it('unset: no marker (local/tests behave like production)', async () => {
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    const { sendMail } = await captureSend((n) => n.sendOrderPaid(collection, 'https://d.example'));
    const sent = sendMail.mock.calls[0][0];
    expect(sent.subject).toBe('דוגרי · התקבל תשלום — שירה');
    expect(sent.text).not.toContain('הזמנת בדיקה');
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
