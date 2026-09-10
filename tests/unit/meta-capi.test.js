// @vitest-environment node
//
// The Conversions API (server/meta-capi.js). Two things here can be wrong in
// ways nobody would notice for weeks: an event that Meta silently rejects, and
// an event that Meta accepts TWICE. Most of these tests are about the second.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const capi = require(path.join(__dirname, '..', '..', 'server', 'meta-capi.js'));

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const PIXEL = '1234567890123456';
const TOKEN = 'EAA-test-token';

describe('arming', () => {
  it('needs both a pixel and a token, and refuses a malformed pixel id', () => {
    expect(capi.isArmed({ pixelId: PIXEL, token: TOKEN })).toBe(true);
    expect(capi.isArmed({ pixelId: PIXEL, token: '' })).toBe(false);
    expect(capi.isArmed({ pixelId: '', token: TOKEN })).toBe(false);
    expect(capi.isArmed({ pixelId: 'my-pixel', token: TOKEN })).toBe(false);
    expect(capi.isArmed()).toBe(false);
  });
});

describe('the purchase event', () => {
  // THE DEDUPLICATION KEY. The browser pixel sends the order number as its
  // eventID; if the server sent anything else, Meta would count the same sale
  // twice and every number downstream, ROAS included, would be inflated.
  it('is identified by the order number and nothing else', () => {
    const a = capi.purchaseEvent({ orderNo: 'DG-1001', value: 199 });
    const b = capi.purchaseEvent({ orderNo: 'DG-1001', value: 199, at: Date.now() + 60000 });
    expect(a.event_id).toBe('DG-1001');
    expect(b.event_id).toBe(a.event_id);
  });

  it('carries the money and the shape Meta expects', () => {
    const at = 1_700_000_000_000;
    const e = capi.purchaseEvent({ orderNo: 'DG-1001', value: 238, at });
    expect(e.event_name).toBe('Purchase');
    expect(e.action_source).toBe('website');
    expect(e.custom_data).toEqual({ value: 238, currency: 'ILS' });
    // Seconds. A millisecond value read as seconds is a time thousands of years
    // in the future, and Meta rejects an event dated in the future.
    expect(e.event_time).toBe(Math.floor(at / 1000));
    expect(String(e.event_time)).toHaveLength(10);
  });

  it('rebuilds the click id from the landing URL we already store', () => {
    const at = 1_700_000_000_000;
    const e = capi.purchaseEvent({
      orderNo: 'DG-1',
      value: 199,
      landing: 'https://dugri-israel.co.il/?fbclid=IwAR_xyz',
      at,
    });
    expect(e.user_data.fbc).toBe(`fb.1.${at}.IwAR_xyz`);
  });

  it('has no click id when the visit was not a Meta click', () => {
    const e = capi.purchaseEvent({
      orderNo: 'DG-1',
      value: 199,
      landing: 'https://dugri-israel.co.il/?utm_source=newsletter',
    });
    expect(e.user_data.fbc).toBeUndefined();
    expect(capi.fbcFrom('not a url')).toBeNull();
  });

  it('forwards the browser cookie unread when the page sent one', () => {
    const e = capi.purchaseEvent({ orderNo: 'DG-1', value: 199, fbp: 'fb.1.123.456' });
    expect(e.user_data.fbp).toBe('fb.1.123.456');
  });

  // Contact details must never leave in the clear, and they must not leave at
  // all unless the caller passed them — which the route does only when the owner
  // has switched contact matching on.
  it('sends no contact information unless it is given some', () => {
    const e = capi.purchaseEvent({ orderNo: 'DG-1', value: 199 });
    expect(e.user_data.em).toBeUndefined();
    expect(e.user_data.ph).toBeUndefined();
  });

  it('hashes an email, lowercased and trimmed, never in the clear', () => {
    const e = capi.purchaseEvent({
      orderNo: 'DG-1',
      value: 199,
      contact: { email: '  Shira@Example.COM ' },
    });
    expect(e.user_data.em).toEqual([sha('shira@example.com')]);
    expect(JSON.stringify(e)).not.toContain('Shira@Example.COM');
    expect(JSON.stringify(e)).not.toContain('shira@example.com');
  });

  // '052-244-1334' and '+972 55 244 1334' are the same person to a human and to
  // Meta, but only if we normalise before hashing — a local number hashed as
  // typed can never match anything.
  it('normalises an Israeli phone to its international form before hashing', () => {
    const local = capi.purchaseEvent({
      orderNo: 'DG-1',
      value: 199,
      contact: { phone: '052-244-1334' },
    });
    const intl = capi.purchaseEvent({
      orderNo: 'DG-1',
      value: 199,
      contact: { phone: '+972 52 244 1334' },
    });
    expect(local.user_data.ph).toEqual([sha('972522441334')]);
    expect(local.user_data.ph).toEqual(intl.user_data.ph);
  });

  // Every shape a phone number actually arrives in. Each of these is the SAME
  // person, and a variant that normalises wrong hashes to something Meta can
  // never match — a silent failure nobody would notice for weeks.
  it('normalises every form of the same number to one hash', () => {
    const forms = [
      '052-244-1334',
      '0522441334',
      '+972 52 244 1334',
      '+972-052-244-1334',
      '00972522441334',
      '00972-052-2441334',
      '972522441334',
      '9720522441334',
      '522441334',
    ];
    for (const f of forms) expect([f, capi.normalisedPhone(f)]).toEqual([f, '972522441334']);
    for (const f of forms) expect(capi.hashedPhone(f)).toBe(sha('972522441334'));
  });

  it('leaves a number that is already international alone', () => {
    // A '00' prefix and a '+' both say "this is a full international number":
    // adding a country code to one produces a number that belongs to nobody.
    expect(capi.normalisedPhone('+1 (415) 555-0123')).toBe('14155550123');
    expect(capi.normalisedPhone('001 415 555 0123')).toBe('14155550123');
    expect(capi.normalisedPhone('')).toBe('');
    expect(capi.normalisedPhone('abc')).toBe('');
  });

  // Meta requires at least one customer-information parameter and refuses the
  // whole event without one. The buyer this feature exists for — pixel blocked,
  // no _fbc, no _fbp — is exactly the buyer who would otherwise send an empty
  // user_data and have the sale rejected.
  it('always carries a match key, even for a browser that gave Meta nothing', () => {
    const e = capi.purchaseEvent({ orderNo: 'DG-1', value: 199 });
    expect(Object.keys(e.user_data).length).toBeGreaterThan(0);
    expect(e.user_data.external_id).toEqual([sha('dg-1')]);
  });

  it('sends the buyer’s ip and browser, which a website event is required to carry', () => {
    const e = capi.purchaseEvent({
      orderNo: 'DG-1',
      value: 199,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (iPhone)',
      externalId: 'DG-1',
    });
    expect(e.user_data.client_ip_address).toBe('203.0.113.7');
    expect(e.user_data.client_user_agent).toBe('Mozilla/5.0 (iPhone)');
  });

  // A rebuilt _fbc stamped with the PURCHASE time claims a click that may be
  // days old was just observed, and disagrees with the _fbc the browser really
  // holds. The caller passes the earliest moment it can prove it saw the click.
  it('stamps a rebuilt click id with the click time, not the sale time', () => {
    const clickAt = 1_700_000_000_000;
    const e = capi.purchaseEvent({
      orderNo: 'DG-1',
      value: 199,
      landing: 'https://dugri-israel.co.il/?fbclid=IwAR_xyz',
      at: clickAt + 3 * 24 * 60 * 60 * 1000,
      clickAt,
    });
    expect(e.user_data.fbc).toBe(`fb.1.${clickAt}.IwAR_xyz`);
  });

  // Meta's own cookies are first-party on our domain, so the server can read
  // them straight off the buyer's request — which is what lets the sale be
  // reported from a payment callback, where no page exists to hand them over.
  it('reads Meta’s cookies off the request', () => {
    expect(capi.fbCookies('_fbp=fb.1.1.2; _fbc=fb.1.9.Click; other=x')).toEqual({
      fbp: 'fb.1.1.2',
      fbc: 'fb.1.9.Click',
    });
    expect(capi.fbCookies('session=abc')).toEqual({});
    expect(capi.fbCookies('')).toEqual({});
    expect(capi.fbCookies(undefined)).toEqual({});
    // Percent-encoded, as a browser may store it.
    expect(capi.fbCookies('_fbc=fb.1.9.a%2Bb').fbc).toBe('fb.1.9.a+b');
  });

  // THE OWNER TOKEN. collect.html is opened as ?c=<id>&k=<owner_token>, and that
  // token both reads and WRITES the order. Every URL this module is handed can
  // be that one, so every URL this module is handed loses its query string.
  it('reduces a page url to origin and path, dropping the query that holds the token', () => {
    expect(capi.pageUrl('https://dugri-israel.co.il/collect.html?c=abc&k=secret-token#frag')).toBe(
      'https://dugri-israel.co.il/collect.html'
    );
    expect(capi.pageUrl('https://dugri-israel.co.il/')).toBe('https://dugri-israel.co.il/');
    // Anything that is not an absolute http(s) url is not a page url.
    expect(capi.pageUrl('javascript:alert(1)')).toBe('');
    expect(capi.pageUrl('/collect.html?k=secret')).toBe('');
    expect(capi.pageUrl('')).toBe('');
  });

  it('takes the click id out of a landing url and leaves the rest behind', () => {
    const tokenised = 'https://dugri-israel.co.il/collect.html?c=abc&k=secret&fbclid=IwAR_9';
    expect(capi.fbclidFrom(tokenised)).toBe('IwAR_9');
    expect(capi.fbclidFrom('https://dugri-israel.co.il/?utm_source=newsletter')).toBe('');
    expect(capi.fbclidFrom('not a url')).toBe('');
  });

  it('never carries a landing url into the payload — only the click id from it', () => {
    const e = capi.purchaseEvent({
      orderNo: 'DG-1',
      value: 199,
      landing: 'https://dugri-israel.co.il/collect.html?c=abc&k=secret-token&fbclid=IwAR_9',
      at: 1_700_000_000_000,
    });
    expect(e.user_data.fbc).toBe('fb.1.1700000000000.IwAR_9');
    expect(JSON.stringify(e)).not.toContain('secret-token');
    expect(JSON.stringify(e)).not.toContain('k=');
  });

  it('drops an empty contact rather than hashing the empty string', () => {
    const e = capi.purchaseEvent({
      orderNo: 'DG-1',
      value: 199,
      contact: { email: '', phone: '' },
    });
    expect(e.user_data.em).toBeUndefined();
    expect(e.user_data.ph).toBeUndefined();
    expect(capi.hashed('  ')).toBeNull();
    expect(capi.hashedPhone('abc')).toBeNull();
  });
});

describe('sending', () => {
  const event = { event_name: 'Purchase', event_id: 'DG-1001' };

  it('sends nothing at all when it is not armed', async () => {
    const fetchImpl = vi.fn();
    const r = await capi.send({ pixelId: '', token: '', event, fetchImpl });
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the event to the pinned graph version with the token in the body', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ events_received: 1 }) }));
    const r = await capi.send({ pixelId: PIXEL, token: TOKEN, event, fetchImpl });
    expect(r).toMatchObject({ ok: true, received: 1 });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://graph.facebook.com/${capi.GRAPH_VERSION}/${PIXEL}/events`);
    const body = JSON.parse(opts.body);
    expect(body.data).toEqual([event]);
    expect(body.access_token).toBe(TOKEN);
    // No test code unless one was asked for: with one set, a real sale would
    // only ever reach the Test events tab.
    expect(body.test_event_code).toBeUndefined();
  });

  it('adds the test code when the owner is verifying the wiring', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    await capi.send({ pixelId: PIXEL, token: TOKEN, testCode: 'TEST123', event, fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).test_event_code).toBe('TEST123');
  });

  // The buyer is on their confirmation page. Whether Meta accepted the event is
  // no business of theirs, and must never become an error they can see.
  it('never throws — a refusal comes back as a result, with Meta’s own reason', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid parameter' } }),
    }));
    const r = await capi.send({ pixelId: PIXEL, token: TOKEN, event, fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 400, error: 'Invalid parameter' });
  });

  // THE CODE, not the status. Meta answers a plain 400 for an expired token and
  // for throttling alike, so the status on its own cannot tell a refusal from a
  // "later" — the caller needs the code, and can only have it if send() hands it
  // over.
  it('hands back Meta’s error code, not only the http status', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: 'Error validating access token: Session has expired',
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
        },
      }),
    }));
    const r = await capi.send({ pixelId: PIXEL, token: TOKEN, event, fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 400, code: 190, subcode: 463 });
    expect(r.type).toBe('OAuthException');
  });

  it('reports no code at all as 0 rather than as a guess', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => null,
    }));
    const r = await capi.send({ pixelId: PIXEL, token: TOKEN, event, fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 500, code: 0, subcode: 0, type: '' });
    expect(r.error).toBe('http 500');
  });

  it('never throws when the network does', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const r = await capi.send({ pixelId: PIXEL, token: TOKEN, event, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ENOTFOUND');
  });

  it('reports a timeout as a timeout, not as a mystery', async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const r = await capi.send({ pixelId: PIXEL, token: TOKEN, event, fetchImpl });
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
  });
});
