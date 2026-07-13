// @vitest-environment node
//
// Guards the self-hosted font pipeline: the site must NOT depend on the Google
// Fonts CDN (in-app mobile browsers block/throttle fonts.gstatic.com), every
// @font-face in fonts.css must resolve to a real woff2 on disk, and every page
// that renders text must link the local stylesheet.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'site');
const FONT_DIR = path.join(SITE, 'assets', 'fonts');
const CSS = path.join(FONT_DIR, 'fonts.css');

const css = fs.readFileSync(CSS, 'utf8');

// Every .html under site/ (recursive — files under assets/ count too).
function walkHtml(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkHtml(abs));
    else if (e.name.endsWith('.html')) out.push(abs);
  }
  return out;
}
const htmlFiles = walkHtml(SITE);

describe('self-hosted fonts', () => {
  it('fonts.css never reaches the Google Fonts CDN', () => {
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('every @font-face src resolves to a real woff2 file (valid wOF2 magic)', () => {
    const refs = [...css.matchAll(/url\((\/assets\/fonts\/[^)]+\.woff2)\)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const abs = path.join(SITE, ref.replace(/^\//, ''));
      expect(fs.existsSync(abs), `missing ${ref}`).toBe(true);
      const magic = fs.readFileSync(abs).toString('latin1', 0, 4);
      expect(magic, `${ref} is not woff2`).toBe('wOF2');
    }
  });

  it('declares every family+weight the site uses', () => {
    // family -> weights that must be present (union of what the pages request).
    const expected = {
      Assistant: [200, 400, 500, 600],
      Heebo: [300, 400, 500, 600, 700, 800, 900],
      Fredoka: [400, 500],
      'Gveret Levin': [400],
      'Playpen Sans Hebrew': [400, 500],
      Carlito: [400, 700],
      Rubik: [500, 700, 900],
      'Secular One': [400],
    };
    // Split into @font-face blocks and index by family+weight.
    const blocks = css.split('@font-face').slice(1);
    const have = new Set();
    for (const b of blocks) {
      const fam = (b.match(/font-family:\s*'([^']+)'/) || [])[1];
      const w = (b.match(/font-weight:\s*(\d+)/) || [])[1];
      if (fam && w) have.add(`${fam}:${w}`);
    }
    for (const [fam, weights] of Object.entries(expected)) {
      for (const w of weights) {
        expect(have.has(`${fam}:${w}`), `missing ${fam} ${w}`).toBe(true);
      }
    }
  });

  it('keeps only the hebrew + latin subsets (no latin-ext/math/symbols bloat)', () => {
    const subsets = [...css.matchAll(/\/\*\s*([a-z-]+)\s*\*\//g)].map((m) => m[1]);
    expect(subsets.length).toBeGreaterThan(0);
    for (const s of subsets) expect(['hebrew', 'latin']).toContain(s);
  });

  it('woff2 filenames are content-hashed (so the immutable cache self-busts on regen)', () => {
    const refs = [...css.matchAll(/url\(\/assets\/fonts\/([^)]+\.woff2)\)/g)].map((m) => m[1]);
    for (const name of refs) {
      expect(name, `${name} is not content-hashed`).toMatch(
        /^[a-z-]+-\d+-[a-z]+\.[0-9a-f]{8}\.woff2$/
      );
    }
  });

  it('no HTML page anywhere under site/ references the Google Fonts CDN', () => {
    for (const abs of htmlFiles) {
      const html = fs.readFileSync(abs, 'utf8');
      expect(html, `${path.relative(SITE, abs)} still hits Google Fonts`).not.toMatch(
        /fonts\.googleapis\.com|fonts\.gstatic\.com/
      );
    }
  });

  it('every page that renders brand text (links tokens.css) also links the local font stylesheet', () => {
    // The invariant: brand tokens (--font/--display) imply the brand faces must
    // be self-hosted on that page. Derived from the files so a new page can't
    // silently ship without fonts.
    const branded = htmlFiles.filter((abs) =>
      fs.readFileSync(abs, 'utf8').includes('/css/tokens.css')
    );
    expect(branded.length).toBeGreaterThanOrEqual(11);
    for (const abs of branded) {
      const html = fs.readFileSync(abs, 'utf8');
      expect(html, `${path.relative(SITE, abs)} missing local fonts.css`).toContain(
        '/assets/fonts/fonts.css'
      );
    }
  });
});
