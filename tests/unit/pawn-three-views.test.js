import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TILE_MARGIN, tileSlotShare } from '../../site/js/pawn-print.js';

// THE HARNESS HAS TO BE A TEST OF THE PAGE, NOT OF ITSELF.
//
// generator/pawn_three_views.py renders the printed card, the preview card and the
// editor tile and measures the three against each other. Its two browser panes are
// painted by site/js/pawn-print.js — `paintCard` and `paintTile`, the very calls
// collect.html makes — so it only says anything about the real page for as long as
// the real page draws through those same two functions, and for as long as the
// harness measures the tile the module actually draws.
//
// Deleting this file once left the harness agreeing with itself: it hand-wrote the
// calls and carried its own copy of the tile margin, so the page could have stopped
// using either without a single test going red.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

describe('the pages draw through the module the harness renders', () => {
  const collect = read('site', 'collect.html');
  const wizard = read('site', 'options.html');
  const harness = read('generator', 'pawn_three_views.py');

  it('the collection page paints both the card and the tiles through it', () => {
    expect(collect).toContain("from './js/pawn-print.js'");
    expect(collect).toContain('paintCard(');
    expect(collect).toContain('paintTile(');
  });

  it('the wizard paints its slots through it', () => {
    expect(wizard).toContain("from './js/pawn-print.js'");
    expect(wizard).toContain('paintTile(');
  });

  it('the harness paints its two panes through the same two calls', () => {
    expect(harness).toContain('paintCard(document.getElementById');
    expect(harness).toContain('paintTile(document.getElementById');
    // …over the page's own stylesheet and the page's own module, never a copy.
    expect(harness).toContain('_read(os.path.join(SITE, "js", "pawn-print.js"))');
  });

  it('and measures the tile with the margin the module draws, not a copy', () => {
    // The harness crops the slot out of the tile, which means knowing the paper
    // around it. It reads that number out of the module; this is the pin that the
    // number is there to be read.
    expect(harness).toContain('export const TILE_MARGIN = ([\\d.]+);');
    expect(read('site', 'js', 'pawn-print.js')).toContain(
      `export const TILE_MARGIN = ${TILE_MARGIN};`
    );
  });
});

describe('the tile shows the slot plus that margin on every side', () => {
  it('a 66-unit slot in a 72-unit tile', () => {
    expect(tileSlotShare({ w: 66 })).toBeCloseTo(66 / (66 + 2 * TILE_MARGIN), 10);
  });

  it('and the share follows the margin it is given', () => {
    expect(tileSlotShare({ w: 66 }, 0)).toBe(1);
    expect(tileSlotShare({ w: 10 }, 5)).toBeCloseTo(0.5, 10);
  });
});
