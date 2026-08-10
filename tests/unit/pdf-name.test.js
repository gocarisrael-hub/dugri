import { describe, it, expect } from 'vitest';
import pdfName from '../../server/pdf-name.js';

// The owner's rule: "i want the pdf name to be the title the clients give (if no
// then the name the client give, but better title)". Everything below is about
// that sentence surviving a Hebrew title, a hostile one, and a browser.

const id = '03a87356-22af-45c7-871c-0ac3c58f1648';

describe('the name on the file', () => {
  it('is the title the customer gave', () => {
    expect(pdfName.fileName({ id, custom_title: 'Happy birthday', honoree_name: 'Shira' })).toBe(
      'dugri-Happy birthday-03a87356.pdf'
    );
  });

  it('falls back to the honoree when there is no title', () => {
    expect(pdfName.fileName({ id, honoree_name: 'Shira' })).toBe('dugri-Shira-03a87356.pdf');
  });

  it('falls back to the id alone when the order has neither', () => {
    // An admin-created order can carry only an id. That is the name every
    // download had before this existed, so it degrades to exactly that.
    expect(pdfName.fileName({ id })).toBe('dugri-03a87356.pdf');
  });

  it('keeps the id after the title, because titles collide', () => {
    // Two "Happy birthday" orders would otherwise land as x.pdf and x (1).pdf,
    // numbered by arrival, and the wrong one goes to the print shop.
    const a = pdfName.fileName({ id: 'aaaa1111-x', custom_title: 'Happy birthday' });
    const b = pdfName.fileName({ id: 'bbbb2222-x', custom_title: 'Happy birthday' });
    expect(a).not.toBe(b);
    expect(a).toContain('Happy birthday');
    expect(b).toContain('Happy birthday');
  });

  it('flattens a two-line title onto one line', () => {
    // custom_title is stored with '\n' between the lines it prints on the card.
    expect(pdfName.fileName({ id, custom_title: 'החגיגה של\nשירה' })).toBe(
      'dugri-החגיגה של שירה-03a87356.pdf'
    );
  });

  it('drops characters a filesystem or a header would refuse', () => {
    expect(pdfName.fileName({ id, custom_title: 'Dana/Roni: 40?  "x"' })).toBe(
      'dugri-DanaRoni 40 x-03a87356.pdf'
    );
    // …including control characters, which in a header are a splitting bug.
    expect(pdfName.fileName({ id, custom_title: 'a\r\nb\tc' })).not.toMatch(/[\r\n\t]/);
  });

  it('caps a very long title without splitting a surrogate pair', () => {
    const long = '🎉'.repeat(60);
    const name = pdfName.label({ id, custom_title: long });
    expect(Array.from(name).length).toBeLessThanOrEqual(pdfName.MAX_LABEL);
    // A lone surrogate percent-encodes into a name browsers reject.
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('the Content-Disposition header', () => {
  it('carries the real name in filename* and an ASCII name in filename', () => {
    const h = pdfName.contentDisposition({ id, custom_title: 'החגיגה של שירה' });
    expect(h).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    // The Hebrew rides percent-encoded…
    expect(h).toContain(encodeURIComponent('דוגרי'.slice(0, 0) + 'החגיגה של שירה'));
    // …and the quoted fallback is plain ASCII, because the header is Latin-1 by
    // spec and browsers disagree about anything else.
    const ascii = h.match(/filename="([^"]*)"/)[1];
    expect(ascii).toMatch(/^[\x20-\x7e]*$/);
  });

  it('degrades an all-Hebrew name to the id rather than to punctuation', () => {
    const ascii = pdfName.asciiFallback({ id, custom_title: 'החגיגה של שירה' });
    expect(ascii).toBe('dugri-03a87356.pdf');
  });

  it('never lets a quote out of the fallback and into the header', () => {
    const h = pdfName.contentDisposition({ id, custom_title: 'say "hello"' });
    const ascii = h.match(/filename="([^"]*)"/)[1];
    expect(ascii).not.toContain('"');
  });

  it('keeps the suffix that says which file this is', () => {
    // The press file's -press / -press-rgb is the one thing the old filenames
    // said deliberately; the board's -board likewise.
    expect(pdfName.fileName({ id, custom_title: 'Shira' }, '-press.pdf', '')).toBe(
      'dugri-Shira-03a87356-press.pdf'
    );
    expect(pdfName.fileName({ id, custom_title: 'Shira' }, '-board', '.pdf')).toBe(
      'dugri-Shira-03a87356-board.pdf'
    );
  });

  it('survives an order object that is missing entirely', () => {
    expect(() => pdfName.contentDisposition(null)).not.toThrow();
    expect(pdfName.fileName(null)).toBe('dugri.pdf');
  });
});
