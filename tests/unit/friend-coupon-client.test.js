// @vitest-environment jsdom
//
// The browser half of the friend coupon: the landing note + the carried code
// (site/js/friend-coupon.js) and the email rule the sheet gates its button on
// (site/js/friend-bar.js). The bar and sheet themselves are driven end to end in
// tests/e2e/friend-coupon.spec.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

async function load() {
  vi.resetModules();
  return import('../../site/js/friend-coupon.js');
}

let events;
beforeEach(() => {
  events = [];
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('gtag', (...a) => events.push(a));
  window.history.replaceState({}, '', '/');
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('landing with ?coupon=', () => {
  it('remembers the code for the visit, says it is active, and tells GA only the type', async () => {
    window.history.replaceState({}, '', '/?coupon=noa5-k7q2&utm_source=coupon');
    const m = await load();
    expect(m.carriedCoupon()).toBe('NOA5-K7Q2');
    expect(sessionStorage.getItem('dugri:coupon')).toBe('NOA5-K7Q2');
    expect(document.querySelector('[data-testid="coupon-landing"]').textContent).toContain(
      'הקופון שלכם פעיל: 5% הנחה'
    );
    expect(events).toEqual([['event', 'coupon_landing', { coupon_type: 'friend' }]]);
  });

  it('reads the percent out of the code, not from a setting that may have moved', async () => {
    const m = await load();
    expect(m.percentInCode('DUGRI15-ABCD')).toBe(15);
    expect(m.percentInCode('SUMMER10')).toBe(null);
  });

  it('an owner coupon is carried too, without a percent it cannot know', async () => {
    window.history.replaceState({}, '', '/?coupon=summer10');
    const m = await load();
    expect(m.carriedCoupon()).toBe('SUMMER10');
    expect(document.body.textContent).toContain('הקופון שלכם פעיל');
    expect(document.body.textContent).not.toContain('%');
  });

  it('ignores junk in the URL', async () => {
    window.history.replaceState({}, '', '/?coupon=%3Cscript%3E');
    const m = await load();
    expect(m.carriedCoupon()).toBe(null);
    expect(events).toEqual([]);
  });

  it('still works for the page when storage is blocked (in-app browsers)', async () => {
    vi.stubGlobal('sessionStorage', throwingStorage());
    window.history.replaceState({}, '', '/?coupon=NOA5-K7Q2');
    const m = await load();
    expect(m.carriedCoupon()).toBe('NOA5-K7Q2');
    m.clearCarriedCoupon();
    expect(m.carriedCoupon()).toBe(null);
  });

  it('does nothing on a page without one', async () => {
    const m = await load();
    expect(m.carriedCoupon()).toBe(null);
    expect(document.body.innerHTML).toBe('');
  });
});

describe('the sheet’s email rule', () => {
  it('matches the server’s', async () => {
    vi.resetModules();
    const { isValidEmail } = await import('../../site/js/friend-bar.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const server = require('../../server/friend-coupons.js');
    for (const e of ['noa@x.co', ' Noa@Gmail.com ', 'noa@', 'noa@x', 'a b@x.co', '', 'x@y.co.il']) {
      expect(isValidEmail(e), e).toBe(server.isValidEmail(e));
    }
  });
});

describe('the bar and the on-screen keyboard', () => {
  it('steps aside while the visual viewport shrinks, and comes back after', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('requestAnimationFrame', (fn) => fn());
    const vv = new window.EventTarget();
    vv.height = 844;
    vi.stubGlobal('visualViewport', vv);
    window.visualViewport = vv;
    vi.resetModules();
    const { initFriendBar } = await import('../../site/js/friend-bar.js');
    const fetchImpl = async () => ({ ok: true, json: async () => ({ enabled: true, percent: 5 }) });
    const fb = initFriendBar({ collectionId: 'c1', fetchImpl });
    await fb.wordAdded();
    const bar = document.getElementById('friendBar');
    expect(bar.classList.contains('fb-in')).toBe(true);
    expect(bar.classList.contains('fb-aside')).toBe(false);
    vv.height = 480; // keyboard up
    vv.dispatchEvent(new Event('resize'));
    expect(bar.classList.contains('fb-aside')).toBe(true);
    vv.height = 844; // keyboard down
    vv.dispatchEvent(new Event('resize'));
    expect(bar.classList.contains('fb-aside')).toBe(false);
    delete window.visualViewport;
  });

  it('is a no-op on the browser that made the order, and only there', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('requestAnimationFrame', (fn) => fn());
    vi.resetModules();
    const { initFriendBar, markOwned } = await import('../../site/js/friend-bar.js');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ enabled: true, percent: 5 }),
    }));
    markOwned('c2');
    await initFriendBar({ collectionId: 'c2', fetchImpl }).wordAdded();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(document.getElementById('friendBar')).toBe(null);
    // Another party on the same browser is a friend's.
    await initFriendBar({ collectionId: 'c3', fetchImpl }).wordAdded();
    expect(document.getElementById('friendBar')).not.toBe(null);
    document.getElementById('friendBar').remove();
  });

  it('ignores the marker the first version left on every ?k= visitor', async () => {
    const ls = memoryStorage();
    ls.setItem('dugri:owned:c4', '1');
    vi.stubGlobal('localStorage', ls);
    vi.stubGlobal('requestAnimationFrame', (fn) => fn());
    vi.resetModules();
    const { initFriendBar } = await import('../../site/js/friend-bar.js');
    const fetchImpl = async () => ({ ok: true, json: async () => ({ enabled: true, percent: 5 }) });
    await initFriendBar({ collectionId: 'c4', fetchImpl }).wordAdded();
    expect(document.getElementById('friendBar')).not.toBe(null);
    document.getElementById('friendBar').remove();
  });
});
