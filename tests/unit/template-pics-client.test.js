import { describe, it, expect, beforeEach } from 'vitest';

// The page side of server/template-pics.js: loadCustomDesigns (site/js/designs.js) keeps a custom design's `pics` only
// when every URL is one of ours, and registers them so srcsetFor(<template-image url>) (site/js/design-images.js) hands
// every surface the WebP ladder in place of the multi-megabyte SVG. The SVG stays the `src`.
import { loadCustomDesigns } from '../../site/js/designs.js';
import { srcsetFor, registerTemplatePics, galleryFor } from '../../site/js/design-images.js';
import { homeDesigns, cardSrcset, pictureFallback } from '../../site/js/home-data.js';

const REV = '0123456789abcdef';
const ladder = (slug, role, widths) => ({
  src: `/template-pics/${slug}/${REV}/${role}-${widths[0]}.webp`,
  srcset: widths.map((w) => `/template-pics/${slug}/${REV}/${role}-${w}.webp ${w}w`).join(', '),
});
const fetchWith = (designs) => async () => ({ ok: true, json: async () => ({ designs }) });
const tarifa = (extra = {}) => ({
  id: 'tarifa',
  name: 'טריפה',
  img: {
    front: '/api/template-image/tarifa/front',
    back: '/api/template-image/tarifa/back',
    board: '/api/template-image/tarifa/board',
  },
  ...extra,
});

beforeEach(() => registerTemplatePics([]));

describe('template pictures on the page', () => {
  it('a design with `pics` gets its ladder through srcsetFor, for every picture it has', async () => {
    const pics = {
      front: ladder('tarifa', 'front', [400, 800, 1200]),
      back: ladder('tarifa', 'back', [400, 800, 1200]),
      board: ladder('tarifa', 'board', [800, 1400, 2000]),
    };
    const [d] = await loadCustomDesigns({ fetchImpl: fetchWith([tarifa({ pics })]) });
    expect(d.pics).toEqual(pics);
    expect(srcsetFor('/api/template-image/tarifa/front')).toBe(pics.front.srcset);
    expect(srcsetFor('/api/template-image/tarifa/board')).toBe(pics.board.srcset);
    // the gallery's shot is still the SVG — the src a browser falls back to — and the ladder rides along with it
    const [shot] = galleryFor({}, d, 'products');
    expect(shot.src).toBe('/api/template-image/tarifa/front');
    expect(srcsetFor(shot.src)).toMatch(/front-800\.webp 800w/);
  });

  it('a design without `pics` (not rendered yet) keeps the plain SVG', async () => {
    await loadCustomDesigns({ fetchImpl: fetchWith([tarifa()]) });
    expect(srcsetFor('/api/template-image/tarifa/front')).toBe('');
  });

  it('drops a ladder that names anything but our own /template-pics/ files', async () => {
    const bad = {
      front: {
        src: 'https://evil.example/front-400.webp',
        srcset: 'https://evil.example/front-400.webp 400w',
      },
      back: {
        src: `/template-pics/tarifa/${REV}/back-400.webp`,
        srcset: `/template-pics/tarifa/${REV}/back-400.webp 400w, //evil.example/x.webp 800w`,
      },
      board: { src: `/home-art/tarifa/${REV}/board-800.webp`, srcset: '' },
    };
    const [d] = await loadCustomDesigns({ fetchImpl: fetchWith([tarifa({ pics: bad })]) });
    expect(d.pics).toBeNull();
    for (const slot of ['front', 'back', 'board'])
      expect(srcsetFor(`/api/template-image/tarifa/${slot}`)).toBe('');
  });

  it('a newer load replaces the ladders: a new rev is what the page asks for', async () => {
    await loadCustomDesigns({
      fetchImpl: fetchWith([tarifa({ pics: { front: ladder('tarifa', 'front', [400]) } })]),
    });
    const NEW = 'fedcba9876543210';
    const front = {
      src: `/template-pics/tarifa/${NEW}/front-400.webp`,
      srcset: `/template-pics/tarifa/${NEW}/front-400.webp 400w`,
    };
    await loadCustomDesigns({ fetchImpl: fetchWith([tarifa({ pics: { front } })]) });
    expect(srcsetFor('/api/template-image/tarifa/front')).toBe(front.srcset);
  });

  it('only a template-image URL is looked up; an upload still reads the gallery manifest', () => {
    registerTemplatePics([
      {
        img: { front: '/api/template-image/x/front' },
        pics: { front: ladder('x', 'front', [400]) },
      },
    ]);
    expect(srcsetFor('/api/template-image/x/front')).toContain('/template-pics/x/');
    expect(srcsetFor('/api/template-image/x/front?y')).toBe('');
    expect(srcsetFor('/content-uploads/aaaaaaaaaaaaaaaa.png')).toBe('');
  });
});

describe('template pictures on the homepage (new.html, the occasion pages)', () => {
  // a design with no hand-cut homepage art (site/js/home-data.js DESIGN_ART), whose card is otherwise its SVG
  const custom = (extra) => ({
    id: 'brand-new',
    name: 'חדש',
    custom: true,
    public: true,
    img: {
      front: '/api/template-image/brand-new/front',
      back: '/api/template-image/brand-new/back',
    },
    ...extra,
  });
  const pics = { front: ladder('brand-new', 'front', [400, 800]) };

  it('shows the ladder while the generator render does not exist yet, the SVG still behind it', () => {
    const [d] = homeDesigns([custom({ pics, home: null })]);
    expect(d.fronts).toEqual([pics.front.src]);
    expect(cardSrcset(pics.front.src)).toBe(pics.front.srcset);
    expect(pictureFallback(pics.front.src)).toBe('/api/template-image/brand-new/front');
    // a role with no ladder keeps its SVG
    expect(d.back).toBe('/api/template-image/brand-new/back');
  });

  it('the generator render wins once it exists', () => {
    const home = { front: { src: `/home-art/brand-new/${REV}/front-400.webp`, srcset: '' } };
    const [d] = homeDesigns([custom({ pics, home })]);
    expect(d.fronts).toEqual([home.front.src]);
  });

  it('never replaces a hand-cut homepage picture (tarifa has one)', () => {
    const tPics = { front: ladder('tarifa', 'front', [400, 800]) };
    const [d] = homeDesigns([{ ...tarifa(), custom: true, public: true, pics: tPics }]);
    expect(d.fronts[0]).toMatch(/^assets\/home\/cards\/tarifa-f1\.webp$/);
  });
});
