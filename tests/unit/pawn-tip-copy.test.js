import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The owner's wording for the pawn step's fix tip (2026-10-19): a background in a colour opposite to the photo's,
// not "black". Staging and production have no saved override for this key, so this default is what buyers read.
const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../site');

describe('the pawn step fix tip', () => {
  it('asks for a background in a colour opposite to the photo', () => {
    const html = fs.readFileSync(path.join(SITE, 'options.html'), 'utf8');
    const doc = new JSDOM(html).window.document;
    const text = doc
      .querySelector('[data-edit="options-photos-tip-fix"]')
      .textContent.replace(/\s+/g, ' ')
      .trim();
    expect(text).toBe(
      'לא יצא טוב? בקשו מ-ChatGPT להחליף את הרקע שלכם בתמונה בצבע נגדי לצבעי התמונה ונסו להעלות שוב, מניסיוננו זה משפר מאוד.'
    );
  });
});
