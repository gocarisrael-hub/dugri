import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ONE TREATMENT FOR THE STRUCK PRICE — AND A GUARD AGAINST IT DRIFTING AGAIN.
//
// Six storefront pages each declared their own `.was` rule. They drifted to
// 0.82em/700 and 0.85em/700, to opacity .55 and .6, and to three different
// ideas about spacing — one of which put the air on the OUTSIDE of the pair
// (margin-inline-end in an RTL row), so the home rail printed the two prices as
// a single number, "239199". css/tokens.css now owns the look; the E2E in
// tests/e2e/price-row.spec.js proves the rendered result, and this file keeps
// the next page from quietly re-declaring its own copy.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(__dirname, '..', '..', 'site');
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');

// Every page that prints a struck price.
const PAGES = [
  'index.html',
  'how.html',
  'products.html',
  'product.html',
  'collect.html',
  'options.html',
];

describe('the struck price is styled in exactly one place', () => {
  const tokens = read(path.join('css', 'tokens.css'));

  it('css/tokens.css carries the canonical .was rule', () => {
    const rule = tokens.match(/(?:^|\n)\.was\s*\{([\s\S]*?)\n\}/);
    expect(rule, 'a top-level `.was { … }` rule in css/tokens.css').toBeTruthy();
    const body = rule[1];
    expect(body).toMatch(/text-decoration:\s*line-through/);
    // Sized and weighted DOWN from the live price beside it.
    expect(body).toMatch(/font-size:\s*0\.86em/);
    expect(body).toMatch(/font-weight:\s*400/);
    // The air is claimed on the START side, so in RTL it lands BETWEEN the two
    // prices and can never end up outside the pair.
    expect(body).toMatch(/margin-inline-start:\s*var\(--was-gap\)/);
    expect(body).not.toMatch(/margin-inline-end/);
  });

  it('the gap is one number, and --was-gap defaults to it', () => {
    expect(tokens).toMatch(/--price-gap:\s*9px/);
    expect(tokens).toMatch(/--was-gap:\s*var\(--price-gap\)/);
  });

  // A page may still SCOPE an override (`.pdp-price .was { font-size: 18px }`)
  // — what must not come back is a page-wide `.was { … }` restating the look.
  it.each(PAGES)('%s does not re-declare a bare .was rule', (page) => {
    const html = read(page);
    const bare = html.match(/\n\s*\.was\s*\{/);
    expect(bare, `${page} restyles .was itself instead of using css/tokens.css`).toBeNull();
  });

  // A container that spaces its children itself must zero the struck price's
  // own margin, or the gap doubles. These are the four that do.
  it.each([
    ['products.html', '--was-gap: 0'],
    ['product.html', '--was-gap: 0'],
    ['collect.html', '--was-gap: 0'],
    ['how.html', '--was-gap: 0'],
  ])('%s zeroes --was-gap on the row that supplies its own gap', (page, needle) => {
    expect(read(page)).toContain(needle);
  });
});
