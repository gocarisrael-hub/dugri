// @vitest-environment node
//
// The template editor's SURFACE, after the owner went through it control by
// control.
//
// These are assertions about markup rather than about the fit, and that is the
// point: the fit is a faithful port of the generator and was deliberately not
// touched. What changed is what the owner is asked to look at — and every item
// below is one she named.
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', '..', 'site', 'admin-bench.html');
let html;
beforeAll(() => {
  html = fs.readFileSync(FILE, 'utf8');
});

// A switch whose answer is always yes is not a question. Each of these was
// ticked on every real template, so it stops being asked — but the engine still
// reads it, so it has to still be there, checked, and out of sight.
const ALWAYS_ON = ['wFit', 'capOn', 'enDrag', 'tFit', 'tCapOn', 'bFit', 'bCapOn'];

describe('the switches that were always ticked', () => {
  it.each(ALWAYS_ON)('%s is present, checked and hidden', (id) => {
    const m = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
    expect(m, id + ' is gone — the fit reads it and would see undefined').toBeTruthy();
    expect(m[0]).toContain('checked');
    expect(m[0]).toContain('hidden');
  });

  it('none of them is still drawn as a labelled question', () => {
    for (const id of ALWAYS_ON) {
      expect(html).not.toMatch(new RegExp('<label class="sw"[^>]*>\\s*<input[^>]*id="' + id + '"'));
    }
  });
});

describe('what the owner asked to have taken off the screen', () => {
  it('the try-a-size panel is gone', () => {
    expect(html).not.toContain('<section class="try" id="try">');
    expect(html).not.toContain('Try a size');
  });

  it('but its inputs survive as hidden state, because the ceilings mirror them', () => {
    // Deleting these would leave the mirroring reaching for nulls on load.
    for (const id of ['tryHe', 'tryEn', 'tryT', 'tryB']) {
      expect(html).toContain('id="' + id + '"');
    }
    expect(html).toMatch(/<div hidden id="tryLegacy">/);
  });

  it('the per-card number readouts are hidden', () => {
    for (const id of ['wRead', 'tRead', 'bRead']) {
      expect(html).toMatch(new RegExp('id="' + id + '"[^>]*hidden'));
    }
  });

  it('the honoree row is no longer chrome', () => {
    expect(html).not.toContain('<span>honoree</span>');
    expect(html).toMatch(/<input[^>]*id="name"[^>]*hidden/);
  });
});

describe('the word presets', () => {
  it('offers mixed and long only, plus the four free fields', () => {
    expect(html).toContain('data-words="mix"');
    expect(html).toContain('data-words="long"');
    expect(html).not.toContain('data-words="he"');
    expect(html).not.toContain('data-words="en"');
    for (const i of [0, 1, 2, 3]) expect(html).toContain('id="w' + i + '"');
  });
});

describe('alignment moves the box, and the artwork bounds every direction', () => {
  it('each card offers right, centre and left', () => {
    for (const v of ['right', 'center', 'left']) {
      expect(html).toContain('data-centre="' + v + '"');
    }
  });

  it('the two old centre-in-the-clear / centre-in-the-card buttons are gone', () => {
    // "clear" stopped being a mode you opt into: it is now what every option does.
    expect(html).not.toContain('data-centre="clear"');
    expect(html).not.toContain('data-centre="card"');
  });

  it('the back card gets the same three', () => {
    for (const v of ['right', 'center', 'left']) {
      expect(html).toContain('data-centre="' + v + '" data-k="back"');
    }
  });

  it('alignTitle places the box inside the run the artwork leaves', () => {
    expect(html).toContain('function alignTitle(');
    expect(html).toContain('clearRun(');
    expect(html).not.toContain('function centreTitle(');
  });
});

describe('Hebrew', () => {
  it('reads right to left', () => {
    expect(html).toMatch(/html\s*{\s*direction:\s*rtl/);
  });

  it('the section headings are in Hebrew', () => {
    for (const h of ['קופסת המילים', 'תקרות המילים', 'אנגלית מול עברית', 'הכותרת']) {
      expect(html).toContain(h);
    }
    expect(html).not.toContain('<h2>Word box');
    expect(html).not.toContain('<h2>Word ceilings');
  });

  it('the deck download says what it downloads', () => {
    expect(html).toContain('הורדת החבילה');
    expect(html).not.toContain('build the PDF');
  });
});
