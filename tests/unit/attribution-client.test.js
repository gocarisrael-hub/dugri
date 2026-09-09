// @vitest-environment jsdom
//
// The browser half (site/js/attribution.js). Its whole job is to REMEMBER the ad
// a visitor arrived on, so a purchase two pages later can still be credited to
// it. The tests are about that memory: what replaces it, what must not, and that
// a browser which refuses to store anything still measures the visit.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function load() {
  vi.resetModules();
  return import('../../site/js/attribution.js');
}

function setUrl(href) {
  window.history.replaceState({}, '', href.replace('http://localhost', ''));
}

// jsdom under this Node exposes no window.localStorage (the global is Node's own
// experimental one, which has no Storage methods), so the tests bring their own.
// It is a faithful stand-in for what the module actually uses: get, set, throw.
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}
function throwingStorage() {
  const boom = () => {
    throw new Error('blocked');
  };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom };
}

let fetchMock;
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  setUrl('http://localhost/');
  Object.defineProperty(document, 'referrer', { value: '', configurable: true });
  fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const lastBody = () => JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);

describe('recognising a campaign arrival', () => {
  it('spots every parameter an ad platform might use, and nothing else', async () => {
    const { isTagged } = await load();
    for (const q of ['utm_source=ig', 'utm_campaign=x', 'fbclid=abc', 'igshid=abc', 'gclid=abc']) {
      expect(isTagged('https://dugri-israel.co.il/?' + q)).toBe(true);
    }
    expect(isTagged('https://dugri-israel.co.il/?step=3')).toBe(false);
    expect(isTagged('nonsense')).toBe(false);
  });
});

describe('the remembered touch', () => {
  it('keeps the ad through later untagged pages', async () => {
    const { currentTouch } = await load();
    currentTouch('https://dugri-israel.co.il/?utm_source=instagram&utm_campaign=rovakot', '');
    // Two pages deeper into the wizard, no parameters left on the URL.
    const later = currentTouch('https://dugri-israel.co.il/options.html?step=4', '');
    expect(later.landing).toContain('utm_campaign=rovakot');
  });

  // Last non-direct touch: a SECOND ad takes the credit, because that is the
  // model Ads Manager uses and the two numbers have to be comparable.
  it('hands the credit to a newer campaign', async () => {
    const { currentTouch } = await load();
    currentTouch('https://dugri-israel.co.il/?utm_campaign=first', '');
    const second = currentTouch('https://dugri-israel.co.il/?utm_campaign=second', '');
    expect(second.landing).toContain('utm_campaign=second');
    expect(currentTouch('https://dugri-israel.co.il/how.html', '').landing).toContain('second');
  });

  // An untagged first arrival still has ONE piece of evidence — where the click
  // came from — and it is what separates Instagram-profile traffic from direct.
  // It is captured on that first page and kept for the rest of the funnel.
  it('remembers the referrer of a first, untagged arrival', async () => {
    Object.defineProperty(document, 'referrer', {
      value: 'https://l.instagram.com/',
      configurable: true,
    });
    const { currentTouch } = await load();
    currentTouch('https://dugri-israel.co.il/', document.referrer); // the arrival
    // Two pages later, with no referrer of its own to offer.
    const later = currentTouch('https://dugri-israel.co.il/options.html?step=2', '');
    expect(later.referrer).toBe('https://l.instagram.com/');
  });
});

describe('sending events', () => {
  it('posts the landing URL and a stable visitor id to our own endpoint', async () => {
    setUrl('http://localhost/?utm_source=instagram&utm_medium=paid&utm_campaign=rovakot');
    const { sendEvent, visitorId } = await load();
    await sendEvent('checkout');
    const [url, opts] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(url).toBe('/api/track');
    expect(opts.method).toBe('POST');
    // keepalive is what lets the beacon outlive the click that navigates away.
    expect(opts.keepalive).toBe(true);
    const body = lastBody();
    expect(body.kind).toBe('checkout');
    expect(body.landing).toContain('utm_campaign=rovakot');
    expect(body.visitor).toBe(visitorId());
  });

  it('sends one visit per session, not one per page', async () => {
    const mod = await load();
    expect(mod.trackVisit()).toBe(true);
    // The next page of the same browse: the session flag is already set.
    expect(mod.trackVisit()).toBe(false);
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/track')).toHaveLength(1);
  });

  // The beacon must never race the page it is measuring. An ad click lands on a
  // phone over mobile data, and this request has no business competing with the
  // fonts and the first picture.
  it('waits for the page to finish loading before it measures anything', async () => {
    vi.useFakeTimers();
    const mod = await load();
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/track')).toHaveLength(0);
    mod.scheduleVisit();
    vi.runAllTimers();
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/track')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('never lets a measurement failure reach the page', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { sendEvent } = await load();
    await expect(sendEvent('visit')).resolves.toBe(false);
  });

  // An ad click very often opens in an in-app browser, and some of them throw on
  // every storage access. Losing the link between two page views is acceptable;
  // a thrown error on the buyer's first screen is not.
  it('still measures when storage is blocked entirely', async () => {
    vi.stubGlobal('localStorage', throwingStorage());
    vi.stubGlobal('sessionStorage', throwingStorage());
    setUrl('http://localhost/?utm_campaign=rovakot');
    const { sendEvent } = await load();
    await expect(sendEvent('visit')).resolves.toBe(true);
    expect(lastBody().landing).toContain('utm_campaign=rovakot');
    expect(lastBody().visitor).toBeTruthy();
  });
});
