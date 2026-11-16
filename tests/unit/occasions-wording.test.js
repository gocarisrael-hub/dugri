// The title she types in the wizard is printed on the CARDS ("הכותרת שתודפס על הקלפים", options.html), not on a box:
// no occasion page may tell her she writes it on the box.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../server/occasions');
const pages = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));

describe('occasion pages: where the title is printed', () => {
  it('has pages to check', () => {
    expect(pages.length).toBeGreaterThan(0);
  });
  for (const o of pages) {
    it(`${o.slug} says the title goes on the cards`, () => {
      const steps = JSON.stringify(o.steps || {});
      expect(steps).not.toMatch(/(כותבים|כותבות) על הקופסה/);
    });
  }
});
