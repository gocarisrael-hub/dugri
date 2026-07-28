// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Unit tests for the PORTRAIT card-structure helpers in
// scripts/render-design-assets.mjs. Importing the module does not run the CLI (it
// only calls main() when invoked directly), so these exercise the pure helpers.
import {
  PORTRAIT,
  inlineCardAssets,
  photoCardSource,
} from '../../scripts/render-design-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATES = path.join(ROOT, 'resources/canva/templates');

// De-duplicated portrait artwork stores each shared background raster ONCE at
// <slug>/assets/<sha16>.png and references it as href="../assets/<sha16>.png"
// (docs/card-structure-schema.md §4). That relative reference cannot resolve inside
// page.setContent(), whose document has no base URL — and a file:// rewrite is
// blocked as a local-file subresource, which renders the card with its background
// SILENTLY missing (the near-blank byte guard does not catch it: the card frame
// alone is far bigger than the threshold). Inlining is the only form that survives.
describe('inlineCardAssets — de-duplicated card artwork survives the renderer', () => {
  const SVG_PATH = '/tpl/grapefruit/clean/2.svg';
  const readFile = (p) => {
    if (p === '/tpl/grapefruit/assets/abc.png') return Buffer.from([1, 2, 3]);
    throw new Error('ENOENT ' + p);
  };

  it('rewrites a ../assets reference into the raster it points at', () => {
    const out = inlineCardAssets(
      '<svg><image href="../assets/abc.png" /></svg>',
      SVG_PATH,
      readFile
    );
    expect(out).toBe('<svg><image href="data:image/png;base64,AQID" /></svg>');
    // Nothing relative survives — a leftover ../assets href is exactly the bug
    // that renders a card with no background.
    expect(out).not.toContain('../assets/');
  });

  it('handles the xlink:href form Canva actually exports, and repeats', () => {
    const out = inlineCardAssets(
      '<svg><image xlink:href="../assets/abc.png"/><image xlink:href="../assets/abc.png"/></svg>',
      SVG_PATH,
      readFile
    );
    expect(out.match(/data:image\/png;base64,AQID/g)).toHaveLength(2);
    expect(out).toContain('xlink:href="data:');
  });

  it('is a NO-OP on artwork that was never de-duplicated (embedded data URIs)', () => {
    const embedded = '<svg><image href="data:image/png;base64,AAAA"/></svg>';
    expect(inlineCardAssets(embedded, SVG_PATH, readFile)).toBe(embedded);
  });

  it('leaves a missing asset alone rather than throwing mid-render', () => {
    const src = '<svg><image href="../assets/gone.png"/></svg>';
    expect(inlineCardAssets(src, SVG_PATH, readFile)).toBe(src);
  });
});

describe('photoCardSource — the photo card degrades when its art is absent', () => {
  const dir = '/tpl/grapefruit';

  it('prefers the theme’s own photo-card template', () => {
    const exists = (p) => p.endsWith('/clean/photo.svg');
    expect(photoCardSource(dir, exists)).toBe(path.resolve(dir, 'clean/photo.svg'));
  });

  it('falls back to the shared generic Dugri art', () => {
    const exists = (p) => p.includes('_shared/photo-fallback');
    expect(photoCardSource(dir, exists)).toContain('_shared/photo-fallback/photo-card.svg');
  });

  it('returns "" when neither exists, so no photo slide is rendered at all', () => {
    // This is today's state: the generic fallback art has not shipped yet, so no
    // gallery-photo.webp is produced, no thumbs.photo is recorded, and the reader
    // simply omits the slide — it never 404s a missing picture into the carousel.
    expect(photoCardSource(dir, () => false)).toBe('');
  });
});

describe('PORTRAIT — which designs render from portrait card artwork', () => {
  it('lists only templates that really carry the numbered 1–9 structure', () => {
    for (const [id, slug] of Object.entries(PORTRAIT)) {
      const dir = path.join(TEMPLATES, slug);
      if (!fs.existsSync(dir)) continue; // artwork ships in a separate PR
      for (const n of [1, 2]) {
        expect(fs.existsSync(path.join(dir, `clean/${n}.svg`)), `${id} clean/${n}.svg`).toBe(true);
      }
      const svg = fs.readFileSync(path.join(dir, 'clean/1.svg'), 'utf8');
      // Portrait single card, not a landscape A4 sheet of 8.
      expect(svg).toContain('viewBox="0 0 223.92 312"');
    }
  });

  it('does not claim a design that is still on the legacy landscape artwork', async () => {
    const { GENERATED } = await import('../../site/js/designs.generated.js');
    for (const id of Object.keys(PORTRAIT)) {
      // A design in BOTH must be flagged portrait in the manifest, or the storefront
      // would size a portrait card into the landscape sheet box.
      if (GENERATED[id]) expect(GENERATED[id].portrait, `${id}.portrait`).toBe(true);
    }
    for (const [id, g] of Object.entries(GENERATED)) {
      if (g.portrait) expect(PORTRAIT[id], `${id} flagged portrait but not rendered`).toBeTruthy();
    }
  });
});
