// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// THE INVARIANT: the file the customer downloads and the file the print shop
// prints are the same deck, so they are asked for the same way.
//
// They were not. The press route built its own argv with four entries — theme,
// name, words, title — and the customer's route built one with eleven. The six
// it left out are not cosmetic: the buyer's own pawn photos, the {AGE} in her
// title, the gender that decides בת or בן, the chasers board she paid for, the
// seed pool that picks the filler WORDS, and the word font she chose. The owner
// found it from the outside: "why when i create the pdf to בית דפוס it removes
// the pawns of the costumer? and also put the old version of the default pawns?"
// — the pawns were missing because nothing told the press run about them, and the
// generic set appeared in their place.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-press-args-'));
  for (const f of ['db.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  app = require(path.join(serverDir, 'index.js'));
});

// Everything about one order that reaches the generator, with nothing left at a
// default — a default would let an omission pass unnoticed.
const ORDER = {
  theme: 'bachelorette',
  name: 'Shira',
  wordsFile: '/tmp/words.txt',
  wordFont: 'Cafe Regular.ttf',
  extraFields: { AGE: '40' },
  chasers: true,
  customTitle: 'Happy birthday',
  wordlist: 'generic-350.txt',
  gender: 'female',
  photos: ['/tmp/pawn-1.png', '/tmp/pawn-2.png'],
};

describe('one order, two files, one argv', () => {
  it('carries every per-order choice', () => {
    const args = app.orderArgs({ ...ORDER, outPath: '/tmp/out.pdf' });
    expect(args).toContain('--word-font');
    expect(args).toContain('--field');
    expect(args).toContain('AGE=40');
    expect(args).toContain('--chasers');
    expect(args).toContain('--title=Happy birthday');
    expect(args).toContain('--wordlist=generic-350.txt');
    expect(args).toContain('--gender');
    // One --photo per photo, and the paths themselves.
    expect(args.filter((a) => a === '--photo')).toHaveLength(2);
    expect(args).toContain('/tmp/pawn-1.png');
    expect(args).toContain('/tmp/pawn-2.png');
  });

  it('differs between the two runs ONLY by the output path', () => {
    // This is the test that would have caught the bug: build the argv the way
    // each route does and diff them. Anything but the destination is a file the
    // print shop prints differently from the one she approved.
    const customer = app.orderArgs({ ...ORDER, outPath: '/tmp/deck.pdf' });
    const press = app.orderArgs({ ...ORDER, outPath: '/tmp/deck.press.partial' });
    expect(customer.length).toBe(press.length);
    const diffs = customer
      .map((a, i) => [a, press[i]])
      .filter(([a, b]) => a !== b)
      .flat();
    expect(diffs).toEqual(['/tmp/deck.pdf', '/tmp/deck.press.partial']);
  });

  it('drops a choice the order did not make, rather than passing an empty flag', () => {
    const bare = app.orderArgs({
      theme: 'bachelorette',
      name: 'Shira',
      wordsFile: '/tmp/w.txt',
      outPath: '/tmp/o.pdf',
    });
    expect(bare).toHaveLength(5);
    for (const flag of [
      '--word-font',
      '--field',
      '--chasers',
      '--wordlist',
      '--gender',
      '--photo',
    ]) {
      expect(bare.some((a) => a === flag || String(a).startsWith(flag + '='))).toBe(false);
    }
  });

  it('keeps a leading-dash title from being read as an option', () => {
    // "-40" or "-רווקות" as a title would otherwise be parsed by argparse as a
    // flag and kill the run; the '=' form is why it cannot.
    const args = app.orderArgs({
      theme: 'bachelorette',
      name: 'x',
      wordsFile: '/tmp/w.txt',
      outPath: '/tmp/o.pdf',
      customTitle: '-40',
      wordlist: '-pool.txt',
    });
    expect(args).toContain('--title=-40');
    expect(args).toContain('--wordlist=-pool.txt');
    expect(args).not.toContain('-40');
  });
});
