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
// The switches that carry the template's answer and are never asked as a
// question. `wFit` LEFT this list: with it hidden, a template that pinned no size
// had no reachable way to make its words bigger — the line gap was the only lever
// on the page — which is the whole of the owner's "why can't I make the font
// bigger?". It is a labelled switch again, and has its own group below.
const ALWAYS_ON = ['capOn', 'enDrag', 'tFit', 'tCapOn', 'bFit', 'bCapOn'];

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
  });

  // THE SWITCH IS GONE, and that is the fix. It chose between the design's title
  // with a name poured in and her own words, it was not on the screen, and
  // saveState persisted it with every other field — so a page restored on 'the
  // template' made the top-bar box decorative: she typed and the cards did not
  // move, with nothing visible to blame. Her words are the only answer now.
  it('there is no title mode left to be stuck on', () => {
    expect(html).not.toContain('titleMode');
    // customLines reads the field and nothing else — no gate in front of it
    expect(html).toMatch(/function customLines\(\) \{\s*const ls = \$\('titleText'\)/);
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
    // It used to say the TEMPLATE pins the size ("התבנית הזו מקבעת") — true while
    // the only way to be pinned was to arrive pinned. Now she can pin it herself,
    // so the note says whose number it is.
    expect(html).toContain('id="wPinWhy"');
    expect(html).toMatch(/id="wPinWhy"[\s\S]{0,160}<b>אתם<\/b> קובעים את הגודל/);
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
    // Scoped to the rule's own body, not a character count: the declaration sat
    // 217 chars from the selector and a 200-char window called a present feature
    // missing. [^}]* cannot leak into the next rule, so this stays honest while
    // surviving anyone adding a property above it.
    expect(html).toMatch(/\.top \.fld input,\s*\.top \.fld textarea \{[^}]*min-height: 62px/);
  });
});

describe('the ceiling examples are gone', () => {
  // Each ceiling drew its own miniature of a word at that size, with a line of
  // mono underneath. The cards above already show exactly that, at the size that
  // actually prints — the miniature was the same answer twice, in a smaller font.
  it('no example blocks, and nothing left to draw into them', () => {
    expect(html).not.toContain('class="eg"');
    expect(html).not.toContain('function drawEg(');
    expect(html).not.toMatch(/\bdrawEg\(/);
  });

  it('the ceiling rows still hide and show with their switch', () => {
    // capRows drove both the row and its example; only the example goes.
    expect(html).toContain('function capRows()');
    expect(html).toContain("const r = $(id).closest('.row');");
    expect(html).not.toMatch(/egs: \[/);
  });
});

describe('the size can be set by hand, not only inferred from the box', () => {
  // "why cant i make the font bigger? only when spacing is bigger? it doesnt
  // make sense" — and it did not. With auto-fit ON the size is
  // median(row heights) x _WORD_SIZE_K, and the editor writes those rows from the
  // line gap, so the gap was the only thing on the page that could grow the type.
  // The escape hatch existed in the data (`word_size`, which the press reads
  // FIRST) and three shipped templates print from it — but the switch that
  // reveals it carried `hidden`, and the slider only appeared for a template that
  // was already pinned. So a template with no pin had no reachable way to say
  // "bigger".
  it('the auto-fit switch is on the page, not hidden', () => {
    expect(html).toMatch(/<input type="checkbox" id="wFit" checked \/>/);
    expect(html).not.toMatch(/id="wFit"[^>]*\shidden/);
    // …and it is a labelled switch, like the bold one beside it.
    expect(html).toMatch(/id="wFit"[\s\S]{0,120}להתאים את גודל המילים לקופסה/);
  });

  it('the pinned-size row still follows the switch', () => {
    expect(html).toContain("$('wPinRow').hidden = $('wFit').checked;");
  });

  it('turning the pin on opens it where the card already is', () => {
    // Same rule the ceilings follow: a switch that moves the type by itself makes
    // the next drag unreadable. BOUND.lastWordSize is what the last fit landed on.
    expect(html).toContain('function fitToggled()');
    expect(html).toMatch(/if \(!\$\('wFit'\)\.checked && BOUND\.lastWordSize > 0\) setR\('wPin'/);
    expect(html).toContain("if (e.target.id === 'wFit') fitToggled();");
  });

  it('the box no longer claims it beats a pinned size', () => {
    // The fit stopped clamping a pin to the box (it read 15.82 on אואזיס where
    // the press sets its pinned 21.30); the tooltip had not caught up.
    expect(html).not.toContain('קיבוע נעצר בקופסה');
    expect(html).toContain('וקיבוע גובר על הקופסה');
    // The behaviour the copy now describes, in the fit itself.
    expect(html).toContain('const hBind = pinned ? leadBind : Math.min(leadBind, boxBind);');
  });
});

describe('a ceiling says where it stops', () => {
  // The owner asked twice why a ceiling ends at 14.2 and not 99. It ends at the
  // largest size that box could ever set — above it a ceiling can never bite —
  // so the slider names that number instead of leaving it a mystery.
  it('capMax writes the bound out in words, under the reading', () => {
    expect(html).toContain('המקסימום של הקופסה הזו');
    expect(html).toMatch(/end\.textContent = 'עד ' \+ r2\(top\)/);
    expect(html).toContain("(o || e).insertAdjacentElement('afterend', end)");
  });

  it('the bound is the box maximum, not a fixed 99', () => {
    // capMax is handed a measured bound; nothing may hardcode a range here.
    expect(html).toContain('top = Math.max(+e.min, r2(bound))');
    expect(html).toContain('e.max = top;');
  });

  it('.capend is styled and spans its own line', () => {
    expect(html).toMatch(/\.capend \{[^}]*grid-column: 1 \/ -1;/);
  });
});

describe('the line gap says why it stops', () => {
  // Same question as the ceiling, one row down: the renderer prints
  // max(this number, what the glyphs need), so under the glyphs' own need the
  // slider does nothing. Measured 0.64 (two-letter words) to 0.84 (a final
  // letter descending) on the bench face; the slider floors just above that.
  it('the pitch floor is stated on the row', () => {
    expect(html).toContain('מתחת ל-0.9 האותיות עצמן קובעות את הרווח');
    expect(html).toContain('id="wPitch" min="0.9"');
  });

  it('and the fit really does take the larger of the two', () => {
    expect(html).toContain('const eff = Math.max(ratio, lead || 0);');
  });
});

// THE CONTROL WAS INERT and a passing test said otherwise. `stepFor` held the
// right arithmetic — max(slider, lead) x size — and had no callers; the rows were
// drawn by `rowCentres` stepping the STORED pitch, so on סיישל every ratio from
// the slider's own minimum to 1.53 printed the same 28.01 gap. A test that reads
// a dead function's source is what let that live for as long as it did, so this
// one drives the functions instead of grepping them.
describe('the line gap actually moves the rhythm', () => {
  // `html` is only read in beforeAll, so the source is pulled per test.
  const rhythmBlock = () =>
    html.match(/ {2}let STEP = 24;[\s\S]*?\n {2}function pitchUnits\(\) \{[\s\S]*?\n {2}\}/)[0];
  // סיישל: a pinned word_size of 18.7 carrying a calibrated rhythm of 28.01.
  const load = (pitch = 28.01, base = 18.7) => {
    const block = rhythmBlock();
    const slider = { value: '1.4' };
    // eslint-disable-next-line no-unused-vars
    const $ = () => slider;
    // eslint-disable-next-line no-unused-vars
    const r2 = (n) => Math.round(n * 100) / 100;
    // eslint-disable-next-line no-unused-vars
    const setR = (id, v) => {
      slider.value = String(v);
    };
    const api = eval(block + ';({ setRhythm, pitchUnits })');
    api.setRhythm(pitch, base);
    return { ...api, slider };
  };

  it('an untouched slider prints the stored rhythm to the unit', () => {
    // 28.01 / 18.7 = 1.4979, which the 0.01 input snaps to 1.50. Multiplying back
    // would store 28.05 — a calibrated number nudged by merely opening the page.
    const { pitchUnits, slider } = load();
    expect(+slider.value).toBe(1.5);
    expect(pitchUnits()).toBe(28.01);
  });

  it('moving it moves the gap, proportionally', () => {
    const { pitchUnits, slider } = load();
    slider.value = '0.9';
    expect(pitchUnits()).toBeCloseTo(16.83, 6);
    slider.value = '1.2';
    expect(pitchUnits()).toBeCloseTo(22.44, 6);
  });

  it('0.9 and 1.2 are not the same gap — the bug itself', () => {
    const { pitchUnits, slider } = load();
    slider.value = '0.9';
    const low = pitchUnits();
    slider.value = '1.2';
    expect(pitchUnits()).not.toBe(low);
  });

  it('a template with no pinned size still answers the slider', () => {
    const { pitchUnits, slider } = load(24, 0); // base falls back to STEP / 1.4
    expect(+slider.value).toBe(1.4);
    expect(pitchUnits()).toBe(24);
    slider.value = '2.8';
    expect(pitchUnits()).toBeCloseTo(48, 6);
  });

  it('the rhythm never reads the fit back — the decay stays fixed', () => {
    // THE PITCH IS THE BAND'S: feeding solved.pitch into the spacing multiplied
    // it by ratio x 0.507 every repaint and the wall decayed card after card.
    // PITCH_BASE is set only on load, so the loop cannot form.
    expect(rhythmBlock()).toContain('return r * PITCH_BASE;');
    expect(html).not.toMatch(/STEP = solved/);
    expect(html).toContain('const step = pitchUnits();');
    expect(html).toMatch(/first \+ i \* pitchUnits\(\)/);
  });
});

// A CONTROL THAT DRAWS BUT CANNOT SAVE is the same failure as one that saves but
// cannot draw, and the bench had both. `word_bold` went into the payload and the
// API had no branch for it, so the unknown key was dropped in silence — the wall
// went heavy and the press printed light. `word_alt_scale` was addressed to
// nobody: the generator and the API both read that flat name, and the bench sent
// it nested inside `word_en`, a shape neither has a concept of.
describe('the controls that draw can also reach paper', () => {
  const saveable = () => html.match(/const SAVEABLE = \[([\s\S]*?)\];/)[1];

  it('the allowlist carries the weight switch and the English fraction', () => {
    expect(saveable()).toContain("'word_bold'");
    expect(saveable()).toContain("'word_alt_scale'");
  });

  it('the English fraction is sent flat, under the name both readers use', () => {
    // generator/config.word_alt_scale and server/templates.js read this exact
    // name at the top level; nested under word_en it reached neither.
    expect(html).toMatch(/\{ word_alt_scale: r2\(\+\$\('enScale'\)\.value\) \}/);
  });

  it('and only in the mode that has a press to reach', () => {
    // `exact` and `own-fit` have no generator field at all, so they are omitted
    // rather than nulled — clearing a calibrated fraction on the way past would
    // be a change she did not ask for.
    expect(html).toMatch(/\.\.\.\(\$\('enMode'\)\.value === 'scale'/);
  });

  it('the reasons that stopped being true are gone', () => {
    // #521 is closed: templates.js stores word_alt_scale. word_wrap_pitch has
    // been read by config.word_wrap_pitch since #522.
    expect(html).not.toContain('the settings API cannot yet');
    expect(html).not.toContain('not in the generator yet');
  });

  it('word_en itself stays out — the press has no concept of a MODE', () => {
    expect(saveable()).not.toContain("'word_en'");
    expect(saveable()).not.toContain("'word_en_drags_card'");
    expect(saveable()).not.toContain("'word_lead'");
  });
});

// THE WALL HAS TO SOLVE THE CARD THE PAPER WILL PRINT. Two places where it
// solved a different one, both found by reading the generator rather than the
// page: an alignment the press varies per front and the page held deck-wide, and
// an English entry the press always counts and the page let out of the fit.
describe('the wall solves the card the press prints', () => {
  it('the title alignment is the FRONT’s where that front has one', () => {
    // generator/config.front_align(cfg, front_index) reads
    // title_style.front_align["<n>"] and falls back to the deck-wide align.
    expect(html).toContain('function alignFor(front)');
    expect(html).toMatch(/const per = \(TS && TS\.front_align\) \|\| \{\};/);
    expect(html).toContain('const align = alignFor(front);');
  });

  it('and every front that knows its own number passes it', () => {
    expect(html).toContain('drawTitle(g, S.titles[k], tf, k);');
    expect(html).toContain('drawTitle(g, box, tf, isBack ? null : key);');
    // the back has no front alignment to look up
    expect(html).toContain('drawTitle(bg, S.back, bf);');
  });

  it('every entry holds the card down, English included', () => {
    // The press excludes an entry on emptiness alone (render_page.py:3039) and
    // then mins over all of them (:2507). No script test exists in that path.
    expect(html).toContain('const holds = live;');
    expect(html).not.toMatch(/mode === 'scale' && drag/);
  });

  it('alignFor prefers the front, falls back to the deck', () => {
    // Driven rather than grepped: טוקיו is flush-right on 2/4/6/8 and flush-left
    // on 3/5/7/9, and the deck-wide value must still answer for a front that
    // says nothing, and for the back, which passes no front at all.
    const src = html.match(/ {2}function alignFor\(front\) \{[\s\S]*?\n {2}\}/)[0];
    const make = (front_align, deck) => {
      // eslint-disable-next-line no-unused-vars
      const TS = { front_align };
      // eslint-disable-next-line no-unused-vars
      const $ = () => ({ value: deck });
      return eval(src + ';alignFor');
    };
    const jp = make(
      {
        2: 'right',
        3: 'left',
        4: 'right',
        5: 'left',
        6: 'right',
        7: 'left',
        8: 'right',
        9: 'left',
      },
      'center'
    );
    expect(jp(2)).toBe('right');
    expect(jp(3)).toBe('left');
    expect(jp(9)).toBe('left');
    expect(jp('3')).toBe('left'); // the keys arrive as strings from the wall
    expect(jp(99)).toBe('center'); // a front with no answer of its own
    expect(jp(null)).toBe('center'); // the back
    // a template with no per-front table at all is unchanged
    expect(make(undefined, 'right')(2)).toBe('right');
  });

  it('the English fraction applies only where a second face exists', () => {
    // Face.scale: `alt_scale if is_latin and self.alt is not None else 1.0`
    // (render_page.py:275). Every shipped design has word_font_alt unset, and the
    // panel fills the NAME in for display, so the question has to be asked before
    // that fallback runs — otherwise it can never be answered.
    expect(html).toContain('HAS_WORD_ALT = !!LIVE.word_font_alt;');
    expect(html).toContain('if (!HAS_WORD_ALT) return 1;');
    const src = html.match(/ {2}function latRatio\(\) \{[\s\S]*?\n {2}\}/)[0];
    const make = (hasAlt, mode, scale) => {
      // eslint-disable-next-line no-unused-vars
      const HAS_WORD_ALT = hasAlt;
      // eslint-disable-next-line no-unused-vars
      const $ = (id) => ({ value: id === 'enMode' ? mode : scale });
      return eval(src + ';latRatio')();
    };
    expect(make(false, 'scale', 0.8)).toBe(1); // no second face: the card's own size
    expect(make(true, 'scale', 0.8)).toBe(0.8); // a real alt face: the fraction
    expect(make(true, 'exact', 0.8)).toBe(1);
    expect(make(true, 'free', 0.8)).toBe(1);
  });

  it('the dead face-lead helper is gone', () => {
    // It measured the per-face ink floor the wPitch caption states as a fixed
    // 0.9, and had no callers — the same shape as stepFor.
    expect(html).not.toContain('function faceLead(');
  });
});
