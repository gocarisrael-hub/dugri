// @vitest-environment node
// An occasion page's designs (site/js/home-data.js occasionDesigns, used by home-new.js on occasion.html): the page's designs
// first, the deck dealing only those, and every design's order link carrying the occasion so options.html can count it.
import { describe, it, expect } from 'vitest';
import { homeDesigns, occasionDesigns } from '../../site/js/home-data.js';
import { PUBLIC_DESIGNS } from '../../site/js/designs.js';

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
});
