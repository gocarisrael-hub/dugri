// Unit tests for the buyer-facing FAQ reader/renderer (site/js/faq.js).
//
// Two properties matter here and nothing else really does:
//   1. FAIL-SOFT — index.html ships the four questions as real markup, so a
//      failed/slow/malformed /api/faq must leave the DOM untouched. A blank FAQ
//      section on the home page is a worse outcome than a stale one.
//   2. OWNER TEXT IS TEXT — an answer or a link the owner typed can never become
//      markup or a javascript: href, even though she is trusted and the server
//      already validated it on the way in.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchFaq,
  renderFaq,
  initFaq,
  isValidFaq,
  isSafeUrl,
  paragraphsOf,
} from '../../site/js/faq.js';

const GOOD = {
  items: [
    { id: 'a', q: 'שאלה ראשונה', a: 'תשובה ראשונה', link_text: '', link_url: '' },
    { id: 'b', q: 'שאלה שנייה', a: 'פסקה\n\nפסקה שנייה', link_text: 'להזמנה', link_url: '/x' },
  ],
};

function stub(body, { ok = true } = {}) {
  global.fetch = vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));
}

// The shipped markup: a <section> wrapping the container, exactly like index.html.
function shippedDom() {
  document.body.innerHTML = `
    <section id="faq">
      <div class="faq" id="faqList">
        <details><summary>שאלה שנשלחה עם העמוד</summary><p>תשובה שנשלחה עם העמוד</p></details>
      </div>
    </section>`;
  return document.getElementById('faqList');
}

describe('fetchFaq — validated + fail-safe', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns the live list with ok:true for a well-formed payload', async () => {
    stub(GOOD);
    const r = await fetchFaq();
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
  });

  it('reports ok:false on a non-2xx, a network error and a malformed body', async () => {
    stub(GOOD, { ok: false });
    expect((await fetchFaq()).ok).toBe(false);

    global.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    expect((await fetchFaq()).ok).toBe(false);

    for (const bad of [null, {}, { items: 'x' }, { items: [{ q: '', a: 'x' }] }]) {
      stub(bad);
      expect((await fetchFaq()).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('an EMPTY list is a VALID answer, not a failure (the owner cleared the FAQ)', async () => {
    stub({ items: [] });
    const r = await fetchFaq();
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([]);
  });

  it('is timeout-bounded — a hanging request resolves ok:false, it does not hang', async () => {
    global.fetch = vi.fn(
      (_u, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const r = await fetchFaq(10);
    expect(r.ok).toBe(false);
  });
});

describe('initFaq — the shipped questions stay unless we have something better', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('swaps in the owner list when the API answers', async () => {
    const el = shippedDom();
    stub(GOOD);
    const out = await initFaq(el);
    expect(out).toEqual({ ok: true, rendered: 2 });
    expect(el.querySelectorAll('details')).toHaveLength(2);
    expect(el.textContent).not.toContain('שאלה שנשלחה עם העמוד');
  });

  it('LEAVES the shipped markup when the API fails', async () => {
    const el = shippedDom();
    global.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const out = await initFaq(el);
    expect(out.ok).toBe(false);
    expect(el.textContent).toContain('שאלה שנשלחה עם העמוד');
    expect(el.querySelectorAll('details')).toHaveLength(1);
  });

  it('LEAVES the shipped markup when the payload is malformed', async () => {
    const el = shippedDom();
    stub({ items: [{ q: 'no answer', a: '' }] });
    expect((await initFaq(el)).ok).toBe(false);
    expect(el.textContent).toContain('תשובה שנשלחה עם העמוד');
  });

  it('hides the whole section for an explicitly EMPTY list', async () => {
    const el = shippedDom();
    stub({ items: [] });
    const out = await initFaq(el);
    expect(out).toEqual({ ok: true, rendered: 0 });
    expect(el.children).toHaveLength(0);
    expect(document.getElementById('faq').hidden).toBe(true);
  });

  it('does nothing (and does not throw) when the container is not on this page', async () => {
    stub(GOOD);
    await expect(initFaq(null)).resolves.toEqual({ ok: false, rendered: 0 });
  });
});

describe('renderFaq — owner text is TEXT, never markup', () => {
  it('renders a question and an answer as text content', () => {
    const el = shippedDom();
    renderFaq(el, GOOD.items);
    const first = el.querySelectorAll('details')[0];
    expect(first.querySelector('summary').textContent).toBe('שאלה ראשונה');
    expect(first.querySelector('p').textContent).toBe('תשובה ראשונה');
  });

  it('a blank line starts a new paragraph; a single newline does not', () => {
    const el = shippedDom();
    renderFaq(el, [{ id: 'x', q: 'ש', a: 'אחת\n\nשתיים\nהמשך', link_text: '', link_url: '' }]);
    const ps = el.querySelectorAll('details p');
    expect(ps).toHaveLength(2);
    expect(ps[1].textContent).toBe('שתיים המשך');
  });

  it('an <img onerror> in an answer is DISPLAYED, never executed', () => {
    const el = shippedDom();
    renderFaq(el, [
      {
        id: 'x',
        q: '<b>לא מודגש</b>',
        a: '<img src=x onerror="window.__pwned = true">',
        link_text: '',
        link_url: '',
      },
    ]);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('summary').textContent).toBe('<b>לא מודגש</b>');
    expect(el.querySelector('details p').textContent).toContain('onerror');
    expect(window.__pwned).toBeUndefined();
  });

  it('renders a safe link and DROPS an unsafe one (defence in depth behind the server)', () => {
    const el = shippedDom();
    renderFaq(el, [
      { id: 'ok', q: 'ש', a: 'ת', link_text: 'להזמנה', link_url: '/options.html' },
      { id: 'bad', q: 'ש', a: 'ת', link_text: 'לחצו', link_url: 'javascript:alert(1)' },
      { id: 'off', q: 'ש', a: 'ת', link_text: 'לחצו', link_url: '//evil.example' },
    ]);
    const links = el.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/options.html');
    expect(links[0].textContent).toBe('להזמנה');
  });

  it('re-showing a previously hidden section un-hides it', () => {
    const el = shippedDom();
    renderFaq(el, []);
    expect(document.getElementById('faq').hidden).toBe(true);
    renderFaq(el, GOOD.items);
    expect(document.getElementById('faq').hidden).toBe(false);
  });
});

describe('the small pure helpers', () => {
  it('isValidFaq requires a question and an answer on every item', () => {
    expect(isValidFaq(GOOD)).toBe(true);
    expect(isValidFaq({ items: [] })).toBe(true);
    expect(isValidFaq({ items: [{ q: 'x' }] })).toBe(false);
    expect(isValidFaq({})).toBe(false);
  });

  it('isSafeUrl mirrors the server allowlist', () => {
    expect(isSafeUrl('https://dugri.co.il')).toBe(true);
    expect(isSafeUrl('/options.html')).toBe(true);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('//evil.example')).toBe(false);
    expect(isSafeUrl('http://dugri.co.il')).toBe(false);
  });

  it('paragraphsOf drops empty runs and trims', () => {
    expect(paragraphsOf('  א  \n\n\n  ב  ')).toEqual(['א', 'ב']);
    expect(paragraphsOf('')).toEqual([]);
    expect(paragraphsOf(null)).toEqual([]);
  });
});
