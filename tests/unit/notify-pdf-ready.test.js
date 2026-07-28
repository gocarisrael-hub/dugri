// @vitest-environment node
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

const link = 'https://dugri.example/api/admin/collections/col-1/pdf?key=SECRET';
const board = 'https://dugri.example/api/admin/collections/col-1/board?key=SECRET';

afterEach(() => {
  vi.unstubAllGlobals();
  setResend(false);
});

describe('buildPdfReadyMessage', () => {
  it('includes the honoree name and the download link', () => {
    const notify = loadFresh();
    const msg = notify.buildPdfReadyMessage({ honoree_name: 'עוז' }, link);
    expect(msg.subject).toContain('עוז');
    expect(msg.text).toContain(link);
  });

  it('omits the link line when no link is given', () => {
    const notify = loadFresh();
    const msg = notify.buildPdfReadyMessage({ honoree_name: 'עוז' }, null);
    expect(msg.text).not.toContain('http');
  });

  // An order now ships TWO artifacts: the card deck and the board, generated as
  // a separate file. Both have to reach the customer in this one email.
  it('carries the board link as a second labelled link + CTA', () => {
    const notify = loadFresh();
    const msg = notify.buildPdfReadyMessage({ honoree_name: 'עוז' }, link, '', {
      boardLink: board,
    });
    expect(msg.text).toContain(link);
    expect(msg.text).toContain(board);
    expect(msg.text).toContain('לוח המשחק');
    // two CTA buttons in the branded HTML — one per artifact
    expect(msg.html).toContain(`href="${link}"`);
    expect(msg.html).toContain(`href="${board}"`);
    expect(msg.html.match(/<a href="http/g) || []).toHaveLength(2);
  });

  // A board is only produced once a theme is migrated to the new card structure;
  // until then the email must look exactly like the single-artifact one.
  it('stays a one-artifact email when there is no board file', () => {
    const notify = loadFresh();
    const withOut = notify.buildPdfReadyMessage({ honoree_name: 'עוז' }, link, '');
    const withNull = notify.buildPdfReadyMessage({ honoree_name: 'עוז' }, link, '', {
      boardLink: null,
    });
    expect(withNull).toEqual(withOut);
    expect(withOut.text).not.toContain('לוח המשחק');
    expect(withOut.html.match(/<a href="http/g) || []).toHaveLength(1);
  });
});

describe('sendPdfReady', () => {
  it('is a no-op (returns false, no fetch) when email is unconfigured', async () => {
    setResend(false);
    const notify = loadFresh();
    const { fn } = stubFetch();
    const r = await notify.sendPdfReady({ honoree_name: 'עוז', owner_email: 'c@x.com' }, '', link);
    expect(r).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('sends to BOTH the client (owner_email) and Dugri (NOTIFY_TO)', async () => {
    setResend(true);
    const notify = loadFresh();
    const { calls } = stubFetch();
    const r = await notify.sendPdfReady(
      { honoree_name: 'עוז', owner_email: 'client@x.com' },
      '',
      link
    );
    expect(r).toBe(true);
    const recipients = calls.map((c) => c.body.to[0]).sort();
    expect(recipients).toEqual(['client@x.com', 'owner@dugri.example']);
    // both carry the download link
    for (const c of calls) expect(c.body.text).toContain(link);
  });

  it('sends only to Dugri when there is no client email', async () => {
    setResend(true);
    const notify = loadFresh();
    const { calls } = stubFetch();
    await notify.sendPdfReady({ honoree_name: 'עוז' }, '', link);
    expect(calls.length).toBe(1);
    expect(calls[0].body.to[0]).toBe('owner@dugri.example');
  });

  it('does not double-send when the client email equals NOTIFY_TO', async () => {
    setResend(true);
    const notify = loadFresh();
    const { calls } = stubFetch();
    await notify.sendPdfReady(
      { honoree_name: 'עוז', owner_email: 'owner@dugri.example' },
      '',
      link
    );
    expect(calls.length).toBe(1);
  });

  it('sends the ADMIN link to Dugri and the CUSTOMER link to the client — never the admin key to the customer', async () => {
    setResend(true);
    const notify = loadFresh();
    const { calls } = stubFetch();
    const adminLink = 'https://dugri.example/api/admin/collections/col-1/pdf?key=SUPERSECRET';
    const customerLink = 'https://dugri.example/api/collections/col-1/pdf?t=capabilitytoken123';
    await notify.sendPdfReady({ honoree_name: 'עוז', owner_email: 'client@x.com' }, '', {
      admin: adminLink,
      customer: customerLink,
    });
    const byRecipient = Object.fromEntries(calls.map((c) => [c.body.to[0], c.body]));
    // Dugri (NOTIFY_TO) gets the admin link.
    expect(byRecipient['owner@dugri.example'].text).toContain(adminLink);
    // The customer gets the capability link and NEVER the admin key.
    const customer = byRecipient['client@x.com'];
    expect(customer.text).toContain(customerLink);
    expect(JSON.stringify(customer)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(customer)).not.toContain('key=');
  });

  // Same split for the SECOND artifact: the board links are per-recipient too, so
  // the admin-keyed board URL can never ride along in the customer's copy.
  it('gives each recipient their OWN board link alongside their deck link', async () => {
    setResend(true);
    const notify = loadFresh();
    const { calls } = stubFetch();
    const adminLink = 'https://dugri.example/api/admin/collections/col-1/pdf?key=SUPERSECRET';
    const adminBoard = 'https://dugri.example/api/admin/collections/col-1/board?key=SUPERSECRET';
    const customerLink = 'https://dugri.example/api/collections/col-1/pdf?t=capabilitytoken123';
    const customerBoard = 'https://dugri.example/api/collections/col-1/board?t=capabilitytoken123';
    await notify.sendPdfReady({ honoree_name: 'עוז', owner_email: 'client@x.com' }, '', {
      admin: adminLink,
      customer: customerLink,
      adminBoard,
      customerBoard,
    });
    const byRecipient = Object.fromEntries(calls.map((c) => [c.body.to[0], c.body]));
    const owner = byRecipient['owner@dugri.example'];
    expect(owner.text).toContain(adminLink);
    expect(owner.text).toContain(adminBoard);
    const customer = byRecipient['client@x.com'];
    expect(customer.text).toContain(customerLink);
    expect(customer.text).toContain(customerBoard);
    expect(JSON.stringify(customer)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(customer)).not.toContain('key=');
  });
});
