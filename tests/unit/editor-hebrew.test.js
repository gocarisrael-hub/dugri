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
  it('reads right to left — the INTERFACE, not the cards', () => {
    // A document-level flip re-reads what start and end mean underneath the
    // drawing code, which computes every anchor against the direction it
    // inherits. So the chrome is flipped and the SVG subtree is left alone.
    expect(html).toMatch(/\.top,[\s\S]{0,240}direction: rtl;/);
    expect(html).not.toMatch(/\bhtml\s*\{\s*direction:\s*rtl/);
    expect(html).not.toMatch(/\bbody\s*\{[^}]*direction:\s*rtl/);
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
    expect(html).toMatch(/--paper:\s*#faf8f5/);
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

describe('translating must not rename a value', () => {
  // The align options carried no value attribute, so their value WAS their
  // text. Translating "center" to "מרכז" renamed the value, sideAnchor stopped
  // recognising it, and every title on every card lost its centring and ran off
  // the edge of the card. Nothing in the markup looked wrong.
  it('every option states its value explicitly', () => {
    const bare = html.match(/<option(?![^>]*\bvalue=)[^>]*>/g) || [];
    expect(
      bare,
      'an option without a value: its value is its label, so translating it changes it'
    ).toEqual([]);
  });

  it('the align values are the ones sideAnchor tests for', () => {
    for (const v of ['center', 'left', 'right']) {
      expect(html).toContain('<option value="' + v + '">');
    }
    expect(html).toContain("if (side === 'center') return 'middle'");
  });
});

describe('the title reads in one language, the way the press decides it', () => {
  it('the first strong character decides, not the presence of any Hebrew', () => {
    // generator/title_script. Asking "is there ANY Hebrew" called
    // "MAYA בן 30" a Hebrew title, which directs the run right-to-left.
    expect(html).toContain('function firstStrongIsHeb(lines)');
    expect(html).not.toContain('spec.lines.some(hasHeb)');
  });
});

describe('a store written by an older page cannot poison a select', () => {
  // The align options once carried no value attribute, so their value WAS their
  // Hebrew label, and browsers saved that. Assigning an unknown value to a
  // <select> leaves it BLANK, every reader falls through its cases, and titles
  // went on being drawn off the card long after the markup was fixed.
  it('a restored value the select does not have is refused', () => {
    expect(html).toContain("if (e.tagName === 'SELECT')");
    expect(html).toContain('const known = [...e.options].some((o) => o.value === v)');
    expect(html).toContain('return; // keep the default');
  });

  it('the labels an older page saved are mapped back to values', () => {
    expect(html).toMatch(/LEGACY_CHOICE = \{[^}]*'center'/);
    expect(html).toMatch(/LEGACY_CHOICE = \{[^}]*'left'/);
    expect(html).toMatch(/LEGACY_CHOICE = \{[^}]*'right'/);
  });
});

describe('the hidden switches carry the template\u2019s answer, not a preference', () => {
  // They LOOK like preferences and are not: resetAll sets six of the seven from
  // the ENTRY. סיישל pins word_size 18.7, so it must open pinned — forcing them
  // on would show a fitted size for a design the press sets at a fixed one.
  it('nothing overrides them when state is restored', () => {
    expect(html).not.toContain('ALWAYS_ON');
  });

  it('a pinned size says whose decision it is, in Hebrew', () => {
    expect(html).toContain('id="wPinWhy"');
    expect(html).toContain('<b>מקבעת</b>');
    expect(html).toContain('<label for="wPin">גודל מקובע</label>');
    expect(html).not.toContain('>pinned size<');
  });
});

describe('the panels read as cards, not as a wall of settings', () => {
  it('a group is a bordered card with room in it', () => {
    const m = html.match(/\.grp \{[^}]*\}/);
    expect(m[0]).toContain('background: var(--surface)');
    expect(m[0]).toContain('border: 1px solid var(--rule)');
    expect(m[0]).not.toContain('border-bottom: 1px solid var(--rule);');
  });

  it('the number in a row is the coloured thing, and the copy is readable', () => {
    expect(html).toMatch(/\.row output \{[^}]*color: var\(--sea\)/);
    expect(html).toMatch(/\.row label \{[^}]*font-size: 14px/);
    expect(html).toMatch(/\.hint \{[^}]*font-size: 12\.5px/);
  });

  it('the cards no longer caption themselves with a number', () => {
    expect(html).not.toContain('<span>קלף ${k}</span>');
  });
});

describe('the buttons exist at all', () => {
  // An earlier rewrite of the top bar deleted the base .btn rule along with the
  // markup around it, and every button on the page fell back to a browser
  // default. Nothing failed; it just looked unfinished.
  it('there is a base rule, not only its modifiers', () => {
    expect(html).toMatch(/\n\s*\.btn \{[\s\S]{0,320}cursor: pointer/);
  });

  it('and it is soft', () => {
    const m = html.match(/\n\s*\.btn \{[^}]*\}/);
    expect(m[0]).toMatch(/border-radius: 9px/);
    expect(m[0]).toMatch(/font-family: var\(--ui\)/);
  });

  it('a card is rounded, and so is the artwork inside it', () => {
    expect(html).toMatch(/\.grp \{[^}]*border-radius: 14px/);
    expect(html).toMatch(/\.slot \{[^}]*border-radius: 12px/);
    expect(html).toMatch(/\.slot svg \{[^}]*border-radius: 8px/);
  });
});

describe('the card is not the page', () => {
  // Every anchor in drawWords/drawTitle is start/end against the direction the
  // element inherits. With the interface flipped and the card left to inherit
  // it, "end" changes sides: the numbered column hangs OUTSIDE its box, on the
  // wrong side of the anchor the press puts it on.
  //
  // Measured against the press for סיישל: every row's ink ends at 365px and the
  // widest slot edge is 364.6 — the numeral sits INSIDE, touching the anchor.
  it('the card svg is pinned left-to-right', () => {
    expect(html).toMatch(/\.slot svg \{[\s\S]{0,600}direction: ltr/);
  });

  it('and the page-wide flip is still off', () => {
    expect(html).not.toMatch(/\bhtml\s*\{\s*direction:\s*rtl/);
  });
});

describe('the panels stopped explaining themselves', () => {
  // Fifteen paragraphs of prose sat under the controls. The owner uses this page
  // every few weeks and does not need it argued at each time; what she does need
  // is what the page is doing RIGHT NOW.
  it('no static prose is left in the panels', () => {
    const body = html.slice(0, html.indexOf('<script>'));
    const prose = body.match(/<p class="hint">/g) || [];
    expect(prose, 'a hint with no id is prose, not a reading').toEqual([]);
  });

  it('the notes that only ever said one thing are gone with the rest', () => {
    // faceNote listed the template's four fonts; enNote and titleFaceNote
    // argued about English; tmplNote could only ever say one thing once the
    // title became always-her-own-words. Three of the four were still English.
    for (const id of ['faceNote', 'enNote', 'tmplNote', 'titleFaceNote']) {
      expect(html).not.toContain(id);
    }
  });

  it('but everything that reports live state stays', () => {
    for (const id of ['wPinWhy', 'wrapRoom', 'deckStatus']) {
      expect(html).toContain('id="' + id + '"');
    }
  });

  it('the essay at the foot is one line, and keeps the fact worth keeping', () => {
    expect(html).toContain('class="foot-note"');
    expect(html).toContain('0.03');
    expect(html).not.toContain('<h3>מה העורך הזה, ומה הוא לא</h3>');
  });
});

describe('the top bar has zones instead of a pile', () => {
  // Four things were injected into it at runtime — a back link, a status
  // reading, a save button and a template picker — and each landed wherever it
  // fell. The bar is a grid with named areas now, so nothing can drift.
  it('identity, the field, and the actions each have a place', () => {
    expect(html).toMatch(/grid-template-areas: 'who fld sp acts' 'state state state state'/);
    for (const c of ['who', 'acts', 'state']) {
      expect(html).toContain('class="' + c + '"');
    }
  });

  it('what the bar reports sits under what it offers', () => {
    expect(html).toContain(".top .state') || bar).appendChild(says)");
    expect(html).toContain(".top .who') || bar).appendChild(pick)");
  });

  it('one button carries weight; the rest are quiet', () => {
    expect(html).toMatch(/<button class="btn quiet" id="reset"/);
    expect(html).toMatch(/<button class="btn" id="copy"/);
    expect(html).toMatch(/save\.className = 'btn solid'/);
  });

  it('the chip and the picker do not both name the template', () => {
    // They read "סיישלtrip comeback" run together, and then said סיישל twice.
    expect(html).toContain("$('brandHe').textContent = '';");
    expect(html).toMatch(/\.top \.brand \{[^}]*gap: 7px/);
  });

  it('the title field shows three lines without being dragged open', () => {
    expect(html).toMatch(/<textarea id="titleTop" rows="3"/);
    expect(html).toMatch(/\.top \.fld input,[\s\S]{0,200}min-height: 62px/);
  });
});
