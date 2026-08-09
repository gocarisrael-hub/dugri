// @vitest-environment node
// The BUYER's "we've got your list, we've started making it" email — fired when
// they close word collection with "סיום — התחילו להפיק".
//
// It replaced pdf_ready ("your file is ready, download it"), which was written
// for the digital-only phase and stopped making sense once the product shipped
// as a printed game. The two properties that matter here are the ones that
// distinguish it from the mail it replaced: it goes to the BUYER only (the owner
// has their own mail from the same moment, order_finished), and it carries NO
// download link — there is nothing for the customer to download.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// server/notify.js reads its env at require time, so each test loads a fresh
// copy after setting/clearing the Resend vars. The Resend transport is a fetch
// POST; we stub it to capture every send without leaving the machine.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, '..', '..', 'server', 'notify.js');

function loadFresh() {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

function stubFetch({ ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok, status, text: async () => '' };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
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
  honoree_name: 'עוז',
  owner_email: 'buyer@example.com',
  owner_token: 'tok-abc',
  count: 84,
};

afterEach(() => {
  vi.unstubAllGlobals();
  setResend(false);
});

describe('buildProductionStarted', () => {
  it('names the honoree and echoes the word count back', () => {
    const msg = loadFresh().buildProductionStarted(collection, 'https://dugri.example');
    expect(msg.subject).toContain('עוז');
    expect(msg.text).toContain('עוז');
    // The one number that tells the buyer their whole list arrived.
    expect(msg.text).toContain('84');
  });

  it('carries NO link and NO CTA — the list is closed, there is nothing to click', () => {
    const msg = loadFresh().buildProductionStarted(collection, 'https://dugri.example');
    expect(msg.text).not.toContain('http');
    // The branded shell still renders (logo + body), it just has no button.
    expect(msg.html).toContain('<!DOCTYPE html>');
    expect(msg.html).toContain('https://dugri.example/assets/dugri-logo-email.png');
    expect(msg.html).not.toContain('/pdf?');
    expect(msg.html).not.toContain('/board?');
  });

  it('renders without a word count rather than printing "undefined"', () => {
    const msg = loadFresh().buildProductionStarted({ honoree_name: 'עוז' }, '');
    expect(msg.text).not.toContain('undefined');
    expect(msg.text).not.toContain('{wordCount}');
  });
});

describe('sendProductionStarted', () => {
  it('is a no-op (returns false, no fetch) when email is unconfigured', async () => {
    setResend(false);
    const { fn } = stubFetch();
    await expect(loadFresh().sendProductionStarted(collection)).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('goes to the BUYER, not to the owner inbox', async () => {
    setResend(true);
    const { calls } = stubFetch();
    await expect(
      loadFresh().sendProductionStarted(collection, 'https://dugri.example')
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    // The owner's own "ready to produce" mail is a separate send
    // (sendOrderFinished) — this one must never land in NOTIFY_TO.
    expect(calls[0].body.to).toEqual(['buyer@example.com']);
  });

  it('skips gracefully when the buyer gave no email', async () => {
    setResend(true);
    const { fn } = stubFetch();
    await expect(
      loadFresh().sendProductionStarted({ ...collection, owner_email: '' })
    ).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('never throws when the transport fails', async () => {
    setResend(true);
    stubFetch({ ok: false, status: 500 });
    await expect(loadFresh().sendProductionStarted(collection)).resolves.toBe(false);
  });
});
