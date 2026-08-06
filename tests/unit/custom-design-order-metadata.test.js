// @vitest-environment node
//
// A CUSTOM design (an owner-uploaded template on sale in the store) has to be
// ORDERABLE, not just browsable. The buyer wizard resolves three things off the
// selected design before it creates the order:
//
//   themeForDesign(d)       -> the generator theme the deck is rendered from
//   languageForDesign(d)    -> which script the honoree's name must be written in
//   extraFieldsForDesign(d) -> {AGE}/{YEARS}/{NAME1}+{NAME2} the title needs
//
// All three are backed by static maps that know only the BUILT-IN designs, so a
// custom design must carry its own values — and loadCustomDesigns is the only
// thing that puts them on the object. Dropped there, an english template asks for
// a Hebrew name, a template needing {AGE} is never asked for it, and the order is
// created with theme:null — a paid deck with no template to render it from.
import { describe, it, expect } from 'vitest';
import {
  loadCustomDesigns,
  themeForDesign,
  languageForDesign,
  extraFieldsForDesign,
} from '../../site/js/designs.js';

const PAYLOAD = {
  designs: [
    {
      id: 'football-boys',
      name: 'מרקאנה',
      theme: 'football-boys',
      custom: true,
      public: true,
      hasBoard: true,
      extra_fields: ['AGE'],
      language: 'english',
      name_form: 'english',
      img: {
        front: '/api/template-image/football-boys/front',
        back: '/api/template-image/football-boys/back',
        board: '/api/template-image/football-boys/board',
      },
    },
  ],
};

function fetchOk(json) {
  return async () => ({ ok: true, json: async () => json });
}

async function loadOne(json = PAYLOAD) {
  const list = await loadCustomDesigns({ fetchImpl: fetchOk(json) });
  expect(list).toHaveLength(1);
  return list[0];
}

describe('loadCustomDesigns — the metadata an ORDER needs survives normalization', () => {
  it("keeps the template's theme, language and extra fields", async () => {
    const d = await loadOne();
    expect(d.theme).toBe('football-boys');
    expect(d.language).toBe('english');
    expect(d.extra_fields).toEqual(['AGE']);
  });

  it('resolves through the wizard helpers exactly as the wizard calls them', async () => {
    const d = await loadOne();
    // The wizard passes the DESIGN OBJECT (not the id) — an id alone hits only the
    // built-in maps, which have never heard of an uploaded template.
    expect(themeForDesign(d)).toBe('football-boys');
    expect(languageForDesign(d)).toBe('english');
    expect(extraFieldsForDesign(d)).toEqual(['AGE']);
    // …and by id it is genuinely unknown, which is the whole point.
    expect(themeForDesign(d.id)).toBe(null);
  });

  it('exposes its template pictures as `products` — the field the wizard previews from', async () => {
    const d = await loadOne();
    expect(d.products).toEqual({
      front: '/api/template-image/football-boys/front',
      back: '/api/template-image/football-boys/back',
      board: '/api/template-image/football-boys/board',
    });
    // `img` stays as the storefront gallery resolver's alias.
    expect(d.img).toEqual(d.products);
    // A baked template has no recolour anchors, but the array must EXIST so every
    // `d.anchors` reader (and the manifest shape) is satisfied.
    expect(d.anchors).toEqual([]);
    expect(d.recolor).toBe('fixed');
  });

  it('omits a slot the template has no art for, in `products` too', async () => {
    const noBoard = {
      designs: [
        {
          ...PAYLOAD.designs[0],
          hasBoard: false,
          img: {
            front: '/api/template-image/football-boys/front',
            back: '/api/template-image/football-boys/back',
          },
        },
      ],
    };
    const d = await loadOne(noBoard);
    expect(Object.keys(d.products)).toEqual(['front', 'back']);
  });

  it('falls back safely when the server sends no language / extra fields', async () => {
    const bare = {
      designs: [
        {
          id: 'plain-tpl',
          name: 'plain',
          theme: 'plain-tpl',
          img: { front: '/api/template-image/plain-tpl/front' },
        },
      ],
    };
    const d = await loadOne(bare);
    expect(d.language).toBe('hebrew'); // the Hebrew-first product default
    expect(d.extra_fields).toEqual([]);
    expect(languageForDesign(d)).toBe('hebrew');
    expect(extraFieldsForDesign(d)).toEqual([]);
  });

  it('drops junk in extra_fields rather than passing it to the wizard', async () => {
    const junk = {
      designs: [{ ...PAYLOAD.designs[0], extra_fields: ['AGE', 7, null, { k: 1 }, 'YEARS'] }],
    };
    const d = await loadOne(junk);
    expect(d.extra_fields).toEqual(['AGE', 'YEARS']);
  });
});

describe('themeForDesign accepts a design object', () => {
  it('believes an object over the built-in map, and an id behaves as before', () => {
    expect(themeForDesign({ id: 'nope', theme: 'my-template' })).toBe('my-template');
    // A built-in id still resolves through the static map.
    expect(themeForDesign('japanese')).toBe('japanese');
    expect(themeForDesign('marriage')).toBe('anniversary');
    // An object with no own theme falls through to the map.
    expect(themeForDesign({ id: 'marriage' })).toBe('anniversary');
    expect(themeForDesign({ id: 'nope' })).toBe(null);
  });
});
