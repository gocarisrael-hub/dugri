#!/usr/bin/env python3
"""Render one full 8-card page: overlay title + words onto the CLEAN background
at the recipe slots. No masking needed (background is already text-free).

  python3 generator/render_page.py <theme> <clean_svg> <csv> <row> <title> <out.png>
"""
import base64
import collections
import functools
import itertools
import os
import re
import sys
import csv as csvmod

import card_paper
import chrome
import config
import deck_html

# Chrome itself lives in generator/chrome.py — ONE module owns the binary, the
# flag set, the timeout and the kill-on-expiry, so no render path can be added
# without them (a Chrome that never exits used to orphan itself and eat the
# container's whole PID budget). These two names are re-exported because callers
# and tests across the generator read them from here.
CHROME = chrome.CHROME
CHROME_FONT_WAIT = chrome.FONT_WAIT
HERE = os.path.dirname(os.path.abspath(__file__))

# Chrome grid-fits/stem-darkens (hints) a live @font-face at the small on-card
# render sizes, painting glyphs ~25% heavier than their true outline weight. The
# Canva originals are OUTLINED paths (never hinted), so they stay thin — the
# generator looked bold by comparison. Turning hinting off makes every glyph
# paint at its true outline weight, matching the origin. Applied as ONE global
# rule alongside the @font-face block on every render path (fronts, board, backs)
# so titles and words stay in lock-step.
GEOMETRIC_TEXT_STYLE = "text{text-rendering:geometricPrecision;}"


def dims(svg):
    head = open(svg, encoding="utf-8").read(2000)
    w = int(re.search(r'width="(\d+)"', head).group(1))
    h = int(re.search(r'height="(\d+)"', head).group(1))
    return w, h


@functools.lru_cache(maxsize=32)
def weight_axis(path):
    """``(minimum, default, maximum)`` of a font file's weight axis, or None.

    A VARIABLE font is nine cuts in one file and picks one by an axis value.
    Nothing here used to ask, so an uploaded variable face was drawn at its
    axis DEFAULT — and League Spartan's default is 100, Thin, the lightest of
    its nine. The owner's מרקאנה title, set Bold in the design, printed as a
    hairline. Static faces have no axis and answer None, so they take exactly
    the path they always did.
    """
    try:
        from PIL import ImageFont
        for axis in ImageFont.truetype(path, 32).get_variation_axes():
            if (axis.get("name") or b"").strip().lower() in (b"weight", b"wght"):
                return (axis["minimum"], axis["default"], axis["maximum"])
    except Exception:      # noqa: BLE001 — a static face raises; that is the answer
        return None
    return None


def font_face(name, path, weight=None):
    """An @font-face rule embedding a font file as base64.

    A variable face declares its WHOLE weight range rather than a flat 400. Two
    things follow, both of them fixes: Chrome stops synthesising a fake bold for
    it (asked for 700 against a 400-only face it smears the outline — measured,
    the ink grows 4% taller and stays the same width, which is not a heavier
    cut), and the ``wght`` instance the design was set in can be selected. The
    instance is declared on the FACE, so every element using the family gets it
    with no per-call plumbing.
    """
    b64 = base64.b64encode(open(path, "rb").read()).decode()
    axis = weight_axis(path)
    if axis:
        lo, default, hi = axis
        pick = default if weight is None else min(hi, max(lo, float(weight)))
        span = (f"font-weight:{lo:g} {hi:g};"
                f"font-variation-settings:'wght' {pick:g};")
    else:
        span = "font-weight:400;"
    return (f"@font-face{{font-family:'{name}';{span}font-style:normal;"
            f"src:url(data:font/ttf;base64,{b64}) format('truetype');}}")



# THE MEASURING INSTRUMENT MUST DRAW THE SAME PICTURE EVERYWHERE.
#
# Pillow lays text out with one of two engines. BASIC walks the string in
# LOGICAL order, one glyph after the next. RAQM — bundled in the manylinux
# wheels, absent from the macOS ones — runs the full Unicode bidi algorithm and
# reorders a Hebrew run itself.
#
# Every reading in this module compensates for BASIC. ``visual_order`` exists
# precisely because Pillow does not reorder and Chrome does, so it puts the
# string into paint order by hand before rasterizing it. Hand that already
# reordered string to RAQM and it reorders it a SECOND time: the measurement is
# then taken of a picture nothing ever prints. Measured on the same four Hebrew
# words, the per-column row floor came back 0.92 of the type size under BASIC
# and 1.49 under RAQM — a 62% difference in a number that decides how far apart
# a card's rows sit, purely from which wheel was installed.
#
# So the engine is PINNED. Not to whichever is better — to the one every
# calibrated constant in this module and in ``calibrate`` was measured against,
# so a card renders identically on a developer's laptop, in CI and in the
# production image. Chrome, which does the real rendering, is unaffected by any
# of this; only the ruler is being held still.
def _measuring_font(font_path, size):
    from PIL import ImageFont
    return ImageFont.truetype(font_path, size,
                              layout_engine=ImageFont.Layout.BASIC)


@functools.lru_cache(maxsize=8)
def _word_metrics(font_path, ref=200):
    return _measuring_font(font_path, ref), ref


# How many times the metric size a glyph is rendered at when its ink edges are
# measured. A bitmap answers in whole pixels, so measuring at the metric size
# alone quantises the bearings to 1 unit of 200 — 0.1 user units at card sizes.
# Four times over gives a quarter-unit answer, which is a hundredth of a
# millimetre on the printed card and costs one 2400px render per glyph, once.
_BEARING_SS = 4


@functools.lru_cache(maxsize=64)
def _glyph_bearings(font, ref, ch):
    """``(lsb, rsb)`` — the gaps from ``ch``'s ADVANCE edges to its INK, at ``ref``.

    Measured off a rendered bitmap, because ``ImageFont.getbbox`` cannot answer
    this: for the calibrated word faces it reports 0..advance horizontally — the
    LAYOUT box, not the outline. Drawn and measured instead, Cafe's digits carry
    left bearings of 14 / 8 / 7 / 2 units of a 200 em and right bearings of
    9 / 8 / 8 / 9, so advance and ink are genuinely different spans and pinning
    one does not pin the other. Nine glyphs per face, cached for the process.
    """
    from PIL import Image, ImageDraw
    big = _measuring_font(font.path, ref * _BEARING_SS)
    pad = ref * _BEARING_SS
    im = Image.new("L", (pad * 3, pad * 3), 0)
    ImageDraw.Draw(im).text((pad, pad), ch, font=big, fill=255)
    bb = im.getbbox()
    if not bb:                                # whitespace: no ink to bear
        return 0.0, 0.0
    return ((bb[0] - pad) / _BEARING_SS,
            (big.getlength(ch) - (bb[2] - pad)) / _BEARING_SS)


def _marker_geometry(font, ref, num, msize, advance=None):
    # Standard numbered look in RTL: the DIGIT is the rightmost glyph and the
    # PERIOD sits immediately to its LEFT (so reading right-to-left gives "1."),
    # then a gap, then the word. Digit and period are separate <text> runs so
    # bidi can never reorder the "." away from its digit. Returns the digit
    # string, the digit's own right-anchor offset, the period's right-anchor
    # offset (both relative to the line's right edge) and the marker's total
    # width (digit + tiny inter-gap + period) — the caller uses the width to
    # place the word.
    #
    # ``advance`` (in ``ref`` units) makes the DIGIT COLUMN a fixed width instead
    # of the drawn digit's own advance. The calibrated Hebrew faces have no
    # tabular figures and their digits differ wildly — Cafe sets "1" at 54 units
    # of a 200 em against "2" at 110 — so measuring each digit put every entry's
    # period and word at a different x: 0.28 x the font size of drift, 1.7 mm at
    # the 16.8 these cards set at. That is the ragged left edge the owner
    # reported. The fixed column keeps the WORDS all starting at the same x.
    #
    # WHAT THE DIGIT IS PINNED BY. #294 centred each digit inside that column,
    # which lined the PERIODS up (they hang off the column, not off the digit)
    # and left the digits' own right edges ragged by the half-column difference:
    # measured on grapefruit, the four digits' anchors spread over 2.24 units,
    # 0.8 mm, exactly the wobble the owner then photographed. Her instruction is
    # to align by "the right outer boundary of the number", so the DIGIT'S INK
    # right edge is pinned to the line's right edge and the period is placed
    # relative to that digit's ink. The dots therefore do NOT form a column any
    # more — that is the accepted trade, not a regression; the two cannot both be
    # true on a face whose digits are different widths.
    #
    # Ink, not advance: the right edge asked for is the one you can SEE, and the
    # two differ by 8-9 units of a 200 em on this face (see ``_glyph_bearings``).
    #
    # Only when a fixed column is in play (a declared v2 card, where the four
    # numbers really do share one anchor). The v1 sheet anchors every line on its
    # OWN slot, so its digits never shared an x to be ragged about, and it stays
    # byte for byte as calibrated.
    digit = f"{num}"
    digit_w = font.getlength(digit) / ref * msize
    col_w = digit_w if advance is None else advance / ref * msize
    dot_w = font.getlength(".") / ref * msize
    tiny = msize * 0.06                      # hairline gap between digit & period
    marker_w = col_w + tiny + dot_w          # full marker span (digit..period)
    if advance is None:
        return digit, 0.0, -col_w - tiny, marker_w
    d_lsb, d_rsb = (v / ref * msize for v in _glyph_bearings(font, ref, digit))
    _, dot_rsb = (v / ref * msize for v in _glyph_bearings(font, ref, "."))
    ink_w = digit_w - d_lsb - d_rsb
    # text-anchor="end" pins the ADVANCE right edge, so push it right by the
    # digit's own right bearing and the INK lands exactly on the line's edge.
    digit_x = d_rsb
    # The period hangs off the digit's INK left edge, a hairline clear of it.
    dot_x = -(ink_w + tiny) + dot_rsb
    return digit, digit_x, dot_x, marker_w


def _marker_advance(font, count):
    """Width of the fixed digit column for a card of ``count`` numbered entries.

    The WIDEST digit actually used, so no marker ever overflows its column and
    every word starts at the same x (see ``_marker_geometry``). In ``ref`` units.
    """
    return max(font.getlength(f"{n}") for n in range(1, max(count, 1) + 1))


# Explicit RTL base direction for ONE line of customer text, as bidi control
# characters embedded in the text itself (U+202B RIGHT-TO-LEFT EMBEDDING …
# U+202C POP DIRECTIONAL FORMATTING).
#
# WHY the characters and not the attribute: a bare <text> run has NO stated base
# direction, so Chrome falls back to LTR and the Unicode bidi algorithm orders
# the line by its FIRST strong character. Every customer word that starts with a
# Hebrew letter is therefore already correct by luck — which is why this went
# unnoticed — but a line that starts with DIGITS is laid out LTR-first and comes
# out reversed. Measured against a real HTML ``dir="rtl"`` paragraph in the same
# face and size:
#
#   "40 מתחת"      truth: 40 on the RIGHT  |  no embedding: 40 on the LEFT  WRONG
#   "40 מתחת ל40"  truth: 40 on the RIGHT  |  no embedding: misplaced       WRONG
#   "מתחת ל40"     identical                                                fine
#   "בת 40"        identical                                                fine
#   "מסיבה"        identical                                                fine
#
# With the embedding all five match the browser exactly, so it is applied to
# every line unconditionally: a no-op on the three that were already right, a fix
# on the two that were not. Wrapping is what exposed this — splitting
# "40 מתחת ל40" produces a line "40 מתחת" that BEGINS with digits.
#
# WHY not direction="rtl" on the <text>: tried, and it breaks the anchoring
# model — with text-anchor="end" the runs render off-canvas. The embedding leaves
# the anchor alone and only states the base direction of the characters.
#
# NEVER applied to the marker runs below: the digit is deliberately
# direction="ltr" and the period is a separate run precisely so bidi cannot
# reorder them (see word_lines).
_RTL_EMBED, _RTL_POP = "‫", "‬"


def word_lines(x_right, center_y, size, color, num, lines, font_path, lead=None,
               marker_advance=None, bold_w=0.0):
    """One numbered entry, wrapped over ``lines``, as SVG markup.

    RTL numbered line: the marker must sit on the RIGHT (the Hebrew reading
    start) and the word flow to its LEFT. Chrome's headless SVG text engine
    ignores ``direction="rtl"`` (and inline bidi controls) for run ORDERING,
    and when Hebrew + digits + the neutral "." share one <text> the bidi
    algorithm reorders the "." AWAY from its digit. So we render the DIGIT,
    the PERIOD and the WORD as THREE independent right-anchored <text> runs —
    no bidi crosses an element boundary. The digit's right edge is pinned to
    the slot's right edge (rightmost glyph); the period is pinned just to its
    LEFT; the word is right-aligned just left of the whole marker. Each WORD run
    carries an explicit RTL embedding so a line that starts with digits is not
    laid out LTR-first (see ``_RTL_EMBED``).

    Continuations hang under the FIRST LINE'S TEXT, not under the marker, which
    is the conventional numbered-list shape and keeps the digit column clean. The
    block is centred on ``center_y`` so a wrapped entry grows symmetrically into
    the air above and below rather than drifting down into its neighbour. On a
    declared card the caller does not pass the slot centre here — it passes the
    centre the CARD-WIDE line grid put this entry on (see ``_grid_centers``), so
    every gap on the card, inside an entry or between two, is the same.

    ``lead`` is the baseline pitch as a multiple of ``size``; omitted, it is
    measured from these very lines (see ``_lead_for``). ``marker_advance`` fixes
    the digit column width so every entry's word starts at the same x; omitted,
    each digit is measured as before and the v1 sheet renders byte for byte
    unchanged.

    ``bold_w`` fattens every run with a stroke IN ITS OWN COLOUR — synthetic
    bold for a template whose origin words are heavier than the cut we ship (see
    ``_WORD_BOLD_W``). The marker is fattened with the word so a bold card does
    not read as bold words beside thin numbers. Zero (the default) emits the
    exact markup it always did.
    """
    msize = size * _MARKER_SCALE
    font, ref = _word_metrics(font_path)
    digit, digit_x, dot_x, marker_w = _marker_geometry(font, ref, num, msize,
                                                       advance=marker_advance)
    gap = size * _WORD_GAP
    word_x = x_right - marker_w - gap
    lead = size * (_lead_for(font, ref, lines) if lead is None else lead)
    first = center_y - (len(lines) - 1) * lead / 2 + size * _CENTER_DROP
    # paint-order="stroke" keeps the stroke UNDER the fill, so the glyph grows
    # outward instead of the stroke eating into its own counters.
    fat = (f'stroke="{color}" stroke-width="{size * bold_w:.2f}" '
           'paint-order="stroke" stroke-linejoin="round" ') if bold_w else ""
    m_fat = (f'stroke="{color}" stroke-width="{msize * bold_w:.2f}" '
             'paint-order="stroke" stroke-linejoin="round" ') if bold_w else ""
    out = [
        f'<text x="{x_right + digit_x:.2f}" y="{first:.2f}" font-family="HebWord" '
        f'font-size="{msize:.2f}" fill="{color}" {m_fat}text-anchor="end" '
        f'direction="ltr" xml:space="preserve">{digit}</text>'
        f'<text x="{x_right + dot_x:.2f}" y="{first:.2f}" font-family="HebWord" '
        f'font-size="{msize:.2f}" fill="{color}" {m_fat}text-anchor="end" '
        f'xml:space="preserve">.</text>'
    ]
    for i, line in enumerate(lines):
        out.append(
            f'<text x="{word_x:.2f}" y="{first + i * lead:.2f}" '
            f'font-family="HebWord" font-size="{size:.2f}" fill="{color}" '
            f'{fat}text-anchor="end" xml:space="preserve">'
            f'{_RTL_EMBED}{escape(line)}{_RTL_POP}</text>'
        )
    return "".join(out)


def word_text(x_right, baseline, size, color, num, word, font_path):
    """One numbered entry on a SINGLE line, anchored by its baseline.

    The unwrapped case, kept as its own entry point because a caller that has
    already decided the word fits wants to place a baseline, not a block centre.
    """
    return word_lines(x_right, baseline - size * _CENTER_DROP, size, color, num,
                      [word], font_path)


def escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# Fraction constants shared with word_text() so the fit calculation and the
# actual render stay in lock-step: the marker (digit+period) renders at 0.9x the
# word size, and a 0.30x gap separates the marker from the word.
_MARKER_SCALE = 0.9
_WORD_GAP = 0.30
# Synthetic-bold stroke for the WORDS, as a fraction of the word size — the same
# trick the title already uses (see _BOLD_WEIGHT), for a template whose origin
# set its words in a heavier cut than the face we ship. Opt in per theme via
# ``word_bold``; ``word_bold_w`` overrides the weight. Kept lighter than the
# title's default because a card word is set far smaller, and a heavy stroke
# closes up Hebrew counters first at that size.
_WORD_BOLD_W = float(os.environ.get("DUGRI_WORD_BOLD_W", "0.028"))
# Where a line's BASELINE sits below the visual centre the callers place, as a
# fraction of the font size. Every caller works in centres (a slot centre, or a
# grid centre); the renderer converts once, here.
_CENTER_DROP = 0.34

# House-style minimum right margin for a numbered line, as a fraction of the card
# cell width. A numbered line is right-anchored: its DIGIT (rightmost glyph) is
# pinned to the line's right edge. Recipe auto-detection normally records that
# edge with a healthy inset, but on some templates (japanese) it collapsed
# the slot's right edge onto the CELL EDGE, so the digit rendered ON the border
# and got clipped. Clamping every numbered line to at least this right margin
# keeps the marker inside the card for ANY template — a no-op for already-inset
# slots, a pull-in for an edge-pinned one. Generic, not per-template.
_LINE_RIGHT_MARGIN = float(os.environ.get("DUGRI_LINE_RIGHT_MARGIN", "0.21"))


def _line_right_edge(slot_x1, cell):
    """Right anchor (digit right edge) for a numbered line, clamped inside the
    card cell by ``_LINE_RIGHT_MARGIN`` so the marker never lands on the border.
    ``cell`` is [x0,y0,x1,y1]; without it the raw ``slot_x1`` is returned."""
    if not cell:
        return slot_x1
    return min(slot_x1, cell[2] - _LINE_RIGHT_MARGIN * (cell[2] - cell[0]))


def _card_right_edge(slots, cell):
    """ONE right anchor for every numbered line on a declared card.

    The four slots are supposed to share an anchor — the origin's numbers sit in
    a column — but each recorded box is the INK extent of a different origin
    word, so they disagree: on the affected deck by 2.24 units (0.8 mm) between
    slot 3 and slot 4, which is a visibly ragged column of digits. The WIDEST
    right edge is the honest estimate of where that column really is (ink can
    only fall short of the anchor, never past it), clamped as always so the
    marker cannot land on the card border.
    """
    return _line_right_edge(max(s["x1"] for s in slots), cell)


def _declared_left(slot, cell):
    """Left bound of a declared words column, widened to ``_BAND_LEFT_MAX``."""
    if not cell:
        return slot["x0"]
    return min(slot["x0"], cell[0] + _BAND_LEFT_MAX * (cell[2] - cell[0]))


def _line_width_at(font, ref, num, word, advance=None):
    """Full numbered-line width (marker + gap + word) at the metric ``ref`` size.
    Everything scales linearly with the font size, so a width measured at ``ref``
    converts to any render size S by multiplying by S/ref. ``advance`` must be
    the same fixed digit column the render uses, or the fit and the render
    disagree about where the word starts."""
    _, _, _, marker_w = _marker_geometry(font, ref, num, ref * _MARKER_SCALE,
                                         advance=advance)
    return marker_w + ref * _WORD_GAP + font.getlength(word)


# The origin template renders every word on a card at ONE font size (Canva Bulk
# Create fills a fixed-size text box). The recipe's per-slot boxes are just where
# that single size landed on the ORIGIN words, so their heights encode the origin
# size: a slot's box height ~= the ink height of a full Hebrew line (letters +
# number, incl. the odd ascender/descender) at the origin size. Empirically the
# origin size ~= median(box height) x 1.3 for the calibrated Hebrew word face.
_WORD_SIZE_K = float(os.environ.get("DUGRI_WORD_K", "1.3"))


# WRAPPING. A customer word is often a PHRASE ("להקת שבעת הכוכבים"), and the
# origin templates were calibrated against single words. Rendered as one line a
# phrase runs left out of its slot, across the artwork and — measured on
# grapefruit — past the TRIM line, so the guillotine amputates it. Canva's own
# text box wraps instead of overflowing, so we wrap too: split at spaces and hang
# the continuation under the first line's text.
#
# Clear air between the INK of one wrapped line and the ink of the next, as a
# fraction of the font size. The pitch itself is MEASURED, not fixed: a constant
# lead collides, because the calibrated Hebrew faces draw far outside their em.
# Cafe sets "לקחת" 1.45x its own font size tall, with ascenders reaching y=8 of
# a 200-unit em and descenders down to y=325 — so a 0.95 lead put the ל of one
# line straight through the letters above it. _lead_for measures the two lines
# actually being set and spaces them by what those glyphs need.
_WRAP_GAP = float(os.environ.get("DUGRI_WRAP_GAP", "0.07"))
# Clear air to leave between one entry's ink and the next entry's, as a fraction
# of the size. Must stay wider than _WRAP_GAP leaves between two lines of the
# SAME entry, or the four entries stop reading as four items: the continuation of
# entry 2 would sit as close to entry 3 as to its own first line.
_WRAP_CLEAR = float(os.environ.get("DUGRI_WRAP_CLEAR", "0.30"))
# Most lines a phrase may wrap onto. Past three the type is smaller than the gain.
_WRAP_MAX_LINES = int(os.environ.get("DUGRI_WRAP_MAX_LINES", "3"))
# Hard floor on a line's left edge, as a fraction of the cell width — the LAST
# defence, not the layout bound. Two values because "the cell" is not the same
# thing in the two deck formats, and the fraction has to mean the same MARGIN
# INSIDE THE FINISHED CARD in both:
#
#   v1 — the cell is one card of the 8-up sheet, i.e. the card as trimmed. 2% of
#        it is 2% inside the finished card.
#   v2 — the card page carries its own bleed (grapefruit: 2.495 mm, 3.2% of the
#        223.92-unit width), so the cell is BIGGER than the finished card and a
#        fraction of it over-counts. 5% of the page is ~1.8% inside the trim —
#        the same real margin as v1's 2%.
#
# The old code used 0.02 for both. On grapefruit that put the bound 4.5 units
# from the page edge while the trim line sits at 7.1, so it licensed ink in the
# region the guillotine removes: the reported amputation.
_CELL_SAFE = float(os.environ.get("DUGRI_CELL_SAFE", "0.02"))
_CARD_SAFE = float(os.environ.get("DUGRI_CARD_SAFE", "0.05"))
# How far right a DECLARED words column may start, as a fraction of the card
# width. The owner's choice, measured on the affected deck.
#
# A declared column is traced by eye around the ORIGIN card's words, and the
# origin words are short, so the traced left edge records where those particular
# words happened to stop — not a text box anyone drew. On the "Bride in One Pot"
# deck it came out at 0.448, a column 21.7 mm wide, while the printed frame
# leaves 61.5 mm of clear paper (0.110..0.890, measured off the artwork). Two-word
# entries like "סדנה שמית" therefore wrapped with 27 mm standing empty to their
# left, which is what the owner reported. Grapefruit has the same shape at 0.300
# (31.6 mm of the same 61.5).
#
# Rather than restate the boundary per theme, it is clamped here: the affected
# deck is an OWNER-UPLOADED template whose calibration lives in the admin store,
# not in themes.json, so a themes.json edit could not reach it — and every future
# upload would arrive with the same too-narrow trace. 0.200 leaves the ink about
# 15.8 mm from the page edge, 7 mm clear of the frame stroke, so nothing lands on
# the printed border. A column that already starts further LEFT is untouched.
_BAND_LEFT_MAX = float(os.environ.get("DUGRI_BAND_LEFT_MAX", "0.200"))


Layout = collections.namedtuple("Layout", "size lines lead center")
Layout.__new__.__defaults__ = (None,)   # center: None -> the caller's slot centre


def _lead_for(font, ref, lines):
    """Baseline-to-baseline pitch for a wrapped entry, as a multiple of the size.

    MEASURED from the glyphs actually being set, because the calibrated Hebrew
    faces draw well outside their em and by wildly different amounts: in Cafe at
    a 200-unit em, "ים" occupies y=141..254 while "לקחת" occupies y=8..298. A
    constant lead therefore either collides (the reported bug: the ל of one line
    struck the letters above it) or wastes height on lines that need none.

    For each stacked pair, the pitch has to carry the upper line's DESCENT plus
    the lower line's ASCENT, so the two inks clear by ``_WRAP_GAP``.
    """
    if len(lines) < 2:
        return 0.0
    need = 0.0
    for upper, lower in zip(lines, lines[1:]):
        drop = font.getbbox(upper)[3] - font.getbbox(lower)[1]
        need = max(need, drop / ref)
    return need + _WRAP_GAP


# Every glyph a card can print: the Hebrew alphabet (final forms included),
# Latin, the digits the markers set, and the punctuation a customer's phrase can
# carry. The FONT's worst case is measured over all of it — see ``_font_lead``.
_LEAD_REPERTOIRE = ("".join(chr(c) for c in range(0x05D0, 0x05EB))
                    + "0123456789"
                    + "abcdefghijklmnopqrstuvwxyz"
                    + "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                    + ".,:;!?()'\"-־׳״")


@functools.lru_cache(maxsize=8)
def _font_lead(font, ref):
    """The ONE line pitch this face needs, as a multiple of the font size.

    The owner's rule, in her words: "a fixed gap between lines (the minimum gap
    (that obey the rule that no 2 letters touch each other) between the most
    descent letter (above) and the most ascent letter (bottom)) … applied between
    all lines, same phrase or also totally different words."

    So it is a property of the FONT, not of the card: the deepest descender that
    can ever sit above a line, plus the tallest ascender that can ever sit below
    it, plus ``_WRAP_GAP`` of clear air. Measuring it per card — which is what
    ``_lead_for`` does — gave two cards of the same deck two different rhythms
    (30.56 against 29.39 on the owner's own two cards), and that difference is
    exactly what she is reading as inconsistent.

    Measured off rendered ink, not font metrics: these display faces draw far
    outside their em and the metrics do not describe where the ink actually is.
    Per 200-unit em, Cafe runs from y=0 ("h") to y=333 ("g"), 8..325 over Hebrew
    alone ("ל" over "ך") — a 1.665 pitch. The other shipped faces are far tighter
    (almoni 0.835, VarelaRound 1.005, Comix No2 1.095), so on those templates this
    floor never binds and the origin's own spacing stands.

    Drawn in chunks rather than glyph by glyph: only the vertical extremes matter,
    so a whole run of glyphs shares one bitmap and one measurement. Once per face
    per process.
    """
    from PIL import Image, ImageDraw
    top = bottom = None
    for i in range(0, len(_LEAD_REPERTOIRE), 24):
        run = _LEAD_REPERTOIRE[i:i + 24]
        w = max(int(font.getlength(run)) + 4 * ref, ref * 3)
        im = Image.new("L", (w, ref * 3), 0)
        ImageDraw.Draw(im).text((ref, ref), run, font=font, fill=255)
        bb = im.getbbox()
        if not bb:
            continue
        t, b = bb[1] - ref, bb[3] - ref
        top = t if top is None else min(top, t)
        bottom = b if bottom is None else max(bottom, b)
    if top is None:
        return 0.0
    return (bottom - top) / ref + _WRAP_GAP


# The digits and stop every card prints in its line markers (``word_lines``).
# They are set from the same face on the same baseline, so they belong in the
# card's own glyph repertoire even though they are drawn as a separate run.
_MARKER_GLYPHS = "1234567890."


def _card_lead(font, ref, lines, count=None, bold_w=0.0):
    """The pitch this card's own type needs, as a multiple of the size.

    The owner's rule: "the minimum gap (that obeys the rule that no 2 letters
    touch each other) between the most descent letter (above) and the most ascent
    letter (bottom) … applied between all lines". Two halves, and they pull
    against each other:

      NOT TOUCHING is about the glyphs that are actually set. The deepest
      descender that can sit above a line and the tallest ascender that can sit
      below it are properties of the TEXT ON THIS CARD, because those are the only
      letters that can ever be adjacent on it.

      ONE GAP FOR ALL LINES is about the card, and it is satisfied by taking the
      worst pair over the whole card and spacing every line by it — which is what
      this returns.

    This USED to reserve the worst case over an abstract repertoire of every
    glyph a card could ever print (``_font_lead``) — Hebrew, Latin, digits and
    punctuation together. #327 narrowed that to the card's own glyphs, and the
    reading was still taken off the lines' bounding BOXES: the deepest ink any
    line on the card puts below its baseline, plus the highest any line puts
    above its own, wherever on the line either happens to be.

    A BOX IS NOT A SHAPE, and on Hebrew that is most of the number. "1. סיף"
    carries its ink 0.15 of the size ABOVE the ascender line, at the yod; "3. חתן"
    hangs its final nun 0.5 of the size below the baseline, at the far end of the
    word. Boxed, those two lines demand 1.74 of the size between their baselines
    — and the two pieces of ink are nowhere near one another horizontally. Read
    COLUMN BY COLUMN on the rasterized glyphs, the same card asks 1.05, and the
    design's own row spacing (1.27 on סנטוריני) is then what sets the card. Boxed,
    it was not: 36% of that deck's cards came out spaced wider than the origin
    spaces its own, which is the "the word rows are too far apart" the owner read
    off her preview. Column by column, 2.3% do, and those are the cards whose
    letters really would have met.

    OF THE PAIRS THE CARD ACTUALLY STACKS, which is the other half of the same
    correction and the one the owner was still reading. #337 asked the question of
    every ORDERED pair instead — so that the same four words dealt into different
    slots would report the same pitch — and that charges a card for collisions it
    cannot have. On her front 2 the pair that set the card was "חתן" over "השראה"
    at 1.385 of the size, a stacking that is not on the card: השראה is printed
    ABOVE חתן, and read in the order it is printed the card asks 1.070 and the
    design's 1.27 stands. Over her real deck the every-ordered-pair reading left
    9.2% of cards spaced wider than the design spaces its own; the printed pairs
    leave 2.3%.

    The invariant it bought is not one the artwork or the owner asks for. Her
    rules are "no 2 letters touch" — a question about the letters that end up over
    one another, and about no others — one gap for every line of a card, and the
    deck spaced the way the design is. Order-independence serves none of the
    three and costs the third: it put four times as many cards off the deck's
    common rhythm. A re-deal of the same four words is a different card and is
    entitled to its own answer.

    THE MARKER COLUMN IS MEASURED SEPARATELY, because it is separate on the card:
    ``word_lines`` sets the digit and its stop as their own right-anchored runs, a
    clear ``_WORD_GAP`` of the size to the right of every word, so a marker can
    only ever meet another marker. Boxed is the honest reading there — a column
    one glyph wide has no shape to read — over the digits this card actually sets.

    Every word run shares ONE right anchor (``_card_right_edge``), which is what
    makes the per-column reading the right one: two rows overlap exactly where
    their ink shares a column of that shared edge.

    ``bold_w`` is the synthetic-bold stroke, as a fraction of the size. It is
    centred on the outline, so it grows each line by half its width top and bottom
    and two neighbours need the whole of it between their baselines — and half of
    it sideways, which can bring two columns into each other's reach that the bare
    outlines miss.

    Still provably safe, and now provable on the pixels rather than on a metric:
    no column of one row's ink reaches within ``_WRAP_GAP`` of the row below it.
    """
    texts = [ln for ln in lines if ln and ln.strip()]
    if not texts:
        return _font_lead(font, ref)
    marker = _MARKER_GLYPHS if not count else (
        "".join(str(n) for n in range(1, max(int(count), 1) + 1)) + ".")
    mbox = font.getbbox(marker)
    markers = (mbox[3] - mbox[1]) / ref * _MARKER_SCALE + _WRAP_GAP
    if len(texts) < 2:
        return max(markers, _WRAP_GAP)
    words = _min_line_pitch(font, ref, texts, bold_w or 0.0, align="right",
                            grow=(bold_w or 0.0) / 2, rtl=True, clear=_WRAP_GAP)
    return max(words, markers)


def _slot_pitch(slots, i):
    """Distance from slot ``i`` to its nearest neighbouring slot centre.

    The centre distance — not the slot's own height, which only records where the
    origin's single line of ink sat. A lone slot has no neighbour to collide
    with, so it reports twice its own height.
    """
    c = [(s["y0"] + s["y1"]) / 2 for s in slots]
    gaps = [abs(c[i] - c[j]) for j in range(len(slots)) if j != i]
    return min(gaps) if gaps else (slots[i]["y1"] - slots[i]["y0"]) * 2


# THE PRINTED FRAME. A card design draws a border and sets its text INSIDE it, so
# the frame — not the recipe's slots — is what says how much paper the words may
# use. Finding it is a geometry question the artwork already answers: a frame is a
# STROKED outline (``fill="none"`` plus a ``stroke``) that spans most of the card
# and is inset from all four edges. Nothing else in a Canva card export looks like
# that — the background is a filled rect flush to the edge, the decorations are
# filled paths a fraction of the card wide — so the test picks out the border and
# only the border. Verified against the rasterised artwork: on grapefruit the scan
# returns y=22.44..289.37 where a 200-dpi render of the same clean card puts the
# stroke's own pixels at 22.50..289.13, i.e. the two agree to a third of a unit
# (0.1 mm). Scanned rather than hardcoded so an owner-uploaded template — whose
# calibration lives in the admin store and never passes through this repo — is
# measured the same way grapefruit is.
#
# Read straight off the SVG instead of a raster because it needs no browser: the
# layout runs 104 times per order and inside unit tests, and shelling out to
# Chrome for each would be both slow and one more thing to fail in production. A
# template whose border is drawn some other way (a filled ring, an image) simply
# reports no frame, and the caller falls back to the trim-safe area.
_DEFS_BLOCK = re.compile(r"<defs\b.*?</defs>", re.S)
_GEOM_TAG = re.compile(r"<(/?)(g|path|rect)\b([^>]*?)(/?)>", re.S)
_ATTR = re.compile(r'([a-zA-Z:-]+)\s*=\s*"([^"]*)"')
_NUMBER = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")
_TRANSFORM = re.compile(r"(matrix|translate|scale)\s*\(([^)]*)\)")
# Any relative path command (lowercase), or one whose arguments are not xy pairs
# (H/V/A). Either makes a coordinate-pair reading of ``d`` wrong, so such a path
# is skipped rather than mis-measured. "Z" closes a subpath and takes no
# arguments, so it is harmless and left out of the range. A lowercase "e" from
# scientific notation trips this too — which only costs us a candidate we would
# have had to trust a hand-rolled parser for.
_PATH_UNREADABLE = re.compile(r"[a-y]|[HVA]")
_IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _mat_mul(a, b):
    """Compose two SVG transform matrices ``(a, b, c, d, e, f)`` (a then b)."""
    return (a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5])


def _parse_transform(text):
    """An SVG ``transform`` attribute as a matrix (matrix/translate/scale only).

    Those three are what Canva emits — grapefruit's own border arrives as a
    ``matrix(0.749732, 0, 0, 0.749732, 24.34, 22.44)`` around a path in its own
    coordinates, so ignoring transforms would place the frame at 0,0. A rotate or
    skew would need a different bbox anyway (the corners move), so it is left out
    and such an element reports its untransformed box; the inset test then almost
    always rejects it.
    """
    m = _IDENTITY
    for kind, args in _TRANSFORM.findall(text or ""):
        v = [float(x) for x in _NUMBER.findall(args)]
        if kind == "matrix" and len(v) == 6:
            t = tuple(v)
        elif kind == "translate" and v:
            t = (1.0, 0.0, 0.0, 1.0, v[0], v[1] if len(v) > 1 else 0.0)
        elif kind == "scale" and v:
            t = (v[0], 0.0, 0.0, v[1] if len(v) > 1 else v[0], 0.0, 0.0)
        else:
            continue
        m = _mat_mul(m, t)
    return m


def _path_points(d):
    """``d`` as a list of (x, y), or None when it cannot be read as xy pairs."""
    if not d or _PATH_UNREADABLE.search(d):
        return None
    v = [float(x) for x in _NUMBER.findall(d)]
    if len(v) < 4 or len(v) % 2:
        return None
    return list(zip(v[0::2], v[1::2]))


# How much of the card a stroked outline must span, and how far it must be inset
# from every edge, to count as the printed frame.
_FRAME_MIN_SPAN = 0.50
_FRAME_MIN_INSET = 0.01


def frame_box(svg_text, cell):
    """The printed frame's INTERIOR ``[x0, y0, x1, y1]`` in card units, or None.

    ``cell`` is the card itself. The INNERMOST qualifying outline wins (smallest
    bottom), because a design that draws two borders means the text to sit inside
    the inner one.

    The stroke's whole width is taken off each side, not half. A stroke is centred
    on its path, so half would be the geometric interior — but the rasteriser puts
    the painted edge a little past that (grapefruit: geometry says the bottom
    stroke starts at 288.62, a 200-dpi render of the same card inks it from
    288.00), and half a stroke of deliberate conservatism is cheaper than ink on
    the border. On grapefruit that is 0.5 pt.
    """
    if not svg_text or not cell:
        return None
    x0c, y0c, x1c, y1c = cell
    w, h = x1c - x0c, y1c - y0c
    if w <= 0 or h <= 0:
        return None
    body = _DEFS_BLOCK.sub("", svg_text)
    stack = [_IDENTITY]
    best = None
    for m in _GEOM_TAG.finditer(body):
        close, name, attrs, selfclose = m.groups()
        if name == "g":
            if close:
                if len(stack) > 1:
                    stack.pop()
            elif not selfclose:
                stack.append(_mat_mul(stack[-1], _parse_transform(attrs)))
            continue
        if close:
            continue
        a = dict(_ATTR.findall(attrs))
        # A frame is a STROKE, not a fill: an outline that paints no interior.
        if (a.get("fill") or "").strip() != "none":
            continue
        if not (a.get("stroke") or "").strip() or a["stroke"].strip() == "none":
            continue
        t = _mat_mul(stack[-1], _parse_transform(attrs))
        if name == "rect":
            try:
                rx, ry = float(a.get("x", 0)), float(a.get("y", 0))
                rw, rh = float(a["width"]), float(a["height"])
            except (KeyError, ValueError):
                continue
            pts = [(rx, ry), (rx + rw, ry), (rx, ry + rh), (rx + rw, ry + rh)]
        else:
            pts = _path_points(a.get("d"))
            if not pts:
                continue
        xs = [t[0] * x + t[2] * y + t[4] for x, y in pts]
        ys = [t[1] * x + t[3] * y + t[5] for x, y in pts]
        box = [min(xs), min(ys), max(xs), max(ys)]
        if box[2] - box[0] < _FRAME_MIN_SPAN * w or box[3] - box[1] < _FRAME_MIN_SPAN * h:
            continue
        inset = min(box[0] - x0c, box[1] - y0c, x1c - box[2], y1c - box[3])
        if inset < _FRAME_MIN_INSET * min(w, h):
            continue
        try:
            sw = float(a.get("stroke-width", 1))
        except ValueError:
            sw = 1.0
        sw *= abs(t[0] * t[3] - t[1] * t[2]) ** 0.5     # the transform's scale
        box = [box[0] + sw, box[1] + sw, box[2] - sw, box[3] - sw]
        if best is None or box[3] < best[3]:
            best = box
    return best


# RESERVED BOTTOM MARGIN. The owner's words: "i want to get some empty space from
# the bottom that the word wont get to there (in this case the font will be
# smaller)". So the usable area stops SHORT of the frame by a stated margin, and a
# card whose lines will not fit inside what is left sets smaller — which she asked
# for explicitly.
#
# In MILLIMETRES, because that is what it means on the printed card and what she
# picks it by — the value here is the one chosen off a rendered proof of 0 / 4 /
# 8 / 12 mm on real cards. The card's user units are POINTS throughout this
# pipeline (deck_html sets the PDF page box in pt from the same viewBox), so the
# conversion is exact rather than a guess.
#
# Measured from the LAST LINE'S INK, descenders included, to the frame's interior
# edge: measuring from the baseline would let a "ך" eat the margin.
#
# 8 mm is the shipped default because the OWNER PICKED IT off that proof: she
# wanted the foot of the card visibly, unmistakably empty, and 8 mm is the value
# that reads as deliberate white space rather than as a near miss. It is a
# preference about how the printed card looks, so it is hers to set, and she set
# it knowing what it costs — she was shown the trade before choosing:
#
#   * type size. On her own wrapped card it takes 21.12 -> 19.61 (7.1%); 4 mm
#     would have cost 0.9%. Measured, not estimated.
#   * a card whose last entry only just wrapped stops wrapping, because the
#     shorter room makes the extra line cost more than it buys. Two cards of one
#     deck can then set at different sizes (hers: 19.61 and 20.89). She accepted
#     that; it is not a bug report waiting to be filed.
#
# In exchange every card is guaranteed 8 mm of clear paper under its last line
# (measured 8.08 mm on her wrapped card, ink to the scanned frame interior),
# where 4 mm promised 4.14 and 0 mm promised nothing at all. One env var away if
# a later proof changes her mind.
_PT_PER_MM = 72.0 / 25.4
_BOTTOM_RESERVE_MM = float(os.environ.get("DUGRI_BOTTOM_RESERVE_MM", "8"))

# Cache: the frame is a property of the ARTWORK, and one deck renders the same
# eight fronts 104 times. Keyed by theme + front + payload size, so a test that
# swaps a demo theme's artwork under the same name is not served a stale box.
_FRAME_BOXES = {}


def card_frame_box(theme, front_index, svg_text, cell):
    """``frame_box`` for one card, computed once per (theme, front) per process."""
    key = (theme, front_index, len(svg_text or ""))
    if key not in _FRAME_BOXES:
        _FRAME_BOXES[key] = frame_box(svg_text, cell)
    return _FRAME_BOXES[key]


def room_bottom(theme, front_index, svg_text, cell, safe_bottom):
    """Lowest y a line's INK may reach on this card.

    The frame's interior edge less ``_BOTTOM_RESERVE_MM``, never past the trim-safe
    bound. With no detectable frame the safe bound carries the reserve instead —
    a fraction of the card (``_CARD_SAFE``, inside the bleed) less the same
    margin, which is all a full-bleed design can honestly promise: there is no
    border to stay off, only the guillotine.
    """
    if not cell:
        return safe_bottom
    reserve = _BOTTOM_RESERVE_MM * _PT_PER_MM
    box = card_frame_box(theme, front_index, svg_text, cell)
    if box is None:
        return safe_bottom - reserve
    return min(safe_bottom, box[3]) - reserve


# THE LINE GRID. ``_lead_for`` answers "how much room does a PAIR of lines need".
# This answers "where does every line on the card go", which is the question the
# owner keeps asking: *the spaces between lines should be the same always*. Every
# vertical gap — between the two lines of one wrapped entry AND between one entry
# and the next — has to be the same distance. One rhythm down the card.
#
# Centring each entry on its own slot could not deliver that, for two independent
# reasons:
#
#   1. A wrapped entry grows BOTH ways from its centre, so its first line rises
#      towards the entry above and closes that gap. On the two cards the owner
#      sent — three one-line entries and a fourth wrapping over two — the four
#      gaps came out 28.70 / 30.20 / 16.93 / 20.43 ("הפועל" / "תל אביב") and
#      28.70 / 30.20 / 20.69 / 12.91 ("ארצות" / "הברית"): the two gaps she named,
#      the one INTO the wrapped entry and the one INSIDE it, are the two smallest
#      on the card in both. #294 equalised the gaps inside a wrapped entry against
#      each other and never touched either of these.
#   2. The slot centres are not evenly spaced to begin with. Each recorded box is
#      the ink extent of a DIFFERENT origin word — one with a descender sits lower
#      in its box than one without — so the four centres disagree about where the
#      origin's grid was: 28.70 / 30.20 / 27.15 on the reported deck. That is a
#      3-unit (1.1 mm) wobble on a card that never wrapped at all.
#
# So the whole card gets ONE grid: count every line that will be printed (entries
# plus continuations) and step them all by a single pitch, spanning the FIRST live
# slot's centre to the LAST live slot's centre. It is the argument
# ``_card_right_edge`` already makes for the x anchor, applied to y: the extremes
# are the honest estimate of a grid that the individual boxes only sample.
#
# The two endpoints stay exactly where they are calibrated, so a card that does
# not wrap keeps the origin's own vertical extent and only loses the interior
# wobble; a card that wraps fits its extra lines INSIDE that extent instead of
# growing past it into the artwork or the trim. The price is that the INTERIOR
# entries shift: at most 1.5 units (0.5 mm) on a card that wraps nothing — that is
# just the wobble coming out — and further on one that does, because the extra
# line has to come from somewhere. That drift is what buys the even rhythm.
#
# THE ALTERNATIVE, AND WHY IT CANNOT WORK. The obvious way to keep the
# calibration exactly is to leave every entry pinned to its own slot and let a
# wrapped one grow DOWNWARDS into a subdivided slot pitch. With slot pitch P, an
# entry of n lines spaced L, the gap INSIDE it is L and the gap into the next
# entry is P - (n-1)L, so equality needs L = P/n — a different L for every entry
# that wraps to a different depth, which is a contradiction the moment two entries
# disagree. It fails outright when a MIDDLE entry wraps: entry 2 over two lines
# gives gaps P (1->2), L (inside 2), P-L (2->3), P (3->4), and P = L = P-L has no
# solution. Pinning cannot be kept; the grid gives it up deliberately.
#
# WHERE THE ENVELOPE COMES FROM. The pitch is a span divided by the gaps that must
# fit inside it, so the span is the whole argument. #295 used the calibrated span —
# first live slot's centre to last — and called it a hard envelope on the grounds
# that growing past it "puts ink where the origin never had text". That was wrong,
# and the artwork says so. Measured on grapefruit (a 223.92 x 312 card):
#
#   printed frame, interior   23.9 .. 287.9   (scanned off the artwork)
#   slot centres              117.6, 148.8, 180.0, 211.2
#   the calibrated span       117.6 .. 211.2  =  93.6 units
#   FREE below the last line  211.2 .. 287.9  =  76.7 units, holding nothing
#
# So 78 units of clear paper — 83% again of the entire height the words were
# allowed — sat directly beneath the last line, INSIDE the frame, unusable. The
# calibrated span is not a design boundary at all: it is a record of where four
# ONE-LINE origin words happened to sit. Treating that accident as a wall is what
# made a card that needs a fifth line compress its pitch and drop its type
# (grapefruit: 21.3 -> 16.3, and on cards that could not wrap it forced them to
# stay unwrapped and shrink to fit the width instead — 17.9 on the owner's own
# "הפועל תל אביב" card).
#
# So the envelope now comes from the CARD: the first live slot's centre down to
# ``room_bottom`` — the printed frame's interior less the reserved bottom margin,
# never past the trim. The first line stays pinned where it is calibrated, because
# the space above it belongs to the title, and a card that needs more lines grows
# DOWNWARD into the paper that was empty.
#
# WHERE THE PITCH COMES FROM: the design, not this renderer. The origin's own
# entry spacing is a measurement of the artwork — the calibrated word slots'
# centres, which is where the design put its four rows — and that is the pitch a
# card sets at. It is only ever opened, never tightened, by what the card's own
# glyphs need to keep clear of one another (``_card_lead``). So every gap is equal
# down the card AND the same from card to card — the owner's rule — the type keeps
# its size, and the deck is spaced the way the design is.
#
# On סנטוריני the design leads its rows at 1.27 of the type size; the owner reads
# 1.4 off Canva's line-spacing control, and the two agree — Canva's slider is not
# a baseline multiplier, and across the two designs whose Canva spacing she has
# read to us it runs about a tenth above the baseline step the artwork actually
# sets (סיישל's title: 0.75 on the slider, 0.68 in the ink).
#
# WHERE IT APPLIES, AND FOR HOW LONG. Only to a card with a DECLARED words column
# (``card_slots``), which today means the v2 single-card templates. The eight v1
# sheet themes have no declared column yet, so they cannot wrap and are not
# gridded — their lines are their slots and they render exactly as calibrated.
#
# That split is a MIGRATION STATE, not a design: the owner's plan is that "every
# template will move to card slots". As each sheet theme gains a column it starts
# wrapping and gridding like the rest, and once none are left the undeclared
# branches below (and the ``declared_band`` flag itself) can be deleted outright.
# Nothing here is written to keep two worlds working forever.


def _grid_pitch(centers, gaps, lead, size, cap=None):
    """The single centre-to-centre distance for every pair of lines on a card.

    The DESIGN's own spacing — the calibrated span divided by ``gaps`` — opened
    where this card's own glyphs need more (``lead`` x size, see ``_card_lead``)
    and capped by ``cap``.

    ``gaps`` is what makes the rhythm the same on every card of a deck: pass the
    number of gaps between the card's ENTRIES and the floor is the origin's own
    spacing, a constant that does not care how many lines the card wraps onto. A
    card that wraps then keeps that spacing and grows downward into the room below
    (see WHERE THE ENVELOPE COMES FROM); a card that does not wrap sits exactly
    where it always did. Passing the number of gaps between LINES is the legacy
    behaviour — the calibrated span as a hard envelope — used only when there is
    no card to measure the room against.

    The floor is a PREFERENCE (keep the origin's airy spacing) and the font's own
    need is the RULE (letters must not touch), so ``cap`` — what the remaining
    paper actually allows — overrides the floor but never the rule. Without that
    order a card of six lines was held at the origin's 31.2 spacing, ran out of
    paper, and had to set at 7 points to make the arithmetic work.
    """
    span = (max(centers) - min(centers)) if centers else 0.0
    natural = span / gaps if gaps > 0 and span > 0 else 0.0
    pitch = max(natural, lead * size)
    if cap is not None:
        pitch = max(lead * size, min(pitch, cap))
    return pitch


def _grid_centers(centers, counts, pitch, anchor_top=False):
    """Each entry's block centre on the card grid: ``{slot index: y}``.

    The run of lines is centred on the calibrated slots' own mid-point, so at the
    natural pitch the first line lands exactly on the first slot's centre and the
    last on the last slot's. An entry of two lines reports the centre BETWEEN
    them, which is what ``word_lines`` wants.

    ``anchor_top`` pins the FIRST line to the first calibrated centre and lets the
    run grow downward instead. Used by a card that has reached into the room below
    the last slot: growing symmetrically would spend half that room upward, where
    the title is, so the extra lines all go down. At the natural pitch the two are
    the same placement, which is why a card that wraps nothing is unaffected.
    """
    n = sum(counts.values())
    if anchor_top:
        first = min(centers) if centers else 0.0
    else:
        mid = ((min(centers) + max(centers)) / 2) if centers else 0.0
        first = mid - (n - 1) * pitch / 2
    out, k = {}, 0
    for i in sorted(counts):
        out[i] = first + (k + (counts[i] - 1) / 2) * pitch
        k += counts[i]
    return out


def _ink_reach(font, ref, line):
    """How far a line's ink reaches above and below its visual CENTRE.

    As multiples of the font size, so the caller can solve for a size. Measured
    from the real glyphs: these faces draw far outside their em (Cafe's "לקחת"
    is 1.45x its own size tall), so an em-based estimate would license ink over
    the trim.
    """
    asc, _desc = font.getmetrics()
    bb = font.getbbox(line)
    return (asc - bb[1]) / ref - _CENTER_DROP, (bb[3] - asc) / ref + _CENTER_DROP


def _grid_cap(centers, counts, flat, lead, font, ref, vbounds):
    """Largest size at which the grid's ink still stays inside ``vbounds``.

    The top and bottom bounds are the card's vertical safe area — inside the
    bleed, so no line can be carried off by the guillotine. The grid's first and
    last line sit on FIXED centres, so the only thing that grows with the size is
    the ink around them and the cap is linear. The exception is a card with a
    single live slot: there is no span to pin, the block grows symmetrically about
    that one centre, and the pitch grows with the size too.
    """
    if not vbounds or not flat:
        return float("inf")
    top, bottom = vbounds
    n = sum(counts.values())
    span = max(centers) - min(centers)
    above = _ink_reach(font, ref, flat[0])[0]
    below = _ink_reach(font, ref, flat[-1])[1]
    if n > 1 and span > 0:
        first, last, grow = min(centers), max(centers), 0.0
    else:
        first = last = (min(centers) + max(centers)) / 2
        grow = (n - 1) * lead / 2
    caps = [c / d for c, d in ((first - top, above + grow),
                               (bottom - last, below + grow)) if d > 0]
    return min(caps) if caps else float("inf")


def _room_cap(centers, n_lines, lead, flat, font, ref, room):
    """Largest size for a grid allowed to extend DOWN into the card's free room.

    ``room`` is ``(top bound, bottom bound)``: the top is the card's safe area
    (nothing may rise into it), the bottom is ``room_bottom`` — the printed
    frame's interior less the reserved bottom margin. The first line stays pinned
    to the first calibrated centre, so the block runs

        first centre  +  (lines-1) x pitch  +  the last line's ink below its centre

    and everything after the first term grows with the size. Solved at the TIGHTEST
    pitch the font allows (``lead`` x size): the origin's wider entry spacing is a
    preference the pitch keeps whenever the paper allows it, so it can never be the
    thing that decides how large the card may set (see ``_grid_pitch``).
    """
    if not room or not flat or not centers or len(centers) < 2:
        return float("inf")
    top_bound, bottom_bound = room
    first = min(centers)
    above = _ink_reach(font, ref, flat[0])[0]
    below = _ink_reach(font, ref, flat[-1])[1]
    caps = []
    if above > 0:
        caps.append((first - top_bound) / above)
    denom = max(n_lines - 1, 0) * lead + below
    if denom > 0:
        caps.append(max((bottom_bound - first) / denom, 0.0))
    return min(caps) if caps else float("inf")


def _span(layout):
    """A laid-out entry's height as a multiple of its font size."""
    return (len(layout.lines) - 1) * layout.lead + 1.0 / _WORD_SIZE_K


def _block_half(layout):
    """Half the ink height of a laid-out entry, in user units."""
    return _span(layout) * layout.size / 2


def _strands_a_leading_numeral(lines):
    """True when the first line glues a LEADING bare numeral to the word after it.

    "40 מתחת ל40" is a real customer entry. Split on width alone it comes out as
    "40 מתחת" / "ל40" — 938 units against 1021 for the alternative in the deck's
    own face, so width picks it — and it reads as two figures at opposite ends of
    two lines with מתחת stranded between them. Keeping the numeral on its own
    line gives "40" / "מתחת ל40", which reads as written.

    Deliberately narrow: only a phrase that STARTS with a bare numeral, and only
    its first line. A numeral inside a phrase ("מסיבה 40 שנים") is left alone —
    there it belongs to the words on both sides and no split is obviously wrong.
    """
    first = lines[0].split()
    return len(first) > 1 and first[0].isdigit()


def _balanced_split(font, text, n):
    """Split ``text`` at spaces into ``n`` lines, minimising the widest line.

    Returns None when the text has too few words to make ``n`` lines. Brute force
    over the split points: a card word is a handful of words, so the search is
    tiny and always finds the true optimum.

    Ranked by (strands a leading numeral, widest line), so the numeral rule beats
    pure width — which is the point of it, since the width-optimal split is the
    unreadable one. The readable split is 8.8% wider on the deck's own face but
    needs LESS line pitch (its two lines' glyphs clash less), so on the affected
    card it cost nothing at all: 16.7 against 16.4 for the width-optimal one.
    """
    parts = text.split()
    if len(parts) < n:
        return None
    if n == 1:
        return [" ".join(parts)]
    best = None
    for cuts in itertools.combinations(range(1, len(parts)), n - 1):
        bounds = (0,) + cuts + (len(parts),)
        lines = [" ".join(parts[a:b]) for a, b in zip(bounds, bounds[1:])]
        rank = (_strands_a_leading_numeral(lines),
                max(font.getlength(ln) for ln in lines))
        if best is None or rank < best[0]:
            best = (rank, lines)
    return best[1]


# BREAKING A WORD THAT HAS NOWHERE TO WRAP. "בית הכנסת הגדול" wraps at its
# spaces; "אינטרנציונליזם" has none, so the only ways to fit it are to shrink the
# WHOLE card (one size per card — that is the rule) or to break the word itself.
# The owner asked for the break: a single over-long entry should not shrink the
# other three.
#
# The character drawn at the break. Hebrew does not normally hyphenate, so this
# was put to the owner as an open question and she chose the visible hyphen: a
# silent split can read as two different words. Env-overridable, and setting it to
# "" restores the silent split.
_BREAK_HYPHEN = os.environ.get("DUGRI_BREAK_HYPHEN", "-")
# How far the type has to fall before an ugly break is the better deal, as a
# fraction of the card's target size. A word only slightly too wide is better set
# a little smaller than broken across two lines — the break is visible on every
# card of the deck, the 5% is not. At 0.85 an entry breaks only once keeping it
# whole would cost the card more than 15% of its type.
_BREAK_BELOW = float(os.environ.get("DUGRI_BREAK_BELOW", "0.85"))


def _fit_chars(font, token, width, hyphen):
    """How many leading characters of ``token`` fit ``width`` with ``hyphen``.

    At least one and always fewer than the whole token, so a caller looping on the
    remainder always makes progress. 0 when not even one character fits.
    """
    for k in range(len(token) - 1, 0, -1):
        if font.getlength(token[:k] + hyphen) <= width:
            return k
    return 0


def _wrap_at(font, text, width, hyphen):
    """Greedily wrap ``text`` to ``width``, breaking INSIDE a word when it must."""
    lines, cur = [], ""
    for tok in text.split():
        trial = f"{cur} {tok}" if cur else tok
        if font.getlength(trial) <= width:
            cur = trial
            continue
        if cur:
            lines.append(cur)
            cur = ""
        while font.getlength(tok) > width:
            k = _fit_chars(font, tok, width, hyphen)
            if not k:
                return None                   # not even one character fits
            lines.append(tok[:k] + hyphen)
            tok = tok[k:]
        cur = tok
    if cur:
        lines.append(cur)
    return lines


def _hard_split(font, text, n, hyphen=_BREAK_HYPHEN):
    """Split ``text`` into at most ``n`` lines, breaking inside words if needed.

    The narrowest width that still fits ``n`` lines, found by bisection — which is
    the same "minimise the widest line" objective ``_balanced_split`` brute-forces,
    just over a search space (every character boundary) too large to enumerate.
    Returns None when even a single character will not fit.
    """
    whole = font.getlength(text)
    if whole <= 0 or n < 1:
        return None
    lo, hi, best = 0.0, whole, None
    for _ in range(40):
        mid = (lo + hi) / 2
        lines = _wrap_at(font, text, mid, hyphen)
        if lines and len(lines) <= n:
            best, hi = lines, mid
        else:
            lo = mid
    return best


def _candidates(font, ref, num, word, avail, max_lines=_WRAP_MAX_LINES,
                advance=None, uniform=None):
    """Every way to set one entry: ``{line_count: (lines, lead, max_size_ref)}``.

    ``max_size_ref`` is the largest font size at which that wrapping still fits
    the band. More lines means a narrower widest line, so it always allows a
    larger size — the cost is height, which the caller weighs.

    ``max_lines`` of 1 forbids wrapping outright, which is how the v1 sheet path
    keeps its long words on one line (see ``_word_layouts``).

    ``uniform`` is the card's target size, and it is what decides whether an entry
    with too few spaces may be BROKEN mid-word: only when keeping it whole would
    drag the card below ``_BREAK_BELOW`` of that target.
    """
    marker_ref = _line_width_at(font, ref, num, "", advance=advance)

    def budget(lines):
        widest = max(font.getlength(ln) for ln in lines)
        # Every line is anchored inside the same band: the first after the
        # marker, the continuations under the first line's text. So one budget
        # covers them all.
        denom = marker_ref + widest
        return (lines, _lead_for(font, ref, lines),
                avail * ref / denom if denom > 0 and avail > 0 else float("inf"))

    out = {}
    for n in range(1, max_lines + 1):
        lines = _balanced_split(font, word, n)
        if lines is None:                     # too few spaces to make n lines
            break
        out[n] = budget(lines)
    if not out:                               # no words at all
        out[1] = ([word], 0.0, float("inf"))
        return out
    whole_word_best = max(v[2] for v in out.values())
    if uniform and whole_word_best < uniform * _BREAK_BELOW:
        for n in range(len(out) + 1, max_lines + 1):
            lines = _hard_split(font, word, n)
            if not lines or len(lines) in out:
                break
            out[len(lines)] = budget(lines)
    return out


def _fit_card(cands, pitches, centers, uniform, font=None, ref=None, grid=False,
              vbounds=None, room=None, count=None, bold_w=0.0):
    """Solve ONE font size for the whole card, and each entry's line count.

    Every word on a card renders at the SAME size — that is the origin
    template's look (Canva Bulk Create fills a fixed-size text box) and what the
    owner asked for: a card must not mix a large short word with a small long
    one. So the card's size is set by its most demanding entry, and the others
    follow it down rather than staying big.

    The two constraints are circular — the size decides how many lines a phrase
    needs, and the line counts decide how much height the entries take, which
    caps the size. Rather than relax (which ratchets: the size only falls, and
    once it is low enough for everything to fit on ONE line the search settles
    there — measured at 8.9 against a uniform 21.3), every combination of line
    counts is scored outright. Four slots and at most three lines each is 81
    combinations of trivial arithmetic, so the exact answer is cheaper than the
    approximation was.

    Ties go to the FEWEST total lines: wrapping is a cost paid to keep the type
    big, never a goal, so if a card sets just as large unwrapped it stays
    unwrapped.

    ONE LEAD for the whole card, returned alongside the size. ``_lead_for``
    answers what a given PAIR of lines needs, and that answer varies with the
    glyphs — 0.82 to 1.52 across the test cards — so an entry wrapping around
    "ים" was spaced visibly tighter than the entry below it wrapping around
    "לקחת". The owner reads that as two different gaps on one card. Taking the
    MAXIMUM over the pairs actually being set keeps every line clear of the one
    above it (the collision this mechanism exists to prevent) while making the
    gap the same everywhere.

    ``grid`` switches the HEIGHT constraint from "these two entries must not
    collide" to "every line on the card sits on one pitch" (see THE LINE GRID
    above). The pairs are measured over the card's WHOLE line sequence,
    continuations included, so a gap that straddles two entries is held to the
    same clearance as a gap inside one. Off (the v1 sheet, and any card that
    cannot wrap) the original pairwise solve runs untouched.

    ``room`` is the card's real vertical envelope — the safe top and
    ``room_bottom`` (the printed frame's inner edge less clear air). A card whose
    wrapping ADDS lines is solved against it, so the extra lines go into the paper
    that is actually free below the last calibrated line instead of squeezing the
    pitch. Without it (no cell, no artwork to scan) the old calibrated-span
    envelope stands, which is the conservative answer.
    """
    live = sorted(cands)
    best = None
    for combo in itertools.product(*(sorted(cands[i]) for i in live)):
        counts = dict(zip(live, combo))
        size = min([uniform] + [cands[i][counts[i]][2] for i in live])
        if grid:
            flat = [ln for i in live for ln in cands[i][counts[i]][0]]
            live_c = [centers[i] for i in live]
            lead = _card_lead(font, ref, flat, count=count, bold_w=bold_w)
            span = max(live_c) - min(live_c)
            if room:
                # The card's real envelope: the first calibrated line down to the
                # printed frame. Applied whether the card wraps or not, because
                # the fixed font pitch can spread a plain card too.
                size = min(size, _room_cap(live_c, len(flat), lead, flat,
                                           font, ref, room))
            elif len(flat) > len(live) and span > 0 and lead > 0:
                # No card to measure: the calibrated span is the envelope, as it
                # was before the frame could be read. ONLY the lines the wrap ADDS
                # are ours to fit — a card that wraps nothing sets exactly the
                # entries the origin template set.
                size = min(size, span / ((len(flat) - 1) * lead))
                size = min(size, _grid_cap(live_c, counts, flat, lead, font,
                                           ref, vbounds))
            else:
                size = min(size, _grid_cap(live_c, counts, flat, lead, font, ref,
                                           vbounds))
        else:
            lead = max([0.0] + [cands[i][counts[i]][1] for i in live])
            for a, b in zip(live, live[1:]):
                spans = sum((counts[i] - 1) * lead + 1.0 / _WORD_SIZE_K
                            for i in (a, b))
                room = min(pitches[a], abs(centers[b] - centers[a]))
                size = min(size, room / (spans / 2 + _WRAP_CLEAR))
        key = (size, -sum(combo))
        if best is None or key > best[0]:
            best = (key, size, counts, lead)
    return best[1], best[2], best[3]


def _word_layouts(slots, words, font, ref, cell=None, word_size=None,
                  declared_band=False, safe=_CELL_SAFE, room_bottom=None,
                  bold_w=0.0):
    """Per-slot ``(size, [lines])`` for a card's words, or None for an empty slot.

    One UNIFORM font size is the target for every word (matching the origin's
    single-size look): the uniform size comes from the recipe box heights (see
    ``_WORD_SIZE_K``), NOT from fitting each word to its own box — fitting per box
    would reproduce the ORIGIN word lengths (a short word in a wide origin slot
    would balloon, a long word in a narrow slot would shrink), destroying the
    uniform look.

    A word that does not FIT is wrapped rather than pushed out of the card (see
    the WRAPPING note above). What it has to fit is the question:

    * ``declared_band`` — the slots came from the owner's ``card_slots``, which
      states where the words' COLUMN is. That is a real text box, so a phrase
      wider than it wraps inside it — but its left edge is only ever traced
      around the ORIGIN's short words, so it is widened to at least
      ``_BAND_LEFT_MAX`` of the card first.
    * otherwise the slots were auto-detected, and a detected box is the ink
      extent of the ORIGIN word, not a column: the origin words were short, so
      the boxes are narrow and treating them as a text box wraps phrases that
      have room to spare. Those fall back to the card-wide safe area and set one
      line per entry. This is the UN-MIGRATED path — every template is moving to
      ``card_slots``, and when the last one has, it goes.

    Either way ``safe`` floors the bound, so no line can reach the trim edge and
    be cut off the printed card.

    A declared card also gets ONE right anchor and ONE digit column for all four
    entries (see ``_card_right_edge`` / ``_marker_advance``), so the numbers and
    the words line up down the card instead of each entry landing where its own
    slot and its own digit put it.

    ``room_bottom`` is the lowest y a line's ink may reach on this card — the
    printed frame's inner edge less clear air (see ``room_bottom``). It is what
    lets a card that has to wrap grow DOWNWARD into paper that is already empty
    rather than compressing its pitch; without it the calibrated span is the
    envelope, as before.
    """
    import statistics
    heights = [s["y1"] - s["y0"] for s in slots]
    if not heights:
        return [None] * len(slots)
    # A theme may PIN the uniform word size (the Canva point size, in recipe
    # units) instead of deriving it from the recipe box heights — used where the
    # detected boxes overshoot (e.g. bachelorette rendered ~26 vs the real 19).
    uniform = word_size if word_size else statistics.median(heights) * _WORD_SIZE_K
    floor = cell[0] + (cell[2] - cell[0]) * safe if cell else None
    # A synthetic-bold word is WIDER than the advance the fit measures: the
    # stroke is centred on the outline, so it hangs half its width past each end
    # of the run. Take the WHOLE width off the left bound rather than half — a
    # stroke that reaches the trim edge is guillotined off the printed card, and
    # the fraction of a millimetre this costs is invisible.
    if floor is not None and bold_w:
        floor += uniform * bold_w
    advance = _marker_advance(font, len(slots)) if declared_band else None
    cands = {}
    for wi, slot in enumerate(slots):
        word = words[wi] if wi < len(words) else ""
        if not word:
            continue
        if declared_band:
            right = _card_right_edge(slots, cell)
            left = _declared_left(slot, cell)
            if floor is not None:
                left = max(left, floor)
        else:
            right = _line_right_edge(slot["x1"], cell)
            left = floor if floor is not None else slot["x0"]
        if left >= right:                 # degenerate slot: fall back to the floor
            left = floor if floor is not None else slot["x0"]
        # Wrapping needs a text box to wrap INSIDE. Only a declared column is
        # one; a detected slot is just where the origin word's ink happened to
        # land, so reflowing to it would rewrap all eight live sheet themes
        # against a box their designer never drew. Without a column the old
        # guarantee stands unchanged: one line, shrunk if that is what it takes
        # to stay inside the card.
        cands[wi] = _candidates(font, ref, wi + 1, word, right - left,
                                max_lines=_WRAP_MAX_LINES if declared_band else 1,
                                advance=advance,
                                uniform=uniform if declared_band else None)
    if not cands:
        return [None] * len(slots)
    centers = [(s["y0"] + s["y1"]) / 2 for s in slots]
    pitches = {i: _slot_pitch(slots, i) for i in cands}
    vbounds = ((cell[1] + (cell[3] - cell[1]) * safe,
                cell[3] - (cell[3] - cell[1]) * safe) if cell else None)
    live_c = [centers[i] for i in sorted(cands)]
    # The room below is only usable when it IS below, and only when there are two
    # calibrated centres to read a spacing from. A bound that lands above the last
    # line says the scan found something that is not the frame the words sit in,
    # and the calibrated span is the safer answer.
    room = None
    if (vbounds and room_bottom is not None and len(live_c) > 1
            and max(live_c) > min(live_c) and room_bottom > max(live_c)):
        room = (vbounds[0], min(vbounds[1], room_bottom))
    size, counts, lead = _fit_card(cands, pitches, centers, uniform,
                                   font=font, ref=ref, grid=declared_band,
                                   vbounds=vbounds, room=room,
                                   count=len(slots), bold_w=bold_w)
    if not declared_band:
        return [None if wi not in cands
                else Layout(size, cands[wi][counts[wi]][0], lead)
                for wi in range(len(slots))]
    # Declared card: place every line on the card-wide grid and hand each entry
    # the centre the grid put it on, plus the grid pitch as its lead — so the gap
    # inside a wrapped entry IS the gap between two entries, and the gap on THIS
    # card is the gap on every other card of the deck.
    lines = sum(counts.values())
    # With a card to measure, the pitch floor is the origin's ENTRY spacing (a
    # constant per template) and the ceiling is the paper left below the first
    # line; without one it is the legacy line-span envelope.
    cap = None
    if room and lines > 1:
        last = cands[max(cands)][counts[max(cands)]][0][-1]
        below = _ink_reach(font, ref, last)[1] * size
        cap = (room[1] - min(live_c) - below) / (lines - 1)
    pitch = _grid_pitch(live_c, (len(live_c) - 1) if room else (lines - 1),
                        lead, size, cap=cap)
    # Pinned to the first calibrated line, growing downward, whenever the room is
    # known — the space above belongs to the title. Without a known room the block
    # stays centred on the calibrated span, exactly as it was placed before.
    grid_c = _grid_centers(live_c, counts, pitch, anchor_top=bool(room))
    return [None if wi not in cands
            else Layout(size, cands[wi][counts[wi]][0],
                        pitch / size if size else 0.0, grid_c[wi])
            for wi in range(len(slots))]


def _word_sizes(slots, words, font, ref, cell=None, word_size=None):
    """The rendered font size per slot (None for an empty one).

    A thin view over ``_word_layouts`` for callers that only care about size.
    """
    return [None if lay is None else lay[0]
            for lay in _word_layouts(slots, words, font, ref, cell=cell,
                                     word_size=word_size)]


@functools.lru_cache(maxsize=8)
def _title_metrics(font_path, ref=200):
    return _measuring_font(font_path, ref), ref


# Synthetic-bold stroke width as a fraction of the glyph size. Sized to read as
# a weight step (Medium -> Bold) without closing up Hebrew counters at card
# sizes; env-tunable so a face that needs more or less can be corrected
# without a code change.
_BOLD_WEIGHT = float(os.environ.get("DUGRI_TITLE_BOLD_W", "0.035"))

_TITLE_UID = [0]


def _ink_bearings(f, ref, line, size):
    """Gaps between a line's ADVANCE edges and its actual INK, in user units.

    SVG anchors a text run by its advance width, but ink and advance are not the
    same span: a script or italic face's glyphs routinely overhang the advance
    (Haglos' "Bride in One Pot" measures 1050 of ink against a 1018 advance), and
    a face with generous side bearings does the reverse. Anchoring the advance
    therefore puts the VISIBLE text off the mark the box asks for.

    Returns ``(lsb, rsb)`` — the left and right gaps, scaled from the metric
    ``ref`` size to the rendered ``size``. Either may be NEGATIVE, which is
    exactly the overhang case.
    """
    bb = f.getbbox(line)
    adv = f.getlength(line)
    return bb[0] / ref * size, (adv - bb[2]) / ref * size


# The baseline step this renderer has always stacked title lines at, as a
# fraction of the type size. It is a fallback now, not the rule: a theme whose
# artwork was MEASURED (``title_style.leading``) is stacked at the leading the
# design itself sets. A theme without that measurement keeps this exact number,
# so nothing already shipped moves.
RENDER_PITCH = 0.78


def _title_ink_stack(f, ref, lines, pitch=RENDER_PITCH):
    """Total stacked title-ink height at the metric ``ref`` size.

    Measured over ALL lines, not just the first and last: a 3+ line title can
    carry its tallest ascender or deepest descender on a MIDDLE line, so the
    extreme ink extent is taken across every line (a first/last-only measure would
    under-count and let the middle line spill). (Finding #6.) The middle gaps are
    ``pitch * size`` — whatever spacing the caller is actually going to stack the
    lines at, so the height this reports is the height that gets painted.
    """
    asc, _desc = f.getmetrics()
    ink_above = asc - min(f.getbbox(ln)[1] for ln in lines)  # tallest ink above baseline
    ink_below = max(f.getbbox(ln)[3] for ln in lines) - asc  # deepest ink below baseline
    return ink_above + pitch * ref * (len(lines) - 1) + ink_below


# Daylight the collision floor insists on beyond the point where the two lines'
# ink merely ABUTS, as a fraction of the type size. Touching is not a safe floor:
# the rasterizer paints an antialiased rim about a device pixel wide onto each
# glyph edge, so two outlines that exactly meet come out of Chrome as one welded
# mass.
#
# THREE device pixels, not one. At the coarsest scale anything renders a card at
# (3x over a ~460-unit page, on a ~24-unit title; the buyer's preview is
# comparable at 2x over a 224-unit card) a device pixel is ~0.015 of the type
# size, and the gap has to survive the rim on the upper line's edge, the rim on
# the lower line's, and the pixel of slack between them that keeps the two rims
# from blending at all. One pixel was enough only while the floor was read off
# whole-line bounding boxes, which over-reserved by so much that the clearance
# never bound; read column by column it is the clearance that decides, and
# ``test_no_two_title_lines_touch_at_the_tightest_leading_on_any_template``
# catches סנטוריני welding at one pixel and clear at three.
_INK_CLEARANCE = 0.05


def visual_order(line, rtl):
    """``line`` in the order it will be PAINTED, left to right.

    Pillow lays a string out in logical order, one character after the next;
    Chrome, handed ``direction="rtl"``, reorders it — the Hebrew runs run right
    to left and any digit run inside them stays left to right, all of it placed
    from the right edge. So a per-column reading of a Hebrew title taken off
    Pillow's raster is a reading of the wrong picture: it puts the final-nun of
    "נישואין" where Chrome puts the "10".

    One bidi level is all these titles ever have — Hebrew words with an optional
    number in them — which is exactly the case the Unicode algorithm resolves by
    reversing the run order and each right-to-left run's own characters.
    Verified against the real rasterizer: fed this, Pillow's column profile
    tracks Chrome's to ~3px on a 200px em, against ~33px fed the logical string.
    Neutrals (spaces, punctuation) join the run beside them, which is what the
    algorithm's neutral resolution does between two runs of the same direction.
    """
    if not rtl:
        return line
    import unicodedata
    runs, cur, kind = [], "", None
    for ch in line:
        klass = unicodedata.bidirectional(ch)
        if klass in ("R", "AL"):
            k = "R"
        elif klass in ("L",):
            k = "L"
        elif klass in ("EN", "AN", "ET"):
            k = "N"          # a number: drawn left-to-right inside an RTL line
        else:
            k = kind or "R"  # a neutral takes the direction it sits beside
        if k != kind and cur:
            runs.append((kind, cur))
            cur = ""
        kind, cur = k, cur + ch
    if cur:
        runs.append((kind, cur))
    return "".join(txt[::-1] if k == "R" else txt for k, txt in reversed(runs))


@functools.lru_cache(maxsize=512)
def _ink_skyline(font_path, ref, line):
    """Per column of the RASTERIZED line, its ink's deepest and highest row.

    Returns ``(x_left, below, above)`` — the column the profiles start at
    (relative to the line's pen origin), then per column the lowest inked row
    BELOW the baseline and the highest inked row ABOVE it, in ref-size pixels,
    ``None`` where that column carries no ink at all.

    Measured on real rasterized pixels rather than on the line's bounding BOX,
    because a box is not a shape. "PARTY" over a line whose tallest letter is an
    L reads, box against box, as a full descender depth against a full ascender
    height — when the two are nowhere near one another horizontally and the
    design stacks them happily. Reading each column separately is what lets a
    title be set as tight as its own artwork sets it.

    Cached on (face, size, text): a deck asks this of the same handful of title
    lines on all 104 cards, and rasterizing an em-sized line per card would cost
    more than the whole rest of the page.
    """
    from PIL import Image, ImageDraw
    f = _measuring_font(font_path, ref)
    pad = int(ref) + 8
    w = int(f.getlength(line)) + 2 * pad
    h = 4 * int(ref) + 2 * pad
    base = 2 * int(ref) + pad
    img = Image.new("L", (max(8, w), max(8, h)), 0)
    ImageDraw.Draw(img).text((pad, base), line, font=f, fill=255, anchor="ls")
    ink = img.getbbox()
    if not ink:
        return -pad, (), ()
    below, above = [], []
    for x in range(img.size[0]):
        if x < ink[0] or x >= ink[2]:
            below.append(None)
            above.append(None)
            continue
        col = img.crop((x, ink[1], x + 1, ink[3])).getbbox()
        if col:
            below.append(ink[1] + col[3] - 1 - base)   # +ve: ink under baseline
            above.append(base - (ink[1] + col[1]))     # +ve: ink over baseline
        else:
            below.append(None)
            above.append(None)
    return -pad, tuple(below), tuple(above)


def _min_line_pitch_by_box(f, ref, lines, pad, clear=_INK_CLEARANCE):
    """The pre-skyline floor: the two lines' bounding BOXES may not overlap.

    Strictly safer than the per-column reading and strictly less faithful, so it
    is the fallback for a font object this module cannot re-open by path (a test
    double, a face loaded from a stream). Nothing in production reaches it.
    """
    asc, _desc = f.getmetrics()
    worst = 0.0
    for upper, lower in zip(lines, lines[1:]):
        below = f.getbbox(upper)[3] - asc      # ink under the upper line's baseline
        above = asc - f.getbbox(lower)[1]      # ink over the lower line's baseline
        worst = max(worst, (below + above) / ref)
    return worst + pad + clear


def _dilate(profile, radius):
    """Grow each column's extent over its ``radius`` neighbours (max, skipping
    empty columns) — what a ring or a synthetic-bold stroke does horizontally."""
    if radius <= 0:
        return profile
    n = len(profile)
    out = []
    for i in range(n):
        window = [v for v in profile[max(0, i - radius):i + radius + 1]
                  if v is not None]
        out.append(max(window) if window else None)
    return out


def _min_line_pitch(f, ref, lines, pad, align="center", grow=0.0, rtl=False,
                    clear=_INK_CLEARANCE):
    """The tightest baseline step that still leaves DAYLIGHT between two lines.

    As a fraction of the type size, so it can be compared with a leading
    directly. A design's measured leading is a reading of ITS artwork with ITS
    honoree's name in it, and the name we print is not that name: a title set
    tight on "Alma" collides on a name whose first line hangs a final-kaf under
    the baseline and whose next line carries a lamed above it. So the measured
    leading is a target that is clamped to this, per title, with the real text
    that is about to be drawn.

    THE MEASUREMENT IS PER COLUMN, on rasterized pixels. Two lines collide only
    where they are ABOVE ONE ANOTHER, so the question is asked of each column of
    the stacked block and not of the two lines' bounding boxes. Boxes said סיישל
    needed 0.887 where its design sets 0.68, and סנטוריני 1.180 against 0.50 —
    not because any glyph met any other, but because SOMEWHERE on the upper line
    there was a descender and SOMEWHERE on the lower one an ascender. The owner's
    rule is that glyphs must never touch, and that is what this now measures.

    ``pad`` is everything painted BEYOND the glyph outline, as a fraction of the
    size: the outline ring and any synthetic-bold fatten (a stroke is centred on
    the outline, so it grows each line by half the width top and bottom, and two
    neighbours need the whole width between their baselines), the drop shadow's
    drop, and the arch — a bulged path lifts the lower line's ascenders by up to
    ``arch`` toward the line above. ``grow`` is the HORIZONTAL half of the same
    paint (ring + half the bold stroke), which widens every glyph and so can
    bring two columns into each other's way that the bare outlines miss;
    ``align`` says how the lines are laid out against each other, since a column
    of the upper line only meets the lower one if the layout puts them in line.

    ``clear`` is the daylight demanded on top of the ink itself. It is a
    parameter and not a constant because the two things this measures do not ask
    for the same air: a title's lines are one block and want only enough that the
    rasterizer's rim cannot weld them, while a card's numbered word rows are four
    separate ITEMS and are given the wider ``_WRAP_GAP`` a wrapped entry already
    uses, so a card reads as a list rather than as a paragraph.

    The pairs asked about are the ones the block STACKS — each line over the one
    printed under it — because that is where the question means anything. Asking
    it of every ordered pair instead reserves room between two lines that are
    never neighbours: on a סנטוריני card it was "חתן" over "השראה" (1.385 of the
    size) deciding the pitch while the card prints השראה above חתן and its real
    stackings need 1.070. See ``_card_lead``.
    """
    path = getattr(f, "path", None)
    if not path:
        return _min_line_pitch_by_box(f, ref, lines, pad, clear=clear)
    worst = 0.0
    radius = max(0, int(round((grow or 0.0) * ref)))
    drawn = [visual_order(ln, rtl) for ln in lines]
    for upper, lower in zip(drawn, drawn[1:]):
        ux, u_below, _u_above = _ink_skyline(path, ref, upper)
        lx, _l_below, l_above = _ink_skyline(path, ref, lower)
        u_below, l_above = _dilate(u_below, radius), _dilate(l_above, radius)
        # Where the pen starts for each line, relative to a shared origin. The
        # renderer anchors a centred line on its ADVANCE (text-anchor="middle"),
        # a right-aligned one on its end, a left-aligned one on its start — so
        # this is the same arithmetic the block itself lays out with.
        if align == "left":
            u_pen, l_pen = 0.0, 0.0
        elif align == "right":
            u_pen, l_pen = -f.getlength(upper), -f.getlength(lower)
        else:
            u_pen, l_pen = -f.getlength(upper) / 2, -f.getlength(lower) / 2
        shift = int(round((u_pen + ux) - (l_pen + lx)))
        for i, below in enumerate(u_below):
            if below is None:
                continue
            j = i + shift
            if 0 <= j < len(l_above) and l_above[j] is not None:
                worst = max(worst, (below + l_above[j]) / ref)
    return worst + pad + clear


def title_paint_pad(outline_w, arch, shadow, bold=False, bold_w=None,
                    ring_visible=True):
    """Everything a title paints BEYOND its glyph outlines, per unit of size.

    The ring (and any synthetic-bold fatten) grow every line on all four sides,
    the drop shadow adds a second copy of the line 0.06 lower, and the arch
    lifts a line's middle by ``arch``. Shared between the collision floor and
    the owner's health check so the two reserve the same room — a check that
    predicted a different footprint from the one the card prints would be worse
    than none.

    NOT the height-fit's headroom a few lines below, which counts only the ring
    and the shadow. That is the narrower reservation every shipped design was
    fitted against, and widening it would resize them; this one is free to be
    complete because it only ever pushes lines apart.
    """
    fat = (bold_w if bold_w else _BOLD_WEIGHT) if bold else 0.0
    return (fat + (2 * (outline_w or 0.0) if ring_visible else 0.0)
            + (0.06 if shadow else 0.0) + max(0.0, arch or 0.0))


def title_paint_grow(outline_w, bold=False, bold_w=None, ring_visible=True):
    """How far a title's paint spreads SIDEWAYS from each glyph edge, per unit
    of size: the ring's full thickness plus half the synthetic-bold stroke (a
    stroke is centred on the outline). The collision floor needs this separately
    from ``title_paint_pad`` because vertical padding and horizontal spread play
    different parts once the floor reads the block column by column — the
    vertical part opens the baselines, the horizontal part decides WHICH columns
    can reach each other in the first place."""
    fat = (bold_w if bold_w else _BOLD_WEIGHT) if bold else 0.0
    return fat / 2 + ((outline_w or 0.0) if ring_visible else 0.0)


def back_leading(ts, back_slot=None):
    """The line spacing a card BACK's title is stacked at, or None.

    Resolved down the same chain the back's SIZE is: this back's own (a paired
    deck measures each back separately), then the deck-wide back spacing, then
    the fronts'. The pair matters — a back's pinned size was fitted at the
    back's own spacing, so pulling one without the other prints a size that was
    never measured.
    """
    return ((back_slot or {}).get("leading")
            or (ts or {}).get("back_leading")
            or (ts or {}).get("leading"))


def board_leading(ts):
    """The line spacing the BOARD's title is stacked at, or None."""
    return (ts or {}).get("board_leading") or (ts or {}).get("leading")


def title_pitch(f, ref, lines, leading, pad, align="center", grow=0.0, rtl=False,
                one_block=False):
    """The baseline step ``title_block`` will actually stack ``lines`` at.

    ``leading`` unset — an uncalibrated theme, or a single-line title with no
    spacing to measure — is the fixed step this renderer has always used, so a
    theme without the measurement is laid out exactly as it was. A measured one
    is clamped up to what these particular glyphs need (``_min_line_pitch``);
    the clamp can only ever loosen, so a design that leads generously keeps its
    air.

    ``align``/``grow`` describe the block the floor is being asked about — how
    the lines sit against each other, and how far the paint spreads beyond them.
    Both default to the plainest case so an existing caller measures exactly
    what it did before.

    ``one_block`` DROPS the floor, and it is the only thing that can. The clamp
    exists because a title is set on one honoree's name and printed on another's,
    so a spacing measured on "Alma" has to survive a name that hangs a final-kaf
    where Alma had none. That is the right rule for a title whose lines stand
    clear of one another — and the wrong one for a title whose lines do NOT: on
    סיישל the ring is 0.075 of the type size, the three words are one text box,
    and their outlines run together into the single graffiti mass the design is.
    Prising them apart to satisfy a rule the artwork never obeyed is precisely
    the inter-row space the owner asked to be rid of ("make this in 1 textbox …
    so there will be no spacing between rows").

    So the flag is a reading of the design, not a licence: calibration sets it
    only where the original's own title ink has lost its row structure AND the
    design paints a ring wide enough to have been what closed the rows up
    (``calibrate.sets_one_block``). Where it is set, the design's step stands
    exactly as measured — including where that means two lines touch, because
    they touch in the original.
    """
    if leading is None:
        return RENDER_PITCH
    if one_block:
        return float(leading)
    return max(float(leading),
               _min_line_pitch(f, ref, lines, pad, align=align, grow=grow,
                               rtl=rtl))


# How far a title's real glyph ink may overrun its calibrated box height before we
# stop trusting the original ``old_cap`` size and shrink to the metric ink-fit.
# The recipe title boxes are approximate regions (the origin's own ink/outline
# overrun them by ~10%), so anything up to this tolerance keeps the origin-matching
# size; only a genuine display face whose ink is FAR taller (japanese-class,
# ~2x) crosses it and gets shrunk to fit. (Finding #1.)
_TITLE_OVERFLOW_TOL = float(os.environ.get("DUGRI_TITLE_OVERFLOW_TOL", "0.25"))


def title_is_rtl(cfg):
    # A title is right-to-left when the theme's language is Hebrew. RTL matters
    # for any title that mixes digits with Hebrew (e.g. anniversary "30 שנה
    # נישואין" or "{NAME} בן {AGE}"): with the default LTR base direction the
    # leading/embedded digit run lays out on the wrong side. English themes stay
    # LTR and are untouched.
    return cfg.get("language") == "hebrew"


def title_block(box, lines, fill, outline, font_path, outline_w, arch, shadow,
                rtl=False, fixed_size=None, align="center", italic=False,
                bold=False, bold_w=None, leading=None, one_block=False):
    _TITLE_UID[0] += 1
    uid = _TITLE_UID[0]
    """Graffiti-style stacked title: sized so the WIDEST line fills the box
    width, tight line spacing, an optional drop shadow + thick dark outline
    behind a light fill — the 3D bubble look. All style knobs come from the
    theme config: ``outline_w`` (dark ring thickness as a fraction of glyph
    size), ``arch`` (upward bulge fraction), ``shadow`` (draw the drop shadow
    layer or not) and ``leading`` (the baseline step, as a fraction of the type
    size, measured off the design — unset keeps this renderer's own fixed
    step).

    ``one_block`` says this design's title IS one text box: the lines are stacked
    at exactly ``leading``, touching if that is what the design does, instead of
    being opened up to keep their outlines clear (see ``title_pitch``). The lines
    are still PLACED one by one, which is what an arch, a per-line alignment and
    a per-front title box all need — and a text box lays its lines out on exactly
    this constant baseline step, so placing them individually at that step and
    letting one element wrap produce the same picture. What made ours differ from
    a text box was never the markup, it was the floor."""
    x0, y0, x1, y1 = box["x0"], box["y0"], box["x1"], box["y1"]
    cx = (x0 + x1) / 2
    bw, bh = x1 - x0, y1 - y0
    # Drop empty / whitespace-only lines up front: an UNFILLED title (e.g. a
    # template whose only placeholder couldn't be substituted, so a line resolves
    # to "" or "   ") must degrade to nothing instead of crashing the whole order
    # on ``max([])`` / ``getlength('')==0`` / a zero-width ink stack. Normal titles
    # (every line non-blank) are unaffected. (Finding #3.)
    lines = [ln for ln in lines if ln and ln.strip()]
    if not lines:
        return ""
    f, ref = _title_metrics(font_path)
    ratios = [f.getlength(ln) / ref for ln in lines]      # width per unit size
    n = len(lines)
    # --- the LEADING: how far apart the baselines sit -----------------------
    # A same-colour "outline" (monochrome themes) is never painted as a ring, so
    # it adds no width to the glyph and no room between the lines either.
    visible_outline = outline_w > 0 and outline != fill
    fat = (bold_w if bold_w else _BOLD_WEIGHT) if bold else 0.0
    paint_pad = title_paint_pad(outline_w, arch, shadow, bold, bold_w,
                                ring_visible=visible_outline)
    paint_grow = title_paint_grow(outline_w, bold, bold_w,
                                  ring_visible=visible_outline)
    pitch = title_pitch(f, ref, lines, leading, paint_pad,
                        align=align, grow=paint_grow, rtl=rtl,
                        one_block=one_block)
    # size to fill the WIDTH, capped so the stacked lines still fit the box HEIGHT.
    # The height cap comes from the REAL font metrics, not a fixed per-line
    # fraction: some display title faces (e.g. the japanese font) draw
    # glyphs far taller than their em, so a stacked title could spill well past its
    # calibrated box. Measure the actual ink stack and scale it to fill the box.
    #
    # Measure the ink extent over ALL lines, not just the first/last: a 3+ line
    # title can carry its tallest ascender or deepest descender on a MIDDLE line,
    # which the first/last-only measure under-counts. (Finding #6.)
    stack = _title_ink_stack(f, ref, lines, pitch)        # full stacked ink at ref
    # The PAINTED title is taller than its raw ink: a dark outline RING of
    # size*outline_w rings every glyph (top & bottom), and (when enabled) the drop
    # shadow drops a further size*0.06 below. Reserve that headroom so the whole
    # painted footprint (ink + outline + shadow) stays inside the calibrated box on
    # a height-bound title, instead of the ink filling the box and the ring/shadow
    # spilling onto the neighbouring artwork. (Finding #5.)
    pad = 2 * outline_w + (0.06 if shadow else 0.0)
    denom_h = stack + pad * ref
    ink_fit = bh * ref / denom_h if denom_h > 0 else bh
    # Height cap. ``old_cap`` is the ORIGINAL calibrated cap (``bh/(0.80*n)*1.02``)
    # that matched every shipped origin: the recipe title boxes are approximate
    # regions, not hard clips, so a normal face whose real ink runs ~10% past the
    # box at ``old_cap`` still looks right (the origin's own ink/outline overrun
    # the same box). Keep ``old_cap`` — so previously-correct titles are neither
    # enlarged (the ink-fit-only regression that grew MrDafoe/bachelorette) nor
    # shrunk (ink-fit under-sized CooperLtBT/birthday etc.). Fall to the metric
    # ``ink_fit`` ONLY when the ink overflows ``old_cap`` by more than a wide
    # tolerance — i.e. a genuine display face (japanese-class) whose glyphs
    # are far taller than their em and would otherwise spill dramatically. The
    # tolerance is well above every shipped theme's ~10% overrun and well below a
    # real display face's ~100%, so current themes render exactly as the origin
    # while an extreme future face is still reined in. (Findings #1, #5, #6.)
    #
    # The 0.80 is the per-line share of the box this cap has always assumed, and
    # it is only right while the lines are stacked ~0.78 apart. A design that
    # leads WIDER stacks a taller block out of the same type, so the cap has to
    # come down with it or the auto-fit overflows the box by exactly the extra
    # leading. Taking the larger of the two leaves the fallback path — pitch
    # 0.78 — on the identical 0.80 it always used, and only a genuinely wide
    # measured leading moves it. (A tighter leading is left alone: the block is
    # then shorter than the cap assumes, so the cap is merely conservative, and
    # ``ink_fit`` is the binding constraint anyway.)
    old_cap = bh / (max(0.80, pitch) * n) * 1.02
    size_h = old_cap if old_cap <= ink_fit * (1 + _TITLE_OVERFLOW_TOL) else ink_fit
    denom_w = max(ratios)
    size = min(bw * 0.89 / denom_w, size_h) if denom_w > 0 else size_h
    # A theme may pin the title to an EXACT size (the Canva point size, in the
    # recipe's user units) instead of auto-fitting to the box — the box then only
    # positions (centres) the title. Used where auto-fit over/under-shoots.
    if fixed_size:
        # ...but a pinned size is the ORIGIN's size, measured against the
        # ORIGIN's own title text — and the honoree's name is not that text.
        # Pin grapefruit at Canva's 28 and "רווקות לדניאל" fits, while
        # "רווקות לאלכסנדרה-מרגריטה" runs clean off BOTH card edges, on all 104
        # printed cards of a paid order.
        #
        # So a pin is a target, never a licence to overflow: clamp it to what
        # the box can actually hold. The existing overrun tolerance is kept,
        # because the calibrated boxes are approximate regions that the origin's
        # own ink already overruns slightly — so every title that fits today is
        # untouched and only genuine overflow is reined in.
        size = fixed_size
        if denom_w > 0:
            size = min(size, bw * 0.89 / denom_w * (1 + _TITLE_OVERFLOW_TOL))
    gap = size * pitch
    total = gap * (n - 1)
    top = (y0 + y1) / 2 - total / 2
    dx, dy = size * 0.035, size * 0.06                    # drop-shadow offset
    bulge = size * arch                                   # graffiti upward arch
    # Boldness = a heavy dark OUTLINE ring (not fattened fill). Three stacked
    # layers per line on the arched path: shadow, dark dilated body (outline),
    # light fill on top -> the visible dark ring thickness equals T. (Agent B.)
    # Letters render at the font's TRUE outline weight (pure fill, like the word
    # text) — no body-fatten stroke, which made titles read bolder than the
    # outlined-vector originals. A visible (contrasting) outline is still drawn as
    # a ring behind the fill; a same-colour "outline" (monochrome themes) is NOT
    # drawn, since it would only fatten with no visible ring.
    # Synthetic BOLD. The default stays true outline weight — that was a
    # deliberate fidelity fix, because fattening made titles read heavier than
    # the outlined-vector originals. But a design whose Canva title really is
    # bold, on a family we only ship a lighter cut of (grapefruit: Comix No2 CLM
    # ships Medium only, Canva sets Bold), renders too light without it. Opt-in
    # per theme via title_style "bold": true, and it fattens in the FILL colour
    # so it thickens the letter rather than adding a visible ring.
    # (``visible_outline`` is settled above, where the line spacing needs it.)
    # Per-theme weight when the design needs one: how much stroke it takes to
    # read as the origin's Bold depends on the face, so a single global number
    # cannot be right for every template. Measured against grapefruit's Canva
    # original by ink coverage in the title band (8.72%): 0.035 gave 7.41%,
    # 0.06 gave 9.28%.
    w_fat = size * fat                                    # synthetic-bold fatten
    t_ring = size * outline_w                             # dark outline ring
    outer = w_fat + 2 * t_ring
    defs, out = [], []
    # RTL (Hebrew) titles: set a right-to-left BASE direction on the <text> so a
    # mixed digit+Hebrew line (e.g. "30 שנה נישואין") reads correctly — the number
    # on the RIGHT (Hebrew reading start), not the LEFT. VERIFIED against the real
    # headless-Chrome SVG rasterizer this generator targets: `direction="rtl"`
    # correctly reorders the runs for BOTH a leading digit ("30 שנה נישואין" ->
    # 30 on the right) and a trailing digit ("{NAME} בן {AGE}" -> age on the
    # left). It does NOT reverse the digits themselves (unlike unicode-bidi
    # "bidi-override", which renders "30" as "03"), so plain `direction="rtl"` is
    # the right, self-contained fix here — no run-splitting like word_text needs.
    # (Not a contradiction with word_text's "Chrome ignores direction=rtl" note:
    # THAT path has a NEUTRAL "." wedged between a Hebrew word and a digit inside
    # ONE plain <text>, where the neutral is reordered away from its digit and a
    # base direction can't pin it — hence its three-run split. A title line has no
    # such stranded neutral: it is a digit run beside Hebrew words on a textPath,
    # where the base direction IS honored. Verified via the real rasterizer in
    # test_title_block_rtl_reorders_digit_in_raster.)
    dir_attr = ' direction="rtl"' if rtl else ""
    # Title alignment. Default "center": each line on a centered arced textPath.
    # "left" anchors every line to the box's left edge (x0) so multi-line titles
    # share a left edge instead of centering each line independently (japanese).
    left_align = align == "left"
    right_align = align == "right"
    if left_align:
        path_anchor = 'startOffset="0" text-anchor="start"'
    elif right_align:
        path_anchor = 'startOffset="100%" text-anchor="end"'
    else:
        path_anchor = 'startOffset="50%" text-anchor="middle"'
    # Synthetic italic: Chrome obliques the upright font when the theme's real
    # face has no italic cut (e.g. Cooper). Opt-in via title_style "italic": true.
    italic_attr = ' font-style="italic"' if italic else ""

    def on_path(pid, fill_c, stroke_c, swv, line):
        return (f'<text font-family="TitleFont" font-size="{size:.2f}" fill="{fill_c}" '
                f'stroke="{stroke_c}" stroke-width="{swv:.2f}" paint-order="stroke" '
                f'stroke-linejoin="round" stroke-linecap="round"{italic_attr}{dir_attr}>'
                f'<textPath href="#{pid}" {path_anchor}>'
                f'{escape(line)}</textPath></text>')

    for k, line in enumerate(lines):
        by = top + gap * k + size * 0.33
        wln = ratios[k] * size
        # Centre on the INK, not the advance. SVG's text-anchor positions a run by its
        # ADVANCE width, but a script or italic face's glyphs overhang that advance
        # — Haglos' final "t" swash runs 32/1018 past it — so anchoring the advance
        # leaves the visible title off-centre even though the geometry is right.
        # Measured on daniel-amit: the title sat 5.5px right of centre on a 598px
        # card, on BOTH faces (margins L=25 R=14), against a Canva original that is
        # centred. Correcting by the bearing asymmetry costs one getbbox per line
        # and needs no per-theme offset knob. (``lsb``/``rsb`` are the gaps from the
        # advance edges to the ink, in user units; either may be NEGATIVE when the
        # ink overhangs.)
        if left_align:
            # Anchor every line to the box's left edge; extend the path right so
            # the left-anchored (possibly arched) run is never clipped. Left and
            # right alignment stay on the ADVANCE deliberately: they exist to give
            # multi-line titles a SHARED edge, and a shared advance edge is what
            # reads as flush — correcting each line by its own bearing would ragged
            # that edge by a glyph's overhang.
            xl, xr = x0, x0 + wln + size * 0.3
        elif right_align:
            # Mirror of left: anchor every line to the box's RIGHT edge; extend
            # the path left so the right-anchored run is never clipped.
            xl, xr = x1 - wln - size * 0.3, x1
        else:
            # Shift the anchor by half the asymmetry so the ink — not the advance —
            # straddles the box centre.
            lsb, rsb = _ink_bearings(f, ref, line, size)
            skew = (lsb - rsb) / 2
            xl = cx - skew - wln / 2 - size * 0.15
            xr = cx - skew + wln / 2 + size * 0.15
        cxp = (xl + xr) / 2

        def arc(pid, ox, oy):
            defs.append(f'<path id="{pid}" fill="none" d="M {xl+ox:.1f} {by+oy:.1f} '
                        f'Q {cxp+ox:.1f} {by+oy-2*bulge:.1f} {xr+ox:.1f} {by+oy:.1f}"/>')

        if shadow:
            arc(f"t{uid}s{k}", dx, dy)                    # shadow path
        arc(f"t{uid}m{k}", 0, 0)                          # main path
        if shadow and visible_outline:
            out.append(on_path(f"t{uid}s{k}", outline, outline, outer, line))  # shadow
        if visible_outline:
            out.append(on_path(f"t{uid}m{k}", outline, outline, outer, line))  # outline
        out.append(on_path(f"t{uid}m{k}", fill, fill, w_fat, line))         # fill body
    return "<defs>" + "".join(defs) + "</defs>" + "".join(out)


# How far a nudged title box may reach toward the card's trim, as a fraction of
# the cell. The recipes' own detected title boxes sit at 0.03, so a nudge that
# stops there lands where the origin's own title was allowed to.
_TITLE_NUDGE_MARGIN = 0.03


def _nudge_title_box(tbox, cell, offset):
    """Move a title box by ``[dx, dy]`` cell fractions, CLIPPED to the card.

    A nudge that pushes the box past the card is clipped rather than translated,
    so the box SHRINKS and the title auto-fits smaller instead of printing off
    the card. That is the whole safety of a per-front nudge: japanese needs its
    title driven ~0.30 to the right on the four fronts whose koi occupies the
    top-left, and a translate-only nudge would carry a long honoree name clean
    past the trim edge on every one of them.
    """
    if not offset or not cell:
        return tbox
    cw, ch = cell[2] - cell[0], cell[3] - cell[1]
    dx, dy = offset[0] * cw, offset[1] * ch
    lo_x, hi_x = cell[0] + _TITLE_NUDGE_MARGIN * cw, cell[2] - _TITLE_NUDGE_MARGIN * cw
    lo_y, hi_y = cell[1] + _TITLE_NUDGE_MARGIN * ch, cell[3] - _TITLE_NUDGE_MARGIN * ch
    x0, x1 = max(lo_x, tbox["x0"] + dx), min(hi_x, tbox["x1"] + dx)
    y0, y1 = max(lo_y, tbox["y0"] + dy), min(hi_y, tbox["y1"] + dy)
    # A nudge big enough to invert the box would leave nothing to fit into;
    # keep the original rather than emit a negative-width box.
    if x1 <= x0 or y1 <= y0:
        return tbox
    return {"x0": x0, "x1": x1, "y0": y0, "y1": y1}


def _title_overlay(tbox_list, title_lines, cfg, title_font, cell, offset=None,
                   fixed_size=None, align=None):
    """The stacked-title markup for one card, or "" when there is nothing to draw.

    ``tbox_list`` may hold ONE BOX PER TITLE LINE (birthday-girls records two);
    the title is fitted into their UNION, because using only the first box would
    cram every line into one line's height at ~half size. ``offset`` nudges the
    union by ``[dx, dy]`` fractions of the card cell — used to seat a title that
    detection placed into a corner at the original's inset position.
    """
    if not tbox_list or not title_lines:
        return ""
    ts = cfg["title_style"]
    tbox = {"x0": min(b["x0"] for b in tbox_list), "y0": min(b["y0"] for b in tbox_list),
            "x1": max(b["x1"] for b in tbox_list), "y1": max(b["y1"] for b in tbox_list)}
    tbox = _nudge_title_box(tbox, cell, offset)
    return title_block(tbox, title_lines, ts["fill"], ts["outline"], title_font,
                       ts["outline_w"], ts["arch"], ts["shadow"],
                       rtl=title_is_rtl(cfg),
                       fixed_size=fixed_size if fixed_size is not None else ts.get("size"),
                       align=align or ts.get("align", "center"),
                       italic=ts.get("italic", False),
                       bold=ts.get("bold", False),
                       bold_w=ts.get("bold_w"),
                       leading=ts.get("leading"),
                       one_block=bool(ts.get("one_block")))


def _words_overlay(slots, words, cfg, word_font, cell, room=None):
    """The four numbered word lines for one card, as SVG markup.

    ``room`` is the lowest y a line's ink may reach (see ``room_bottom``) — the
    card's real vertical envelope, which a wrapping card may grow down into.
    """
    if not slots:
        return ""
    wf_metrics, wf_ref = _word_metrics(word_font)
    # card_slots is the owner's own statement of where the words' column sits, so
    # when it is set the slots ARE a text box and a long phrase wraps inside it.
    declared = bool((cfg.get("card_slots") or {}).get("words"))
    bold_w = config.word_bold_w(cfg, _WORD_BOLD_W)
    layouts = _word_layouts(slots, words, wf_metrics, wf_ref, cell=cell,
                            word_size=cfg.get("word_size"), safe=_CARD_SAFE,
                            declared_band=declared, room_bottom=room,
                            bold_w=bold_w)
    # One anchor and one digit column for the whole card, so the four numbers sit
    # in a column and the four words start at the same x. Both must match what
    # _word_layouts fitted against, or the render would overflow the band it was
    # measured for.
    x_right = _card_right_edge(slots, cell) if declared else None
    advance = _marker_advance(wf_metrics, len(slots)) if declared else None
    out = []
    for wi, slot in enumerate(slots):
        if layouts[wi] is None:
            continue
        lay = layouts[wi]
        # A declared card carries its own grid centre (one pitch for every gap on
        # the card); without one the entry sits on its slot centre as before.
        center = lay.center if lay.center is not None else (slot["y0"] + slot["y1"]) / 2
        right = x_right if x_right is not None else _line_right_edge(slot["x1"], cell)
        out.append(word_lines(right, center, lay.size, slot["color"],
                              wi + 1, lay.lines, word_font, lead=lay.lead,
                              marker_advance=advance, bold_w=bold_w))
    return "".join(out)


# ---- v2: one portrait card per page ---------------------------------------
# v1 laid 8 cards onto an A4 sheet, so every render walked recipe["cards"]. A v2
# page IS one card: the same slot geometry and the same title/word painters, just
# applied once against the card's own viewBox. The overlays below emit markup
# ONLY — no <style>, no @font-face — because the whole deck is assembled into one
# HTML document where the fonts are declared a single time (see deck_html).


def card_overlay(theme, recipe, words, title_lines, front_index=None,
                 word_font=None, kind="word", card_vb=None, card_svg=None):
    """Title + word markup for ONE card, in the card's own viewBox units.

    ``front_index`` selects which front's title box to use: the words are SHARED
    across the eight fronts but the title MOVES, so the box comes per front and
    the owner's nudge from ``title_style.front_offset``.
    The photo card (``kind="photo"``) carries no text at all — its four customer
    photos are the content, and a title would sit on top of them.

    Geometry comes from ``config.card_word_boxes`` / ``config.card_title_boxes``,
    which prefer the owner's saved ``card_slots`` calibration and fall back to
    the auto-detected recipe. Reading the recipe directly here would silently
    ignore every measurement made through the admin calibration form.

    ``card_svg`` is the artwork this overlay is going onto. It is what the words
    are allowed to measure their room against — the printed frame is in there and
    nowhere else (see THE PRINTED FRAME). Every production caller already holds
    the text, so it is passed rather than re-read; omitted, the card falls back to
    the trim-safe area, which is where a v2 card sat before the frame was read.
    """
    if kind == "photo":
        return ""
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    cell = (recipe.get("card") or {}).get("cell") or _recipe_cell(recipe, card_vb)
    word_font_path = config.resolve_word_font(theme, word_font)
    title_font_path = config.font_path(theme, cfg["title_font"])
    safe_bottom = cell[3] - (cell[3] - cell[1]) * _CARD_SAFE if cell else None
    room = (room_bottom(theme, front_index, card_svg, cell, safe_bottom)
            if card_svg and cell else None)
    return (_title_overlay(config.card_title_boxes(cfg, recipe, front_index, cell),
                           title_lines, cfg, title_font_path, cell,
                           offset=config.front_offset(cfg, front_index),
                           align=config.front_align(cfg, front_index))
            + _words_overlay(config.card_word_boxes(cfg, recipe, cell), words,
                             cfg, word_font_path, cell, room=room))


def back_overlay(theme, recipe, title_lines, card_vb=None, back_index=None):
    """Title markup for ONE card back.

    Three distinct cases, and conflating the last two would misprint a card:

    * the recipe carries detected back boxes -> use them;
    * the recipe carries an EXPLICIT ``"back": null`` -> the back genuinely has
      no text slot, so print NOTHING. Grapefruit's back is a full-bleed pattern
      with no room for a name; falling through to ``back.frac`` here would stamp
      the honoree's name across the artwork on all 104 backs.
    * the recipe has NO ``back`` key at all -> nothing was said either way (the
      template predates back detection), so fall back to the theme's
      ``back.frac`` fractions, which is how v1 placed it.

    ``back_index`` names WHICH back is being drawn. A deck whose eight styles
    each have their own back (#315) was drawn eight separate times, so the
    honoree's name may sit somewhere else on each — or on none of them — and one
    shared answer would misplace it on seven cards out of eight. Omitting the
    argument keeps the shared-back behaviour verbatim, which is every template
    that predates pairing.

    A per-back CALIBRATION entry outranks the recipe's shared ``back``: a
    template converted to per-front backs keeps the ``back`` its OLD artwork was
    detected against, and that answer is not about the card now being printed.
    """
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    bk = config.theme_back_slot(cfg, back_index)
    cell = _recipe_cell(recipe, card_vb)
    boxes = config.recipe_back_title(recipe, back_index)
    if not boxes:
        # An explicit null/empty back is an ANSWER, not a gap — respect it,
        # unless THIS back has since been calibrated on its own.
        if (config.recipe_answered_back(recipe, back_index)
                and not config.has_back_calibration(cfg, back_index)):
            return ""
        if not bk:
            return ""            # theme has no personalized back -> clean art
        frac = bk["frac"]
        w, h = cell[2] - cell[0], cell[3] - cell[1]
        boxes = [{"x0": cell[0] + frac["x0"] * w, "x1": cell[0] + frac["x1"] * w,
                  "y0": cell[1] + frac["y0"] * h, "y1": cell[1] + frac["y1"] * h}]
    ts = cfg["title_style"]
    title_font = config.font_path(theme, cfg["title_font"])
    # The back's own fill/outline when the theme calibrated them (the back art is
    # usually a different colour field from the fronts), else the shared style.
    style = dict(ts)
    if bk:
        style["fill"] = bk.get("fill", ts["fill"])
        style["outline"] = bk.get("outline", ts["outline"])
    # ...and the back's own LINE SPACING, resolved down the same chain the size
    # is: this back's own, then the deck-wide back spacing, then the fronts'.
    # Most designs reuse one block on every surface and the calibrator writes
    # them all the same number (calibrate.couple_leadings), but not all do —
    # tarifa's back stacks its two lines a third further apart than its front —
    # and the back's pinned SIZE was measured at whichever spacing it ended up
    # with, so drawing it at another one would print a size that was never
    # measured.
    style["leading"] = back_leading(ts, bk)
    cfg_back = {**cfg, "title_style": style}
    # A paired back may need its own size: eight separately drawn backs give the
    # title eight differently sized rooms, and one pin fits only the box it was
    # measured against. Falls through to the deck-wide pins when unset.
    return _title_overlay(boxes, title_lines, cfg_back, title_font, cell,
                          fixed_size=((bk or {}).get("size")
                                      or ts.get("back_size") or ts.get("size")))


def back_draws_title(theme, clean_svg, back_index=None):
    """Whether this back will be printed WITH the honoree's name on it.

    Answered by ASKING :func:`back_overlay` — the function that actually draws
    it — rather than by re-reading the theme/recipe here. The three-way rule it
    applies (detected boxes / an explicit "no text on this back" / nothing
    calibrated yet) is subtle enough that a second copy would drift, and a
    report that drifts from the render is worse than no report: it would tell
    the owner her back is titled while the deck prints it bare.

    Cheap — this builds an overlay string and throws it away; no Chrome, no
    fonts, no file written.
    """
    import card_assets
    cfg = config.theme(theme)
    recipe = config.recipe_or_empty(cfg)
    svg = card_assets.read_svg(clean_svg)
    try:
        card_vb = deck_html.view_box(svg)
    except Exception:
        card_vb = None
    if back_index is None:
        back_index = _index_from_card_path(clean_svg)
    # A non-empty name, so an overlay that IS drawn can never come back blank
    # for want of text and be misread as "this back carries no title".
    overlay = back_overlay(theme, recipe, ["X"], card_vb=card_vb,
                           back_index=back_index)
    return bool(overlay.strip())


# The photo card's four slots ship in the artwork as <image> elements with NO
# href — id="photo-slot-1".."photo-slot-4" — already carrying their geometry,
# their xMidYMid-meet fit and their circular clip (see docs/photo-card.md).
# Filling one is therefore a single attribute set, NOT drawing a new image: the
# card's designed crop, disc clip and empty-slot artwork all stay the template's
# to decide, and a slot we leave alone renders as its designed empty disc rather
# than a hole.
_PHOTO_SLOT = re.compile(
    r'<image\b(?P<attrs>[^>]*?\bid="photo-slot-(?P<n>[1-9])"[^>]*?)/\s*>'
)
_HAS_HREF = re.compile(r'\b(?:xlink:href|href)\s*=')


def photo_slot_count(svg_text):
    """How many fillable photo slots the artwork ships (0 on a non-photo card)."""
    return len(set(m.group("n") for m in _PHOTO_SLOT.finditer(svg_text)))


def fill_photo_slots(svg_text, photo_paths):
    """Return the photo card with its slots filled from ``photo_paths``, in order.

    Slots are matched by id, so slot N always takes photo N regardless of the
    order the elements appear in the file. Both ``href`` and ``xlink:href`` are
    set, because the deck is rendered by Chrome (which honours plain ``href``)
    while older rasterisers only understand the namespaced form.

    A slot with no corresponding photo is left EXACTLY as shipped, so a customer
    who uploaded two photos still prints a clean card with two designed empty
    discs rather than two broken images.
    """
    by_index = {str(i + 1): p for i, p in enumerate(photo_paths or []) if p}
    if not by_index:
        return svg_text

    def fill(m):
        path = by_index.get(m.group("n"))
        attrs = m.group("attrs")
        # Never add a second href to a slot that already has one — that would be
        # artwork we do not understand, and overwriting it could blank the card.
        if not path or _HAS_HREF.search(attrs):
            return m.group(0)
        url = deck_html.image_data_url(path)
        return f'<image{attrs} href="{url}" xlink:href="{url}"/>'

    return _PHOTO_SLOT.sub(fill, svg_text)


def photo_card_svg(theme, photos, paper=None):
    """The theme's pawn card, printed on ``paper`` and filled with ``photos``.

    The ONE place a pawn card is composed, so the deck and the single-card
    preview cannot drift apart on what it looks like. Resolution of WHICH card
    (owner overlay, the theme's own, the generic) stays in ``config``.

    ``paper`` is the colour the card prints on — the front card's own paper, so
    the sheet of pawns matches the deck it ships with instead of being white
    under every template. It is passed IN rather than measured here because
    measuring means rendering the front (``card_paper.front_paper``), and
    ``build.deck_document`` is contractually Chrome-free: it assembles deck
    STRUCTURE, and structure does not depend on colour. ``None`` prints the card
    exactly as shipped, which is also what an unmeasurable front yields.
    """
    import card_assets
    svg = card_assets.read_svg(config.photo_card_path(theme))
    return fill_photo_slots(card_paper.repaper(svg, paper), photos or [])


def _index_from_card_path(path):
    """The card number a ``clean/13.svg`` path names, or None if it isn't one."""
    stem = os.path.splitext(os.path.basename(path or ""))[0]
    return int(stem) if stem.isdigit() else None


def build_single_card_svg(theme, clean_svg, words, title_lines, front_index=None,
                          word_font=None, kind="word", photos=None,
                          back_index=None):
    """A STANDALONE, self-contained SVG for one card — fonts and all.

    The deck path puts fonts in the document stylesheet once and shares the
    artwork between pages; a preview renders exactly ONE card on its own, so it
    needs the @font-face rules inside the SVG itself. Same overlays either way,
    so what the buyer previews is what the deck prints.
    """
    import card_assets
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    recipe = config.recipe_or_empty(cfg)
    svg = card_assets.read_svg(clean_svg)
    # The artwork's OWN viewBox, so card_slots fractions still resolve when no
    # recipe has been detected yet — without it the cell collapsed to zero and
    # every fraction multiplied to nothing, rendering a blank card.
    try:
        card_vb = deck_html.view_box(svg)
    except Exception:
        card_vb = None
    if kind == "photo":
        # The photo card carries no text — every piece of its static copy is
        # already baked to vector paths — so it needs no @font-face injection at
        # all. Its slots are filled in the artwork itself, not overlaid, and its
        # paper follows the theme's front card, so it is composed by the shared
        # helper rather than from the ``clean_svg`` handed in here. This path
        # renders through Chrome anyway, so measuring the paper here costs it
        # nothing it was not already paying.
        return photo_card_svg(theme, photos, paper=card_paper.front_paper(theme))
    style = ("<style>" + GEOMETRIC_TEXT_STYLE
             + font_face("HebWord", config.resolve_word_font(theme, word_font))
             + font_face("TitleFont", config.font_path(theme, cfg["title_font"]),
                          config.title_font_weight(cfg))
             + "</style>")
    if kind == "back":
        # Which back this is decides where its title goes on a paired template.
        # The caller usually knows; when it doesn't, the file being rendered says
        # so — its number IS the back index everywhere else in the schema.
        if back_index is None:
            back_index = _index_from_card_path(clean_svg)
        overlay = back_overlay(theme, recipe, title_lines, card_vb=card_vb,
                               back_index=back_index)
    else:
        overlay = card_overlay(theme, recipe, words, title_lines,
                               front_index=front_index, word_font=word_font,
                               card_vb=card_vb, card_svg=svg)
    return svg.replace("</svg>", style + overlay + "</svg>")


def render_single_card(theme, clean_svg, words, title_lines, out_png,
                       front_index=None, word_font=None, kind="word", photos=None,
                       back_index=None):
    """Screenshot one card to ``out_png`` (the preview path)."""
    svg = build_single_card_svg(theme, clean_svg, words, title_lines,
                                front_index=front_index, word_font=word_font,
                                kind=kind, photos=photos, back_index=back_index)
    svg_path = out_png.replace(".png", ".svg")
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(svg)
    w, h = dims(clean_svg)
    chrome.screenshot(svg_path, out_png, w, h, scale=2, what="the preview card")
    return out_png


def render_fronts_strip(theme, fronts, words, title_lines, out_dir,
                        word_font=None, scale=2):
    """Render EVERY front once and return their PNG paths, in ``fronts`` order.

    The title position is calibrated PER FRONT, so an owner tuning fronts 2..9
    has to SEE fronts 2..9 — previewing only the first leaves them adjusting
    numbers blind.

    Done as ONE Chrome run over a single strip of cards rather than one run per
    front, for the same reason the deck is one pass: browser start-up dominates,
    so eight separate screenshots cost roughly eight times a strip that is then
    sliced. Cards are laid out edge to edge at their exact pixel size, so every
    crop is an exact rectangle.
    """
    if not fronts:
        return []
    import card_assets
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    recipe = config.recipe_or_empty(cfg)
    # Fonts ONCE for the whole strip, not once per card. build_single_card_svg
    # makes each card self-contained, which is right for a single preview and
    # wasteful here: eight cards x two base64 faces is sixteen copies of the same
    # fonts in one document (653KB, where the artwork itself is a fraction of
    # that). The deck assembler already declares them at document level for the
    # same reason.
    style = (GEOMETRIC_TEXT_STYLE
             + font_face("HebWord", config.resolve_word_font(theme, word_font))
             + font_face("TitleFont", config.font_path(theme, cfg["title_font"]),
                           config.title_font_weight(cfg)))
    cards = []
    for front in fronts:
        svg = card_assets.read_svg(config.card_path(theme, front))
        try:
            card_vb = deck_html.view_box(svg)
        except Exception:
            card_vb = None
        overlay = card_overlay(theme, recipe, words, title_lines,
                               front_index=front, word_font=word_font,
                               card_vb=card_vb, card_svg=svg)
        cards.append(svg.replace("</svg>", overlay + "</svg>"))
    w, h = dims(config.card_path(theme, fronts[0]))
    body = "".join(f'<div class="c">{svg}</div>' for svg in cards)
    html = (
        '<!doctype html><html><head><meta charset="utf-8"><style>'
        "html,body{margin:0;padding:0;background:#fff}"
        f"body{{display:flex;width:{w * len(cards)}px}}"
        f".c{{width:{w}px;height:{h}px;flex:0 0 {w}px;overflow:hidden}}"
        ".c svg{display:block;width:100%;height:100%}"
        + style +
        "</style></head><body>" + body + "</body></html>"
    )
    os.makedirs(out_dir, exist_ok=True)
    page = os.path.join(out_dir, "fronts.html")
    with open(page, "w", encoding="utf-8") as f:
        f.write(html)
    shot = os.path.join(out_dir, "fronts.png")
    chrome.screenshot(page, shot, w * len(cards), h, scale=scale,
                      what=(f"the {len(cards)}-front strip "
                            f"({w * len(cards)}x{h} at scale {scale})"))
    from PIL import Image
    strip = Image.open(shot)
    # Slice from the ACTUAL rendered width rather than assuming w*scale: Chrome
    # can round a device-scale-factor, and a sub-pixel drift accumulated across
    # eight cards would shear the last crop.
    cw = strip.width / len(cards)
    out = []
    for i, front in enumerate(fronts):
        path = os.path.join(out_dir, f"front-{front}.png")
        strip.crop((int(round(i * cw)), 0,
                    int(round((i + 1) * cw)), strip.height)).save(path)
        out.append(path)
    return out


def _recipe_cell(recipe, fallback_vb=None):
    """The card's box in viewBox units — the whole card in v2.

    ``fallback_vb`` is the ARTWORK's own viewBox, used when the recipe has none.
    A template with no detected recipe yet still has a card to measure against,
    and card_slots are FRACTIONS of it — without this the cell collapsed to
    [0,0,0,0] and every fraction multiplied to zero, so a hand-calibrated
    template rendered a blank card instead of its text.
    """
    card = recipe.get("card") or {}
    if card.get("cell"):
        return card["cell"]
    vb = recipe.get("viewBox") or fallback_vb or [0, 0, 0, 0]
    return [vb[0], vb[1], vb[0] + vb[2], vb[1] + vb[3]]


def build_page(theme, clean_svg, words_by_card, title_lines, word_font=None):
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    recipe = config.recipe_or_empty(cfg)
    # word_font optionally overrides the theme's card font (a filename); it
    # resolves against the theme's own fonts/ dir first, then the shared
    # word-fonts/ pool. No override -> the theme's configured word_font.
    word_font = config.resolve_word_font(theme, word_font)
    title_font = config.font_path(theme, cfg["title_font"])
    ts = cfg["title_style"]
    svg = open(clean_svg, encoding="utf-8").read()
    style = ("<style>" + GEOMETRIC_TEXT_STYLE + font_face("HebWord", word_font)
             + font_face("TitleFont", title_font,
                         config.title_font_weight(cfg)) + "</style>")
    overlay = [style]
    for ci, card in enumerate(recipe["cards"]):
        if not card:
            continue
        if card.get("title") and title_lines:
            # The recipe may record ONE box per title LINE (birthday-girls has 2).
            # Fit the stacked title into the UNION of those boxes — using only
            # card["title"][0] would cram every line into the first line's height
            # (~half size). For a single-box title the union is that box (no-op).
            tb = card["title"]
            tbox = {"x0": min(b["x0"] for b in tb), "y0": min(b["y0"] for b in tb),
                    "x1": max(b["x1"] for b in tb), "y1": max(b["y1"] for b in tb)}
            # Optional per-theme title nudge, as [dx, dy] fractions of the card
            # cell (positive = right / down). Used to seat a title that the
            # detected box places into a corner (e.g. japanese, top-left) at the
            # original's inset position. No-op when unset.
            #
            # PER CARD, not one nudge for the sheet: the eight fronts of a sheet
            # differ by more than an icon (japanese alternates which corner the
            # koi occupies), so the position that clears the artwork on cards 1-4
            # lands the title ON it for 5-8. ``front_offset["<n>"]`` answers for
            # one card and falls back to the shared ``offset``, so a theme that
            # never needed per-card placement renders exactly as before.
            off = config.front_offset(cfg, ci + 1)
            cell = card.get("cell")
            tbox = _nudge_title_box(tbox, cell, off)
            overlay.append(title_block(tbox, title_lines,
                                       ts["fill"], ts["outline"], title_font,
                                       ts["outline_w"], ts["arch"], ts["shadow"],
                                       rtl=title_is_rtl(cfg),
                                       fixed_size=ts.get("size"),
                                       align=config.front_align(cfg, ci + 1),
                                       italic=ts.get("italic", False),
                                       bold=ts.get("bold", False),
                                       bold_w=ts.get("bold_w"),
                                       leading=ts.get("leading"),
                                       one_block=bool(ts.get("one_block"))))
        words = words_by_card[ci] if ci < len(words_by_card) else []
        # A card may carry a title but no word slots (its title was drawn above);
        # skip the word pass so the sizing below can't crash the whole page.
        if not card["words"]:
            continue
        wf_metrics, wf_ref = _word_metrics(word_font)
        bold_w = config.word_bold_w(cfg, _WORD_BOLD_W)
        layouts = _word_layouts(card["words"], words, wf_metrics, wf_ref,
                                cell=card.get("cell"), word_size=cfg.get("word_size"),
                                bold_w=bold_w)
        for wi, slot in enumerate(card["words"]):
            if layouts[wi] is None:
                continue
            lay = layouts[wi]
            center = (slot["y0"] + slot["y1"]) / 2
            x_right = _line_right_edge(slot["x1"], card.get("cell"))
            overlay.append(word_lines(x_right, center, lay.size, slot["color"],
                                      wi + 1, lay.lines, word_font, lead=lay.lead,
                                      bold_w=bold_w))
    body = "".join(overlay)
    return svg.replace("</svg>", body + "</svg>")


def render(theme, clean_svg, words_by_card, title_lines, out_png, word_font=None):
    svg = build_page(theme, clean_svg, words_by_card, title_lines, word_font=word_font)
    svg_path = out_png.replace(".png", ".svg")
    open(svg_path, "w", encoding="utf-8").write(svg)
    w, h = dims(clean_svg)
    chrome.screenshot(svg_path, out_png, w, h, scale=2,
                      what=f"the page {os.path.basename(clean_svg)}")
    return out_png


def load_csv_row(path, row):
    rows = list(csvmod.DictReader(open(path, encoding="utf-8-sig")))
    r = rows[row]
    return [[r.get(f"c{c}w{w}", "") for w in range(1, 5)] for c in range(1, 9)]


if __name__ == "__main__":
    theme, clean, csvp, row, title, out = sys.argv[1:7]
    wbc = load_csv_row(csvp, int(row))
    render(theme, clean, wbc, title.split("|"), out)   # "OZ'S|WELCOME|PARTY"
    print("wrote", out)
