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
