// @vitest-environment jsdom
//
// GA on the occasion pages (/yom-huledet, ...): site/js/analytics.js reads the
// page's #occasion-data (slug + audience, written by server/occasions.js) and
// sends every event with `occasion`, plus the events the owner's reports key on:
// occasion_view, occasion_cta_click, faq_open with occasion, and on a company
// page (audience "business") business_lead_submit and whatsapp_click cta:business.
// Also the visit beacon that counts each occasion page (site/js/attribution.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function page({ slug = 'yom-huledet', audience = 'private', faq = true } = {}) {
  document.head.innerHTML = `<script type="application/json" id="occasion-data">${JSON.stringify({
    slug,
    audience,
    designs: ['birthday'],
  })}</script>`;
  document.body.innerHTML = `
    <a id="hero" href="#order" data-ga="order_started" data-ga-cta="hero">x</a>
    <a id="head" href="#order" data-ga="nav_order">x</a>
    <a id="menu" href="#order" data-ga="nav_order" data-ga-where="menu">x</a>
    <a id="wa" href="#wa" data-ga="whatsapp_click" data-ga-cta="designs">x</a>
    <a id="lead" href="#lead" data-ga="occasion_cta_click" data-ga-cta="hero">x</a>
    ${
      faq
        ? `<section id="faq"><div class="qa">
             <details><summary>כמה אנשים יכולים לשחק?</summary><p>a</p></details>
             <details><summary>מתי זה מגיע?</summary><p>b</p></details>
           </div></section>`
        : ''
    }`;
}

let calls;
// Every fresh import adds the module's delegated click listener to the document;
// the ones a test added are taken off again after it, so tests never hear each
// other's clicks.
const added = [];
async function load() {
  vi.resetModules();
  calls = [];
  window.gtag = (...a) => calls.push(a);
  globalThis.gtag = window.gtag;
  const real = document.addEventListener.bind(document);
  const spy = vi.spyOn(document, 'addEventListener').mockImplementation((t, fn, o) => {
    added.push([t, fn, o]);
    return real(t, fn, o);
  });
  try {
    return await import('../../site/js/analytics.js');
  } finally {
    spy.mockRestore();
  }
}
const events = () => calls.filter((c) => c[0] === 'event').map((c) => [c[1], c[2]]);

afterEach(() => {
  for (const [t, fn, o] of added.splice(0)) document.removeEventListener(t, fn, o);
  delete window.gtag;
  delete globalThis.gtag;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('occasionContext', () => {
  it('is the page’s slug and audience, and null off an occasion page', async () => {
    const { occasionContext } = await load();
    expect(occasionContext(document)).toBe(null);
    page({ audience: 'business', slug: 'asakim' });
    expect(occasionContext(document)).toEqual({ occasion: 'asakim', audience: 'business' });
    page({ audience: 'something' });
    expect(occasionContext(document).audience).toBe('private');
    document.head.innerHTML = '<script type="application/json" id="occasion-data">{nope</script>';
    expect(occasionContext(document)).toBe(null);
  });
});

describe('occasionEvents (pure)', () => {
  it('passes an event through untouched off an occasion page', async () => {
    const { occasionEvents } = await load();
    expect(occasionEvents('order_started', { cta: 'hero' }, null)).toEqual([
      ['order_started', { cta: 'hero' }],
    ]);
  });

  it('adds the occasion to every event, and an order button also sends occasion_cta_click', async () => {
    const { occasionEvents } = await load();
    const ctx = { occasion: 'yom-huledet', audience: 'private' };
    expect(occasionEvents('deck_deal', {}, ctx)).toEqual([
      ['deck_deal', { occasion: 'yom-huledet' }],
    ]);
    for (const cta of ['hero', 'steps', 'designs', 'faq', 'design_view'])
      expect(occasionEvents('order_started', { cta }, ctx)).toEqual([
        ['order_started', { cta, occasion: 'yom-huledet' }],
        ['occasion_cta_click', { occasion: 'yom-huledet', cta }],
      ]);
    expect(occasionEvents('nav_order', {}, ctx)[1]).toEqual([
      'occasion_cta_click',
      { occasion: 'yom-huledet', cta: 'header' },
    ]);
    expect(occasionEvents('nav_order', { where: 'menu' }, ctx)[1][1].cta).toBe('menu');
  });

  it('faq_open carries the occasion', async () => {
    const { occasionEvents } = await load();
    expect(
      occasionEvents(
        'faq_open',
        { question: 'q', position: 1 },
        { occasion: 'x', audience: 'private' }
      )
    ).toEqual([['faq_open', { question: 'q', position: 1, occasion: 'x' }]]);
  });

  it('a private page sends no business events', async () => {
    const { occasionEvents } = await load();
    const ctx = { occasion: 'yom-huledet', audience: 'private' };
    expect(occasionEvents('business_lead', {}, ctx)).toEqual([
      ['business_lead', { occasion: 'yom-huledet' }],
    ]);
    expect(occasionEvents('whatsapp_click', { cta: 'designs' }, ctx)).toEqual([
      ['whatsapp_click', { cta: 'designs', occasion: 'yom-huledet' }],
    ]);
  });

  it('a company page: the lead sends business_lead_submit, WhatsApp is cta business', async () => {
    const { occasionEvents } = await load();
    const ctx = { occasion: 'asakim', audience: 'business' };
    expect(occasionEvents('business_lead', {}, ctx)).toEqual([
      ['business_lead', { occasion: 'asakim' }],
      ['business_lead_submit', { occasion: 'asakim' }],
    ]);
    expect(occasionEvents('whatsapp_click', { cta: 'float' }, ctx)).toEqual([
      ['whatsapp_click', { cta: 'business', occasion: 'asakim', where: 'float' }],
    ]);
    // a place it already names is kept
    expect(occasionEvents('whatsapp_click', { cta: 'business', where: 'biz' }, ctx)).toEqual([
      ['whatsapp_click', { cta: 'business', where: 'biz', occasion: 'asakim' }],
    ]);
    // the company template's own lead buttons name the event themselves
    expect(occasionEvents('occasion_cta_click', { cta: 'hero' }, ctx)).toEqual([
      ['occasion_cta_click', { cta: 'hero', occasion: 'asakim' }],
    ]);
  });
});

describe('on a real (jsdom) occasion page', () => {
  it('sends occasion_view once, with the occasion and the audience', async () => {
    page();
    await load();
    expect(events().filter(([n]) => n === 'occasion_view')).toEqual([
      ['occasion_view', { audience: 'private', occasion: 'yom-huledet' }],
    ]);
  });

  it('sends nothing of the kind on any other page', async () => {
    document.body.innerHTML = '<a id="hero" data-ga="order_started" data-ga-cta="hero">x</a>';
    await load();
    document.getElementById('hero').click();
    expect(events()).toEqual([['order_started', { cta: 'hero' }]]);
  });

  it('every order button click also sends occasion_cta_click with its place', async () => {
    page();
    await load();
    calls.length = 0;
    for (const id of ['hero', 'head', 'menu']) document.getElementById(id).click();
    expect(events()).toEqual([
      ['order_started', { cta: 'hero', occasion: 'yom-huledet' }],
      ['occasion_cta_click', { occasion: 'yom-huledet', cta: 'hero' }],
      ['nav_order', { occasion: 'yom-huledet' }],
      ['occasion_cta_click', { occasion: 'yom-huledet', cta: 'header' }],
      ['nav_order', { where: 'menu', occasion: 'yom-huledet' }],
      ['occasion_cta_click', { occasion: 'yom-huledet', cta: 'menu' }],
    ]);
  });

  it('opening one of the page’s questions sends faq_open with the occasion', async () => {
    page();
    const mod = await load();
    mod.initOccasionPage(document); // already wired by the module's own call: no second listener
    calls.length = 0;
    const d = document.querySelectorAll('#faq details')[1];
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    expect(events()).toEqual([
      ['faq_open', { question: 'מתי זה מגיע?', position: 2, occasion: 'yom-huledet' }],
    ]);
  });

  it('a company page: WhatsApp is cta business, and the sent lead is business_lead_submit', async () => {
    page({ slug: 'asakim', audience: 'business' });
    const mod = await load();
    calls.length = 0;
    document.getElementById('wa').click();
    document.getElementById('lead').click();
    mod.track('business_lead', {}); // what js/home-new.js sends once the form is accepted
    expect(events()).toEqual([
      ['whatsapp_click', { cta: 'business', occasion: 'asakim', where: 'designs' }],
      ['occasion_cta_click', { cta: 'hero', occasion: 'asakim' }],
      ['business_lead', { occasion: 'asakim' }],
      ['business_lead_submit', { occasion: 'asakim' }],
    ]);
  });
});

// The visit beacon (site/js/attribution.js): an occasion page counts its own
// visit, once per session per page, even after the session's visit was counted.
describe('the occasion visit beacon', () => {
  function memoryStorage() {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
    };
  }
  let fetchMock;
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
    fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const visits = () =>
    fetchMock.mock.calls.filter((c) => c[0] === '/api/track').map((c) => JSON.parse(c[1].body));
  const attr = async () => {
    vi.resetModules();
    return import('../../site/js/attribution.js');
  };

  it('pageOccasion is the slug on an occasion page and empty elsewhere', async () => {
    const { pageOccasion } = await attr();
    expect(pageOccasion(document)).toBe('');
    page();
    expect(pageOccasion(document)).toBe('yom-huledet');
    page({ slug: '../evil' });
    expect(pageOccasion(document)).toBe('');
  });

  it('a home visit, then an occasion page, then the same page again: two beacons', async () => {
    const { trackVisit } = await attr();
    expect(trackVisit()).toBe(true); // the home page
    page();
    expect(trackVisit()).toBe(true); // /yom-huledet, same session
    expect(trackVisit()).toBe(false); // a reload of it
    page({ slug: 'yom-huledet-aba' });
    expect(trackVisit()).toBe(true); // another occasion page
    expect(visits().map((b) => b.occasion)).toEqual([undefined, 'yom-huledet', 'yom-huledet-aba']);
    expect(visits().every((b) => b.kind === 'visit')).toBe(true);
  });
});
