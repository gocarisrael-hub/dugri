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

describe('the readouts that answer "why is the type this size"', () => {
  it('names the edge that is holding it, in Hebrew', () => {
    expect(html).toContain("const HOLD = { width: 'הרוחב', height: 'הגובה', ceiling: 'התקרה' }");
    expect(html).toContain('הגובה של הקופסה מחזיק את הגודל');
    expect(html).toContain('הרוחב של הקופסה מחזיק את הגודל');
    expect(html).toContain('התקרה מחזיקה את הגודל');
  });

  it('the per-card line no longer reports in English', () => {
    expect(html).not.toContain('held by <span class="b">');
    expect(html).not.toContain('at ceiling</span>');
    expect(html).toContain('בתקרה');
  });

  it('says how much room is left for a break, and where', () => {
    expect(html).toContain('id="wrapRoom"');
    expect(html).toContain('שבירות שורה');
    expect(html).toContain('תקטין את כל הקלף');
  });

  it('derives that room from the fit, not from a second measurement', () => {
    // A readout computed a second way is how it came to promise breaks the card
    // could not afford.
    expect(html).toContain('function freeBreaks(fit, words)');
    expect(html).toContain('fit.hBind / fit.he - 1');
  });
});

describe('every card is the same size', () => {
  it('the backs are laid out on the fronts’ track, not a wider one', () => {
    const m = html.match(/\.backwall \.wall \{[^}]*\}/);
    expect(m).toBeTruthy();
    expect(m[0]).toContain('minmax(214px, 1fr)');
    expect(m[0]).not.toContain('260px');
  });
});

describe('the look the owner approved', () => {
  it('the accent is the template’s ink, not the page’s old teal', () => {
    expect(html).toMatch(/--sea:\s*#02408c/);
    expect(html).not.toMatch(/--sea:\s*#017f8d/);
    expect(html).toMatch(/--paper:\s*#f7f6f4/);
  });

  it('the cards take the wide half, the controls a column beside them', () => {
    const m = html.match(/\.shell \{[^}]*\}/);
    expect(m[0]).toContain('minmax(0, 1fr) 380px');
    expect(html).toMatch(/\.stage \{\s*order: -1;/);
  });

  it('the title she prints is in the top bar, and is always her own words', () => {
    expect(html).toContain('id="titleTop"');
    expect(html).toContain('הכותרת שתודפס');
    expect(html).toContain("$('titleMode').value = 'own'");
    // the select survives hidden — the fit reads it
    expect(html).toMatch(/<div class="row wide" hidden>[\s\S]{0,80}titleMode/);
  });

  it('the field opens on the filled title, not the template’s placeholders', () => {
    expect(html).toContain('SEED_TITLE');
    expect(html).toContain("$('titleText').value = titleLines().lines.join('\\n')");
  });

  it('the chip names the template without reciting the card’s dimensions', () => {
    expect(html).toContain("$('brandEn').textContent = TPL.en;");
    expect(html).not.toContain("TPL.en + ' · ' + CW");
  });

  it('the legend reads in Hebrew', () => {
    expect(html).toContain('קופסת המילים — אחת');
    expect(html).toContain('הצלע שמחזיקה את הגודל');
    expect(html).not.toContain('word box — one for');
  });
});

describe('what a browser found that the markup could not', () => {
  it('the try panel’s word fields survive — the boot seeds them', () => {
    // Removing the section took t0..t3 and tName with it; boot threw on load and
    // the wall never drew.
    for (const id of ['t0', 't1', 't2', 't3', 'tName']) {
      expect(html).toContain('id="' + id + '"');
    }
  });

  it('syncHidden tolerates enDrag having lost its label', () => {
    expect(html).toContain("const dragSw = $('enDrag').closest('.sw')");
    expect(html).toContain('if (dragSw)');
  });
});
