// @vitest-environment node
//
// THE ONE-LANGUAGE TITLE (the shop owner, 2026-10-18): the printed title is Hebrew OR English, never both. Digits,
// spaces and punctuation belong to neither. The browser copy (site/js/title-language.js) and the server's
// (server/validate.js) must agree character for character, or the field and the API disagree about what is allowed.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as client from '../../site/js/title-language.js';

const require = createRequire(import.meta.url);
const server = require('../../server/validate.js');

const ONE_LANGUAGE = [
  'ליאת חוגגת 40',
  'Liat turns 40',
  'HADAR IS 30',
  'מזל טוב ׳לשירה׳!',
  'החגיגה של\nשירה',
  'שירה - 30 שנה ♥',
  'Dana/Roni: 40?',
  'José 50',
  '40',
  '',
  '2 × 20',
];
const MIXED = ['Liat חוגגת 40', 'ליאת turns 40', 'שירה\nShira', 'Happy יום הולדת', 'José ושירה'];

describe('the browser and the server use the same letters', () => {
  it('pins the two character classes and the message', () => {
    expect(client.HEBREW_LETTERS).toBe(server.HEBREW_LETTERS);
    expect(client.LATIN_LETTERS).toBe(server.LATIN_LETTERS);
    expect(client.TITLE_LANGUAGE_MESSAGE).toBe(server.TITLE_LANGUAGE_MESSAGE);
  });
});

for (const [side, v] of [
  ['browser', client],
  ['server', server],
]) {
  describe(`titleMixesLanguages (${side})`, () => {
    for (const t of ONE_LANGUAGE) {
      it(`accepts ${JSON.stringify(t)}`, () => {
        expect(v.titleMixesLanguages(t)).toBe(false);
        expect(v.titleLanguageMessage(t)).toBe(null);
      });
    }
    for (const t of MIXED) {
      it(`refuses ${JSON.stringify(t)}`, () => {
        expect(v.titleMixesLanguages(t)).toBe(true);
        expect(v.titleLanguageMessage(t)).toBe('כותרת בשפה אחת בלבד - עברית או אנגלית');
      });
    }
    it('treats a missing title as empty', () => {
      expect(v.titleMixesLanguages(null)).toBe(false);
      expect(v.titleMixesLanguages(undefined)).toBe(false);
    });
  });
}
