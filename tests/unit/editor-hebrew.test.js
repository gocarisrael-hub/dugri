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

describe('the rows are on screen, so the height slider can be read', () => {
  // "what is גובה השורה? when i change it in the editor it changes nothing" —
  // and on a card held by its WIDTH that was very nearly true. The slider edits
  // the four row rectangles, which are what the press sizes from and what the
  // save writes, and this page drew only the band AROUND them. So its whole
  // effect was one grey number under the ceilings.
  it('the four rows are drawn, wherever the band is', () => {
    expect(html).toContain('function drawRows(g)');
    // Every place the band is painted paints the rows inside it — the big card,
    // the per-front wall, and the try-a-card panel.
    expect(html.match(/drawRows\(g\);/g) || []).toHaveLength(3);
  });

  it('the drawing and the save are one helper, so they cannot drift', () => {
    // They used to work the rectangle out twice, off two different pitches:
    // rowCentres() steps by pitchUnits(), the save sized the row by fit.step.
    // One of them is now the only one.
    expect(html).toContain('function rowSlots()');
    expect(html).toMatch(/rowSlots\(\)\.forEach\(\(r\) => \{/);
    expect(html).toMatch(/words: rowSlots\(\)\.map\(\(r\) => \(\{/);
    // and nothing computes a row rectangle anywhere else: rowTop()/rowBot() are
    // each called from exactly one place now, and that place is rowSlots.
    expect(html.match(/rowTop\(\)/g) || []).toHaveLength(1);
    expect(html.match(/rowBot\(\)/g) || []).toHaveLength(1);
  });

  it('they read as description, not as a handle, and in a key of their own', () => {
    // The band is what she grabs; four more grabbable rectangles inside it would
    // fight her thumb, and at the band's weight they would bury the words.
    expect(html).toMatch(/\.rowband \{[^}]*fill: none;/);
    expect(html).toMatch(/\.rowband \{[^}]*pointer-events: none;/);
    // …and NOT in the word box's colour or its dash. One dashed --bandline
    // swatch in the legend cannot stand for two different rectangles.
    expect(html).toMatch(/\.rowband \{[^}]*stroke: var\(--rowline\);/);
    expect(html).not.toMatch(/\.rowband \{[^}]*stroke: var\(--bandline\);/);
    // every theme block defines the new key — light, the media query, the toggle
    expect(html.match(/--rowline:/g) || []).toHaveLength(3);
    // and the legend names it
    expect(html).toMatch(/border-color: var\(--rowline\); border-top-style: dotted/);
    expect(html).toContain('שורות המילים');
    // the dead class that encoded the same idea and was never drawn is gone
    expect(html).not.toContain('.rowrule');
  });

  it('the ceiling names the sliders that can actually raise it, and only those', () => {
    // #574 wrote that copy when the gap was the only thing behind the bound;
    // #578 put a second control behind it — but only in ONE state. hBind is
    // leadBind alone when a size is pinned, and leadBind is the smaller term
    // whenever the marker's pitch bites first; ROW_SHARE lives in boxBind and
    // nowhere else. So the sentence is chosen from the fit, and in the state
    // where "גובה השורה" cannot move the number it says so.
    expect(html).toContain('רווח בין שורות" או ב"גובה השורה"');
    expect(html).toContain('כאן רק "רווח בין שורות" מרים אותו');
    expect(html).toMatch(/rowBinds: !pinned && boxBind < leadBind,/);
    expect(html).toContain('capMax(id, fit.hBind, CAP_WHY.word(fit))');
  });
});

// ---------------------------------------------------------------------------
// …and the same thing again, RUN rather than read.
//
// Everything above this line is a text match, which is all the surface tests
// need to be — but "the dashes are the rows the file gets" is a claim about
// arithmetic, and an earlier attempt at this fix re-anchored the rectangles on
// the WORD PAINTER's walk and passed every string assertion while drawing four
// rows the save had never heard of. So the page's own code is lifted out of the
// HTML and executed here, and the drawing is compared against the save.
//
// THE INVARIANT IS THE SAVE, not drawWords. The press reads `card_slots.words`:
// exactly four slots (generator/config.py CARD_WORD_SLOTS = 4, and card_slots()
// rejects a shorter list), and render_page._grid_centers anchors every entry on
// THOSE centres — a wrapped entry grows about its own slot rather than claiming
// a second one. What the owner drags against therefore has to be what `saveOut`
// writes, or she calibrates against a picture the paper never receives.
describe('the drawn rows are the rows the file gets (executed)', () => {
  // The painters are plain declarations in one inline <script>, so they can be
  // cut out by brace-matching and compiled on their own. Nothing in them is a
  // string or comment holding an unbalanced brace.
  function fnSource(name) {
    const at = html.indexOf('\n  function ' + name + '(');
    expect(at, name + ' is no longer a top-level function on the page').toBeGreaterThan(-1);
    let d = 0,
      i = html.indexOf('{', at);
    for (; i < html.length; i++) {
      if (html[i] === '{') d++;
      else if (html[i] === '}' && --d === 0) break;
    }
    const src = html.slice(at + 1, i + 1);
    expect(src.endsWith('\n  }'), name + ' did not close where expected').toBe(true);
    return src;
  }

  /** The save's OWN expression for card_slots.words, lifted out of writeJSON and
   *  run — so this compares two live pieces of the page rather than two readings
   *  of one helper name. */
  function saveExpr() {
    const m = html.match(/words: (rowSlots\(\)\.map\(\(r\) => \(\{[\s\S]*?\}\)\)),\n/);
    expect(m, 'saveOut no longer builds card_slots.words the way this test reads it').toBeTruthy();
    return m[1];
  }

  const CARD = { CW: 300, CH: 420 };
  const REF = 200;
  // A face where the tall letters matter, so an anchor taken off the alphabet
  // and one taken off a short word are visibly different numbers.
  const ASC = (t) => (/[לךףץ]/.test(t) ? 0.78 : 0.55) * REF;

  /** Compile the page's row geometry against stubs and read both ends of it. */
  function bench({ share = 0.39, pitch = 1, base = 0, step = 26, last = 18 } = {}) {
    const env = {
      S: { band: { x0: 0.1, x1: 0.9, y0: 0.25, y1: 0.8 } },
      CW: CARD.CW,
      CH: CARD.CH,
      REF,
      CENTER_DROP: 0.34,
      ROW_TOP_0: 0.3,
      ROW_BOT_0: 0.09,
      ROW_SHARE_0: 0.39,
      inkBox: (t) => ({ a: ASC(t), d: 0.2 * REF }),
      $: (id) => ({ value: id === 'wPitch' ? String(pitch) : '0' }),
      el: (tag, attrs) => ({ tag, attrs, textContent: '' }),
      r4: (n) => Math.round(n * 1e4) / 1e4,
    };
    // rowTop/rowBot are the page's own arrows, so ROW_SHARE really is the thing
    // "גובה השורה" moves — the whole claim of this change.
    const arrows = html.match(/ {2}const rowTop = \(\) => .+\n {2}const rowBot = \(\) => .+\n/);
    expect(arrows, 'rowTop/rowBot are no longer where this test reads them').toBeTruthy();
    const src =
      `let _ASC = null;\nlet LASTSIZE = ${last};\nlet ROW_SHARE = ${share};\n` +
      `let STEP = ${step};\nlet PITCH_BASE = ${base};\nlet PITCH_R0 = -1;\n` +
      arrows[0] +
      ['faceAscent', 'blockTop', 'pitchUnits', 'rowCentres', 'rowSlots', 'drawRows']
        .map(fnSource)
        .join('\n');
    const make = new Function(
      ...Object.keys(env),
      src + `\nreturn { blockTop, rowCentres, rowSlots, drawRows, saved: () => (${saveExpr()}) };`
    );
    const M = make(...Object.values(env));

    const rects = [];
    M.drawRows({ appendChild: (n) => rects.push(n) });
    return { M, rects, saved: M.saved() };
  }

  it('there are exactly four, because the press takes four and refuses fewer', () => {
    // config.CARD_WORD_SLOTS = 4; card_slots() returns None on a shorter list, so
    // the template silently falls back to a detected recipe. A drawing with any
    // other count is a drawing of a card that cannot be saved.
    const b = bench();
    expect(b.rects).toHaveLength(4);
    expect(b.saved).toHaveLength(4);
  });

  it('each drawn rectangle IS the slot the save writes', () => {
    const b = bench();
    b.rects.forEach((r, i) => {
      expect(r.attrs.y / CARD.CH).toBeCloseTo(b.saved[i].y0, 3);
      expect((r.attrs.y + r.attrs.height) / CARD.CH).toBeCloseTo(b.saved[i].y1, 3);
      expect(r.attrs.x / CARD.CW).toBeCloseTo(b.saved[i].x0, 3);
      expect((r.attrs.x + r.attrs.width) / CARD.CW).toBeCloseTo(b.saved[i].x1, 3);
    });
  });

  it('and they are anchored where the save anchors them, not on a word', () => {
    // Guard against the assertion above passing for the wrong reason. The save
    // hangs the grid off blockTop(LASTSIZE) — faceAscent, the WHOLE alphabet's
    // ascent. An anchor taken off a short first word ('ים' opens the short case)
    // lands more than a third of a row away, and a row is 0.39 of the pitch.
    const b = bench();
    const alphabet = b.M.blockTop(18);
    const firstCentre = b.rects[0].attrs.y + 26 * 0.3;
    expect(firstCentre).toBeCloseTo(alphabet, 9);
    expect(Math.abs(b.M.blockTop(18, 'ים') - alphabet)).toBeGreaterThan(0.39 * 26 * 0.33);
  });

  it('"גובה השורה" moves the rectangle — and moves the saved slot with it', () => {
    // The reason the change exists: the slider edits ROW_SHARE, which until now
    // was drawn nowhere. Both ends have to answer it, and by the same amount.
    const a = bench({ share: 0.39 });
    const b = bench({ share: 0.78 });
    const hA = a.rects[0].attrs.height,
      hB = b.rects[0].attrs.height;
    expect(hB).toBeCloseTo(hA * 2, 9);
    expect(b.saved[0].y1 - b.saved[0].y0).toBeCloseTo((a.saved[0].y1 - a.saved[0].y0) * 2, 3);
    // the CENTRES do not move — a row grows about its own calibrated middle
    const mid = (r, h) => r.attrs.y + h * (0.3 / 0.39);
    expect(mid(b.rects[0], hB)).toBeCloseTo(mid(a.rects[0], hA), 6);
  });

  it('the pitch under the drawing is the pitch under the save', () => {
    // These were two different numbers: rowCentres() steps by pitchUnits() while
    // the save sized the row by fit.step, so a slider moved after the last fit
    // wrote a rectangle nothing on screen had drawn.
    const a = bench({ base: 20, pitch: 1.3 });
    const b = bench({ base: 20, pitch: 1.6 });
    const gapA = a.rects[1].attrs.y - a.rects[0].attrs.y;
    const gapB = b.rects[1].attrs.y - b.rects[0].attrs.y;
    expect(gapA).toBeCloseTo(26, 9);
    expect(gapB).toBeCloseTo(32, 9);
    a.rects.forEach((r, i) => expect(r.attrs.y / CARD.CH).toBeCloseTo(a.saved[i].y0, 3));
    b.rects.forEach((r, i) => expect(r.attrs.y / CARD.CH).toBeCloseTo(b.saved[i].y0, 3));
  });
});

describe('a row\u2019s height is the template\u2019s, not a constant', () => {
  // The press sizes words at median(row height) x _WORD_SIZE_K, so a row's share
  // of the gap IS the size. This page wrote 0.39 over whatever a design actually
  // had — a claim about every template rather than a measurement of any.
  //
  // Measured on staging: five templates sit at exactly 0.390 (the constant,
  // written back by this page) while birthday-girls sits at 0.848 and prints at
  // 21.05 against a box that allows 21.62. Saving birthday-girls from this page
  // would have rewritten its rows to 0.39 and taken the type down by nearly half,
  // silently. That is what this stops.
  it('the share is read from the template, not hardcoded', () => {
    expect(html).toContain('function shareFromSlots(');
    expect(html).toMatch(/ROW_SHARE = own && own > 0 \? own : ROW_SHARE_0;/);
    // ROW_TOP/ROW_BOT keep their 0.30 : 0.09 proportion INSIDE the share — that
    // ratio is the shape of a line of type, and only the total was in question.
    expect(html).toContain('const rowTop = () => (ROW_TOP_0 / ROW_SHARE_0) * ROW_SHARE;');
    expect(html).toContain('const rowBot = () => (ROW_BOT_0 / ROW_SHARE_0) * ROW_SHARE;');
  });

  it('the fit and the save both measure with the live share', () => {
    expect(html).toContain('const boxBind = step * ROW_SHARE * WORD_SIZE_K;');
    // The save reads the rectangle off rowSlots(), which is where the share
    // arithmetic now lives — one copy, shared with the drawing.
    expect(html).toContain('return rowCentres().map((cy) => ({ y0: cy - step * rowTop()');
    expect(html).toContain('y1: cy + step * rowBot() }));');
    expect(html).toMatch(/words: rowSlots\(\)\.map\(\(r\) => \(\{/);
    // …and nothing measures with the bare constants any more.
    expect(html).not.toMatch(/step \* \(ROW_TOP \+ ROW_BOT\)/);
  });

  it('it is a slider, and it stops where two rows would touch', () => {
    expect(html).toMatch(/<label for="wRowH">גובה השורה<\/label>/);
    expect(html).toMatch(/id="wRowH"[^>]*type="range"|type="range" id="wRowH"/);
    // The bound is the face's own leading need, not a second constant.
    expect(html).toContain('r2(1 / (WORD_SIZE_K * fit.lead))');
    expect(html).toContain('מעבר לזה שתי שורות נוגעות');
  });

  it('an un-calibrated template still opens on the old constant', () => {
    // A detected recipe has four DIFFERENT row heights (birthday-girls' spread is
    // 69%), so there is no single share to read; flattening those quietly is the
    // thing being fixed, not something to do earlier.
    expect(html).toContain('const ROW_SHARE_0 = 0.39;');
    expect(html).toMatch(/if \(!Array\.isArray\(w\) \|\| w\.length < 2\) return null;/);
  });
});

describe('a ceiling says where it stops', () => {
  // The owner asked twice why a ceiling ends at 14.2 and not 99. It ends at the
  // largest size that box could ever set — above it a ceiling can never bite —
  // so the slider names that number instead of leaving it a mystery.
  it('capMax writes the bound out in words, under the reading', () => {
    expect(html).toMatch(
      /end\.textContent = 'עד ' \+ r2\(top\) \+ ' — ' \+ \(why \|\| CAP_WHY\.box\)/
    );
    expect(html).toContain("(o || e).insertAdjacentElement('afterend', end)");
  });

  // …AND IT NAMES THE RIGHT MEASUREMENT. One sentence served all six sliders and
  // was true of only three of them: a TITLE ceiling really is bounded by its own
  // box (fitFor's capH divides bh), while a WORD ceiling is bounded by the row
  // PITCH — hBind is leadBind (step / markerLead), or min of that and boxBind
  // (step x ROW_SHARE x WORD_SIZE_K) where nothing pins the size, and no term
  // reads S.band's rectangle at all. So "make the box bigger" moved a title's
  // number and could never move a word's, which is exactly what the owner hit.
  it('a word ceiling points at the line gap, not at the box, in every state', () => {
    expect(html).toMatch(/word: \(fit\) =>/);
    expect(html).toMatch(/'הכי גדול שהשורה מחזיקה\..*רווח בין שורות/);
    // Both branches keep saying the box is not the answer here.
    expect(html.match(/גודל הקופסה לא משנ/g) || []).toHaveLength(2);
    expect(html).toContain('capMax(id, fit.hBind, CAP_WHY.word(fit))');
  });

  it('a title ceiling is the one bounded by its own box, and says height', () => {
    // The title sliders take the default, so nothing passes them a reason — the
    // fallback IS their sentence, and it is about height: the width only ever
    // enters through the other half of min(width fit, height fit).
    expect(html).toMatch(/box: 'הכי גדול שהקופסה הזו מחזיקה לגובה/);
    expect(html).toContain("capMax('tCapEn', tEn)");
    expect(html).toContain("capMax('bCapEn', bEn)");
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
