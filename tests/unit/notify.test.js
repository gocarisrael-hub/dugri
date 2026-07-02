// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// server/notify.js captures the RESEND_API_KEY/NOTIFY_* env vars at require
// time, so each test loads a fresh copy after setting (or clearing) the
// environment.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, '..', '..', 'server', 'notify.js');

function loadFresh() {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

// The Resend transport is an HTTPS POST via the global fetch. Stub it so nothing
// leaves the machine and every request is captured (URL, headers, parsed JSON
// body) so tests can assert what was sent. `ok`/`status`/`textBody` model the
// Resend response.
function stubFetch({ ok = true, status = 200, textBody = '' } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, opts) => {
    const parsed = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, opts, body: parsed });
    return { ok, status, text: async () => textBody };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

// Map a captured Resend request body back to the message shape the tests assert
// on (single recipient, subject, text, html).
function sentMessage(call) {
  return {
    to: Array.isArray(call.body.to) ? call.body.to[0] : call.body.to,
    from: call.body.from,
    subject: call.body.subject,
    text: call.body.text,
    html: call.body.html,
  };
}

const RESEND = {
  RESEND_API_KEY: 're_test_key',
  NOTIFY_TO: 'owner@dugri.example',
  NOTIFY_FROM: 'Dugri <orders@dugri.example>',
};

function setResend(on) {
  for (const k of Object.keys(RESEND)) {
    if (on) process.env[k] = RESEND[k];
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
  setResend(false);
  delete process.env.REPLY_TO;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isConfigured', () => {
  it('is false when the Resend env vars are missing', () => {
    setResend(false);
    expect(loadFresh().isConfigured()).toBe(false);
  });

  it('is false when only some Resend vars are set', () => {
    setResend(false);
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.NOTIFY_TO = 'owner@dugri.example';
    // NOTIFY_FROM still missing.
    expect(loadFresh().isConfigured()).toBe(false);
  });

  it('is true when RESEND_API_KEY, NOTIFY_TO and NOTIFY_FROM are all set', () => {
    setResend(true);
    expect(loadFresh().isConfigured()).toBe(true);
  });
});

describe('partial-config warning', () => {
  it('warns once (and stays a no-op) when some — but not all — Resend vars are set', async () => {
    setResend(false);
    // Key + recipient set, NOTIFY_FROM forgotten — the likely misconfiguration.
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.NOTIFY_TO = 'owner@dugri.example';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notify = loadFresh(); // startup warning fires here
    const { fn } = stubFetch();

    // Warned exactly once, naming the missing var.
    const partialWarnings = warn.mock.calls
      .map((c) => c.join(' '))
      .filter((m) => m.includes('email partially configured'));
    expect(partialWarnings.length).toBe(1);
    expect(partialWarnings[0]).toContain('NOTIFY_FROM');

    // Still fully dormant: not configured, sends are no-ops, fetch never called.
    expect(notify.isConfigured()).toBe(false);
    await expect(notify.sendOrderPaid(collection, 'https://d.example')).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not warn when all three vars are set (fully configured)', () => {
    setResend(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadFresh();
    const partialWarnings = warn.mock.calls
      .map((c) => c.join(' '))
      .filter((m) => m.includes('email partially configured'));
    expect(partialWarnings.length).toBe(0);
  });

  it('does not warn when no vars are set (dormant by design)', () => {
    setResend(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadFresh();
    const partialWarnings = warn.mock.calls
      .map((c) => c.join(' '))
      .filter((m) => m.includes('email partially configured'));
    expect(partialWarnings.length).toBe(0);
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
  it('returns false (no-op) when Resend is unconfigured', async () => {
    setResend(false);
    const { fn } = stubFetch();
    await expect(loadFresh().sendBuyerConfirmation(collection)).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('skips gracefully (returns false) when the buyer has no email', async () => {
    setResend(true);
    const notify = loadFresh();
    const { fn } = stubFetch();
    await expect(notify.sendBuyerConfirmation({ ...collection, owner_email: '' })).resolves.toBe(
      false
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('sends to the buyer address (not NOTIFY_TO) when configured', async () => {
    setResend(true);
    const notify = loadFresh();
    const { fn, calls } = stubFetch();
    await expect(notify.sendBuyerConfirmation(collection, 'https://dugri.example')).resolves.toBe(
      true
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sentMessage(calls[0]).to).toBe('buyer@example.com');
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

describe('Resend transport (send)', () => {
  it('POSTs to the Resend URL with the Bearer auth header and the right from/to/subject', async () => {
    setResend(true);
    const notify = loadFresh();
    const { fn, calls } = stubFetch();
    await expect(notify.sendOrderPaid(collection, 'https://d.example')).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, opts] = fn.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer re_test_key');
    expect(opts.headers['Content-Type']).toBe('application/json');
    const msg = sentMessage(calls[0]);
    expect(msg.from).toBe('Dugri <orders@dugri.example>');
    // Recipient is sent as an array in the JSON body.
    expect(calls[0].body.to).toEqual(['owner@dugri.example']);
    expect(msg.subject).toBe('דוגרי · התקבל תשלום — שירה');
    expect(msg.text).toContain('התקבל תשלום');
  });

  it('returns false and logs a warning (no throw) on a non-2xx response', async () => {
    setResend(true);
    const notify = loadFresh();
    stubFetch({ ok: false, status: 422, textBody: '{"message":"domain not verified"}' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(notify.sendOrderPaid(collection, 'https://d.example')).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('422');
    expect(logged).toContain('domain not verified');
  });

  it('is a no-op (no fetch) when RESEND_API_KEY is unset', async () => {
    setResend(true);
    delete process.env.RESEND_API_KEY;
    const notify = loadFresh();
    const { fn } = stubFetch();
    expect(notify.isConfigured()).toBe(false);
    await expect(notify.sendOrderPaid(collection, 'https://d.example')).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('is a no-op (no fetch) when NOTIFY_FROM is unset', async () => {
    setResend(true);
    delete process.env.NOTIFY_FROM;
    const notify = loadFresh();
    const { fn } = stubFetch();
    expect(notify.isConfigured()).toBe(false);
    await expect(notify.sendOrderPaid(collection, 'https://d.example')).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('Reply-To routing (REPLY_TO)', () => {
  it('defaults reply_to to NOTIFY_TO when REPLY_TO is unset', async () => {
    setResend(true);
    delete process.env.REPLY_TO;
    const notify = loadFresh();
    const { fn, calls } = stubFetch();
    await expect(notify.sendOrderPaid(collection, 'https://d.example')).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].body.reply_to).toBe('owner@dugri.example');
  });

  it('uses the REPLY_TO value when it is set (overrides NOTIFY_TO)', async () => {
    setResend(true);
    process.env.REPLY_TO = 'business.inbox@gmail.example';
    const notify = loadFresh();
    const { fn, calls } = stubFetch();
    await expect(notify.sendOrderPaid(collection, 'https://d.example')).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].body.reply_to).toBe('business.inbox@gmail.example');
  });

  it('sets reply_to on the buyer confirmation too (customer replies reach us)', async () => {
    setResend(true);
    process.env.REPLY_TO = 'business.inbox@gmail.example';
    const notify = loadFresh();
    const { calls } = stubFetch();
    await expect(notify.sendBuyerConfirmation(collection, 'https://d.example')).resolves.toBe(true);
    expect(calls[0].body.reply_to).toBe('business.inbox@gmail.example');
  });
});

describe('non-prod test marker (RAILWAY_ENVIRONMENT_NAME)', () => {
  // Load notify with Resend configured + a stubbed fetch, then capture the
  // message actually POSTed (after any env marking is applied).
  async function captureSend(fn) {
    setResend(true);
    const notify = loadFresh();
    const { calls } = stubFetch();
    const ok = await fn(notify);
    return { ok, sent: calls.length ? sentMessage(calls[0]) : null };
  }

  it('staging: prepends the plain-text subject marker and banners the body', async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    const { ok, sent } = await captureSend((n) => n.sendOrderPaid(collection, 'https://d.example'));
    expect(ok).toBe(true);
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
    expect(buyer.sent.subject).toContain('הזמנת בדיקה (staging) — ');
    expect(buyer.sent.text).toContain('זו הזמנת בדיקה מסביבת staging');

    const finished = await captureSend((n) => n.sendOrderFinished(collection));
    expect(finished.sent.subject).toContain('הזמנת בדיקה (staging) — ');
    expect(finished.sent.text).toContain('זו הזמנת בדיקה מסביבת staging');
  });

  it('production: no marker — subject and body are unchanged', async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    const { sent } = await captureSend((n) => n.sendOrderPaid(collection, 'https://d.example'));
    expect(sent.subject).toBe('דוגרי · התקבל תשלום — שירה');
    expect(sent.subject).not.toContain('הזמנת בדיקה');
    expect(sent.text).not.toContain('הזמנת בדיקה');
    expect(sent.text.startsWith('התקבל תשלום')).toBe(true);
    // No HTML body is introduced for the plain-text emails.
    expect(sent.html).toBeUndefined();
  });

  it('Production (any casing): treated as prod — no marker', async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'Production';
    const { sent } = await captureSend((n) => n.sendOrderPaid(collection, 'https://d.example'));
    expect(sent.subject).toBe('דוגרי · התקבל תשלום — שירה');
    expect(sent.text).not.toContain('הזמנת בדיקה');
  });

  it('unset: no marker (local/tests behave like production)', async () => {
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    const { sent } = await captureSend((n) => n.sendOrderPaid(collection, 'https://d.example'));
    expect(sent.subject).toBe('דוגרי · התקבל תשלום — שירה');
    expect(sent.text).not.toContain('הזמנת בדיקה');
  });

  it('staging free order: carries BOTH the test marker AND the 0 ₪ charged amount', async () => {
    // The two features are orthogonal — send() wraps subject/body with the
    // test marker while the amountCharged content lives in the body. A free
    // order in a non-prod env must show both at once.
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    const { ok, sent } = await captureSend((n) =>
      n.sendOrderPaid(collection, 'https://d.example', { amountCharged: 0 })
    );
    expect(ok).toBe(true);
    // #84 test marker present...
    expect(sent.subject.startsWith('הזמנת בדיקה (staging) — ')).toBe(true);
    expect(sent.text.startsWith('זו הזמנת בדיקה מסביבת staging — לא הזמנה אמיתית.\n\n')).toBe(true);
    // ...and the charged-amount content reads as free, not the 199 ₪ package.
    expect(sent.text).toContain('0 ₪');
    expect(sent.text).toContain('קופון 100%');
    expect(sent.text).not.toContain('199 ₪');
  });
});

describe('send* never throw', () => {
  it('sendOrderPaid returns false (no-op) when unconfigured', async () => {
    setResend(false);
    await expect(loadFresh().sendOrderPaid(collection)).resolves.toBe(false);
  });

  it('sendOrderFinished returns false and never throws when the transport fails', async () => {
    setResend(true);
    const notify = loadFresh();
    // Force fetch to reject; the wrapper must swallow it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down')))
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(notify.sendOrderFinished(collection)).resolves.toBe(false);
  });

  it('aborts a hung request after the timeout — returns false + logs, never hangs', async () => {
    setResend(true);
    const notify = loadFresh();
    vi.useFakeTimers();
    // A fetch that never resolves on its own — it only settles when send()'s
    // AbortController fires, so this proves the timeout actually aborts it.
    const fetchMock = vi.fn(
      (url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = notify.sendOrderPaid(collection, 'https://d.example');
    // Advance past the 10s timeout so the abort fires.
    await vi.advanceTimersByTimeAsync(10000);
    await expect(p).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The request carried an abort signal, and it ended up aborted by the timer.
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('[notify] send failed:');
  });
});
