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

// The harsher case, and the common one on an ad click: site data is refused
// outright (Chrome's "block all cookies", a sandboxed webview, Firefox with
// dom.storage off) and reading the PROPERTY throws a SecurityError — there is no
// storage object to call a method on. Returns its own undo.
function blockStorageProperty(name) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error('SecurityError: access to storage is not allowed from this context');
    },
  });
  return () => {
    if (before) Object.defineProperty(globalThis, name, before);
    else delete globalThis[name];
  };
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

// An ad click lands in an in-app browser more often than not, and some of them
// refuse site data at the property: `window.localStorage` throws before any
// method is reached. Everything downstream of the call that throws is lost — the
// wizard's step change would stop before it painted the checkout summary, and the
// confirmation page before it filled in the order number. A measurement must
// never be able to do that.
describe('a browser that refuses site data outright', () => {
  let undo = [];
  afterEach(() => {
    while (undo.length) undo.pop()();
  });

  it('still measures, and never throws into the page that called it', async () => {
    setUrl('http://localhost/?utm_campaign=rovakot');
    const mod = await load();
    undo.push(blockStorageProperty('localStorage'));
    undo.push(blockStorageProperty('sessionStorage'));

    expect(() => mod.visitorId()).not.toThrow();
    expect(() => mod.currentTouch(location.href, '')).not.toThrow();
    await expect(mod.sendEvent('checkout')).resolves.toBe(true);
    expect(lastBody().landing).toContain('utm_campaign=rovakot');
    expect(lastBody().visitor).toBeTruthy();
    expect(() => mod.trackVisit()).not.toThrow();
  });

  it('reports the campaign even when nothing can be remembered', async () => {
    setUrl('http://localhost/?utm_source=instagram&utm_medium=paid');
    const mod = await load();
    undo.push(blockStorageProperty('localStorage'));
    undo.push(blockStorageProperty('sessionStorage'));
    expect(mod.trackVisit()).toBe(true);
    expect(lastBody().kind).toBe('visit');
    expect(lastBody().landing).toContain('utm_source=instagram');
  });
});

// Last non-direct touch replaces the stored campaign on any tagged arrival. If
// the VISIT is only ever counted once per session, the second ad gets the order
// and none of the traffic: its row reads "1 order, 0 visits, conversion —" while
// the first source keeps a visit that did not convert. Both halves are wrong, and
// Ads Manager — the thing this report exists to be compared against — counts that
// second click.
describe('a second campaign in the same session', () => {
  it('counts a visit for the ad that took the credit', async () => {
    setUrl('http://localhost/?utm_source=google&utm_medium=organic');
    const mod = await load();
    expect(mod.trackVisit()).toBe(true);
    expect(lastBody().landing).toContain('utm_source=google');

    // Same tab, later: the visitor clicks an Instagram ad.
    setUrl('http://localhost/?utm_source=instagram&utm_medium=paid&utm_campaign=rovakot');
    expect(mod.trackVisit()).toBe(true);
    expect(lastBody().landing).toContain('utm_campaign=rovakot');
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/track')).toHaveLength(2);
  });

  it('does not count the same ad link twice when the page is reloaded', async () => {
    setUrl('http://localhost/?utm_source=instagram&utm_campaign=rovakot');
    const mod = await load();
    expect(mod.trackVisit()).toBe(true);
    expect(mod.trackVisit()).toBe(false);
    // And an ordinary page deeper into the site is not a new arrival either.
    setUrl('http://localhost/options.html?step=4');
    expect(mod.trackVisit()).toBe(false);
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/track')).toHaveLength(1);
  });

  // A page rewrites its own address constantly, and none of it is an arrival.
  // options.html rebuilds location.href and appends its wizard state on every
  // step, an in-page link adds a #fragment, and parameters do not always come
  // back in the order they were sent. A mark that is the href counts a visit for
  // each of those; the mark is the campaign, so none of them count.
  it('is not fooled by the page rewriting its own URL', async () => {
    const ad = '?utm_source=instagram&utm_medium=paid&utm_campaign=rovakot&fbclid=abc';
    setUrl('http://localhost/' + ad);
    const mod = await load();
    expect(mod.trackVisit()).toBe(true);

    for (const href of [
      'http://localhost/' + ad + '#faq', // an in-page anchor
      'http://localhost/options.html' + ad + '&plan=&design=&color=&step=4', // the wizard
      'http://localhost/?fbclid=abc&utm_campaign=rovakot&utm_medium=paid&utm_source=instagram',
    ]) {
      setUrl(href);
      expect(mod.trackVisit()).toBe(false);
    }
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/track')).toHaveLength(1);
  });

  // The one case that DOES count again, on purpose: Meta issues a fresh fbclid
  // per click, so the same ad clicked a second time is a second click — which is
  // what Ads Manager will be showing on the other screen.
  it('counts a genuine second click on the same ad', async () => {
    setUrl('http://localhost/?utm_source=instagram&utm_campaign=rovakot&fbclid=click1');
    const mod = await load();
    expect(mod.trackVisit()).toBe(true);
    setUrl('http://localhost/?utm_source=instagram&utm_campaign=rovakot&fbclid=click2');
    expect(mod.trackVisit()).toBe(true);
  });
});

describe('campaignKey', () => {
  it('is the campaign parameters and nothing else about the address', async () => {
    const { campaignKey } = await load();
    const key = campaignKey('https://dugri-israel.co.il/?utm_source=ig&utm_campaign=rovakot');
    expect(key).toBe(
      campaignKey('https://dugri-israel.co.il/options.html?utm_campaign=rovakot&utm_source=ig#x')
    );
    expect(key).not.toBe(campaignKey('https://dugri-israel.co.il/?utm_source=ig&utm_campaign=x'));
    expect(campaignKey('https://dugri-israel.co.il/?step=4')).toBe('');
    expect(campaignKey('nonsense')).toBe('');
  });
});

// TWO OF OUR OWN PAGES CARRY A CREDENTIAL IN THE ADDRESS BAR.
// collect.html?c=<id>&k=<owner token> and pay-success.html?c=&k= are both
// buyer-facing pages that load this module, and that token is write access to
// the order: the delivery address, what she was charged, and the routes that
// change the order, cancel the payment, edit the word list or close the
// collection. A landing URL is stored and then replayed with every later event,
// so an unfiltered href would put the token in localStorage and in every request
// body from then on — and anything downstream that persists or forwards these
// fields (an ad platform's event_source_url, say) would carry it further.
describe('a measurement never carries a credential', () => {
  const TOKENS = '?c=8f6b2c1e-3f1a-4f0e-9a2b-000000000001&k=3c9e77aa-1d55-4a90-b0b1-000000000002';
  const seen = () =>
    JSON.stringify(fetchMock.mock.calls) + (localStorage.getItem('dugri_attr') || '');

  it('strips the order token out of what it sends and what it stores', async () => {
    setUrl('http://localhost/collect.html' + TOKENS + '&utm_source=instagram&utm_medium=paid');
    const mod = await load();
    await mod.sendEvent('visit');

    const body = lastBody();
    // The campaign still gets through — that is the whole point of the field.
    expect(body.landing).toContain('utm_source=instagram');
    expect(body.landing).toContain('utm_medium=paid');
    expect(body.landing).toContain('/collect.html');
    // And the credential does not, anywhere.
    for (const secret of ['3c9e77aa', '8f6b2c1e', 'k=', 'c=']) {
      expect(body.landing).not.toContain(secret);
    }
    expect(seen()).not.toContain('3c9e77aa');
    expect(seen()).not.toContain('8f6b2c1e');
    // Including the copy kept in the browser for the rest of the funnel.
    const stored = JSON.parse(localStorage.getItem('dugri_attr'));
    expect(stored.landing).toContain('utm_source=instagram');
    expect(stored.landing).not.toContain('k=');
  });

  it('drops the fragment and every parameter that is not a campaign', async () => {
    setUrl('http://localhost/options.html?utm_campaign=rovakot&plan=premium&step=4#pay');
    const mod = await load();
    const touch = mod.currentTouch(location.href, '');
    expect(touch.landing).toBe(location.origin + '/options.html?utm_campaign=rovakot');
  });

  // A buyer who moves on from the collection page hands the NEXT page that
  // tokenised address as its referrer, so the referrer is the same leak.
  it('strips the referrer too', async () => {
    setUrl('http://localhost/');
    const mod = await load();
    const referrer = 'http://localhost/collect.html' + TOKENS;
    const touch = mod.currentTouch(location.href, referrer);
    expect(touch.referrer).toBe('http://localhost/collect.html');
    expect(seen()).not.toContain('3c9e77aa');
  });

  // A value written by an earlier version of this file is still sitting in real
  // browsers, and it gets replayed with every event until it is replaced.
  it('sanitises a tokenised touch that was stored before this rule existed', async () => {
    const mod = await load();
    localStorage.setItem(
      'dugri_attr',
      JSON.stringify({
        landing: 'http://localhost/collect.html' + TOKENS + '&utm_campaign=rovakot',
        referrer: 'http://localhost/pay-success.html' + TOKENS,
      })
    );
    setUrl('http://localhost/how.html');
    await mod.sendEvent('visit');
    expect(lastBody().landing).toContain('utm_campaign=rovakot');
    expect(seen()).not.toContain('3c9e77aa');
    expect(seen()).not.toContain('8f6b2c1e');
  });

  it('keeps the ad parameter the server reads as a fallback for the creative', async () => {
    setUrl('http://localhost/?utm_source=ig&utm_ad=reel_03');
    const mod = await load();
    const touch = mod.currentTouch(location.href, '');
    expect(touch.landing).toContain('utm_ad=reel_03');
  });
});
