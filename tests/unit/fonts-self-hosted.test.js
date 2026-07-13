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
const htmlFiles = fs.readdirSync(SITE).filter((f) => f.endsWith('.html'));

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

  it('no HTML page references the Google Fonts CDN', () => {
    for (const f of htmlFiles) {
      const html = fs.readFileSync(path.join(SITE, f), 'utf8');
      expect(html, `${f} still hits Google Fonts`).not.toMatch(
        /fonts\.googleapis\.com|fonts\.gstatic\.com/
      );
    }
  });

  it('every page that previously loaded web fonts now links the local stylesheet', () => {
    // The customer + admin pages all render Hebrew text and must self-host.
    const pages = [
      'index',
      'product',
      'products',
      'options',
      'collect',
      'how',
      'timer',
      'admin',
      'dashboard',
      'admin-templates',
      'coupons',
    ];
    for (const p of pages) {
      const html = fs.readFileSync(path.join(SITE, `${p}.html`), 'utf8');
      expect(html, `${p}.html missing local fonts.css`).toContain('/assets/fonts/fonts.css');
    }
  });
});
