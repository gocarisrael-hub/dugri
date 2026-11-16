// @vitest-environment node
// An occasion page's designs (site/js/home-data.js occasionDesigns, used by home-new.js on occasion.html): the page's designs
// first, the deck dealing only those, and every design's order link carrying the occasion so options.html can count it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDesigns, occasionDesigns, DESIGN_ART, NOT_DEALT } from '../../site/js/home-data.js';
import { PUBLIC_DESIGNS } from '../../site/js/designs.js';

const DATA = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'server',
  'occasions'
);
const page = (slug) => JSON.parse(fs.readFileSync(path.join(DATA, `${slug}.json`), 'utf8'));
// what /api/custom-designs sends for the owner's uploaded designs, after loadCustomDesigns() (site/js/designs.js)
const custom = (id) => ({
  id,
  name: id,
  custom: true,
  public: true,
  img: {
    front: `/api/template-image/${id}/front`,
    back: `/api/template-image/${id}/back`,
    board: `/api/template-image/${id}/board`,
  },
});
const CUSTOM = ['daniel-amit', 'grapefruit', 'football-boys'];
const withCustom = homeDesigns([...PUBLIC_DESIGNS, ...CUSTOM.map(custom)]);

const base = homeDesigns(PUBLIC_DESIGNS);

describe('occasionDesigns', () => {
  it('leaves the home page as it is', () => {
    expect(occasionDesigns(base, null)).toBe(base);
  });

  it("puts the page's designs first, in its order, and keeps the rest after", () => {
    const out = occasionDesigns(base, { slug: 'yom-huledet', designs: ['marriage', 'birthday'] });
    expect(out.map((d) => d.id).slice(0, 2)).toEqual(['marriage', 'birthday']);
    expect(out.map((d) => d.id).sort()).toEqual(base.map((d) => d.id).sort());
    // the rest keep the home page's order
    const rest = base.map((d) => d.id).filter((id) => id !== 'marriage' && id !== 'birthday');
    expect(out.map((d) => d.id).slice(2)).toEqual(rest);
  });

  it("deals only the page's designs", () => {
    const out = occasionDesigns(base, { slug: 'yom-huledet', designs: ['marriage', 'birthday'] });
    expect(out.filter((d) => d.deal).map((d) => d.id)).toEqual(['marriage', 'birthday']);
  });

  it('deals every design when none of the listed ones can be dealt', () => {
    const out = occasionDesigns(base, { slug: 'x', designs: ['kids', 'no-such-design'] });
    expect(out.filter((d) => d.deal).map((d) => d.id)).toEqual(
      base.filter((d) => d.deal).map((d) => d.id)
    );
  });

  it('every order link carries the occasion', () => {
    const out = occasionDesigns(base, { slug: 'yom-huledet', designs: ['birthday'] });
    for (const d of out)
      expect(d.href).toMatch(/^options\.html\?design=[^&]+&step=2&occasion=yom-huledet$/);
  });

  // pages 2-4: the agent's picks from the live designs, for the owner to change in the data files
  describe('pages 2-4', () => {
    const LISTS = {
      'mesibat-ravakot': ['bachelorette', 'daniel-amit', 'tarifa', 'birthday', 'grapefruit'],
      'tiyul-mishpachti-lechul': ['posttrip', 'marriage', 'grapefruit', 'tarifa', 'birthday'],
      pensia: ['japanese', 'marriage', 'grapefruit', 'posttrip'],
    };
    const ALL_CUSTOM = homeDesigns([
      ...PUBLIC_DESIGNS,
      ...['daniel-amit', 'grapefruit', 'football-boys', 'tarifa'].map(custom),
    ]);

    for (const [slug, list] of Object.entries(LISTS)) {
      it(`/${slug} lists 3-5 designs with art, deals its built-ins first, then all of them`, () => {
        expect(page(slug).designs).toEqual(list);
        expect(list.length).toBeGreaterThanOrEqual(3);
        expect(list.length).toBeLessThanOrEqual(5);
        for (const id of list) expect(DESIGN_ART[id], id).toBeTruthy();
        const builtIn = list.filter((id) => PUBLIC_DESIGNS.some((d) => d.id === id));
        expect(builtIn.length).toBeGreaterThan(0);
        // first paint: only the listed built-ins are dealt
        const first = occasionDesigns(base, page(slug));
        expect(first.filter((d) => d.deal).map((d) => d.id)).toEqual(builtIn);
        // with the custom designs in: the strip starts with the list, every one dealt
        const later = occasionDesigns(ALL_CUSTOM, page(slug));
        expect(later.map((d) => d.id).slice(0, list.length)).toEqual(list);
        expect(later.filter((d) => d.deal).map((d) => d.id)).toEqual(list);
      });
    }
  });

  // page 14: the live חנוכה custom design first. It has no DESIGN_ART entry (no hand-cut art in the repo): it is drawn from
  // the server's render of its template, as /api/custom-designs sends it on production (img with no back; home renders)
  describe('page 14, /chag-mishpachti', () => {
    const LIST = ['hanuka', 'marriage', 'birthday', 'grapefruit', 'posttrip'];
    const render = (role) => ({
      src: `/home-art/hanuka/27c4ddbef62c1f4a/${role}-400.webp`,
      srcset: `/home-art/hanuka/27c4ddbef62c1f4a/${role}-400.webp 400w`,
    });
    const hanuka = {
      id: 'hanuka',
      name: 'חנוכה',
      custom: true,
      public: true,
      accent: null,
      img: { front: '/api/template-image/hanuka/front', board: '/api/template-image/hanuka/board' },
      home: { front: render('front'), back: render('back'), board: render('board') },
    };

    it('leads with hanuka, which shows and is dealt from its render once the custom designs arrive', () => {
      expect(page('chag-mishpachti').designs).toEqual(LIST);
      expect(DESIGN_ART.hanuka).toBeUndefined();
      for (const id of LIST.slice(1)) expect(DESIGN_ART[id], id).toBeTruthy();
      // first paint: hanuka has not arrived, the listed built-ins are dealt
      const builtIn = LIST.filter((id) => PUBLIC_DESIGNS.some((d) => d.id === id));
      expect(builtIn.length).toBeGreaterThan(0);
      const first = occasionDesigns(base, page('chag-mishpachti'));
      expect(first.filter((d) => d.deal).map((d) => d.id)).toEqual(builtIn);
      // then: hanuka first, drawn from its renders, dealt with the rest of the list
      const later = occasionDesigns(
        homeDesigns([...PUBLIC_DESIGNS, custom('grapefruit'), hanuka]),
        page('chag-mishpachti')
      );
      expect(later.map((d) => d.id).slice(0, LIST.length)).toEqual(LIST);
      expect(later.filter((d) => d.deal).map((d) => d.id)).toEqual(LIST);
      const h = later[0];
      expect(h.fronts).toEqual([render('front').src]);
      expect(h.back).toBe(render('back').src);
      expect(h.board.src).toBe(render('board').src);
      expect(h.href).toBe('options.html?design=hanuka&step=2&occasion=chag-mishpachti');
    });

    it('a server with no render of it still shows its template card, undealt (no back to deal)', () => {
      const bare = { ...hanuka, home: undefined };
      const out = occasionDesigns(homeDesigns([...PUBLIC_DESIGNS, bare]), page('chag-mishpachti'));
      expect(out[0].id).toBe('hanuka');
      expect(out[0].fronts).toEqual(['/api/template-image/hanuka/front']);
      expect(out[0].deal).toBe(false);
    });
  });

  describe("the owner's lists", () => {
    const MOM = ['daniel-amit', 'birthday', 'grapefruit', 'marriage', 'bachelorette'];
    const DAD = ['japanese', 'kids', 'football-boys', 'posttrip'];

    it('the data files carry them, in her order', () => {
      expect(page('yom-huledet').designs).toEqual(MOM);
      expect(page('yom-huledet-aba').designs).toEqual(DAD);
    });

    it('every listed design has art the page can draw before the volume answers', () => {
      for (const id of [...MOM, ...DAD]) expect(DESIGN_ART[id], id).toBeTruthy();
    });

    it('before the custom designs arrive the deck deals the listed built-ins only, never an empty or unrelated deck', () => {
      const mom = occasionDesigns(base, page('yom-huledet'));
      expect(mom.filter((d) => d.deal).map((d) => d.id)).toEqual([
        'birthday',
        'marriage',
        'bachelorette',
      ]);
      expect(mom.map((d) => d.id).slice(0, 3)).toEqual(['birthday', 'marriage', 'bachelorette']);
      const dad = occasionDesigns(base, page('yom-huledet-aba'));
      expect(dad.filter((d) => d.deal).map((d) => d.id)).toEqual(['japanese', 'posttrip']);
      expect(dad.map((d) => d.id).slice(0, 3)).toEqual(['japanese', 'kids', 'posttrip']);
    });

    it('once they arrive the strip starts with her list and the deck deals every listed custom design', () => {
      const mom = occasionDesigns(withCustom, page('yom-huledet'));
      expect(mom.map((d) => d.id).slice(0, MOM.length)).toEqual(MOM);
      expect(mom.filter((d) => d.deal).map((d) => d.id)).toEqual(MOM);
      const dad = occasionDesigns(withCustom, page('yom-huledet-aba'));
      expect(dad.map((d) => d.id).slice(0, DAD.length)).toEqual(DAD);
      // ברוקלין (kids) is shown second but never dealt: the site-wide NOT_DEALT rule (an NBA-like logo on its back)
      expect(NOT_DEALT.has('kids')).toBe(true);
      expect(dad.filter((d) => d.deal).map((d) => d.id)).toEqual([
        'japanese',
        'football-boys',
        'posttrip',
      ]);
    });
  });
});
