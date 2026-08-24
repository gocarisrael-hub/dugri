#!/usr/bin/env python3
"""Render one full 8-card page: overlay title + words onto the CLEAN background
at the recipe slots. No masking needed (background is already text-free).

  python3 generator/render_page.py <theme> <clean_svg> <csv> <row> <title> <out.png>
"""
import base64
import collections
import functools
import itertools
import math
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
    """The canvas size an SVG declares, in points: ``(width, height)``.

    READ OFF THE <svg> TAG, and only off it. This used to scan the first 2000
    characters for `width="(\d+)"` — digits only, anywhere in the file — which is
    wrong twice over. The photo card declares `width="223.92"`, a decimal the
    pattern cannot match, so the search ran on into the artwork and found
    `stroke-width="8"` on a child element: the card was screenshotted 8 points
    wide, a sliver of orange. Any template whose clean SVG carries a decimal
    width has the same fault waiting in the preview path.

    So: the opening tag is isolated first (a child's stroke-width can no longer
    be mistaken for the canvas), decimals are accepted, and the viewBox answers
    when the tag states no size at all — which is legal SVG and, for a file we
    are about to rasterise at a fixed pixel size, the same question.
    """
    head = open(svg, encoding="utf-8").read(4000)
    m = re.search(r"<svg\b[^>]*>", head, re.S)
    tag = m.group(0) if m else head
    w = re.search(r'\bwidth="([\d.]+)', tag)
    h = re.search(r'\bheight="([\d.]+)', tag)
    if w and h:
        return round(float(w.group(1))), round(float(h.group(1)))
    vb = re.search(r'\bviewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)', tag)
    if vb:
        return round(float(vb.group(3))), round(float(vb.group(4)))
    raise ValueError("cannot read a canvas size from %s" % svg)


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


# THE TWO FAMILIES, DECLARED TOGETHER OR NOT AT ALL.
#
# ``HebWord``/``TitleFont`` are named in the markup by every render path — the
# buyer's single-card preview, the owner's fronts strip, the v1 sheet, the deck,
# the backs and the board — and each of those declared them itself. A second
# face doubles the number of places a declaration can be forgotten, and a
# FORGOTTEN one does not fail: Chrome silently substitutes a system font for the
# family it cannot find, so the surface prints in Helvetica and nothing says so.
# That is the exact failure this feature exists to remove, so the pairing is
# made once, here, and every site asks for the pair.
#
# ``emit`` is the rule-writer, because the deck assembles its stylesheet through
# ``deck_html.font_face`` (same output, no import cycle) while everything else
# uses the one above. Nothing else differs, and nothing else may.


def word_faces(theme, word_font=None, emit=None):
    """``@font-face`` for a card's word face, plus the Latin one if it has one.

    Empty second half whenever the theme ships no alt face (every template
    today) or the buyer picked her own word font (see ``word_font_alt``), so a
    surface that has always declared one family goes on declaring exactly one.
    """
    emit = emit or font_face
    css = emit("HebWord", config.resolve_word_font(theme, word_font))
    alt = word_font_alt(theme, word_font)
    return css + (emit("HebWordAlt", alt) if alt else "")


def title_faces(theme, cfg=None, emit=None, lines=None):
    """``@font-face`` for the ONE face this title is set in.

    ``TitleFont`` must name the SAME FILE the fit measured, or the title is
    measured in one typeface and painted in another. That is not hypothetical:
    when the choice moved to ``title_font_for`` but this kept emitting the
    design's own file, a buyer's Hebrew title on an English design was measured
    in the second face and painted as ``TitleFont`` — the design's Latin face,
    which has no Hebrew — so Chrome substituted a system font. The owner's card
    came back in a typeface nobody had chosen. Pass ``lines`` and the two agree
    by construction.

    ``lines`` is optional only for callers with no title to set (a preview of
    the plate alone); without it this falls back to the design's own face, which
    is what a titleless render would have used anyway.

    No second family is declared. A title is one face — ``title_font_for`` has
    already picked it — so there is nothing for a ``TitleFontAlt`` to be.
    """
    emit = emit or font_face
    cfg = cfg or config.theme(theme)
    path = (title_font_for(theme, lines, cfg) if lines
            else config.resolve_title_font(theme))
    return emit("TitleFont", path, config.title_font_weight(cfg))


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


class Face:
    """One or two fonts, measured as if they were one.

    A template ships a Hebrew word face. The owner may upload a Latin one beside
    it; when she has, Latin runs are set in it — her choice, applied outright,
    not "when the Hebrew face can't cope".

    Every width and ink reading in the fitter goes through here so that the
    number the fit reserves is the number the renderer paints. Get that wrong
    and lines cross the trim, which is the whole reason the fit measures at all.

    WITH NO ALT FACE THIS IS THE PRIMARY FONT, NOT A WRAPPER OVER IT. ``length``
    returns ``primary.getlength(text)`` — the same call, the same float, no sum
    over a one-element list that could reassociate and move a last digit. That
    is what makes an un-uploaded second font byte-identical rather than merely
    equivalent, and it is asserted in the tests.

    IT ANSWERS THE FONT PROTOCOL, and that is deliberate rather than convenient:
    ``getlength``/``getbbox``/``getmetrics``/``path`` are exactly what the fit
    already asks a measuring font, so handing the fitter a Face routes every
    reading through both faces without a single call site having to remember to.
    A function that measures therefore CANNOT accidentally reach past the second
    face — it has no other handle to reach with. The three that must NOT see it
    (``_marker_geometry``, ``_marker_advance``, ``_glyph_bearings``: the digit is
    the card's own face by design) are handed ``_primary`` explicitly, which
    makes the exception visible at the call site instead of implied by absence.

    ``alt_scale`` is how big the SECOND face sets, as a fraction of the card's
    word size, and it lives here for the same reason every other reading does:
    the number the fit reserves has to be the number the renderer paints. It
    applies to the alt face's OWN runs and to nothing else — the primary is never
    scaled, so the promise above survives it (with no alt face there is no run to
    scale and ``length`` is still the one call).
    """

    __slots__ = ("primary", "alt", "ref", "rtl", "alt_scale")

    def __init__(self, primary, alt=None, ref=200, rtl=True, alt_scale=1.0):
        self.primary = primary
        self.alt = alt
        self.ref = ref
        self.rtl = rtl
        self.alt_scale = alt_scale

    @property
    def single(self):
        return self.alt is None

    @property
    def faces(self):
        """Every font this may set text in — one, or two.

        UNSCALED, deliberately: the one caller is ``_font_lead``, which reads the
        deck's row pitch as the worst case over both faces. A pitch is a floor —
        reserving it off the Latin face's full-size ink can only leave a hair
        more air between rows, never less — and the nine shipped designs were
        calibrated against that floor. Scaling it here would re-space every one
        of them as a side effect of making their English a little smaller, which
        is not what the owner asked for.
        """
        return (self.primary,) if self.alt is None else (self.primary, self.alt)

    def scale(self, is_latin):
        """The fraction of the card's word size a run is set at.

        ``1.0`` for a run in the card's own script, ``alt_scale`` for a Latin
        one. Every width, box and emitted ``font-size`` asks this rather than
        deciding for itself, so the fit and the render cannot answer differently.

        It takes the SCRIPT flag ``runs_by_script`` hands out and not a font,
        deliberately — see that method for the six designs where the two faces
        are one object and a font could not have told them apart.
        """
        return self.alt_scale if is_latin and self.alt is not None else 1.0

    @property
    def path(self):
        """The primary's file, for the readings that rasterize by path."""
        return getattr(self.primary, "path", None)

    def getmetrics(self):
        """The PRIMARY's ascent/descent, which is the frame ``bbox`` reports in.

        Both faces sit on one baseline, so one origin has to be chosen for the
        two to be comparable at all, and the card's own face is the honest one.
        """
        return self.primary.getmetrics()

    def runs(self, text):
        """``[(font, substring)]`` in logical order, covering ``text`` exactly.

        Split against the LINE's own base direction, not the card's. A neutral at
        the edge of a line takes the base direction (Unicode N1/N2), so under the
        card's Hebrew base the break hyphen at the end of "TELEV-" became its own
        right-to-left run and was placed at the LEFT of the English word it
        belongs to. The line knows which way it reads; ask it.
        """
        return [(f, t) for f, t, _lat in self.runs_by_script(text)]

    def runs_by_script(self, text):
        """``runs``, each with the flag that says WHICH FACE'S RULE it follows.

        ASK THE SCRIPT, NEVER THE FONT OBJECT. Six of the ten shipped designs
        name the SAME file in both word slots — their Hebrew face draws Latin
        perfectly well, and the owner filled the second slot anyway — so on those
        cards ``font is self.alt`` is true of every run, Hebrew included. Anything
        that keyed off identity therefore treated a Hebrew word as English: it
        would have shrunk their Hebrew along with their English, which is the
        opposite of what the owner asked for on six of the nine designs she
        named. The split already knows which run is which; carry the answer.
        """
        if self.alt is None:
            return [(self.primary, text, False)]
        base = self.rtl
        if _line_is_latin(text):
            base = False
        elif _line_is_rtl(text):
            base = True
        return [(self.alt if lat else self.primary, t, lat)
                for lat, t in script_runs(text, base_rtl=base)]

    def uses_alt(self, text):
        """True when any run of ``text`` would be set in the second face."""
        return self.alt is not None and any(lat for _f, _t, lat
                                            in self.runs_by_script(text))

    def length(self, text):
        if self.alt is None:
            return self.primary.getlength(text)
        return sum(f.getlength(t) * (self.alt_scale if lat else 1.0)
                   for f, t, lat in self.runs_by_script(text))

    def bbox(self, text):
        """The union box, expressed against a pen starting at x=0.

        Runs advance one after another, so each run's own box is offset by the
        width of everything before it. The vertical extremes are the union: a
        Latin descender under a Hebrew line still has to be cleared.

        MEASURED AGAINST ONE BASELINE. Pillow reports a box relative to the
        font's own ASCENDER line, and two faces at one size do not share an
        ascent — Cafe's is 213 of a 200-unit em where Fredoka's is 194, so a
        naive union of the two boxes reads a 19-unit descender that is not
        there and reserves row pitch for it. Each run's box is therefore shifted
        onto the primary's ascender, which is the frame ``getmetrics`` reports
        and the one every caller subtracts.

        A SCALED RUN SHRINKS ABOUT ITS BASELINE, not about the ascender line it
        is reported against — the renderer sets it at a smaller ``font-size`` on
        the SAME baseline. So each run's box is taken to the baseline first
        (``b - ascent``), scaled there, and only then lifted onto the primary's
        ascender. At ``scale == 1.0`` that is the same arithmetic as before,
        exactly: ``(b - f_asc) * 1.0 + asc`` is ``b + (asc - f_asc)``.
        """
        if self.alt is None:
            return self.primary.getbbox(text)
        asc = self.primary.getmetrics()[0]
        x = 0.0
        x0 = y0 = x1 = y1 = None
        for f, t, lat in self.runs_by_script(text):
            s = self.scale(lat)
            b = f.getbbox(t)
            if b is not None:
                f_asc = f.getmetrics()[0]          # this run's own ascender line
                bx0, bx1 = b[0] * s + x, b[2] * s + x
                by0 = (b[1] - f_asc) * s + asc     # onto the primary's baseline
                by1 = (b[3] - f_asc) * s + asc
                x0 = bx0 if x0 is None else min(x0, bx0)
                y0 = by0 if y0 is None else min(y0, by0)
                x1 = bx1 if x1 is None else max(x1, bx1)
                y1 = by1 if y1 is None else max(y1, by1)
            x += f.getlength(t) * s
        return (0, 0, 0, 0) if x0 is None else (x0, y0, x1, y1)

    # The font protocol, so the fitter can hold this where it held a font.
    getlength = length
    getbbox = bbox


def _primary(font):
    """The card's OWN face, whatever the fitter was handed.

    The numbered marker is drawn in the card's face and stops there by design
    (see ``_marker_geometry``): an uploaded Latin face may not move a digit, and
    the digit column every word on the card starts after is measured off it. So
    the three marker readings take this rather than the ``Face``, and say so.
    """
    return font.primary if isinstance(font, Face) else font


# How big a card's ENGLISH words are set, as a fraction of the card's word size.
# The owner: "the size of the font of the words only the words in english needs
# to be little bit smaller". A Latin face and a Hebrew one at one point size do
# not read as one size — the Latin x-height is the taller — so English sitting
# beside Hebrew on the same line prints heavier than the design ever intended.
#
# FOUR FIFTHS, and that number is hers rather than a measurement. Nine tenths was
# the first attempt; shown 100 / 85 / 80 / 75 per design on a card carrying both
# languages, she answered "english size - all 80%" — every design, the same
# number, including the one she had left out of her original list. So it is the
# house number and not ten copies of one. A design may still differ, via
# ``word_alt_scale`` in themes.json (see ``config.word_alt_scale``); none does.
_WORD_ALT_SCALE = float(os.environ.get("DUGRI_WORD_ALT_SCALE", "0.8"))


@functools.lru_cache(maxsize=8)
def _word_face(font_path, alt_font_path=None, ref=200,
               alt_scale=_WORD_ALT_SCALE):
    """The measuring instrument for a card's words: one face, or two.

    Cached on the PATHS rather than built per card, because the readings behind
    it are cached on the font OBJECTS — ``_font_lead`` rasterizes a whole glyph
    repertoire once per face, and a fresh Face per card would miss that cache on
    all 104 of them. The primary comes from ``_word_metrics``, so it is the same
    object the one-face path has always measured with.

    ``alt_scale`` rides on the Face rather than on the call sites, so the fit and
    the render read one number (see ``Face.scale``). It is part of the cache key
    because two designs may set their English at two sizes off the same pair of
    files.
    """
    primary = _word_metrics(font_path, ref)[0]
    alt = _word_metrics(alt_font_path, ref)[0] if alt_font_path else None
    return Face(primary, alt, ref, alt_scale=alt_scale)


def word_font_alt(theme, word_font=None):
    """The theme's LATIN word face for THIS render, or ``None``.

    AN EXPLICIT BUYER OVERRIDE SUPPRESSES IT. The word-font picker promises the
    buyer "your whole card in this face"; pairing the face she chose with the
    template's Latin one is a combination nobody designed and she never saw. The
    rule lives here, in one place, because both the ``@font-face`` block and the
    fit have to agree about it — a declaration without a fit would set Latin in
    a face the widths were never measured for.
    """
    return None if word_font else config.resolve_word_font_alt(theme)


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
    # Only when a fixed column is in play — which, since every card is laid on
    # the card-wide grid, is every card that passes an advance. A caller that
    # anchors each line on its own slot (no advance) never had an x for its
    # digits to be ragged about, and reads the same as it always did.
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
# ...and its mirror, for a line that is LATIN. The embedding above states the
# base direction of the characters, and stating RTL over an English line puts its
# NEUTRALS on the wrong side: "TELEVISION" broken across two lines rendered as
# "-TELEV" — the break hyphen, a neutral at the end of a Latin run, taking the
# line's RTL base and jumping to the left edge. The owner: "in the english words
# the hyphen should be on the right".
#
# Chosen per LINE rather than per card, because one card can hold both: a Hebrew
# entry and an English one, each wanting its own base.
_LTR_EMBED = "‪"


def _line_is_rtl(text):
    """Whether this line reads right to left, by its first strong character."""
    import unicodedata

    for ch in text:
        if unicodedata.bidirectional(ch) in ("R", "AL"):
            return True
        if unicodedata.bidirectional(ch) == "L":
            return False
    return False


def _line_is_latin(text):
    """Whether this line reads left to right, by its first strong character."""
    import unicodedata

    for ch in text:
        klass = unicodedata.bidirectional(ch)
        if klass == "L":
            return True
        if klass in ("R", "AL"):
            return False
    return False


def _embed(text):
    """``text`` wrapped in the base direction its own letters call for."""
    opener = _LTR_EMBED if _line_is_latin(text) else _RTL_EMBED
    return f"{opener}{escape(text)}{_RTL_POP}"


def word_lines(x_right, center_y, size, color, num, lines, font_path, lead=None,
               marker_advance=None, bold_w=0.0, alt_font_path=None,
               alt_scale=_WORD_ALT_SCALE):
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
    card the caller does not pass the slot centre here — it passes the centre the
    CARD-WIDE line grid put this entry on (see ``_grid_centers``), so every gap on
    the card, inside an entry or between two, is the same.

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

    ``alt_scale`` sets the LATIN runs a fraction smaller (see ``_WORD_ALT_SCALE``)
    and MUST be the number the fit measured with — it is handed to the Face, and
    the same Face hands back the widths the pen walks, so the two cannot part.
    The marker keeps the card's own size whatever this is: the digit is the
    card's own face by design.
    """
    msize = size * _MARKER_SCALE
    # The optional Latin face. Absent, every line below takes the one-face
    # branch, which emits the exact markup it always has — and so does a HEBREW
    # line on a design that fills both slots with the same file, because the
    # branch is chosen by the line's SCRIPT and not by which object the split
    # handed back (see ``Face.runs_by_script``).
    face = _word_face(font_path, alt_font_path, alt_scale=alt_scale)
    font, ref = face.primary, face.ref
    digit, digit_x, dot_x, marker_w = _marker_geometry(font, ref, num, msize,
                                                       advance=marker_advance)
    gap = size * _WORD_GAP
    word_x = x_right - marker_w - gap
    lead = size * (_lead_for(face, ref, lines) if lead is None else lead)
    first = center_y - (len(lines) - 1) * lead / 2 + size * _CENTER_DROP
    # paint-order="stroke" keeps the stroke UNDER the fill, so the glyph grows
    # outward instead of the stroke eating into its own counters. The stroke is
    # a fraction of the size the run is SET at, so a Latin run set smaller is
    # fattened proportionally rather than being stroked as if it were full size —
    # which would undo the very weight-matching this scaling exists to do.
    def _fat(sz):
        return (f'stroke="{color}" stroke-width="{sz * bold_w:.2f}" '
                'paint-order="stroke" stroke-linejoin="round" ') if bold_w else ""

    fat, m_fat = _fat(size), _fat(msize)
    out = [
        f'<text x="{x_right + digit_x:.2f}" y="{first:.2f}" font-family="HebWord" '
        f'font-size="{msize:.2f}" fill="{color}" {m_fat}text-anchor="end" '
        f'direction="ltr" xml:space="preserve">{digit}</text>'
        f'<text x="{x_right + dot_x:.2f}" y="{first:.2f}" font-family="HebWord" '
        f'font-size="{msize:.2f}" fill="{color}" {m_fat}text-anchor="end" '
        f'xml:space="preserve">.</text>'
    ]
    for i, line in enumerate(lines):
        y = first + i * lead
        runs = face.runs_by_script(line)
        if not runs or len(runs) == 1 and not runs[0][2]:
            # The one-face line, and it must emit the EXACT string it always
            # did — this is the branch every shipped card takes.
            out.append(
                f'<text x="{word_x:.2f}" y="{y:.2f}" '
                f'font-family="HebWord" font-size="{size:.2f}" fill="{color}" '
                f'{fat}text-anchor="end" xml:space="preserve">'
                f'{_embed(line)}</text>'
            )
            continue
        # A line in two faces cannot be one <text>: Chrome ignores
        # direction="rtl" for RUN ordering (the reason the marker above is
        # already three elements), so the runs are ordered and placed here.
        #
        # Anchored by each run's END, walking VISUAL order left to right, so the
        # anchoring model that is already proven under Chrome is untouched:
        #
        #     x_end(j) = word_x - W + sum(w_i for i <= j)
        #
        # One run collapses that to word_x exactly, by algebra.
        #
        # The width of a run is its advance AT THE SIZE IT IS PAINTED, which for
        # a Latin run is ``alt_scale`` of the card's. Asked of the Face rather
        # than assumed here, because ``_line_width_at`` reserves off the very
        # same reading: measure a run full size and paint it nine tenths and the
        # line prints inside a width nobody uses; the other way round it crosses
        # the trim.
        widths = [f.getlength(t) * face.scale(lat) / ref * size
                  for f, t, lat in runs]
        total = sum(widths)
        pen = word_x - total
        for (f, txt, latin), w in reversed(list(zip(runs, widths))):
            pen += w
            body = escape(txt) if latin else _embed(txt)
            fam = "HebWordAlt" if latin else "HebWord"
            rsize = size * face.scale(latin)
            out.append(
                f'<text x="{pen:.2f}" y="{y:.2f}" font-family="{fam}" '
                f'font-size="{rsize:.2f}" fill="{color}" {_fat(rsize)}'
                f'text-anchor="end" xml:space="preserve">{body}</text>'
            )
    return "".join(out)


def latin_scale(cfg, size, default):
    """The share of the card's size a LATIN run sets at, with its ceiling on.

    ``word_alt_scale`` is the design's ratio; ``word_max_en`` is the largest a
    Latin run may print whatever that ratio works out to. Expressed back as a
    ratio because that is what the Face carries, and because the fit measured
    with a ratio — one that can only ever come DOWN, so every width the fit
    reserved is still enough and no run can reach past the row it was fitted in.
    """
    scale = config.word_alt_scale(cfg, default)
    ceiling = config.type_ceiling(cfg, "word_max_en")
    if ceiling and size > 0:
        scale = min(scale, ceiling / size)
    return scale


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
    """ONE right anchor for every numbered line on a card.

    The four slots are supposed to share an anchor — the origin's numbers sit in
    a column — but each recorded box is the INK extent of a different origin
    word, so they disagree: on the affected deck by 2.24 units (0.8 mm) between
    slot 3 and slot 4, which is a visibly ragged column of digits. The WIDEST
    right edge is the honest estimate of where that column really is (ink can
    only fall short of the anchor, never past it), clamped as always so the
    marker cannot land on the card border.
    """
    return _line_right_edge(max(s["x1"] for s in slots), cell)


# The narrowest text box this will hand a card, as a fraction of the card width.
# A design whose numbered column sits unusually far in would otherwise mirror
# itself into a sliver; 0.40 is what אואזיס — the one design that states its own
# text box — actually uses, so no shipped card is touched by this floor and a
# freak measurement cannot produce a column too narrow to set a phrase in.
_MIN_BAND = float(os.environ.get("DUGRI_MIN_BAND", "0.40"))


# ONE ROW GRID AND ONE INK COLOUR FOR THE WHOLE TEMPLATE.
#
# The recipe's rows and colours were read off each card's own artwork, one card
# at a time, and each card's origin had different words in it — so eight cards
# that the design draws identically came back disagreeing. On קליפורניה the first
# row sits anywhere from 84.5 to 107.8 units below the card's top (8 mm of drift
# across the deck); on ברוקלין the four rows carry SIX different colours, one of
# them (#4f2d6c) a purple in a design whose words are blue.
#
# The owner's rule, and it is obviously right: "should be the same in all the
# cards in template". So the deck's own measurements are pooled — the MEDIAN row
# offset and the MOST COMMON colour — and every card is set from those. Nothing
# is invented: both values come from the detector's own readings, with the noise
# voted out instead of printed.
def _median(values):
    ordered = sorted(values)
    mid = len(ordered) // 2
    if not ordered:
        return 0.0
    return (ordered[mid] if len(ordered) % 2
            else (ordered[mid - 1] + ordered[mid]) / 2)


@functools.lru_cache(maxsize=32)
def _deck_rows(theme):
    """``(offsets, colour)`` for a template: where its rows sit under the card's
    top edge, and the one colour its words are set in. ``(None, None)`` when the
    recipe says nothing this can be pooled from."""
    recipe = config.recipe_or_empty(config.theme(theme))
    if not recipe:
        return None, None
    cards = []
    if config.is_single_card_recipe(recipe):
        card = recipe.get("card") or {}
        if card.get("words") and card.get("cell"):
            cards.append((card["cell"], card["words"]))
    else:
        for card in recipe.get("cards") or []:
            if card and card.get("words") and card.get("cell"):
                cards.append((card["cell"], card["words"]))
    if not cards:
        return None, None
    per_row = {}
    colours = {}
    for cell, slots in cards:
        for i, slot in enumerate(slots):
            centre = (slot["y0"] + slot["y1"]) / 2 - cell[1]
            per_row.setdefault(i, []).append(centre)
            col = slot.get("color")
            if col:
                colours[col] = colours.get(col, 0) + 1
    offsets = [_median(per_row[i]) for i in sorted(per_row)]
    colour = max(colours, key=colours.get) if colours else None
    return offsets, colour


def deck_slots(theme, slots, cell):
    """``slots`` re-seated on the deck's own row grid, in its own ink colour.

    Each slot keeps its own HEIGHT (that is what the size fit reads) and its own
    x span; only where it sits and what colour it prints move, and both move to
    the value the deck as a whole measured.
    """
    offsets, colour = _deck_rows(theme)
    if not offsets or not cell:
        return slots
    out = []
    for i, slot in enumerate(slots):
        box = dict(slot)
        if i < len(offsets):
            half = (slot["y1"] - slot["y0"]) / 2
            centre = cell[1] + offsets[i]
            box["y0"], box["y1"] = centre - half, centre + half
        if colour:
            box["color"] = colour
        out.append(box)
    return out


def _card_left_edge(slots, cell):
    """ONE left line for every entry on a card — the mirror of its right anchor.

    THE OWNER'S RULE, in her words: *all text boxes are aligned to the same
    invisible left line*. Every card in the shop is drawn that way, and until now
    only a template that STATED its column (``card_slots``) had one: everything
    else fell back to the card's trim-safe area, 5% in from the paper edge. So a
    long entry on פריז ran to within 5% of the card while the same card kept a
    23% margin on the right — and, having no box to wrap inside, it bought the
    room by shrinking the whole card to 15.2 where אואזיס set 21.3.

    The line is the MIRROR of the right anchor, because that anchor is measured
    (``_card_right_edge``: where the origin's numbered column sits) and these
    designs set their words in a centred box — so the distance the text keeps
    from the right edge is the distance it keeps from the left. Checked against
    the one design that says: אואזיס's stated column starts at 0.300 of the card
    and its anchor sits at 0.700. The mirror reproduces its own line exactly.

    It cannot crowd the printed border, and that is by construction rather than
    by another constant: the anchor is already held ``_LINE_RIGHT_MARGIN`` off
    the right edge, so its mirror is at least that far off the left one.
    """
    right = _card_right_edge(slots, cell)
    if not cell:
        return min(s["x0"] for s in slots)
    left = cell[0] + (cell[2] - right)
    return min(left, right - _MIN_BAND * (cell[2] - cell[0]))


def _line_width_at(font, ref, num, word, advance=None):
    """Full numbered-line width (marker + gap + word) at the metric ``ref`` size.
    Everything scales linearly with the font size, so a width measured at ``ref``
    converts to any render size S by multiplying by S/ref. ``advance`` must be
    the same fixed digit column the render uses, or the fit and the render
    disagree about where the word starts.

    The MARKER is measured in the card's own face (``_primary``) and the WORD in
    whatever the caller is setting it in — which is what the renderer does, so
    the width reserved here is the width painted."""
    _, _, _, marker_w = _marker_geometry(_primary(font), ref, num,
                                         ref * _MARKER_SCALE, advance=advance)
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


def _font_lead(font, ref):
    """The ONE line pitch this card's face — or FACES — needs.

    THE MAXIMUM OVER BOTH. Two faces set at one size do not have one ink height:
    a Latin face uploaded beside the Hebrew one draws its own ascenders and
    descenders, and the owner's rule from #340 is that a card's rows sit one
    constant pitch apart. Measure that pitch off only one of the two and the
    rule breaks on exactly the cards the second face exists for — the pitch
    would be the Hebrew face's, and a Latin descender would reach into it.
    """
    return max(_face_lead(f, ref) for f in getattr(font, "faces", (font,)))


@functools.lru_cache(maxsize=8)
def _face_lead(font, ref):
    """The ONE line pitch a single face needs, as a multiple of the font size.

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
    mbox = _primary(font).getbbox(marker)      # the digit is the card's own face
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
# ``image`` is in the list because a template may place a raster: Canva exports
# one whenever a decoration is not vector art, and a scan that cannot see it
# would report that corner of the card as empty paper. Its box is the placement
# rectangle, transparent margin included, so it reserves a little more than the
# picture's own ink — the safe direction, and noted where it is used.
_GEOM_TAG = re.compile(r"<(/?)(g|path|rect|image)\b([^>]*?)(/?)>", re.S)
_ATTR = re.compile(r'([a-zA-Z:-]+)\s*=\s*"([^"]*)"')
_CLIPPATH = re.compile(r'<clipPath\b[^>]*\bid="([^"]+)"[^>]*>(.*?)</clipPath>', re.S)
_CLIP_REF = re.compile(r"url\(#([^)]+)\)")
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


# ONE WALK OVER THE ARTWORK, TWO QUESTIONS. ``frame_box`` asks "where is the
# printed border"; ``card_obstacles`` asks "where is the artwork the words must
# stay off". Both need the same thing first — every drawn element, in the root's
# coordinates, with the nested <g transform=…> stack resolved — and only then do
# they disagree about which elements matter. So the walk is shared and the
# PREDICATES are separate: widening ``frame_box`` to see icons would have made it
# answer a question it is pinned against (a frame is fill="none", an icon is
# filled; see ``test_a_filled_shape_is_not_a_frame``).
class Shape:
    """One drawn element, in the root's coordinates.

    ``box`` IS PARSED ON DEMAND, and that is the difference between this being a
    shared walk and being a tax on one. Reading an element's outline means
    pulling every number out of its ``d`` — thousands of them on a Canva export,
    and the eight sheets carry about 13,000 elements each. Both callers reject
    most of what the walk yields before they care where it is (``frame_box`` on
    "no fill, has a stroke", ``card_obstacles`` on "paints anything at all"), so
    parsing eagerly did that work for elements nobody asked about: it made
    ``frame_box`` — which matches a handful of outlines per sheet — 30x slower
    than it had been, and a deck's layout 70x. Deferred, each caller pays only
    for the elements its own predicate let through.
    """

    __slots__ = ("name", "attrs", "clip", "mat", "_box")

    def __init__(self, name, attrs, clip, mat):
        self.name, self.attrs, self.clip, self.mat = name, attrs, clip, mat
        self._box = ()                    # () is "not read yet"; None is "cannot"

    @property
    def box(self):
        if self._box == ():
            pts = _shape_points(self.name, self.attrs)
            self._box = _box_of(self.mat, pts) if pts else None
        return self._box


def _shape_points(name, attrs):
    """An element's own corner points, or None when they cannot be read.

    None is a REPORT, not an empty shape: the element is drawn and we could not
    say where. ``frame_box`` may drop it (a frame it cannot read is a frame it
    cannot trust), but ``card_obstacles`` counts it, because silently treating
    unreadable artwork as absent is how words end up printed on top of it.
    """
    if name in ("rect", "image"):
        try:
            x, y = float(attrs.get("x", 0)), float(attrs.get("y", 0))
            w, h = float(attrs["width"]), float(attrs["height"])
        except (KeyError, ValueError):
            return None
        return [(x, y), (x + w, y), (x, y + h), (x + w, y + h)]
    return _path_points(attrs.get("d"))


def _box_of(t, pts):
    """The bounding box of ``pts`` under transform ``t``."""
    xs = [t[0] * x + t[2] * y + t[4] for x, y in pts]
    ys = [t[1] * x + t[3] * y + t[5] for x, y in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def _intersect(a, b):
    """``a`` clipped by ``b``; either may be None (meaning "no bound")."""
    if a is None:
        return b if b is None else list(b)
    if b is None:
        return list(a)
    return [max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])]


@functools.lru_cache(maxsize=16)
def _clip_boxes(svg_text):
    """Each ``<clipPath id=…>``'s bounding box, in its own user space.

    A CLIP IS NOT DECORATION, it is the shape that is actually painted. Canva
    exports a confetti dot as a full-sheet ``<rect>`` inside a ``<g
    clip-path=…>`` whose clipPath is the dot: read without the clip, one
    birthday-girls sprinkle measures 1212 x 858 units and swallows the entire
    sheet. Every ``<g>`` in the eight shipped templates carries a clip and none
    carries a transform as well, so the clip is composed with the group's own
    matrix — which is what SVG asks for and, with no transform in play anywhere,
    is not a reading the artwork can disagree with.

    The box, not the outline: a clip is a mask of arbitrary shape and this scan
    reserves rectangles, so a clipped element is reported over the clip's extent.

    Cached on the artwork text: a sheet declares its clips once and every walk
    over it wants the same answer, so re-reading them per card was 104 passes
    over the ``<defs>`` for one dictionary.
    """
    out = {}
    for cid, body in _CLIPPATH.findall(svg_text):
        boxes = []
        for m in _GEOM_TAG.finditer(body):
            close, name, attrs, _selfclose = m.groups()
            if close or name == "g":
                continue
            pts = _shape_points(name, dict(_ATTR.findall(attrs)))
            if pts:
                boxes.append(_box_of(_parse_transform(attrs), pts))
        if boxes:
            out[cid] = [min(b[0] for b in boxes), min(b[1] for b in boxes),
                        max(b[2] for b in boxes), max(b[3] for b in boxes)]
    return out


def _svg_shapes(svg_text):
    """Every drawn element of ``svg_text`` as a ``Shape`` in root coordinates.

    ``box`` is the element's own bounding box, read on first ask and None when
    it cannot be read (see ``Shape`` and ``_shape_points``); ``clip`` is the box
    of the clip in force on it, or None; ``mat`` is the matrix its own
    coordinates were resolved through, which is what scales a ``stroke-width``.
    Box and clip are kept APART rather than pre-intersected because the callers want
    different answers: the frame scan measures the border's own geometry, which
    is what it was calibrated against, while the obstacle scan wants the paper
    the element actually covers.
    """
    clips = _clip_boxes(svg_text)
    body = _DEFS_BLOCK.sub("", svg_text)
    stack = [(_IDENTITY, None)]

    def clipped(t, attrs, inherited):
        ref = _CLIP_REF.search(attrs)
        if not ref or ref.group(1) not in clips:
            return inherited
        c = clips[ref.group(1)]
        return _intersect(inherited, _box_of(t, [(c[0], c[1]), (c[2], c[3])]))

    for m in _GEOM_TAG.finditer(body):
        close, name, attrs, selfclose = m.groups()
        if name == "g":
            if close:
                if len(stack) > 1:
                    stack.pop()
            elif not selfclose:
                t = _mat_mul(stack[-1][0], _parse_transform(attrs))
                stack.append((t, clipped(t, attrs, stack[-1][1])))
            continue
        if close:
            continue
        t = _mat_mul(stack[-1][0], _parse_transform(attrs))
        yield Shape(name, dict(_ATTR.findall(attrs)),
                    clipped(t, attrs, stack[-1][1]), t)


@functools.lru_cache(maxsize=2)
def svg_shapes(svg_text):
    """``_svg_shapes`` for one piece of artwork, walked once.

    The WALK IS A PROPERTY OF THE SHEET and every question asked of it is about
    ONE CARD: a v1 sheet holds eight, so the same 13,000 elements were being
    re-parsed eight times to answer eight questions about eight corners of it —
    and each card asks twice, once for its frame and once for its icons. Held
    here, the artwork is read once and the ``Shape``s' deferred boxes memoise
    across every card that goes on to want them.

    TWO entries, which is all it needs and was measured to be: ``card_frame_box``
    and ``card_obstacle_rects`` already memoise their ANSWERS per (theme, front),
    so a walk is only ever repeated within one artwork — the eight cards of a
    sheet, or the two questions each of them asks. Raising it to 4 or 12 moved a
    104-card deck by under 2%, on either the v1 sheet or the nine-front v2 deck,
    so the smaller working set is the one to hold: an entry is a sheet's elements
    with their attributes, and these files run to four megabytes.
    """
    return tuple(_svg_shapes(svg_text))


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
    best = None
    for shape in svg_shapes(svg_text):
        a = shape.attrs
        # A frame is a STROKE, not a fill: an outline that paints no interior.
        if (a.get("fill") or "").strip() != "none":
            continue
        if not (a.get("stroke") or "").strip() or a["stroke"].strip() == "none":
            continue
        if shape.box is None:
            continue
        box = list(shape.box)
        if box[2] - box[0] < _FRAME_MIN_SPAN * w or box[3] - box[1] < _FRAME_MIN_SPAN * h:
            continue
        inset = min(box[0] - x0c, box[1] - y0c, x1c - box[2], y1c - box[3])
        if inset < _FRAME_MIN_INSET * min(w, h):
            continue
        try:
            sw = float(a.get("stroke-width", 1))
        except ValueError:
            sw = 1.0
        t = shape.mat
        sw *= abs(t[0] * t[3] - t[1] * t[2]) ** 0.5     # the transform's scale
        box = [box[0] + sw, box[1] + sw, box[2] - sw, box[3] - sw]
        if best is None or box[3] < best[3]:
            best = box
    return best


# THE ICONS. The owner's rule, in her words: "the words are covering the icon …
# the best is to take the words that are covering the icon to a new line (of
# course not if it's a 1 word word), or make the font smaller (and keep all the
# rules like same font for all words in a card)". So the artwork's decorations
# are paper the words may not use, and the fitter has to know where they are.
#
# WHY THE DETECTOR CANNOT ANSWER THIS. Slot detection reads ``recipe_diff`` —
# the clean plate subtracted from the filled one — so it sees exactly what the
# two plates DISAGREE about, which is the origin's own words and nothing else.
# The icons are drawn identically on both plates and cancel to zero. Detection
# is structurally blind to them; the only place they exist is the clean plate's
# own geometry, so that is what is read here.
#
# READ OFF THE SVG, NOT A RASTER, for the reason ``frame_box`` gives: the layout
# runs 104 times per order and inside unit tests, and neither may need a browser.
#
# WHAT COUNTS AS AN ICON — the whole difficulty, and the owner settled it by
# looking at the two templates that bracket the question:
#
#   * מרקאנה (football-boys) draws a light-blue panel over the whole card and
#     scatters badges, balls and players on top of it. She ruled the PANEL is
#     legitimate text area — it is the card's field, the words are meant to sit
#     on it — and only the badges are off limits.
#   * סנטוריני (anniversary) is a drawn scene, and she ruled it has NO icons at
#     all: its art is background, and its words print over it by design.
#
# Both rulings say the same thing: SCENERY IS NOT AN OBSTACLE. And on this
# artwork scenery turns out to be answerable geometrically, in two steps.
#
# PAINT ORDER FIRST, and it does most of the work. A v1 sheet is eight cards on
# one page, and the page's own decoration runs UNDER them: מרקאנה tiles
# footballs across the whole sheet and then lays each card's light-blue field on
# top, opaque, hiding every ball that falls inside a card. Read without paint
# order, card 1 reported 29 obstacles of which 25 were footballs nobody can see —
# the first contact sheet drew them, which is what contact sheets are for.
#
# So an element is dropped when a LATER opaque element's box CONTAINS it: later
# means painted over, opaque means it hides what it paints over, and contains
# means all of it. Stated that way rather than as "the card's field", because the
# field is not always the whole card and a rule written around that missed it —
# אשכוליות pages a card with bleed, so its cream panel covers 0.78 x 0.86 of the
# page and buries four shapes a whole-card test walked straight past (the second
# contact sheet drew those). Containment by the box treats a rounded panel's
# corners as covered, which is a quarter-millimetre of over-claim in four corners
# no word reaches.
#
# That is also the whole of the סנטוריני answer, and it is worth saying plainly
# because it is the strongest evidence the rule is the right one: her scene is
# drawn on the SHEET, and each card lays an opaque cream panel over it. Every one
# of its eight cards reports zero obstacles — not because a threshold was tuned
# until it did, but because there is genuinely nothing painted on those cards.
# She said סנטוריני has no icons; the geometry says the same thing unprompted.
#
# THEN SIZE, for what is painted on top of the field. A badge is an object
# sitting somewhere; a wash, a second panel or the printed border reaches across
# the card in BOTH directions. Measured on the shipped artwork the two
# populations are nowhere near each other — on מרקאנה the field layers span the
# card exactly (1.00 x 1.00 of the cell) and the largest badge is 0.37 x 0.31 —
# so _OBSTACLE_SPAN has a wide gap to sit in. It is deliberately a BOTH-axis
# test: a long flat object is still an object, and reading either axis alone
# dropped מרקאנה's bunting of hanging footballs (0.85 x 0.13) and the hull out
# from under the three passengers on טיול's banana boat (0.63 x 0.16), both of
# which the owner would have found on the contact sheet.
#
# Applied per element AND to each merged group: per element because otherwise a
# card-spanning wash merges with everything it touches and the whole card becomes
# one obstacle, per group because a backdrop drawn as a mosaic of small pieces
# (which is what a Canva scene export is) would otherwise pass through in
# fragments.
#
# RECTANGLES, NOT A SINGLE BOUND. An icon at x 43..69 does not obstruct an entry
# whose ink stops at x 130. A scalar "leftmost safe x" would charge every entry
# on the card for the worst icon on it, and shrink three cards in four for
# nothing. So the scan answers with a LIST of boxes and the fitter asks each
# entry about the ones in its own band.
_OBSTACLE_SPAN = 0.60
# Elements are merged into one obstacle when they touch, or come within this much
# of the smaller side of the card. An icon arrives as dozens of separate paths —
# מרקאנה's card 1 is 259 of them — and reserving each on its own would leave
# hairline alleys between a badge's pieces that no word could ever use. The gap
# is small enough that two icons a visible distance apart stay separate.
_OBSTACLE_MERGE = 0.01
# Below this (of the smaller side) an element is a speck: a rounding sliver, a
# 1-unit registration tick. Reserving it would cost real type for ink nobody can
# see. Applied to merged groups, so a cloud of specks that IS an icon survives.
_OBSTACLE_MIN = 0.02
# How much of the card an opaque element must cover before it is taken to bury
# even the elements this scan could not place (see ``card_obstacles``).
_OBSTACLE_COVER = 0.99
# Slack on "contains", as a fraction of the smaller side of the card. The card
# ``cell`` is a MEASUREMENT of where the card is — detected, or typed into the
# calibration form — and the artwork does not have to agree with it to the unit.
# It does not: סנטוריני's cream panel stops 0.23 units short of its cell's right
# edge, so read exactly, every piece of the scene that runs to that edge came out
# UNBURIED and eight cards the owner called empty reported three to six obstacles
# each. Containment is judged to the tolerance of the measurement it is made
# against. At 0.005 that is a third of a millimetre on these cards.
_OBSTACLE_SLOP = 0.005

Obstacles = collections.namedtuple("Obstacles", "rects unreadable")


def _paints(shape):
    """True when this element puts ink on the card.

    A fill of anything but "none" paints, and so does a stroke — an icon drawn
    as an outline is still an icon. Only an element with neither is invisible.

    An ``<image>`` is the exception and has to be named, because it carries
    NEITHER: a raster paints its own pixels, and read by the fill/stroke rule it
    would be silently invisible — which is the exact failure the walk was widened
    to fix. Its box is the placement rectangle, transparent margin included, so
    it reserves a little more than the picture's own ink; that is the safe
    direction, and the only direction available without opening the raster.
    """
    if shape.name == "image":
        return True
    fill = (shape.attrs.get("fill") or "").strip()
    stroke = (shape.attrs.get("stroke") or "").strip()
    return (fill and fill != "none") or (stroke and stroke != "none")


def _opaque(shape):
    """True when this element hides whatever is painted under it.

    A raster counts, and has to: אשכוליות's card is a PHOTOGRAPH placed over the
    card, and the outlined static copy the photo is laid on top of is drawn
    before it. Read as see-through, the photo buries nothing and that buried copy
    comes back as an icon across two of the four word slots — a keep-out over
    artwork no eye can find, because the picture is on top of it.

    The trade is stated rather than hidden: a raster with an alpha channel does
    NOT hide what it covers, and this cannot tell the difference without opening
    the file (which the layout may not do — see THE ICONS). It errs toward
    burying, which is the direction that costs a guarantee rather than a card,
    and it is the right way round here only because a raster that fully CONTAINS
    another element's box is a backdrop in every template we ship. A cut-out
    sticker dropped over a decoration would be the case to revisit, and the
    contact sheet is where it would show up.
    """
    if shape.name == "image":
        return True
    fill = (shape.attrs.get("fill") or "").strip()
    if not fill or fill == "none":
        return False
    for key in ("fill-opacity", "opacity"):
        try:
            if float(shape.attrs.get(key, 1)) < 1:
                return False
        except ValueError:
            return False
    return True


class Obstacle(tuple):
    """A merged icon: the outer box, plus the PIECES it was merged from.

    THE OWNER'S POINT: "the upper part of the icon is smaller than the lower
    part." A palm tree is 145 separate paths, merged into one rectangle so the
    icon is treated as one thing — and that rectangle then claims the empty sky
    above the fronds and the paper beside the trunks. Measured on her card, only
    29% of the rectangle is painted at all.

    The pieces are what answer it. The box still says WHERE the icon is (that is
    what decides which lines meet it), but how far it REACHES at the height of a
    particular line is asked of the pieces that are actually at that height. A
    round icon then gives back its corners, a palm gives back its sky, and a real
    rectangle behaves exactly as it did — its one piece IS the box.

    A tuple, so every existing reader (o[0]..o[3]) keeps working unchanged.
    """

    def __new__(cls, box, parts=()):
        self = super().__new__(cls, tuple(box))
        self.parts = tuple(tuple(p) for p in parts) or (tuple(box),)
        return self


def _merge_boxes(boxes, pad, keep_parts=False):
    """Union every group of boxes that touches within ``pad``.

    ``keep_parts`` returns each union as an ``Obstacle`` that still carries the
    boxes it swallowed, so a later reader can ask how far the icon reaches at one
    particular height instead of taking the whole rectangle's word for it.
    """
    out = [list(b) for b in boxes]
    parts = [[tuple(b)] for b in boxes]
    merged = True
    while merged:
        merged = False
        i = 0
        while i < len(out):
            j = i + 1
            while j < len(out):
                a, b = out[i], out[j]
                if (a[0] - pad <= b[2] and b[0] - pad <= a[2]
                        and a[1] - pad <= b[3] and b[1] - pad <= a[3]):
                    out[i] = [min(a[0], b[0]), min(a[1], b[1]),
                              max(a[2], b[2]), max(a[3], b[3])]
                    out.pop(j)
                    parts[i] = parts[i] + parts.pop(j)
                    merged = True
                else:
                    j += 1
            i += 1
    if keep_parts:
        return [Obstacle(b, ps) for b, ps in zip(out, parts)]
    return out


def card_obstacles(svg_text, cell):
    """The artwork one card's words must not print over.

    ``Obstacles(rects, unreadable)``: boxes in card units, and how many drawn
    elements this scan could not place. An unreadable element is REPORTED rather
    than assumed empty (see ``_shape_points``) — the caller decides what to do
    about it, but nothing here pretends the card is clear where it is not.

    Scenery is dropped, twice: an element that runs across the card is the
    background or a panel or a border band, and so is a group of elements that
    does. See THE ICONS above for why that is the rule and where the threshold
    came from.
    """
    if not svg_text or not cell:
        return Obstacles([], 0)
    x0, y0, x1, y1 = cell
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return Obstacles([], 0)

    def scenery(box):
        return (box[2] - box[0] >= _OBSTACLE_SPAN * w
                and box[3] - box[1] >= _OBSTACLE_SPAN * h)

    small = min(w, h)
    # THE CARD IS SMALLER THAN THE FILE. The artwork sits on a bleed, so a
    # decoration at the edge is partly cut away — and the part that survives is
    # the only part anything can collide with. Clipping to the printed frame here,
    # BEFORE the burial test below, is what makes that test work at the edge: a
    # ball half off the card is not contained by the card's own face and so
    # survived as an obstacle, even though the half that prints is under the face
    # and invisible. Two of those cost קליפורניה and מרקאנה a third of their title.
    # An unmeasurable frame changes nothing (clip = the cell, as before).
    try:
        import card_frame
        drawn = card_frame.frame(svg_text, cell)
    except Exception:                                    # noqa: BLE001 - never fatal
        drawn = None
    printed = cell
    if drawn:
        printed = _intersect(cell, (drawn["x"], drawn["y"],
                                    drawn["x"] + drawn["w"], drawn["y"] + drawn["h"]))
        if printed[2] - printed[0] <= 0 or printed[3] - printed[1] <= 0:
            printed = cell
    painted, unreadable = [], 0
    for shape in svg_shapes(svg_text):
        if not _paints(shape):
            continue
        if shape.box is None:
            unreadable += 1
            continue
        box = _intersect(_intersect(shape.box, shape.clip), printed)
        if box[2] - box[0] <= 0 or box[3] - box[1] <= 0:
            continue              # clipped away, or on another card of the sheet
        opaque = _opaque(shape)
        if (opaque and box[2] - box[0] >= _OBSTACLE_COVER * w
                and box[3] - box[1] >= _OBSTACLE_COVER * h):
            # This one covers the card, so it buries even what we could not place.
            unreadable = 0
        painted.append((box, opaque))
    # Painted over and out of sight (see PAINT ORDER). Done before the size test,
    # because the layer doing the burying is usually scenery itself and would
    # otherwise have been dropped before it could bury anything.
    slop = _OBSTACLE_SLOP * small
    kept = [b for i, (b, _) in enumerate(painted)
            if not any(o and c[0] <= b[0] + slop and c[1] <= b[1] + slop
                       and c[2] >= b[2] - slop and c[3] >= b[3] - slop
                       for c, o in painted[i + 1:])]
    rects = [b for b in _merge_boxes([b for b in kept if not scenery(b)],
                                     _OBSTACLE_MERGE * small, keep_parts=True)
             if not scenery(b)
             and (b[2] - b[0] >= _OBSTACLE_MIN * small
                  or b[3] - b[1] >= _OBSTACLE_MIN * small)]
    rects.sort(key=lambda b: (b[0], b[1]))
    return Obstacles(rects, unreadable)


# Cached like ``_FRAME_BOXES``, and for the same reason: the icons are a property
# of the ARTWORK and one deck renders the same eight fronts 104 times, while the
# scan walks every path in the file.
_OBSTACLES = {}


def card_obstacle_rects(theme, front_index, svg_text, cell):
    """``card_obstacles`` for one card, computed once per (theme, front).

    An unreadable element is reported to stderr ONCE per card rather than
    swallowed: it means this scan has a blind spot on that card, and a blind spot
    is the one failure mode that puts words back on top of the artwork. It is not
    fatal — every other icon on the card is still reserved — but it must be
    visible, because the fix is a parser change and nobody will make it if the
    scan quietly says the corner is empty. No shipped template hits this today.
    """
    key = (theme, front_index, len(svg_text or ""), tuple(cell or ()))
    if key not in _OBSTACLES:
        found = card_obstacles(svg_text, cell)
        if found.unreadable:
            print(f"[render_page] {theme} front {front_index}: "
                  f"{found.unreadable} drawn element(s) could not be placed by "
                  f"the icon scan; words are NOT guaranteed clear of them",
                  file=sys.stderr)
        _OBSTACLES[key] = found.rects
    return _OBSTACLES[key]


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
# WHERE IT APPLIES: EVERY CARD. It used to be only a card with a DECLARED words
# column (``card_slots``) — the v2 single-card templates — because the v1 sheet
# themes had no column, so they could not wrap and were not gridded; their lines
# were their slots. That was called a migration state here, and it ended the day
# every card got a text box of its own (``_card_left_edge``): the owner picked
# the grid for all of them off rendered cards, and the undeclared branches went
# with the flag that selected them.


def _grid_pitch(centers, gaps, lead, size, cap=None, want=0.0):
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
    # ``want`` is the ONE spacing the whole order prints at, where the deck has
    # one (build.deck_pitch_for). It replaces the design's own measurement as the
    # floor, and that is the point: an order is opened as a deck, not as one card
    # at a time, so a card of four short entries has to step at the same rhythm as
    # the card next to it that wrapped. Without this the number reached only the
    # cards that wrap, and a single deck printed at two rhythms.
    natural = want if want > 0 else (span / gaps if gaps > 0 and span > 0 else 0.0)
    pitch = max(natural, lead * size)
    if cap is not None:
        pitch = max(lead * size, min(pitch, cap))
    return pitch


# ONE LINE RHYTHM FOR THE WHOLE DECK — the owner's rule, in her words: "between
# each line i want even spaces, even if it is in between rows of the same
# number… let's say 1. is one line, then that line should be of height x. now
# let's say 2. is two lines, the height of 2 should be 2x."
#
# So the constant is the LINE, not the entry: every printed line steps by one
# pitch, and an entry of two lines is simply twice as tall as one of one. Within
# a card that was already true. What was not true is ACROSS cards — the pitch was
# solved per card against the paper its own line count left, so a card that
# wrapped more packed them tighter. Measured on one grapefruit deck:
#
#     4 lines   pitch 30.8      (nothing wraps)
#     6 lines   pitch 27.4      (two entries wrap)
#     8 lines   pitch 19.7      (every entry wraps)
#
# Flip through that deck and the rhythm changes card to card. Now the pitch is
# the DESIGN's own on every card, and the size is what gives — see _fit_card,
# which is where it has to be decided rather than imposed afterwards.
def design_pitch(centers):
    """The design's own line pitch: the calibrated span over its entry gaps.

    ONE number per template — which is exactly what makes the rhythm identical on
    every card of the deck instead of solved per card. A card with a single live
    entry has no span to divide and returns 0, which reads as "no rhythm to keep"
    and leaves that card to the font's own leading.
    """
    if not centers or len(centers) < 2:
        return 0.0
    return (max(centers) - min(centers)) / (len(centers) - 1)


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


def _ink_reach_left(font, ref, line):
    """How far a line's INK reaches back from the end of its own advance.

    In ``ref`` units, like ``getlength``, and never less than the advance itself.

    A LINE IS WIDER THAN THE WIDTH A FONT REPORTS. ``getlength`` is a sum of
    ADVANCES — where the pen ends up — and the press paints outlines, which hang
    off the pen wherever a glyph has a negative left side bearing. On the word
    face רווקות is set in, "הכלה במסיבת" advances 984 units of a 200 em and its
    ink starts at -17: seventeen units, 1.7% of the line, printed left of where
    the arithmetic says the line begins.

    That is not a rounding error, it is the whole of a bug this once had. Fitted
    so its advance stopped exactly on an icon's edge, the entry printed five
    pixels of ink on the icon — the fit measuring advances while the rasteriser
    painted outlines. Measured here on the rasterized glyphs, the same way the
    line-pitch floor is (``_ink_skyline``), so the two now agree and no clearance
    is being spent to paper over a wrong number.

    The line is measured in VISUAL order, because the leftmost glyph of a
    right-to-left line is its last character and the reading has to be of the
    line as it is actually painted. Falls back to the box for a font object with
    no path to re-open — a test double; nothing in production reaches it.
    """
    path = getattr(font, "path", None)
    adv = font.getlength(line)
    if not path:
        return adv - min(0.0, font.getbbox(line)[0])
    return adv - min(0.0, _ink_left(path, ref, visual_order(line, True)))


@functools.lru_cache(maxsize=1024)
def _ink_left(font_path, ref, line):
    """The leftmost inked column of a rasterized line, relative to its pen origin.

    Negative when the line's ink hangs off the front of its own advance.

    ``_ink_skyline`` answers this too, and answers far more: it reads every
    column's depth so two stacked lines can be tested where they actually meet.
    A left bound needs one number, and the loop that builds the profile is the
    expensive part of that function — over a deck it was the single largest cost
    of the icon rule. Same rasterization, same pad, just ``getbbox`` instead of
    the per-column walk.
    """
    from PIL import Image, ImageDraw
    f = _measuring_font(font_path, ref)
    pad = int(ref) + 8
    w = int(f.getlength(line)) + 2 * pad
    h = 4 * int(ref) + 2 * pad
    img = Image.new("L", (max(8, w), max(8, h)), 0)
    ImageDraw.Draw(img).text((pad, 2 * int(ref) + pad), line, font=f, fill=255,
                             anchor="ls")
    ink = img.getbbox()
    return 0.0 if not ink else float(ink[0] - pad)


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

# ...and never a SHORT one, however narrow the room gets. The owner's rule has a
# parenthesis in it — "take the words that are covering the icon to a new line
# (of course not if it's a 1 word word), or make the font smaller" — and a card
# whose band an icon has crushed to 33 units answered it by setting "אבא" as
# "א-ב-א". Breaking a word is a trade: a hyphen bought against a smaller card.
# There is nothing to buy on a word this short, so the card sets smaller instead,
# which is what she asked for. Long words keep the trade (אינטרנציונליזציה at 16
# characters is why the breaker exists).
_BREAK_MIN_CHARS = int(os.environ.get("DUGRI_BREAK_MIN_CHARS", "8"))


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
                advance=None, uniform=None, ink=False):
    """Every way to set one entry: ``{line_count: (lines, lead, max_size_ref)}``.

    ``max_size_ref`` is the largest font size at which that wrapping still fits
    the band. More lines means a narrower widest line, so it always allows a
    larger size — the cost is height, which the caller weighs.

    ``max_lines`` of 1 forbids wrapping outright, which is how the v1 sheet path
    keeps its long words on one line (see ``_word_layouts``).

    ``uniform`` is the card's target size, and it is what decides whether an entry
    with too few spaces may be BROKEN mid-word: only when keeping it whole would
    drag the card below ``_BREAK_BELOW`` of that target.

    ``ink`` measures each line by the paper its OUTLINES cover rather than by the
    advance the font reports (see ``_ink_reach_left``). Set for an entry whose
    left bound is an ICON, where the difference is the difference between a
    guarantee and a near miss; left off elsewhere, where the bound is the card's
    own safe area — a soft edge that a hair of overhang has never troubled, and
    where changing the measure would re-fit eight shipped decks for nothing.
    """
    marker_ref = _line_width_at(font, ref, num, "", advance=advance)
    reach = (lambda ln: _ink_reach_left(font, ref, ln)) if ink else font.getlength

    def budget(lines):
        widest = max(reach(ln) for ln in lines)
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
    if (uniform and whole_word_best < uniform * _BREAK_BELOW
            and len(word.replace(" ", "")) >= _BREAK_MIN_CHARS):
        for n in range(len(out) + 1, max_lines + 1):
            lines = _hard_split(font, word, n)
            if not lines or len(lines) in out:
                break
            out[len(lines)] = budget(lines)
    return out


def _entry_step(centers):
    """Units between one entry's row and the next — the gap a wrapped line is
    measured against by ``word_wrap_pitch``. The SMALLEST gap, because a card
    whose rows are not evenly spaced must still keep every continuation inside
    its own entry."""
    cs = sorted(c for c in (centers or []) if c is not None)
    gaps = [b - a for a, b in zip(cs, cs[1:])]
    return min(gaps) if gaps else 0.0


def _fit_card(cands, centers, uniform, font=None, ref=None,
              vbounds=None, room=None, count=None, bold_w=0.0, rows=None,
              pitch=None, wrap_pitch=None):
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

    The HEIGHT constraint is "every line on the card sits on one pitch" (see
    THE LINE GRID above), measured over the card's WHOLE line sequence,
    continuations included, so a gap that straddles two entries is held to the
    same clearance as a gap inside one. There is no second answer to weigh it
    against any more: the pairwise solve this used to fall back to — each entry
    centred on its own traced spot and merely kept clear of its neighbours —
    was what the v1 sheet used while it had no text box to wrap inside. Every
    card has one now (``_card_left_edge``), and the owner picked the grid off
    rendered cards: it is what pays for a wrapped line in paper rather than in
    type size.

    ``room`` is the card's real vertical envelope — the safe top, and the lower
    of the printed frame's clear air and the first icon under the words. A card
    whose wrapping ADDS lines is solved against it, so the extra lines go into
    the paper that is actually free below the last calibrated line instead of
    squeezing the pitch. Without it (no cell, no artwork to scan) the calibrated
    span stands, which is the conservative answer.

    ``rows`` — each entry's own strip of card — binds the ONE case the grid
    cannot bind for itself: a card carrying a single entry. Every other card is
    held by its neighbours and by the room below, but a lone entry has neither,
    so it grew symmetrically about its own centre until it reached up into the
    honoree's name. It happens on any order whose last card holds one word.
    """
    live = sorted(cands)
    best = None
    for combo in itertools.product(*(sorted(cands[i]) for i in live)):
        counts = dict(zip(live, combo))
        size = min([uniform] + [cands[i][counts[i]][2] for i in live])
        flat = [ln for i in live for ln in cands[i][counts[i]][0]]
        live_c = [centers[i] for i in live]
        lead = _card_lead(font, ref, flat, count=count, bold_w=bold_w)
        # THE DESIGN MAY ASK FOR MORE THAN THE INK FLOOR between the lines of one
        # entry (word_wrap_pitch). It is applied HERE, inside the fit, rather than
        # at the render: a wider gap makes the block taller, and only the fit can
        # pay for that in size. `max` keeps the floor, so this can never be why
        # two letters touch; the `lead * size <= pitch` test below keeps a
        # continuation from drifting further than the next entry.
        if wrap_pitch and size:
            step = _entry_step(live_c)
            if step:
                lead = max(lead, wrap_pitch * step / size)
        span = max(live_c) - min(live_c)
        if pitch and pitch > 0:
            # THE DECK'S RHYTHM IS FIXED, so the SIZE is what gives. Two limits,
            # and a combination that satisfies neither simply cannot be set:
            #   * the letters must not touch — lead x size <= pitch;
            #   * the block must not pass the floor — the first line is pinned to
            #     the first calibrated centre and the run is (lines-1) x pitch
            #     tall plus the last line's ink.
            # Which is the trade in the docstring pointed the other way: with a
            # free pitch a wrapped line is paid for in PAPER; at a fixed pitch
            # there is no paper to pay with, so it is paid for in TYPE.
            if lead > 0:
                size = min(size, pitch / lead)
            first = min(live_c)
            below = _ink_reach(font, ref, flat[-1])[1] if font is not None else 0.0
            above = _ink_reach(font, ref, flat[0])[0] if font is not None else 0.0
            run = (len(flat) - 1) * pitch
            floor = room[1] if room else (max(live_c) if live_c else None)
            ceiling = room[0] if room else (vbounds[0] if vbounds else None)
            if floor is not None and below > 0:
                size = min(size, (floor - first - run) / below)
            if ceiling is not None and above > 0:
                size = min(size, (first - ceiling) / above)
            if size <= 0:
                # No paper for this wrapping at this rhythm. A combination that
                # wraps less will win; if none does, the fallback below runs.
                continue
        elif room:
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
        if rows and len(live) == 1 and font is not None and ref is not None:
            # A lone entry sits on its own calibrated centre (there is no span to
            # anchor to and nothing to be spaced from), so its block grows both
            # ways from there — and the strip the design drew for it is the only
            # thing that says how far. The pitch here is the card's own lead: with
            # one centre ``_grid_pitch`` has no span to divide, so it returns
            # exactly ``lead * size``.
            i = live[0]
            lines = cands[i][counts[i]][0]
            if pitch and pitch > 0:
                # At a fixed pitch half the run is ABSOLUTE; only the ink scales.
                grow_abs = (counts[i] - 1) * pitch / 2
                for reach, ink in ((centers[i] - rows[i][0],
                                    _ink_reach(font, ref, lines[0])[0]),
                                   (rows[i][1] - centers[i],
                                    _ink_reach(font, ref, lines[-1])[1])):
                    if ink > 0:
                        size = min(size, max(reach - grow_abs, 0.0) / ink)
            else:
                grow = (counts[i] - 1) * lead / 2
                up = grow + _ink_reach(font, ref, lines[0])[0]
                down = grow + _ink_reach(font, ref, lines[-1])[1]
                for reach, need in ((centers[i] - rows[i][0], up),
                                    (rows[i][1] - centers[i], down)):
                    if need > 0:
                        size = min(size, max(reach, 0.0) / need)
        key = (size, -sum(combo))
        if best is None or key > best[0]:
            best = (key, size, counts, lead)
    if best is None:
        # Every wrapping was refused by the fixed pitch — a card with more lines
        # than its paper can hold at that rhythm. Solve it again with the pitch
        # free: a card that keeps the deck's rhythm by being unprintable is not
        # the trade anyone asked for, and this is the one card in a deck that
        # will not match. It cannot recurse twice (pitch=None takes the old path).
        return _fit_card(cands, centers, uniform, font=font, ref=ref,
                         vbounds=vbounds, room=room, count=count,
                         bold_w=bold_w, rows=rows, pitch=None)
    return best[1], best[2], best[3]


# THE WORDS' SIDE OF THE ICON RULE. The scan says where the artwork is; this says
# what an entry does about it, and the owner set the order: "take the words that
# are covering the icon to a new line (of course not if it's a 1 word word), or
# make the font smaller (and keep all the rules like same font for all words in a
# card)". WRAP FIRST, SHRINK AS THE FALLBACK, ONE SIZE PER CARD.
#
# All three fall out of the fitter that is already here, which is why this adds
# no preference of its own. Every line of an entry is anchored at the card's
# right edge and grows LEFT, so an icon to the left of that edge is simply a
# nearer left bound: it makes the entry's band NARROWER, and nothing else about
# it changes. A narrower band lowers the size at which each wrapping still fits —
# which is exactly ``_candidates``'s ``max_size_ref`` — so wrapping an entry, by
# making its widest line shorter, buys back size it would otherwise have to give
# up. ``_fit_card`` already scores every combination of line counts by
# ``(size, -total_lines)``, so it takes the extra line when the extra line keeps
# the type bigger and refuses it when it does not: wrap first, shrink second, and
# no new term in the objective. One size per card is untouched because the icon's
# cap joins the same card-wide ``min``.
#
# A ONE-WORD ENTRY CANNOT WRAP, and does not: ``_candidates`` stops as soon as
# ``_balanced_split`` runs out of spaces, so such an entry offers a single
# one-line candidate and the card's size drops to fit it. That is the owner's
# parenthesis, and it holds for as long as the entry can be set at a size worth
# reading. Past that the mid-word breaker takes over (``_BREAK_BELOW``): a single
# 25-character word that would drag the whole card under 85% of its size is
# broken with a hyphen rather than allowed to shrink the other three entries
# with it. That rule used to apply only to a card that stated its column; it
# applies to every card now, for the same reason the grid does.
#
# WHICH ICONS AN ENTRY HAS TO CLEAR: the ones beside it, not the ones on the
# card. An icon at x 43..69 does not obstruct an entry whose ink stops at x 130,
# and an icon in the top corner does not obstruct the bottom row. So each entry
# asks about the obstacles crossing ITS ROW — its slot centre plus and minus half
# the distance to the nearest neighbouring slot, which is the paper that row owns
# — and takes the rightmost edge among them as its left bound.
#
# The row is a bound the fit then honours: ``_fit_card`` is told to keep every
# entry's block inside its own row, so an entry cannot wrap its way down into the
# next row's icon. On the v1 sheet that is also the first vertical bound this path
# has ever had — it could not wrap, so it never needed one — and it comes with the
# card's real envelope (``room_bottom``, the printed frame less clear air) for the
# same reason.
#
# AND ONLY WHERE THERE IS SOMETHING TO DODGE. A card no icon reaches keeps
# ``max_lines`` of 1 and no vertical bound: byte for byte the render it produced
# before this existed. That is not timidity, it is the scope the owner set — she
# ruled סנטוריני has no icons, and every one of its cards must come out
# unchanged. Turning wrapping on for the whole v1 sheet is a separate migration
# (see WHERE IT APPLIES, AND FOR HOW LONG) and would rewrap eight decks against
# boxes their designers never drew.
#
# AN ICON THE ENTRY CANNOT DODGE SIDEWAYS. Every line is anchored at ``right``
# and grows left, so an entry clears an icon exactly when its widest line stops
# right of the icon's right edge. An icon whose right edge is PAST the anchor
# cannot be cleared that way at all: the marker digit is pinned at the anchor and
# is on the icon at any size, on any number of lines. Narrowing the entry does
# nothing, and asking for it is actively harmful — ``_candidates`` reads a
# non-positive width as "unconstrained" and answers infinity, which is how
# כדורסל came out setting LARGER on the cards that have an icon than on the ones
# that do not.
#
# There is still a remedy, and it is the other axis. כדורסל's player stands in
# the bottom corner and its box reaches 24 units left of the anchor — but only
# its TOP four units fall inside the last entry's row. The entry does not need to
# be narrower, it needs to stop higher: clip the row at the icon's top edge and
# the entry's ink is clear of it with its width and its alignment untouched. Same
# for an icon above the entry, from the other side.
#
# Only when an icon straddles the entry's own centre is there nothing left to
# try, because the row cannot be clipped past the line it is centred on.
# ``unclearable_icons`` names those, and ``test_no_icon_sits_under_a_word_column``
# holds every shipped template to having none.
#
# CLEAR AIR AROUND AN ICON, AND WHAT IT IS NOT FOR. Fitted to an icon's edge
# exactly, two decks first came out with a handful of pixels over it — five on
# רווקות's champagne tower, eight under כדורסל's player. Both were WRONG
# ARITHMETIC, not bad luck at the boundary, and both are now measured rather than
# padded: the fit was reading advances where the press paints outlines
# (``_ink_reach_left``) and a box-model line height where the face draws a
# descender a third of its size deep (``_ink_reach``, in ``_fit_card``'s row
# bound). With those two right, every card clears with its ink to spare and this
# margin is not carrying the guarantee.
#
# It is still here, for the thing that genuinely cannot be measured in advance:
# the rasterizer's own rim. A glyph edge landing ON a boundary is antialiased
# ACROSS it, so at any resolution the outermost row of pixels can be a partial
# coverage of paper the outline never entered — and the resolution is not one
# number (a screen preview, a 300 dpi press sheet, a customer's home printer all
# differ). Half a millimetre is more than a pixel at every one of them.
#
# And it is what the owner actually asked for. "the words are covering the icon"
# is not a complaint about overlap measured in pixels; a word that stops one hair
# short of a champagne glass still reads as printed on it. So the icons are grown
# by a stated margin before the FIT consults them, while the test asserts against
# the icons' true boxes — the margin is slack in the guarantee, never the reason
# it holds.
#
# HOW THE NUMBER WAS PICKED. The floor is measured, not chosen: rendering all
# seven sheet decks with worst-case entries and counting word-ink pixels inside
# the icons (``test_no_word_ink_lands_on_an_icon``, which is the real assertion)
# gives 9 at 0 mm, 4 at 0.25 mm and NONE at 0.5 mm. So 0.5 is where the rim
# closes, and it is the default.
#
# It is not necessarily where the owner wants it. Above the rim this is an
# aesthetic call about a printed card — how much white reads as "not on the
# picture" — and that is hers, the same way ``_BOTTOM_RESERVE_MM`` was picked off
# a rendered 0/4/8/12 proof. ``scripts/icon-clearance-proof.py`` renders the
# decks at 0 / 0.25 / 0.5 / 1 mm with the type cost of each: 0.5 costs nothing on
# five decks and about 4% of the type on רווקות and טיול, whose worst cards have
# an icon directly beside the entry. Widening it is one environment variable.
_ICON_CLEAR_MM = float(os.environ.get("DUGRI_ICON_CLEAR_MM", "0.5"))


def _grown(obstacles, pad):
    """``obstacles`` with ``pad`` of clear air added on every side.

    The PIECES are grown too, and by the same margin: they are what says how far
    the icon reaches at a given height (see ``Obstacle``), so clear air that the
    outer box has and they do not would be clear air the words never get.
    """
    out = []
    for o in obstacles or []:
        box = [o[0] - pad, o[1] - pad, o[2] + pad, o[3] + pad]
        parts = getattr(o, "parts", None)
        out.append(Obstacle(box, [[p[0] - pad, p[1] - pad, p[2] + pad, p[3] + pad]
                                  for p in parts]) if parts else box)
    return out


# A BOX IS NOT A SILHOUETTE, and at the anchor that difference decides a card.
# This scan reserves rectangles, and the corner of a rectangle round a figure is
# usually blank paper: כדורסל's player is drawn mid-jump, so the top edge of his
# box is the ball in his raised hands and the box's top-left corner is nothing at
# all. On card 1 that empty corner passes the words' anchor by 1.8 units — and
# read literally it says the bottom entry stands on the icon, which no shrinking
# and no wrapping can undo, so the entry was clipped to the 0.2 units of row above
# the box and the card set at 0.49 instead of 11.7. The words became a grey smear
# to protect a piece of paper with nothing printed on it.
#
# So an icon that passes the anchor by less than this fraction of the card's WIDTH
# is read as the box over-claiming, and that entry ignores it. Measured across the
# shipped artwork the two populations are 12x apart — the only slop overlap is
# that 0.96% corner, and the real ones (the same player genuinely standing under
# the column on cards 2 and 7) are 12.5% and 17.1% — so this sits in a wide gap,
# like ``_OBSTACLE_SPAN``. It applies ONLY at the anchor: an icon beside the
# entry is still reserved to its box, where over-claiming costs a little type and
# nothing else. Here it costs the whole card.
_ANCHOR_SLOP = float(os.environ.get("DUGRI_ANCHOR_SLOP", "0.05"))


def _at_anchor(obstacles, band, right, width):
    """Icons in ``band`` that genuinely reach past the anchor ``right``.

    ``width`` is the card's, for ``_ANCHOR_SLOP``. These are the ones no
    narrowing can clear, because the marker digit is pinned at the anchor.
    """
    return [o for o in obstacles or []
            if o[1] < band[1] and band[0] < o[3]
            and o[2] >= right and o[0] < right - _ANCHOR_SLOP * width]


def _row_clip(obstacles, row, center, right, width):
    """``row`` shortened away from icons in it that no narrowing can clear.

    Clipped to the icon's near edge, never past ``center`` — an entry is set
    around its own centre, so a row that excluded it would describe no layout.
    """
    top, bottom = row
    for o in _at_anchor(obstacles, row, right, width):
        if o[1] >= center:
            bottom = min(bottom, o[1])
        elif o[3] <= center:
            top = max(top, o[3])
    return (min(top, center), max(bottom, center))


def _obstacle_left(obstacles, band, right):
    """The rightmost icon edge an entry in ``band`` must stay clear of, or None.

    ``band`` is the entry's row ``(top, bottom)``; ``right`` is the anchor its
    lines are set from.

    ASKED OF THE PIECES, not of the merged rectangle — the owner's point, and the
    reason ``Obstacle`` keeps them: an icon is rarely as wide at the top as it is
    at the bottom, and the rectangle around it claims the difference. A line
    passing beside the fronds of a palm is stopped by the fronds, not by the
    trunks two centimetres below it. An icon of one piece is unaffected, because
    then the piece is the box.
    """
    edges = []
    for o in obstacles or []:
        if not (o[1] < band[1] and band[0] < o[3]):
            continue
        for p in getattr(o, "parts", None) or (o,):
            if p[1] < band[1] and band[0] < p[3] and p[2] < right:
                edges.append(p[2])
    return max(edges) if edges else None


def unclearable_icons(obstacles, band, center, right, width):
    """Icons in ``band`` that neither narrowing nor clipping the row can dodge.

    Worst first, each as ``(depth left of the anchor, box)`` in card units.

    An icon reaching past the anchor ``right`` cannot be cleared sideways — the
    marker digit is pinned there and sits on the icon at any size, on any number
    of lines (see AN ICON THE ENTRY CANNOT DODGE). The remedy is the other axis,
    and it works for every such icon that lies wholly above or wholly below the
    entry's ``center``: the row is clipped to its near edge and the entry sets
    smaller in the strip that is left. An icon STRADDLING the centre is the one
    case with nothing left, because a row clipped past the line it is centred on
    describes no layout at all. Those are what this reports, and what
    ``test_no_icon_sits_under_a_word_column`` holds the shipped artwork to having
    none of. A box that only grazes the anchor is not one of them — that is
    ``_ANCHOR_SLOP``, and it is read as the box over-claiming rather than as
    artwork under the words.
    """
    return sorted((right - o[0], o)
                  for o in _at_anchor(obstacles, band, right, width)
                  if o[1] < center < o[3])[::-1]


def order_by_room(slots, words, font, cell=None, obstacles=None, safe=_CELL_SAFE,
                  room_bottom=None, floor=None):
    """Put each entry on the ROW that suits it, instead of the row it arrived on.

    THE RULE THIS REPLACES: the packer always sent the hardest entry to the
    bottom row, on the reasoning that a wrapped entry has somewhere to go there.
    The owner's question was whether that rule is worth keeping — "sometimes the
    icon is down the card and sometimes not" — and it is not, because the rows of
    a card are identical to each other and it is the ARTWORK that differs. An
    icon beside row 3 takes a bite out of row 3; on the next front it takes it
    out of row 1. A fixed rule cannot know that, and only the renderer can: the
    packer has no idea which front a card will be printed on.

    So every entry is measured against every row of THIS card — the same
    measurement the fit will make — and the arrangement that leaves the card's
    smallest entry as large as possible wins. Four entries over four rows is 24
    arrangements, so the best one is found by trying them all rather than by a
    rule of thumb that would need its own exceptions.

    Ties are broken by the total, which keeps the arrangement stable when the
    rows are equally roomy (a card with no icons beside its words): the entries
    then stay in the order they arrived, and the deck looks exactly as it did.

    Blanks stay TRAILING. Only the live entries are permuted, among the rows they
    already occupy — the renderer numbers the rows 1..4 downwards, so a blank
    between two entries would print an empty numbered line.
    """
    live = [w for w in words if w]
    if len(live) < 2 or not slots:
        return list(words)
    centers = [(sl["y0"] + sl["y1"]) / 2 for sl in slots]
    vbounds = ((cell[1] + (cell[3] - cell[1]) * safe,
                cell[3] - (cell[3] - cell[1]) * safe) if cell else None)
    rows = slot_rows(slots, centers, vbounds, room_bottom)
    # The fit meets the icons with their clear air already on them, so the choice
    # has to meet the same boxes — otherwise an entry is placed against one
    # geometry and set against a tighter one.
    obstacles = _grown(obstacles, _ICON_CLEAR_MM * _PT_PER_MM)

    ref = font.ref
    # ONE digit column for the whole card, exactly as the fit and the render use
    # (see the anchor note in _words_overlay). Measuring each row against its own
    # digit would make the choice turn on whether "4" is wider than "1" — a
    # fraction of a millimetre that has nothing to do with the artwork, and
    # enough to reshuffle a card that has no icons at all.
    advance = _marker_advance(_primary(font), len(slots))
    size = {}
    for wi in range(len(live)):
        right, left, _ = row_bounds(slots, slots[wi], rows[wi], cell, obstacles, floor)
        avail = max(0.0, right - left)
        for w in live:
            try:
                cands = _candidates(font, ref, 1, w, avail, advance=advance)
                best = max((c[2] for c in cands.values() if c and c[2] is not None),
                           default=0.0)
            except Exception:
                best = 0.0
            size[(w, wi)] = best

    best_order, best_key = None, None
    for perm in itertools.permutations(live):
        got = [size[(w, i)] for i, w in enumerate(perm)]
        # The card is set at its smallest entry, so that is what is maximised;
        # the sum only settles ties.
        key = (min(got), sum(got))
        if best_key is None or key > best_key:
            best_order, best_key = perm, key
    return list(best_order) + [""] * (len(words) - len(best_order))


def slot_rows(slots, centers, vbounds=None, room_bottom=None):
    """THE ROW each entry owns: its centre plus and minus half the way to the
    nearest neighbouring slot, held inside the card's safe area and above the
    printed frame's clear air.

    It answers both halves of the icon question — which icons this entry can
    meet, and how far its own block may grow before it reaches the next row's.
    Extracted so the ROW CHOICE reads the same rows the fit will use.
    """
    rows = {}
    for wi in range(len(slots)):
        half = _slot_pitch(slots, wi) / 2
        top, bottom = centers[wi] - half, centers[wi] + half
        if vbounds:
            top, bottom = max(top, vbounds[0]), min(bottom, vbounds[1])
        if room_bottom is not None and room_bottom > centers[wi]:
            bottom = min(bottom, room_bottom)
        rows[wi] = (min(top, centers[wi]), max(bottom, centers[wi]))
    return rows


def row_bounds(slots, slot, row, cell, obstacles, floor=None):
    """One row's ``(right, left, on_icon)`` — the paper an entry there may use.

    Extracted from the fit so the ROW CHOICE can ask the same question the fit
    will answer later: how much room does row 3 of this card actually have? The
    two must agree, or an entry is placed by one measurement and set by another.

    The rows of a card are the same size as each other; what makes them differ is
    the artwork. An icon beside a row pushes its left edge in, and how far
    depends on which front this card is — which is why this cannot be decided
    when the deck is packed.
    """
    right = _card_right_edge(slots, cell)
    # ONE left line for the card, whether or not the template states its column:
    # see ``_card_left_edge``. The trim-safe floor still holds it off the paper
    # edge on a card with no cell to mirror against.
    left = _card_left_edge(slots, cell)
    if floor is not None:
        left = max(left, floor)
    if left >= right:                 # degenerate slot: fall back to the floor
        left = floor if floor is not None else slot["x0"]
    # The row is shortened first, because an icon it no longer reaches is an icon
    # this entry no longer has to be narrow for.
    clipped = _row_clip(obstacles, row, row[0] / 2 + row[1] / 2,
                        right, cell[2] - cell[0] if cell else 0.0)
    edge = _obstacle_left(obstacles, clipped, right)
    on_icon = edge is not None and edge > left
    if on_icon:
        left = edge
    return right, left, on_icon


def _word_layouts(slots, words, font, ref, cell=None, word_size=None,
                  safe=_CELL_SAFE, room_bottom=None, bold_w=0.0,
                  obstacles=None, title_box=None, even_lines=False,
                  deck_pitch=None, max_size=None, wrap_pitch=None):
    """Per-slot ``(size, [lines])`` for a card's words, or None for an empty slot.

    One UNIFORM font size is the target for every word (matching the origin's
    single-size look): the uniform size comes from the recipe box heights (see
    ``_WORD_SIZE_K``), NOT from fitting each word to its own box — fitting per box
    would reproduce the ORIGIN word lengths (a short word in a wide origin slot
    would balloon, a long word in a narrow slot would shrink), destroying the
    uniform look.

    A word that does not FIT is wrapped rather than pushed out of the card (see
    the WRAPPING note above), and EVERY card now has a box to wrap inside: the
    four entries share one left line, the mirror of the card's own numbered
    column (``_card_left_edge``). That is the owner's rule for every template —
    wrap first, shrink second — where before only a template that stated its
    column in ``card_slots`` had a box at all and everything else answered a wide
    phrase by shrinking the whole card onto one line.

    ``safe`` floors the bound, so no line can reach the trim edge and be cut off
    the printed card.

    Every card also gets ONE right anchor and ONE digit column for its four
    entries (``_card_right_edge`` / ``_marker_advance``), and its lines are
    placed on a card-wide grid — one rhythm for every gap on the card — instead
    of each entry sitting on its own traced spot. The owner chose that off
    rendered cards: it is what lets a wrapped entry grow into the paper at the
    foot of the card instead of paying for the second line in type size.

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
    # THE HEBREW WORD CEILING, folded into the card's target rather than applied
    # after it. `uniform` is what `_fit_card` already treats as the largest the
    # card may set and what `_candidates` measures a mid-word break against, so
    # lowering it here caps the type AND keeps the break decision honest — a
    # ceiling applied afterwards would shrink the type while the wrapping stayed
    # solved for a size nobody is printing.
    if max_size and max_size > 0:
        uniform = min(uniform, max_size)
    floor = cell[0] + (cell[2] - cell[0]) * safe if cell else None
    # A synthetic-bold word is WIDER than the advance the fit measures: the
    # stroke is centred on the outline, so it hangs half its width past each end
    # of the run. Take the WHOLE width off the left bound rather than half — a
    # stroke that reaches the trim edge is guillotined off the printed card, and
    # the fraction of a millimetre this costs is invisible.
    if floor is not None and bold_w:
        floor += uniform * bold_w
    advance = _marker_advance(_primary(font), len(slots))
    centers = [(s["y0"] + s["y1"]) / 2 for s in slots]
    vbounds = ((cell[1] + (cell[3] - cell[1]) * safe,
                cell[3] - (cell[3] - cell[1]) * safe) if cell else None)
    # THE ROW each entry owns: its centre plus and minus half the way to the
    # nearest neighbouring slot, held inside the card's safe area and above the
    # printed frame's clear air. It answers both halves of the icon question —
    # which icons this entry can meet, and how far its own block may grow before
    # it reaches the next row's.
    rows = slot_rows(slots, centers, vbounds, room_bottom)
    # Each live entry's band, before and after the icons beside it have taken
    # their bite. Measured for the whole card first, because whether ANY entry is
    # blocked decides whether THIS CARD may wrap at all (see AND ONLY WHERE THERE
    # IS SOMETHING TO DODGE) and that answer has to be one answer for the card.
    bands = {}
    # The fit meets the icons with their clear air already on them; every
    # assertion, and the contact sheet, meets their true boxes (see CLEAR AIR
    # AROUND AN ICON). Stated in millimetres because that is the unit the
    # complaint is in — a margin you can see on the printed card — and converted
    # once here.
    obstacles = _grown(obstacles, _ICON_CLEAR_MM * _PT_PER_MM)
    def _bands(rows):
        """Each live entry's band, with the icons beside it having taken their
        bite — read against the rows it is handed, which is what makes this
        answerable again once the grid has moved the lines."""
        bands = {}
        for wi, slot in enumerate(slots):
            word = words[wi] if wi < len(words) else ""
            if not word:
                continue
            right, left, on_icon = row_bounds(slots, slot, rows[wi], cell,
                                              obstacles, floor)
            bands[wi] = (word, right, left, on_icon)
        return bands

    if not _bands(rows):
        return [None] * len(slots)
    # Wrapping needs a text box to wrap INSIDE, and now every card has one: the
    # left line is the mirror of the card's own numbered column
    # (``_card_left_edge``), not a guess at where the origin's short words
    # happened to stop. So the owner's rule applies to every template alike —
    # WRAP FIRST, SHRINK SECOND — instead of only where an icon forced the issue.
    # The v1 sheet used to answer a phrase too wide for its card by shrinking the
    # whole card onto one line (11.8 on מרקאנה where the same phrase wraps at
    # 21.3 on אואזיס); the type stays up now, and the second line is what pays.
    def _room(live_c, rows):
        """The paper the block may grow down into, or None.

        Only usable when it IS below, and only when there are two calibrated
        centres to read a spacing from. A bound that lands above the last line
        says the scan found something that is not the frame the words sit in, and
        the calibrated span is the safer answer.
        """
        if not (vbounds and room_bottom is not None and len(live_c) > 1
                and max(live_c) > min(live_c) and room_bottom > max(live_c)):
            return None
        bands = _bands(rows)
        band_right = max(b[1] for b in bands.values())
        band_left = min(b[2] for b in bands.values())
        floor_y = min(vbounds[1], room_bottom)
        # ...AND ONLY DOWN TO THE FIRST ICON UNDER THE COLUMN. The frame says how
        # much paper is left at the foot of the card; it does not say what is
        # DRAWN on it. פריז's shoes sit in exactly that paper, so a block growing
        # into it printed its last entry across them. An icon that lies under the
        # word column and below the last calibrated line is therefore a ceiling on
        # the room, which keeps the icon rule the owner set — wrap first, shrink
        # second, never on top of the artwork — true of a card laid on the grid.
        for o in obstacles or []:
            if o[1] > max(live_c) and o[0] < band_right and o[2] > band_left:
                floor_y = min(floor_y, o[1])
        # THE TITLE IS A KEEP-OUT TOO, and on one shipped card it is the only one
        # that matters: מרקאנה's ninth front carries its title at the FOOT, and a
        # block growing down into the free paper printed the last entry straight
        # across the honoree's name. The owner's words — "the title is also red
        # area". Only when it sits BELOW the words, since a title above them is
        # the space this block never grows into anyway.
        if title_box and title_box[1] > max(live_c):
            floor_y = min(floor_y, title_box[0])
        return (vbounds[0], floor_y) if floor_y > max(live_c) else None
    # WHERE THE LINES LAND IS WHERE THEY HAVE TO BE MEASURED. The grid moves an
    # entry off its calibrated centre — that is what it is for — so a row and an
    # icon bound read at the calibrated centre describe a layout that is not the
    # one being printed. Solved as a fixed point instead: fit, see where the grid
    # puts the lines, re-read the rows and the icons THERE, and fit again. Three
    # passes at most, and the size only ever falls, so it always terminates.
    #
    # Every one of the three failures this replaces came from that gap: a second
    # line landing on an icon the first line had cleared (49 overlaps across the
    # catalogue), a crushed band chopping "אבא" into "א-ב-א", and a one-entry card
    # growing up into the honoree's name.
    def _solve(rows, cap):
        cands = {wi: _candidates(font, ref, wi + 1, word, right - left,
                                 max_lines=_WRAP_MAX_LINES,
                                 advance=advance, uniform=cap, ink=on_icon)
                 for wi, (word, right, left, on_icon) in _bands(rows).items()}
        live_c = [centers[i] for i in sorted(cands)]
        room = _room(live_c, rows)
        # THE DECK'S RHYTHM — the design's own line pitch, identical on every card
        # (design_pitch). It goes INTO the fit rather than being applied after it,
        # because the pitch, the size and the wrapping are one circle: fixing the
        # pitch afterwards leaves the size and the line counts solved for a
        # different one, which is how a block ends up over an icon or past the
        # bottom margin.
        # THE RHYTHM, and where it comes from. The design's own spacing was
        # measured from an origin card whose every entry was one short word, so
        # holding a deck to it leaves no paper for a fifth line and a long phrase
        # can only be paid for in type size (9.1pt on קליפורניה's seventh front).
        # A deck may therefore choose a TIGHTER number — one number, for all its
        # cards, so every gap on every card is still identical — and hand it down
        # here. Absent, the design's own spacing stands, which is every card that
        # needs no more room than the origin did.
        want = (deck_pitch if deck_pitch else design_pitch(live_c)) if even_lines else 0.0
        size, counts, lead = _fit_card(cands, centers, cap, font=font, ref=ref,
                                       vbounds=vbounds, room=room,
                                       count=len(slots), bold_w=bold_w,
                                       rows=rows, pitch=want, wrap_pitch=wrap_pitch)
        lines = sum(counts.values())
        # With a card to measure, the pitch floor is the origin's ENTRY spacing (a
        # constant per template) and the ceiling is the paper left below the first
        # line; without one it is the legacy line-span envelope.
        pcap = None
        if room and lines > 1:
            last = cands[max(cands)][counts[max(cands)]][0][-1]
            below = _ink_reach(font, ref, last)[1] * size
            pcap = (room[1] - min(live_c) - below) / (lines - 1)
        pitch = _grid_pitch(live_c, (len(live_c) - 1) if room else (lines - 1),
                            lead, size, cap=pcap, want=want if room else 0.0)
        # Pinned to the first calibrated line, growing downward, whenever the room
        # is known — the space above belongs to the title. Without a known room
        # the block stays centred on the calibrated span, as it was placed before.
        grid_c = _grid_centers(live_c, counts, pitch, anchor_top=bool(room))
        return cands, size, counts, pitch, grid_c

    def _spans(cands, size, counts, pitch, grid_c):
        """The strip of card each entry's INK actually occupies once the grid has
        placed it — top of the first line to the bottom of the last.

        This is what the icons have to be read against. An entry's calibrated row
        describes where the ORIGIN's single line sat; a wrapped entry on the grid
        covers a different piece of paper, and an icon it now reaches is an icon
        the first pass could not have seen. Every overlap in the sweep — a second
        line landing on artwork the first line had cleared — is that difference.
        """
        out = dict(rows)
        for wi, centre in grid_c.items():
            block = (counts[wi] - 1) * pitch / 2
            lines = cands[wi][counts[wi]][0]
            out[wi] = (centre - block - _ink_reach(font, ref, lines[0])[0] * size,
                       centre + block + _ink_reach(font, ref, lines[-1])[1] * size)
        return out

    # THE CEILING OF THE CARD. The block is pinned to the first calibrated line
    # and grows DOWN, so the only way it reaches the honoree's name is by setting
    # bigger than the strip that first line owns — which is what a card carrying
    # ONE entry did, growing symmetrically about its own centre with no neighbour
    # to stop it. One scalar, checked against the strip the design gave that line,
    # and it cannot fight the downward growth the room is there to allow.
    def _spans(cands, size, counts, pitch, grid_c):
        """The strip of card each entry's INK actually occupies once the grid has
        placed it — top of the first line to the bottom of the last.

        This is what the icons have to be read against. An entry's calibrated row
        describes where the ORIGIN's single line sat; a wrapped entry on the grid
        covers a different piece of paper, and an icon it now reaches is an icon
        the first pass could not have seen. Every overlap in the sweep — a second
        line landing on artwork the first line had cleared — is that difference.
        """
        out = dict(rows)
        for wi, centre in grid_c.items():
            block = (counts[wi] - 1) * pitch / 2
            lines = cands[wi][counts[wi]][0]
            out[wi] = (centre - block - _ink_reach(font, ref, lines[0])[0] * size,
                       centre + block + _ink_reach(font, ref, lines[-1])[1] * size)
        return out

    # THE CEILING OF THE CARD. The block is pinned to the first calibrated line
    # and grows DOWN, so the only way it reaches the honoree's name is by setting
    # bigger than the strip that first line owns — which is what a card carrying
    # ONE entry did, growing symmetrically about its own centre with no neighbour
    # to stop it. One scalar, checked against the strip the design gave that line,
    # and it cannot fight the downward growth the room is there to allow.
    def _seated(cands, size, counts, pitch, grid_c):
        """``(centres, overrun)`` — the block moved DOWN off the title, and what
        it could not move.

        A card carrying one entry has no neighbour to stop it growing, so it grew
        symmetrically about its own centre and reached up into the honoree's name
        — on any order whose last card holds a single word. The answer is to seat
        it, not to shrink it: the paper it wants is underneath, which is where
        every other card's block grows. Only what will not fit even after the
        block has slid down is paid for in type size.
        """
        first, last = min(grid_c), max(grid_c)
        up = ((counts[first] - 1) * pitch / 2
              + _ink_reach(font, ref, cands[first][counts[first]][0][0])[0] * size)
        down = ((counts[last] - 1) * pitch / 2
                + _ink_reach(font, ref, cands[last][counts[last]][0][-1])[1] * size)
        sticks_up = rows[first][0] - (grid_c[first] - up)
        if sticks_up <= 0:
            return grid_c, 1.0
        floor_y = rows[last][1]
        free = floor_y - (grid_c[last] + down)
        shift = min(sticks_up, max(free, 0.0))
        seated = {wi: c + shift for wi, c in grid_c.items()}
        left_over = sticks_up - shift
        reach = grid_c[first] - rows[first][0] + shift
        return seated, ((up / reach) if left_over > 0 and reach > 0 else 1.0)

    out, spans = None, None
    for _pass in range(3):
        out = _solve(spans or rows, uniform)
        moved = _spans(*out)
        if moved == (spans or rows):
            break
        spans = moved
    cands, size, counts, pitch, grid_c = out
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


@functools.lru_cache(maxsize=8)
def _title_face(font_path, alt_font_path=None, ref=200, rtl=False):
    """The measuring instrument for a title: one face, or two.

    A buyer may type a custom title in any language, so a template drawn with a
    Hebrew title face can be asked to set an English one (the honoree-NAME script
    guards do not apply to a custom title). The second face is what that title is
    set in; ``None`` leaves this the primary font itself.
    """
    primary = _title_metrics(font_path, ref)[0]
    alt = _title_metrics(alt_font_path, ref)[0] if alt_font_path else None
    return Face(primary, alt, ref, rtl=rtl)


def _title_runs(face, line):
    """One title line's text, in as many faces as it needs.

    ONE ``<text>`` either way, unlike ``word_lines``. The reason the numbered
    word line has to hand-place its runs is that Chrome ignores
    ``direction="rtl"`` for run ORDERING there — a stranded neutral "." between a
    Hebrew word and a digit inside one plain ``<text>``. A title line has no such
    neutral: it is words and an optional number on a ``textPath``, where the base
    direction IS honoured (verified in
    ``test_title_block_rtl_reorders_digit_in_raster``). So the second face is a
    ``<tspan>`` and Chrome does the ordering, which is also what keeps the arch,
    the alignment and the three stacked paint layers working unchanged.

    A single-face line returns the bare escaped string it always did.
    """
    runs = face.runs(line)
    if len(runs) == 1 and runs[0][0] is not face.alt:
        return escape(line)
    return "".join(
        f'<tspan font-family="TitleFontAlt">{escape(t)}</tspan>'
        if f is face.alt else escape(t)
        for f, t in runs)


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


def script_runs(line, base_rtl=True):
    """``line`` split into runs that want the Hebrew face vs the Latin one.

    Returns ``[(is_latin, text), ...]`` in LOGICAL order, covering the line
    exactly (concatenating the texts gives ``line`` back).

    The rule, and why each half of it matters:

    * A strong Latin letter wants the Latin face. That is the whole feature —
      the owner uploads a Latin face and English words are set in it.
    * A strong Hebrew letter wants the Hebrew face.
    * **Everything else is neutral, and that deliberately includes DIGITS.**
      Unicode calls them ``EN``/``AN``, not ``L``. Treating a digit as Latin
      would split "40 מתחת" into two runs and re-emit the markup of every
      shipped card that prints a number — for no visible gain, since the Hebrew
      faces all draw digits. A neutral joins the run beside it; between two runs
      that disagree, or at either edge, it takes the base direction.

    So "40 מתחת ל-BBQ" is two runs — ``40 מתחת ל-`` in Hebrew and ``BBQ`` in
    Latin — with the hyphen staying beside the ``ל`` it belongs to, and
    "מסיבה 40" is ONE run, exactly as today.
    """
    import unicodedata

    base = "R" if base_rtl else "L"
    kinds = []
    for ch in line:
        klass = unicodedata.bidirectional(ch)
        if klass == "NSM":
            # Unicode W1: a combining mark takes the class of the character it
            # combines with. Real data depends on this — the shipped wordlist
            # carries "🅿️", a squared Latin P (class L) plus an invisible
            # variation selector; resolving that selector as a free-standing
            # neutral splits one glyph across two faces.
            kinds.append(kinds[-1] if kinds else None)
        elif klass in ("R", "AL"):
            kinds.append("R")
        elif klass == "L":
            kinds.append("L")
        else:
            kinds.append(None)          # neutral, resolved below
    # Resolve neutrals: a run of them takes the kind on BOTH sides when those
    # agree, else the base. This is Unicode's N1/N2, and it is what keeps a
    # number or a space inside a Hebrew phrase from breaking the phrase up.
    n = len(kinds)
    i = 0
    while i < n:
        if kinds[i] is not None:
            i += 1
            continue
        j = i
        while j < n and kinds[j] is None:
            j += 1
        before = kinds[i - 1] if i > 0 else None
        after = kinds[j] if j < n else None
        kinds[i:j] = [(before if before == after and before else base)] * (j - i)
        i = j
    runs, cur, kind = [], "", None
    for ch, k in zip(line, kinds):
        if kind is not None and k != kind:
            runs.append((kind == "L", cur))
            cur = ""
        kind, cur = k, cur + ch
    if cur:
        runs.append((kind == "L", cur))
    return runs


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


def _line_advance(f, line, rtl):
    """A line's total advance, measured the way its skyline was rasterized.

    The single-face reading is of the DRAWN (visual-order) string, exactly as it
    always was; a two-face line is the sum of its runs' own advances, which is
    what ``_line_skyline`` walks and what ``word_lines`` places.
    """
    if not isinstance(f, Face) or f.single:
        return f.getlength(visual_order(line, rtl))
    return sum(font.getlength(t) for font, t in f.runs(line))


def _line_skyline(f, ref, line, rtl):
    """``_ink_skyline`` for a line that may be set in TWO faces.

    Each run carries its own raster — a Latin run's ink is the Latin face's ink,
    and nothing else can tell you where it reaches — so the runs are rasterized
    separately, each shifted by the pen advance of the runs painted before it,
    and the profiles combined column by column with a max. That is the same
    composition the renderer performs when it places the runs (see
    ``word_lines``), so the skyline describes the picture that gets printed.

    Deliberately NOT ``_min_line_pitch_by_box`` for the two-face case. That
    fallback's own docstring says it over-reserves, and over-reserving is the
    exact failure the per-column reading was introduced to undo (36% of a deck
    spaced wider than its design spaces itself, #327/#337). A second face is no
    reason to go back to it.

    ONE FACE returns the single call it always made, on the same cached raster.
    """
    runs = f.runs(line) if isinstance(f, Face) else [(f, line)]
    if len(runs) == 1:
        return _ink_skyline(runs[0][0].path, ref, visual_order(line, rtl))
    alt = f.alt
    # Left to right: the renderer paints the runs in visual order, which for an
    # RTL line is the logical order reversed.
    ordered = list(reversed(runs)) if rtl else list(runs)
    pen, parts = 0.0, []
    for font, txt in ordered:
        # A Latin run is emitted with no RTL embedding and sets left to right,
        # so it is measured as written; a Hebrew run is put into paint order by
        # hand, because Pillow will not do it (see ``visual_order``).
        drawn = txt if font is alt else visual_order(txt, rtl)
        xl, below, above = _ink_skyline(font.path, ref, drawn)
        parts.append((pen + xl, below, above))
        pen += font.getlength(txt)
    lo = min(int(round(x)) for x, _b, _a in parts)
    hi = max(int(round(x)) + len(b) for x, b, _a in parts)
    below = [None] * (hi - lo)
    above = [None] * (hi - lo)
    for x, b, a in parts:
        off = int(round(x)) - lo
        for i, (bv, av) in enumerate(zip(b, a)):
            if bv is not None:
                j = off + i
                below[j] = bv if below[j] is None else max(below[j], bv)
                above[j] = av if above[j] is None else max(above[j], av)
    return lo, tuple(below), tuple(above)


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
    if not getattr(f, "path", None):
        return _min_line_pitch_by_box(f, ref, lines, pad, clear=clear)
    worst = 0.0
    radius = max(0, int(round((grow or 0.0) * ref)))
    for upper, lower in zip(lines, lines[1:]):
        ux, u_below, _u_above = _line_skyline(f, ref, upper, rtl)
        lx, _l_below, l_above = _line_skyline(f, ref, lower, rtl)
        u_below, l_above = _dilate(u_below, radius), _dilate(l_above, radius)
        # Where the pen starts for each line, relative to a shared origin. The
        # renderer anchors a centred line on its ADVANCE (text-anchor="middle"),
        # a right-aligned one on its end, a left-aligned one on its start — so
        # this is the same arithmetic the block itself lays out with.
        uw, lw = _line_advance(f, upper, rtl), _line_advance(f, lower, rtl)
        if align == "left":
            u_pen, l_pen = 0.0, 0.0
        elif align == "right":
            u_pen, l_pen = -uw, -lw
        else:
            u_pen, l_pen = -uw / 2, -lw / 2
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
#
# ZERO, by the owner's decision: "make the box exact". It was 0.25 — the recipe
# title boxes are approximate regions and the ORIGIN's own ink overran them by
# ~10%, so a tolerance kept every shipped deck matching the design it was traced
# from. The cost was that the box drew one rectangle and the press printed
# another: measured over the 59 live cards, 41 of them painted outside their box,
# typically 2mm and up to 10mm. A box that is not a boundary cannot be used to
# decide anything, which is what the owner was trying to do with it.
#
# So the box binds now, and a title that would overrun it is set smaller. Titles
# on existing designs come down by up to ~20% where they were height-bound.
# HOW MUCH OF ITS BOX A TITLE FILLS, side to side. It was 0.89 — a margin the
# traced boxes needed, because detection drew them tight around the origin's own
# title and the ink had to be kept off the artwork beside it. The boxes are the
# owner's now: she draws the room she wants the title to have, on a rendered
# card, so the margin she wants is already in the rectangle. Holding back another
# 11% only means the title she sized in the editor prints smaller than she drew
# it. The ring painted outside the glyphs still has to fit (the second term of
# the width fit), so the letters cannot spill even at this.
_TITLE_BOX_FILL = 0.98

_TITLE_OVERFLOW_TOL = float(os.environ.get("DUGRI_TITLE_OVERFLOW_TOL", "0"))


# ---- the title path, and the letters that fall off the end of it ------------
#
# THE FAILURE. Every title line rides a ``<textPath>``. SVG does not clip a glyph
# that runs past the end of its path — it DROPS it, whole, and says nothing. A
# CENTRED run (``startOffset="50%"`` + ``text-anchor="middle"``, which is what
# every centre-aligned title here uses) overflows by half at each end, so it
# loses letters from BOTH ends at once. The owner's report was exactly that:
# "no matter what name I put it removes the first and final letter" — אואזיס
# printed "ווקות לט" where the buyer had asked for "רווקות לטל".
#
# Measured through the production rasterizer at the top of this work, on the
# straight (``arch: 0``) path every shipped and owner-onboarded design uses:
#
#     path length      rendered ink span
#     2.00 x the run   119.7 units   (all ten glyphs)
#     1.00 x the run   119.7 units   (all ten glyphs)
#     0.55 x the run    63.7 units   (two glyphs gone)
#     0.30 x the run    23.0 units   (six glyphs gone)
#
# A straight path is NOT lenient about this, whatever an arched one does. There
# is no version of this the renderer can survive: a card that prints a plausible
# but WRONG name is worse than an order that stops, because nothing downstream —
# not the preview, not the proof, not the customer — can tell it went wrong,
# and it goes wrong identically on all 104 cards of a paid order.
#
# WHY A PATH IS EVER TOO SHORT. The run is MEASURED here, by Pillow, and LAID
# OUT there, by Chrome, and the two are not obliged to agree. The catastrophic
# disagreement is a title face that has no glyph for the title's own script:
# Pillow answers with the face's ``.notdef`` advance while Chrome silently
# substitutes a system face with real advances. Measured on the design that
# produced the report — League Spartan Bold, which carries not one Hebrew letter,
# against "רווקות לטל" — Pillow says 93.2 user units and Chrome draws 120: 29%
# more run than the geometry reserved, in a chord that only ever carried
# ``0.3 * size`` (0.15 em a side) of margin. That case is now REFUSED outright
# (``assert_title_drawable``), because a face that cannot draw the text makes
# every OTHER number about the title wrong too, not just this one — the size,
# the centring and the box fit are all measured off the same phantom.
#
# What is left after the refusal is ordinary disagreement — shaping, kerning,
# mark composition — and the answer to that is room. Half the run per free end
# is far past anything measurable across the shipped faces, and it is free: the
# path is never painted, and the extension is EXACT (see ``_extend_quadratic``),
# so not one glyph moves by a subpixel. Verified pixel-for-pixel against the
# pre-extension render of every shipped theme.
#
# Floored at zero, and that is not defensiveness about typos. The invariant
# below asserts the emitted path against ``wln * (1 + sides * SLACK)``, so a
# NEGATIVE value here would lower the bar it is checked against in exact step
# with the path it is checking — the assertion would pass while the path shrank
# under the run, which is the one thing it exists to catch. Clamped, the floor
# is always at least the run itself whatever this knob says.
_TITLE_PATH_SLACK = max(0.0, float(os.environ.get("DUGRI_TITLE_PATH_SLACK",
                                                  "0.5")))


def _extend_quadratic(p0, p1, p2, a, b):
    """Control points for the ``t in [a, b]`` piece of a quadratic Bezier.

    A quadratic IS a parabola, and a parabola extends itself: passing ``a < 0``
    or ``b > 1`` returns a LONGER piece of exactly the same curve, so anything
    already drawn on the shared part stays exactly where it was. That is what
    lets a title path be lengthened for safety without moving a glyph — and it
    is why the lengthening is done this way rather than by nudging the endpoints
    outward, which would flatten the arch the design was measured at.

    ``a == 0, b == 1`` is the identity and returns the input unchanged.
    """
    def at(t):
        u = 1 - t
        return (u * u * p0[0] + 2 * t * u * p1[0] + t * t * p2[0],
                u * u * p0[1] + 2 * t * u * p1[1] + t * t * p2[1])

    def deriv(t):
        return (2 * ((1 - t) * (p1[0] - p0[0]) + t * (p2[0] - p1[0])),
                2 * ((1 - t) * (p1[1] - p0[1]) + t * (p2[1] - p1[1])))

    q0, q2 = at(a), at(b)
    dx, dy = deriv(a)
    half = (b - a) / 2
    return q0, (q0[0] + half * dx, q0[1] + half * dy), q2


def _quad_length(p0, p1, p2, steps=64):
    """Arc length of a quadratic Bezier — the room a ``<textPath>`` on it has.

    Sampled rather than solved in closed form: the closed form degenerates when
    the control point is collinear with the ends, which is EVERY shipped and
    owner design (``arch: 0`` — a dead straight path), and this is measuring a
    safety margin, not placing ink. Sampling is exact on the straight case and
    a slight under-read on a curved one, which errs toward reserving more room.
    """
    total, prev = 0.0, p0
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        pt = (u * u * p0[0] + 2 * t * u * p1[0] + t * t * p2[0],
              u * u * p0[1] + 2 * t * u * p1[1] + t * t * p2[1])
        total += math.hypot(pt[0] - prev[0], pt[1] - prev[1])
        prev = pt
    return total


def title_font_gaps(font_path, lines):
    """The characters of ``lines`` this title face cannot draw, sorted.

    Empty means the face can set the whole title itself, which is the only case
    in which anything measured off that face describes what Chrome will draw.

    A character with no glyph is read as "a non-space character with no ink of
    its own" — the same reading ``calibrate._covers`` takes, and for the same
    reason: a font without the glyph draws ``.notdef``, which reports a
    zero-height box. Pillow is the only font library the production image
    carries (no fontTools — see requirements-dev.txt), so the cmap cannot be
    consulted directly. It is the right reading anyway: a mapped-but-blank glyph
    prints blank whatever the cmap claims.

    NOT cached. Every other font reading in this module is memoised by PATH, and
    that is exactly wrong here: the owner fixes this fault by re-uploading a font
    — very often under the SAME filename — and a cached answer would go on
    refusing her corrected template for the life of the process. One font open
    per order is not a cost worth that.
    """
    try:
        font = _measuring_font(font_path, 200)
    except (OSError, ValueError):
        return []                    # an unopenable face is _assets' complaint
    out = []
    for ch in sorted(set("".join(lines))):
        if ch.isspace():
            continue
        try:
            box = font.getbbox(ch)
        except (OSError, ValueError):
            continue
        if box[3] - box[1] <= 0:
            out.append(ch)
    return out


def assert_title_drawable(font_path, lines, theme=None, alt_font_path=None):
    """Refuse a title NEITHER of its faces can draw.

    ``alt_font_path`` is the optional second title face the owner uploads for
    exactly this case — a design whose primary face is a Latin display script
    being given a Hebrew name, or the reverse. A character the primary cannot
    draw is not a fault when the alt draws it: that IS the feature, and the
    renderer already splits the title across both faces. Checking the primary
    alone refused an order the deck could set perfectly well — פריז with
    MrDafoe (no Hebrew) beside GveretLevin (Hebrew and Latin).

    ``calibrate`` already refuses to MEASURE against such a face ("a fit against
    such a sample measures the wrong typeface entirely and must be refused").
    This is the same refusal one step later, where it decides what gets printed:
    Chrome falls back to a system face for the missing glyphs, so the title is
    set in a typeface nobody chose, at a size fitted to a different one, on a
    path measured for a third — and the first casualty is the letters that fall
    off the end of that path (see ``_TITLE_PATH_SLACK``).

    Raised rather than warned because there is no good degraded form. A title
    the owner can SEE is wrong costs one re-upload; a title that merely looks
    plausible costs a printed order and the customer's name on it.
    """
    gaps = title_font_gaps(font_path, lines)
    if not gaps:
        return
    if alt_font_path:
        # Only what NEITHER face can draw is a real gap. Order matters for the
        # message, not the verdict: the owner is told which characters are
        # unset, whichever face was supposed to carry them.
        gaps = [c for c in gaps if c in set(title_font_gaps(alt_font_path, lines))]
        if not gaps:
            return
    where = f"theme {theme!r}: " if theme else ""
    if alt_font_path:
        raise RuntimeError(
            f"{where}neither title font can draw {''.join(gaps)!r}, which the "
            f"title {' / '.join(lines)!r} is made of — not "
            f"{os.path.basename(font_path)!r} and not "
            f"{os.path.basename(alt_font_path)!r}. Chrome would substitute a "
            f"system face for those letters and the title would print in a "
            f"typeface nobody chose. Upload a title font that covers this "
            f"design's language, or change the title text.")
    raise RuntimeError(
        f"{where}the title font {os.path.basename(font_path)!r} has no glyphs "
        f"for {''.join(gaps)!r}, which the title {' / '.join(lines)!r} is made "
        f"of. Chrome would substitute a system face for those letters and the "
        f"title would print in a typeface nobody chose, at a size fitted to a "
        f"different one — and letters that overrun the path are dropped in "
        f"silence, so the card would look right and read wrong. Upload a title "
        f"font that covers this design's language, or change the title text.")


def title_script(lines):
    """The ONE language a title reads in: ``"hebrew"`` or ``"english"``.

    Taken from the title as a whole, not per line and not per run — a title is
    one thing set in one face. Digits, spaces and punctuation are neutral and
    decide nothing; the first strong character that appears anywhere in the
    title is the answer, so "{NAME} 40S" reads by {NAME}.
    """
    for ln in lines:
        if _line_is_rtl(ln):
            return "hebrew"
        if _line_is_latin(ln):
            return "english"
    return None


def title_font_for(theme, lines, cfg=None):
    """The ONE font a title is set in.

    THE RULE, in the owner's words: "title is always the first font, unless the
    language changed and then the font also changes."

    So the second title font is reached in exactly one case — the title is in
    the other language from the design — and it then sets the WHOLE title.

    It is never reached run by run. That is the WORD rule: ``Face.runs`` splits
    by script so English words take the design's Latin word face, which is right
    for words and wrong for a title. Titles shared that Face, so an ordinary
    English title on a design that happened to have a second title font had its
    Latin runs silently swapped into a face nobody chose — the owner's report was
    "titles in english change font with no reason to the second font".

    Returns a path; the caller measures and paints with that one file.
    """
    cfg = cfg if cfg is not None else config.theme(theme)
    primary = config.resolve_title_font(theme)
    alt = config.resolve_title_font_alt(theme)
    if not alt:
        return primary
    script = title_script(lines)
    if script is None:
        return primary
    return alt if script != (cfg.get("language") or "hebrew") else primary


def title_is_rtl(cfg, lines=None):
    """Whether this title's base direction is right-to-left.

    Read off the TITLE ITSELF, exactly as ``title_font_for`` already reads the
    face off it: ``title_script`` answers "hebrew"/"english" from the first
    strong character anywhere in the title, and digits/spaces/punctuation decide
    nothing. It matters for any title that mixes digits with Hebrew — "30 שנות
    נישואין", "{NAME} בן {AGE}" — because under the default LTR base direction
    the digit run lays out on the WRONG SIDE of the words.

    It used to be read off the theme's ``language`` instead, and that was true
    when the honoree's name was composed into a designed title. It stopped being
    true when the buyer started typing the WHOLE title herself: seven of the ten
    designs are ``language: english`` and every one of them takes Hebrew titles
    daily, so a Latin-scripted deck laid every numbered Hebrew title out
    backwards while the FONT — picked from the same text — swapped correctly.

    ``lines`` omitted, or a title with no strong character in it at all (bare
    digits), falls back to the theme's language, which is the previous
    behaviour and the only answer available.
    """
    script = title_script(lines) if lines else None
    if script is not None:
        return script == "hebrew"
    return cfg.get("language") == "hebrew"


def title_block(box, lines, fill, outline, font_path, outline_w, arch, shadow,
                rtl=False, fixed_size=None, align="center", italic=False,
                bold=False, bold_w=None, leading=None, one_block=False,
                alt_font_path=None, max_size=None):
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
    face = _title_face(font_path, alt_font_path, rtl=rtl)
    f, ref = face, face.ref
    ratios = [f.getlength(ln) / ref for ln in lines]      # width per unit size
    # Does this title actually need the second face? Asked once, because it
    # decides both how the runs are emitted and whether a PINNED size may stand.
    mixed = any(face.uses_alt(ln) for ln in lines)
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
    # WIDTH, with the paint counted. ``_TITLE_BOX_FILL`` is how much of the box
    # the letters may take; the second term is the ring itself, which is painted
    # OUTSIDE the glyph advance (``title_paint_grow`` is the spread per unit of
    # size, at each edge) and therefore has to come out of the same width or the
    # box binds the letters while the ring hangs over the artwork.
    if denom_w > 0:
        size = min(bw * _TITLE_BOX_FILL / denom_w,
                   bw / (denom_w + 2 * paint_grow), size_h)
    else:
        size = size_h
    # A theme may pin the title to an EXACT size (the Canva point size, in the
    # recipe's user units) instead of auto-fitting to the box — the box then only
    # positions (centres) the title. Used where auto-fit over/under-shoots.
    # A PIN CANNOT SURVIVE A CHANGE OF FACE. ``title_style.size`` is a number
    # measured against the ORIGIN's face and the ORIGIN's own title text; a title
    # that resolves any run into the second face is set in neither. The owner
    # settled this as auto-fit at render time rather than a second calibrated
    # size per face: a pin per (template x face x script) is a number nobody
    # would ever re-measure, and the auto-fit already answers the question the
    # pin was standing in for — how large this text goes in this box. One
    # condition, and it covers fronts, backs and board because all three reach
    # here through this same argument.
    if fixed_size and not mixed:
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
            size = min(size, bw * _TITLE_BOX_FILL / denom_w * (1 + _TITLE_OVERFLOW_TOL),
                       bw / (denom_w + 2 * paint_grow))
        # ...and the box binds a pin VERTICALLY too. It never used to: a pinned
        # theme skipped the height fit entirely, so bachelorette's pin printed a
        # title up to 36% taller than the rectangle it was supposedly placed in.
        # A pin is the origin's number for the origin's own title; the box is the
        # promise made to whoever is looking at it.
        size = min(size, size_h)
    # THE CEILING, last. It is not a pin and not a fit: it can only ever bring
    # the answer DOWN, so it is applied after both have had their say and cannot
    # license a title the box would not have allowed. A card whose box gives less
    # than the ceiling never notices it is there.
    if max_size and max_size > 0:
        size = min(size, max_size)
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
                f'{_title_runs(face, line)}</textPath></text>')

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
            #
            # MIRRORED FOR AN RTL RUN. _ink_bearings measures with Pillow, which
            # lays a string out left-to-right whatever its script; the SVG paints
            # a Hebrew title RIGHT-TO-LEFT. So the overhang Pillow reports on the
            # right is the one that shows on the LEFT, and correcting by the
            # unmirrored skew moved the line the wrong way — twice the error
            # rather than none. Measured on סנטוריני's "יעל חוגגת יובל": 1.84
            # units left of centre before, 0 after (the two-line title on the
            # same card was already centred, because its lines happen to have no
            # asymmetry to correct — which is why this hid for so long).
            lsb, rsb = _ink_bearings(f, ref, line, size)
            skew = (rsb - lsb) / 2 if rtl else (lsb - rsb) / 2
            xl = cx - skew - wln / 2 - size * 0.15
            xr = cx - skew + wln / 2 + size * 0.15
        cxp = (xl + xr) / 2
        # The geometry above ANCHORS the run; the path below only HOSTS it, and
        # it is emitted far longer than the glyphs are measured to need — see
        # _TITLE_PATH_SLACK for what silently goes missing when it is not.
        #
        # Only the ends the ANCHOR does not pin are extended, so no run moves.
        # A centred line is anchored at the path's arc-length midpoint, which a
        # symmetric extension of a symmetric parabola leaves exactly where it
        # was; a left-aligned one starts at the path's start, so only its far
        # end grows; a right-aligned one ends at the path's end.
        span = xr - xl
        grow = (_TITLE_PATH_SLACK * wln / span) if span > 0 else 0.0
        t0 = 0.0 if left_align else -grow
        t1 = 1.0 if right_align else 1.0 + grow
        # ...and the room really is there. The invariant is asserted on the
        # EMITTED curve rather than on the arithmetic that produced it, so a
        # later change to how the path is built cannot quietly reintroduce a
        # short one: whatever the shape, a run of ``wln`` has to fit with its
        # slack on every side it is free to grow toward.
        sides = 1 if (left_align or right_align) else 2
        need = wln * (1 + sides * _TITLE_PATH_SLACK)

        def arc(pid, ox, oy):
            q0, q1, q2 = _extend_quadratic((xl + ox, by + oy),
                                           (cxp + ox, by + oy - 2 * bulge),
                                           (xr + ox, by + oy), t0, t1)
            have = _quad_length(q0, q1, q2)
            if have + 1e-6 < need:
                raise RuntimeError(
                    "the title path is shorter than the text it carries, and a "
                    "glyph that falls off a textPath is DROPPED by the "
                    f"rasterizer without a word: {line!r} needs {need:.1f} user "
                    f"units of path and this one is {have:.1f}.")
            defs.append(f'<path id="{pid}" fill="none" d="M {q0[0]:.3f} {q0[1]:.3f} '
                        f'Q {q1[0]:.3f} {q1[1]:.3f} {q2[0]:.3f} {q2[1]:.3f}"/>')

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


_TITLE_HEBREW = re.compile(r"[\u0590-\u05FF]")


def title_ceiling(cfg, lines, back=False):
    """The ceiling for THIS title, by the script it is set in.

    Read off the resolved text rather than the theme's declared language: a buyer
    may write the honoree's name in the other one (``title_font_for`` already
    swaps the face for exactly that), and the ceiling has to follow the face it
    is measured against or it caps the wrong thing.
    """
    key = ("back_title_max_" if back else "title_max_")
    key += "he" if any(_TITLE_HEBREW.search(ln or "") for ln in (lines or [])) else "en"
    return config.type_ceiling(cfg, key)


def title_box_clear_of(tbox, obstacles, right=None):
    """``tbox`` trimmed to paper the artwork does not already occupy.

    THE GAP THIS CLOSES: the words dodge the icons (THE WORDS' SIDE OF THE ICON
    RULE); the title never did. It trusts its calibrated box, which was measured
    around the ORIGIN's own title — one line, in the origin's language. A buyer's
    two-line Hebrew title fills that box's full height, and if an icon sits at the
    edge of it the title simply prints over the artwork. The owner found it on a
    card whose title crossed a rubik's cube.

    So the box is trimmed before the title is fitted into it, and only ever
    trimmed — by whichever of two moves leaves more paper: NARROWING it to the
    widest column no icon stands in, or BANDING it to the tallest strip no icon
    crosses (then pushed in from the left by the icons' real reach at that
    height — their PIECES, not their bounding rectangle, see ``Obstacle``).

    A box with nothing free is returned UNCHANGED. That is deliberate: a title
    squeezed to nothing is not better than a title over an icon, and a template
    whose title box is genuinely buried is a calibration problem for the owner to
    see, not something to hide by printing an unreadable title.
    """
    if not obstacles:
        return tbox
    hits = [o for o in obstacles
            if o[0] < tbox["x1"] and tbox["x0"] < o[2]
            and o[1] < tbox["y1"] and tbox["y0"] < o[3]]
    if not hits:
        return tbox
    # TWO WAYS to get out of an icon's way, and the bigger one wins.
    #
    # Banding alone — the tallest horizontal strip no icon crosses — is right
    # when an icon lies ACROSS the box, and catastrophic when one merely clips a
    # corner: קליפורניה's rubik cube overlapped a title box by four tenths of a
    # point at the edge and the band that survived was 3.7pt tall, which is not a
    # title. Narrowing is right in that case and useless when the icon spans the
    # width. So both are measured and the larger area is taken; on a tie the
    # taller one wins, because a title is fitted by height first.
    x0, x1, y0, y1 = tbox["x0"], tbox["x1"], tbox["y0"], tbox["y1"]

    # (a) FULL HEIGHT, narrowed: the widest column of the box no icon occupies.
    cuts = sorted((max(x0, o[0]), min(x1, o[2])) for o in hits)
    free, edge = [], x0
    for a, b in cuts:
        if a > edge:
            free.append((edge, a))
        edge = max(edge, b)
    if edge < x1:
        free.append((edge, x1))
    narrow = None
    if free:
        a, b = max(free, key=lambda f: f[1] - f[0])
        narrow = {"x0": a, "x1": b, "y0": y0, "y1": y1}

    # (b) FULL WIDTH, banded: the tallest strip between the icons.
    edges = [y0]
    for o in sorted(hits, key=lambda o: o[1]):
        edges += [max(y0, o[1]), min(y1, o[3])]
    edges.append(y1)
    bands = [(edges[i], edges[i + 1]) for i in range(0, len(edges) - 1, 2)
             if edges[i + 1] - edges[i] > 0]
    band = None
    if bands:
        top, bottom = max(bands, key=lambda b: b[1] - b[0])
        band = {"x0": x0, "x1": x1, "y0": top, "y1": bottom}
        # …and the icons still beside that band push the box in from the left, by
        # their real reach at that height.
        edge_x = _obstacle_left(obstacles, (top, bottom),
                                right if right is not None else x1)
        if edge_x is not None and x0 < edge_x < x1:
            band["x0"] = edge_x

    def area(b):
        return (b["x1"] - b["x0"]) * (b["y1"] - b["y0"]) if b else 0

    out = max((c for c in (narrow, band) if c),
              key=lambda c: (area(c), c["y1"] - c["y0"]), default=None)
    if not out or out["x1"] - out["x0"] <= 0 or out["y1"] - out["y0"] <= 0:
        return tbox
    return dict(tbox, **out)


def _title_overlay(tbox_list, title_lines, cfg, title_font, cell, offset=None,
                   fixed_size=None, align=None, obstacles=None, back=False):
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
    # AFTER the nudge, because the nudge is what decides which paper the box
    # actually covers on this front.
    tbox = title_box_clear_of(tbox, obstacles)
    # THE CAP, and WHICH cap. A pinned size is a ceiling the box may still pull
    # down, and a template's two title faces do not share one: the design's own
    # face was measured against the design's own language, and the SECOND face —
    # reached only when the buyer writes in the other language
    # (``title_font_for``) — has its own proportions, so one number cannot suit
    # both. ``size_alt`` is that second number; unset, the alt-language title
    # takes the same chain it always did.
    cap = fixed_size if fixed_size is not None else ts.get("size")
    alt_name = os.path.basename(str(cfg.get("title_font_alt") or "").strip())
    if (alt_name and os.path.basename(str(title_font)) == alt_name
            and ts.get("size_alt") is not None):
        cap = ts["size_alt"]
    return title_block(tbox, title_lines, ts["fill"], ts["outline"], title_font,
                       ts["outline_w"], ts["arch"], ts["shadow"],
                       rtl=title_is_rtl(cfg, title_lines),
                       fixed_size=cap,
                       max_size=title_ceiling(cfg, title_lines, back=back),
                       align=align or ts.get("align", "center"),
                       italic=ts.get("italic", False),
                       bold=ts.get("bold", False),
                       bold_w=ts.get("bold_w"),
                       leading=ts.get("leading"),
                       one_block=bool(ts.get("one_block")))


def _words_overlay(slots, words, cfg, word_font, cell, room=None,
                   obstacles=None, word_font_alt=None, title_box=None,
                   deck_pitch=None):
    """The four numbered word lines for one card, as SVG markup.

    ``room`` is the lowest y a line's ink may reach (see ``room_bottom``) — the
    card's real vertical envelope, which a wrapping card may grow down into.
    ``obstacles`` are the artwork's icons on this card (see THE ICONS), which no
    line may print over.

    ``word_font_alt`` is the template's Latin face, when it ships one. It is
    threaded through the FIT as well as the render because they have to agree:
    a width reserved off one face and painted in another is how a line ends up
    over the trim.
    """
    if not slots:
        return ""
    # ONE scale for the fit and the render — read once, handed to both.
    alt_scale = config.word_alt_scale(cfg, _WORD_ALT_SCALE)
    face = _word_face(word_font, word_font_alt, alt_scale=alt_scale)
    bold_w = config.word_bold_w(cfg, _WORD_BOLD_W)
    # WHICH ROW each entry takes, decided against THIS card's artwork — see
    # order_by_room. The packer chooses which entries share a card; only here is
    # it known which front they are printed on, and therefore which of the four
    # rows an icon has taken a bite out of.
    words = order_by_room(slots, words, face, cell=cell, obstacles=obstacles,
                          safe=_CARD_SAFE, room_bottom=room)
    layouts = _word_layouts(slots, words, face, face.ref, cell=cell,
                            word_size=cfg.get("word_size"), safe=_CARD_SAFE,
                            room_bottom=room, bold_w=bold_w,
                            obstacles=obstacles, title_box=title_box,
                            # THE DECK'S RHYTHM applies to the CARD templates only
                            # — see design_pitch. A v1 sheet card has no paper
                            # below its last line to put an extra line into (eight
                            # cards share one page), so holding it to a fixed
                            # pitch does not cost it type size, it destroys it:
                            # measured on bachelorette card 2, 10.4 -> 2.5. Those
                            # templates keep the per-card pitch they have always
                            # had; every card template, which is everything built
                            # since, gets the uniform rhythm.
                            even_lines=config.is_single_card(cfg),
                            deck_pitch=deck_pitch,
                            max_size=config.type_ceiling(cfg, "word_max_he"),
                            wrap_pitch=config.word_wrap_pitch(cfg))
    # One anchor and one digit column for the whole card, so the four numbers sit
    # in a column and the four words start at the same x. Both must match what
    # _word_layouts fitted against, or the render would overflow the band it was
    # measured for.
    x_right = _card_right_edge(slots, cell)
    advance = _marker_advance(face.primary, len(slots))
    out = []
    for wi, slot in enumerate(slots):
        if layouts[wi] is None:
            continue
        lay = layouts[wi]
        # The card's own grid centre — one pitch for every gap on the card.
        center = lay.center if lay.center is not None else (slot["y0"] + slot["y1"]) / 2
        out.append(word_lines(x_right, center, lay.size, slot["color"],
                              wi + 1, lay.lines, word_font, lead=lay.lead,
                              marker_advance=advance, bold_w=bold_w,
                              alt_font_path=word_font_alt,
                              # per CARD, because the ceiling bites at the size
                              # this card actually set, not the deck's ratio
                              alt_scale=latin_scale(cfg, lay.size, alt_scale)))
    return "".join(out)


# ---- v2: one portrait card per page ---------------------------------------
# v1 laid 8 cards onto an A4 sheet, so every render walked recipe["cards"]. A v2
# page IS one card: the same slot geometry and the same title/word painters, just
# applied once against the card's own viewBox. The overlays below emit markup
# ONLY — no <style>, no @font-face — because the whole deck is assembled into one
# HTML document where the fonts are declared a single time (see deck_html).


def card_pitch_need(theme, recipe, words, front_index=None, word_font=None,
                    card_vb=None, card_svg=None):
    """The line spacing THIS card wants, in card units — or None if it is happy.

    A card is happy when it needs no more lines than the origin's own entries, so
    the design's spacing already fits it. A card carrying a phrase long enough to
    wrap is not: at the design's spacing there is no paper for the extra line, and
    the only currency left is type size.

    Answered by fitting the card with the pitch FREE and reporting what it chose.
    No Chrome, no artwork rendering — the metrics the fit already reads.

    The deck takes the tightest answer over all its cards and prints every card at
    it (build.deck_pitch_for): one number for the order, so every gap on every
    card is still identical, and the number is small enough that the long phrase
    can wrap instead of shrinking the whole card.
    """
    cfg = config.theme(theme)
    if not config.is_single_card(cfg):
        return None
    cell = (recipe.get("card") or {}).get("cell") or _recipe_cell(recipe, card_vb)
    slots = deck_slots(theme, config.card_word_boxes(cfg, recipe, cell), cell)
    if not slots:
        return None
    face = _word_face(config.resolve_word_font(theme, word_font),
                      word_font_alt(theme, word_font),
                      alt_scale=config.word_alt_scale(cfg, _WORD_ALT_SCALE))
    safe_bottom = cell[3] - (cell[3] - cell[1]) * _CARD_SAFE
    room = (room_bottom(theme, front_index, card_svg, cell, safe_bottom)
            if card_svg else None)
    icons = (card_obstacle_rects(theme, front_index, card_svg, cell)
             if card_svg else None)
    free = _word_layouts(slots, words, face, face.ref, cell=cell,
                         word_size=cfg.get("word_size"), safe=_CARD_SAFE,
                         room_bottom=room, bold_w=config.word_bold_w(cfg, _WORD_BOLD_W),
                         obstacles=icons, even_lines=False,
                         max_size=config.type_ceiling(cfg, "word_max_he"),
                         wrap_pitch=config.word_wrap_pitch(cfg))
    live = [l for l in free if l]
    if not live or all(len(l.lines) == 1 for l in live):
        return None                      # nothing wraps: the design's own spacing stands
    return min(l.lead * l.size for l in live)


def card_overlay(theme, recipe, words, title_lines, front_index=None,
                 word_font=None, kind="word", card_vb=None, card_svg=None,
                 deck_pitch=None):
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
    word_alt_path = word_font_alt(theme, word_font)
    title_font_path = title_font_for(theme, title_lines, cfg)
    safe_bottom = cell[3] - (cell[3] - cell[1]) * _CARD_SAFE if cell else None
    room = (room_bottom(theme, front_index, card_svg, cell, safe_bottom)
            if card_svg and cell else None)
    icons = (card_obstacle_rects(theme, front_index, card_svg, cell)
             if card_svg and cell else None)
    word_boxes = deck_slots(theme, config.card_word_boxes(cfg, recipe, cell), cell)
    tboxes = config.card_title_boxes(cfg, recipe, front_index, cell)
    # The title's own strip of card, nudged exactly as the title itself will be,
    # so the words are held off the place the name actually prints.
    title_span = None
    if tboxes and title_lines:
        union = {"x0": min(b["x0"] for b in tboxes), "y0": min(b["y0"] for b in tboxes),
                 "x1": max(b["x1"] for b in tboxes), "y1": max(b["y1"] for b in tboxes)}
        union = _nudge_title_box(union, cell, config.front_offset(cfg, front_index))
        title_span = (union["y0"], union["y1"])
    return (_title_overlay(tboxes,
                           title_lines, cfg, title_font_path, cell,
                           offset=config.front_offset(cfg, front_index),
                           align=config.front_align(cfg, front_index),
                           # The same icons the words are held off — see
                           # title_box_clear_of. Grown by the same clear air, so
                           # the title keeps the margin the words keep.
                           obstacles=_grown(icons, _ICON_CLEAR_MM * _PT_PER_MM))
            + _words_overlay(word_boxes, words,
                             cfg, word_font_path, cell, room=room,
                             obstacles=icons,
                             word_font_alt=word_alt_path,
                             title_box=title_span,
                             deck_pitch=deck_pitch))


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
    # An explicit null/empty back is an ANSWER, not a gap — respect it, unless
    # THIS back has since been calibrated on its own.
    if (not boxes and config.recipe_answered_back(recipe, back_index)
            and not config.has_back_calibration(cfg, back_index)):
        return ""
    # THE OWNER'S BOX WINS, exactly as it does on every front
    # (config.card_title_boxes). Detection traces where the ORIGIN's own back
    # title happened to sit — often line by line, a box drawn tight around the
    # design's own short name — and the owner then draws the room she wants the
    # title to have. Reading the traced boxes over hers left the back title
    # sized to artwork nobody is printing: on קליפורניה the deck set 10.1 in a
    # 95-unit traced box while her box is 156 wide and had 16.6 to give. Hers is
    # the answer; the recipe is only what the picture used to look like.
    frac = bk.get("frac") if isinstance(bk, dict) else None
    if frac:
        w, h = cell[2] - cell[0], cell[3] - cell[1]
        boxes = [{"x0": cell[0] + frac["x0"] * w, "x1": cell[0] + frac["x1"] * w,
                  "y0": cell[1] + frac["y0"] * h, "y1": cell[1] + frac["y1"] * h}]
    if not boxes:
        return ""                # theme has no personalized back -> clean art
    ts = cfg["title_style"]
    title_font = title_font_for(theme, title_lines, cfg)
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
                                      or ts.get("back_size") or ts.get("size")),
                          back=True)


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


# "nobody said" — distinct from ``None``, which a caller uses to say "print this
# card exactly as it shipped". Only the default measures. (photo_card_svg)
_MEASURE = object()

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


def photo_card_svg(theme, photos, paper=None, frame=_MEASURE):
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

    ``frame`` is the SHAPE it prints in — the deck's own frame box, corner radius
    and border stroke (``card_frame``), so the pawn card is the same size and
    roundness as the cards it ships with. Unlike the paper this is MEASURED HERE
    by default, because reading it is a parse of the front card's vector and
    needs no browser: there is nothing for ``deck_document`` to hand down and one
    fewer place for the deck and the preview to drift. Pass an explicit value (or
    ``None``) to override.
    """
    import card_assets
    import card_frame
    svg = card_assets.read_svg(config.photo_card_path(theme))
    if frame is _MEASURE:
        frame = card_frame.front_frame(theme)
    svg = card_frame.reframe(card_paper.repaper(svg, paper), frame)
    return fill_photo_slots(svg, photos or [])


def _index_from_card_path(path):
    """The card number a ``clean/13.svg`` path names, or None if it isn't one."""
    stem = os.path.splitext(os.path.basename(path or ""))[0]
    return int(stem) if stem.isdigit() else None


def build_single_card_svg(theme, clean_svg, words, title_lines, front_index=None,
                          word_font=None, kind="word", photos=None,
                          back_index=None, deck_pitch=None):
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
             + word_faces(theme, word_font) + title_faces(theme, cfg, lines=title_lines)
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
        # A preview is ONE card, so it has no deck to take its rhythm from.
        # Where the owner has set a spacing for this template, that is what the
        # printed deck prints at — so the preview prints at it too, and the card
        # the buyer approves is the card she receives.
        overlay = card_overlay(theme, recipe, words, title_lines,
                               front_index=front_index, word_font=word_font,
                               card_vb=card_vb, card_svg=svg,
                               deck_pitch=deck_pitch or config.word_pitch(cfg))
    return svg.replace("</svg>", style + overlay + "</svg>")


def render_single_card(theme, clean_svg, words, title_lines, out_png,
                       front_index=None, word_font=None, kind="word", photos=None,
                       back_index=None, deck_pitch=None):
    """Screenshot one card to ``out_png`` (the preview path)."""
    svg = build_single_card_svg(theme, clean_svg, words, title_lines,
                                front_index=front_index, word_font=word_font,
                                kind=kind, photos=photos, back_index=back_index,
                                deck_pitch=deck_pitch)
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
    # same reason. Both families of each pair land in THIS block, not in a card:
    # a per-card declaration would be eight copies again the moment a template
    # ships a Latin face.
    style = (GEOMETRIC_TEXT_STYLE
             + word_faces(theme, word_font) + title_faces(theme, cfg, lines=title_lines))
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
    # word-fonts/ pool. No override -> the theme's configured word_font. The
    # declaration block is built from the OVERRIDE (a filename), so it is taken
    # before the name is rebound to the resolved path below.
    style = ("<style>" + GEOMETRIC_TEXT_STYLE
             + word_faces(theme, word_font) + title_faces(theme, cfg, lines=title_lines)
             + "</style>")
    word_alt = word_font_alt(theme, word_font)
    word_font = config.resolve_word_font(theme, word_font)
    title_font = title_font_for(theme, title_lines, cfg)
    ts = cfg["title_style"]
    svg = open(clean_svg, encoding="utf-8").read()
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
                                       rtl=title_is_rtl(cfg, title_lines),
                                       fixed_size=ts.get("size"),
                                       max_size=title_ceiling(cfg, title_lines),
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
        # ONE scale for the fit and the render — read once, handed to both.
        alt_scale = config.word_alt_scale(cfg, _WORD_ALT_SCALE)
        face = _word_face(word_font, word_alt, alt_scale=alt_scale)
        bold_w = config.word_bold_w(cfg, _WORD_BOLD_W)
        # The icons are on the CLEAN plate and only there (see THE ICONS), and
        # this is the plate. The frame's clear air comes with them: a card allowed
        # a second line needs a floor, and the v1 sheet has never had one.
        cell = card.get("cell")
        # One row grid and one ink colour for the whole deck (see _deck_rows), so
        # eight cards the design draws identically print identically.
        card_words = deck_slots(theme, card["words"], cell)
        icons = (card_obstacle_rects(theme, ci + 1, svg, cell) if cell else None)
        room = None
        if cell:
            # EVERY card, not only one with an icon beside its words. The floor is
            # the owner's clear air at the foot of the card — "8 mm of empty paper
            # under the last line" — and it belongs to the card, not to its icons.
            # It only ever bound a card that could wrap, and until now only an
            # icon let a sheet card wrap at all; now that every card has a text
            # box, a card with no icon can grow a second line too, and it must
            # grow it into the same paper as every other card.
            safe_bottom = cell[3] - (cell[3] - cell[1]) * _CARD_SAFE
            room = room_bottom(theme, ci + 1, svg, cell, safe_bottom)
        layouts = _word_layouts(card_words, words, face, face.ref,
                                cell=cell, word_size=cfg.get("word_size"),
                                bold_w=bold_w, obstacles=icons,
                                room_bottom=room,
                                max_size=config.type_ceiling(cfg, "word_max_he"),
                                wrap_pitch=config.word_wrap_pitch(cfg))
        # The sheet card sets on the same grid as every other card: one right
        # anchor, one digit column, and the centres the grid put the lines on.
        x_right = _card_right_edge(card_words, cell)
        advance = _marker_advance(face.primary, len(card_words))
        for wi, slot in enumerate(card_words):
            if layouts[wi] is None:
                continue
            lay = layouts[wi]
            center = (lay.center if lay.center is not None
                      else (slot["y0"] + slot["y1"]) / 2)
            overlay.append(word_lines(x_right, center, lay.size, slot["color"],
                                      wi + 1, lay.lines, word_font, lead=lay.lead,
                                      bold_w=bold_w, alt_font_path=word_alt,
                                      alt_scale=latin_scale(cfg, lay.size, alt_scale),
                                      marker_advance=advance))
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
