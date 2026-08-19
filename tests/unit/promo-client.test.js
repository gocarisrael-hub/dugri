// Unit tests for the home-page "new game" renderer (site/js/promo.js).
//
// Three properties matter here:
//   1. NOTHING BY DEFAULT — a switched-off block, a failed fetch or a malformed
//      payload must leave the page exactly as it was. This section has no shipped
//      markup to fall back to, so "do nothing" is the whole fallback.
//   2. OWNER TEXT IS TEXT — a title, sub-title or alt the owner typed can never
//      become markup, and a button href is re-checked against the same allow-list
//      the server enforces.
//   3. POSITION — 'before' and 'after' land the section on the right side of the
//      designs rail, since that is the knob the owner actually flips.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildPromo, isValidPromo, initPromo } from '../../site/js/promo.js';

const PHOTO = '/content-uploads/0123456789abcdef.webp';
const promo = (over = {}) => ({
  position: 'before',
  background: 'sand',
  badge: 'חדש',
  title: 'משחק חדש',
  sub: '',
  photos: [],
  cta_text: 'לרכישה',
  cta_url: '/products.html',
  cta2: null,
  ...over,
});

function stub(body, { ok = true } = {}) {
  global.fetch = vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));
}

// The two neighbours the section is positioned against.
function page() {
  document.body.innerHTML =
    '<section id="about"></section><section id="products"></section><section id="reviews"></section>';
}

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
  document.body.innerHTML = '';
});

describe('isValidPromo', () => {
  it('accepts a null block — the normal, switched-off state', () => {
    expect(isValidPromo({ promo: null })).toBe(true);
  });
  it('accepts a block with a real title', () => {
    expect(isValidPromo({ promo: promo() })).toBe(true);
  });
  it('rejects a missing key, a bad envelope, and a title-less block', () => {
    expect(isValidPromo(null)).toBe(false);
    expect(isValidPromo({})).toBe(false);
    expect(isValidPromo({ promo: { title: '' } })).toBe(false);
    expect(isValidPromo({ promo: { title: '   ' } })).toBe(false);
  });
});

describe('buildPromo', () => {
  it('builds the section with the badge, title and sub-title paragraphs', () => {
    const sec = buildPromo(promo({ sub: 'פסקה\n\nפסקה שנייה' }));
    expect(sec.tagName).toBe('SECTION');
    expect(sec.id).toBe('newgame');
    expect(sec.querySelector('.promo-badge').textContent).toBe('חדש');
    expect(sec.querySelector('h2').textContent).toBe('משחק חדש');
    expect([...sec.querySelectorAll('.promo-head p')].map((p) => p.textContent)).toEqual([
      'פסקה',
      'פסקה שנייה',
    ]);
  });

  it('omits the badge when the owner left it empty', () => {
    expect(buildPromo(promo({ badge: '' })).querySelector('.promo-badge')).toBeNull();
    expect(buildPromo(promo({ badge: '  ' })).querySelector('.promo-badge')).toBeNull();
  });

  it('carries the sand wash by default and drops it on the white ground', () => {
    expect(buildPromo(promo()).className).toBe('alt');
    expect(buildPromo(promo({ background: 'white' })).className).toBe('');
  });

  it('never registers for the scroll reveal it would be too late for', () => {
    // The observer in index.html runs at load; this section arrives after a fetch,
    // so a data-reveal here would leave it invisible forever.
    expect(buildPromo(promo()).hasAttribute('data-reveal')).toBe(false);
  });

  it('sizes the photo grid by the number of photos and lazy-loads them', () => {
    const two = buildPromo(
      promo({
        photos: [
          { src: PHOTO, alt: 'א' },
          { src: PHOTO, alt: '' },
        ],
      })
    );
    const grid = two.querySelector('.promo-photos');
    expect(grid.dataset.count).toBe('2');
    const imgs = grid.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute('alt')).toBe('א');
    expect(imgs[1].getAttribute('alt')).toBe('');
    expect(imgs[0].getAttribute('loading')).toBe('lazy');
  });

  it('renders no grid at all when there are no photos', () => {
    expect(buildPromo(promo()).querySelector('.promo-photos')).toBeNull();
  });

  it('drops a photo that is not one of our own uploads', () => {
    const sec = buildPromo(
      promo({
        photos: [
          { src: 'https://evil.example/x.png', alt: '' },
          { src: PHOTO, alt: '' },
        ],
      })
    );
    const imgs = sec.querySelectorAll('.promo-photos img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe(PHOTO);
    expect(sec.querySelector('.promo-photos').dataset.count).toBe('1');
  });

  it('inserts owner text as text, never as markup', () => {
    const sec = buildPromo(
      promo({ title: '<img src=x onerror=alert(1)>', sub: '<script>alert(1)</script>' })
    );
    expect(sec.querySelector('h2').innerHTML).not.toContain('<img');
    expect(sec.querySelector('img')).toBeNull();
    expect(sec.querySelector('script')).toBeNull();
    expect(sec.querySelector('h2').textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('renders the primary button with the shared CTA analytics hooks', () => {
    const a = buildPromo(promo()).querySelector('.promo-cta a');
    expect(a.className).toBe('btn');
    expect(a.getAttribute('href')).toBe('/products.html');
    expect(a.dataset.ga).toBe('order_started');
    expect(a.dataset.gaCta).toBe('home-promo');
  });

  it('renders the second button as the ghost one, only when it is on', () => {
    const both = buildPromo(promo({ cta2: { text: 'איך משחקים', url: '/how.html' } }));
    const links = both.querySelectorAll('.promo-cta a');
    expect(links).toHaveLength(2);
    expect(links[1].className).toBe('btn ghost');
    expect(buildPromo(promo()).querySelectorAll('.promo-cta a')).toHaveLength(1);
  });

  it('drops a button whose href is not https:// or a same-site path', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.example']) {
      const sec = buildPromo(promo({ cta_url: url }));
      expect(sec.querySelector('.promo-cta')).toBeNull();
      expect(sec.querySelector('a')).toBeNull();
    }
  });
});

describe('initPromo', () => {
  it('inserts the section BEFORE the designs rail by default', async () => {
    page();
    stub({ promo: promo() });
    const sec = await initPromo();
    expect(sec).not.toBeNull();
    const ids = [...document.body.children].map((el) => el.id);
    expect(ids).toEqual(['about', 'newgame', 'products', 'reviews']);
  });

  it('inserts it AFTER the rail when the owner chose that position', async () => {
    page();
    stub({ promo: promo({ position: 'after' }) });
    await initPromo();
    const ids = [...document.body.children].map((el) => el.id);
    expect(ids).toEqual(['about', 'products', 'newgame', 'reviews']);
  });

  it('does nothing when the section is switched off', async () => {
    page();
    stub({ promo: null });
    expect(await initPromo()).toBeNull();
    expect(document.getElementById('newgame')).toBeNull();
  });

  it('does nothing on a non-2xx, a malformed payload, or a thrown fetch', async () => {
    for (const setup of [
      () => stub({ promo: promo() }, { ok: false }),
      () => stub({ promo: { title: '' } }),
      () => stub({ nope: true }),
      () => {
        global.fetch = vi.fn(() => Promise.reject(new Error('offline')));
      },
    ]) {
      page();
      setup();
      expect(await initPromo()).toBeNull();
      expect(document.getElementById('newgame')).toBeNull();
    }
  });

  it('does nothing on a page with no designs rail, and never fetches', async () => {
    document.body.innerHTML = '<section id="about"></section>';
    stub({ promo: promo() });
    expect(await initPromo()).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
