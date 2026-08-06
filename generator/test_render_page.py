#!/usr/bin/env python3
"""Tests for generator/render_page.py — the card-fidelity fixes that make the
generated cards match the origin Canva templates:

  1. CHROME_FONT_WAIT — headless Chrome must wait for the embedded @font-face
     fonts before screenshotting, otherwise every word/title falls back to a
     heavy default Hebrew face instead of the calibrated theme font.
  2. _word_sizes — ONE uniform word size per card (matching the origin's single
     size), fit from the recipe box heights, with a per-word shrink guard so a
     long word can never spill past the card edge into the artwork.
  3. word_text — numbered lines use Latin-digit markers ("1." "2." …) placed
     RTL, never Hebrew-letter numerals.
  4. title_block — the stacked title is sized to fit its calibrated box HEIGHT
     even for display fonts whose glyphs are far taller than their em (the
     japanese/neon title faces), using real font metrics rather than a fixed
     per-line fraction.

Run: python3 generator/test_render_page.py   (or via pytest)
"""
import json
import os
import re

from PIL import Image, ImageFont

import config
import render_page as rp

HERE = os.path.dirname(os.path.abspath(__file__))
CAFE = os.path.join(HERE, "word-fonts", "Cafe Regular.ttf")


def _cafe():
    return ImageFont.truetype(CAFE, 200), 200


# --- 1. font-load wait -------------------------------------------------------

def test_chrome_font_wait_is_a_virtual_time_budget():
    assert rp.CHROME_FONT_WAIT.startswith("--virtual-time-budget=")
    ms = int(rp.CHROME_FONT_WAIT.split("=", 1)[1])
    assert ms >= 1000, "font-load wait must give Chrome real time to load fonts"


def test_build_render_svg_passes_the_font_wait_flag():
    # The production board/back render path (build.render_svg) must carry the same
    # font-load wait so titles/words don't fall back there either. Checked by
    # running it against a stub Chrome and reading the ACTUAL argv, rather than
    # grepping build.py for the constant's name — the flag now comes from the
    # shared generator/chrome.py, and the old source-grep would have "passed"
    # just as happily if the render had stopped passing it at all.
    import tempfile

    import build
    assert build.CHROME  # sanity: build shares render_page's Chrome binary
    with tempfile.TemporaryDirectory() as tmp:
        argfile = os.path.join(tmp, "argv")
        stub = os.path.join(tmp, "fake-chrome")
        with open(stub, "w", encoding="utf-8") as f:
            f.write('#!/bin/sh\nprintf "%s\\n" "$@" > "' + argfile + '"\n'
                    'for x in "$@"; do\n'
                    '  case "$x" in --screenshot=*) : > "${x#--screenshot=}";; esac\n'
                    'done\n')
        os.chmod(stub, 0o755)
        os.environ["CHROME"] = stub
        try:
            build.render_svg('<svg xmlns="http://www.w3.org/2000/svg"/>', 100, 80,
                             os.path.join(tmp, "board.png"))
        finally:
            os.environ.pop("CHROME", None)
        argv = open(argfile, encoding="utf-8").read().split("\n")
    assert rp.CHROME_FONT_WAIT in argv


# --- 2. uniform word sizing + shrink guard -----------------------------------

def _slots(boxes):
    return [{"x0": x0, "y0": y0, "x1": x1, "y1": y1} for (x0, y0, x1, y1) in boxes]


def test_word_sizes_are_uniform_when_every_word_fits():
    font, ref = _cafe()
    # four generous, equal-height boxes; short words -> nothing overflows.
    slots = _slots([(10, 10 + i * 40, 190, 34 + i * 40) for i in range(4)])
    words = ["מסיבה", "חברים", "ריקודים", "צחוקים"]
    sizes = rp._word_sizes(slots, words, font, ref, cell=[5, 5, 195, 240])
    assert all(s is not None for s in sizes)
    assert max(sizes) - min(sizes) < 1e-9, "words that all fit must share one size"


def test_word_sizes_scale_with_box_height():
    font, ref = _cafe()
    small = rp._word_sizes(_slots([(10, 10, 190, 26)]), ["מסיבה"], font, ref)
    big = rp._word_sizes(_slots([(10, 10, 190, 50)]), ["מסיבה"], font, ref)
    assert big[0] > small[0], "taller recipe boxes -> larger uniform word size"


def test_word_sizes_shrinks_only_the_overflowing_word_to_stay_in_the_cell():
    font, ref = _cafe()
    # a tall box (big uniform size) + one very long word right-anchored near x1.
    slots = _slots([(100, 10, 190, 44)])
    long = "אבגדהוזחטיכלמנסעפצקרשת"
    cell = [5, 5, 195, 240]
    sizes = rp._word_sizes(slots, [long], font, ref, cell=cell)
    left_bound = cell[0] + (cell[2] - cell[0]) * 0.02
    rendered_line = rp._line_width_at(font, ref, 1, long) * sizes[0] / ref
    assert rendered_line <= (190 - left_bound) + 1e-6, "long word must fit the card"


def test_word_sizes_bound_by_the_slot_even_without_a_cell():
    font, ref = _cafe()
    slots = _slots([(100, 10, 190, 44)])
    long = "אבגדהוזחטיכלמנסעפצקרשת"
    uni = rp._word_sizes(slots, [long], font, ref, cell=None)[0]
    med = (slots[0]["y1"] - slots[0]["y0"]) * rp._WORD_SIZE_K
    assert uni < med, "an unbreakable word still shrinks into its own slot"
    rendered = rp._line_width_at(font, ref, 1, long) * uni / ref
    assert rendered <= (190 - 100) + 1e-6, "the slot is the bound when there is no cell"


def test_word_sizes_skips_empty_and_missing_slots():
    font, ref = _cafe()
    slots = _slots([(10, 10, 190, 40), (10, 50, 190, 80), (10, 90, 190, 120)])
    sizes = rp._word_sizes(slots, ["מסיבה", ""], font, ref, cell=[5, 5, 195, 240])
    assert sizes[0] is not None
    assert sizes[1] is None  # blank word
    assert sizes[2] is None  # no word supplied for this slot


# --- 2b. wrapping a phrase that will not fit on one line ---------------------
# A customer "word" is often a phrase. Rendered as one line it ran left out of
# its slot, over the artwork and past the TRIM line, so the guillotine cut it in
# half. These pin the wrap that replaced that overflow.

# The real grapefruit geometry, which is where the amputation was measured: the
# card is 223.92 x 312 user units and its 2.495 mm bleed is 7.1 units, so any ink
# left of x=7.1 is cut off the printed card.
_GF_CELL = [0, 0, 223.92, 312.0]
_GF_TRIM = 7.1
_GF_SLOTS = _slots([(67.2, 111.0, 156.7, 124.1), (67.2, 139.1, 156.7, 155.2),
                    (67.2, 173.2, 156.7, 189.7), (67.2, 202.1, 156.7, 218.6)])
_GF_PHRASE = "להקת שבעת הכוכבים"


def _gf_layouts(font, ref, words):
    """Lay words out the way the v2 deck does: owner-declared column + bleed floor."""
    return rp._word_layouts(_GF_SLOTS, words, font, ref, cell=_GF_CELL,
                            declared_band=True, safe=rp._CARD_SAFE)


def _left_edge(font, ref, layout, num, right, advance=None):
    """Left-most ink x of a laid-out entry (its widest line runs furthest left)."""
    marker = rp._line_width_at(font, ref, num, "", advance=advance) * layout.size / ref
    widest = max(font.getlength(ln) for ln in layout.lines) * layout.size / ref
    return right - marker - widest


def _gf_advance(font):
    return rp._marker_advance(font, len(_GF_SLOTS))


def test_long_phrase_wraps_instead_of_overflowing():
    font, ref = _cafe()
    lay = _gf_layouts(font, ref, [_GF_PHRASE])[0]
    assert len(lay[1]) > 1, "a phrase too wide for its slot must wrap"
    assert " ".join(lay[1]).split() == _GF_PHRASE.split(), "wrapping must not lose words"


def test_wrapped_lines_stay_inside_the_widened_band():
    """The band is the DECLARED column widened to the house bound, not the cell."""
    font, ref = _cafe()
    lay = _gf_layouts(font, ref, [_GF_PHRASE])[0]
    right = rp._card_right_edge(_GF_SLOTS, _GF_CELL)
    left = rp._declared_left(_GF_SLOTS[0], _GF_CELL)
    assert _left_edge(font, ref, lay, 1, right, _gf_advance(font)) >= left - 1e-6


def test_no_word_can_reach_the_trim_edge():
    """The bug this fixes: the old 2%-of-cell bound sat INSIDE the bleed."""
    font, ref = _cafe()
    words = [_GF_PHRASE, "ביחד סביב השולחן", "אבגדהוזחטיכלמנסעפצקרשתאבגדהוז", "מדונה"]
    layouts = _gf_layouts(font, ref, words)
    right = rp._card_right_edge(_GF_SLOTS, _GF_CELL)
    for i, lay in enumerate(layouts):
        assert _left_edge(font, ref, lay, i + 1, right,
                          _gf_advance(font)) > _GF_TRIM, (
            f"word {i + 1} crosses the trim line and would be cut off")


# --- 2b-ii. breaking a word that has nowhere to wrap ------------------------
# The owner: a single over-long entry should not shrink the other three. So a
# word with no spaces BREAKS, and — her answer to the question we put to her —
# shows a hyphen at the break rather than splitting silently.

def test_an_unbreakable_word_breaks_rather_than_shrinking_the_whole_card():
    font, ref = _cafe()
    solid = "אבגדהוזחטיכלמנסעפצקרשתאבגדהוז"          # no spaces to wrap at
    lay = _gf_layouts(font, ref, [solid])[0]
    assert len(lay.lines) > 1, "a word too wide for the column must break"
    rejoined = "".join(ln[:-1] if ln.endswith(rp._BREAK_HYPHEN) else ln
                       for ln in lay.lines)
    assert rejoined == solid, "breaking must not lose or reorder a single letter"


def test_a_broken_word_shows_the_hyphen():
    """Her answer to the open question: a visible "-", not a silent split."""
    assert rp._BREAK_HYPHEN == "-"
    font, _ = _cafe()
    lines = rp._hard_split(font, "אבגדהוזחטיכלמנסעפצקרשתאבגדהוז", 2)
    assert len(lines) == 2
    assert lines[0].endswith("-"), f"the break must be marked — got {lines}"
    assert not lines[-1].endswith("-"), "the last line ends the word, not a break"


def test_a_silent_split_is_one_constant_away():
    """The hyphen is a single knob, so the choice can be revisited without code."""
    font, _ = _cafe()
    lines = rp._hard_split(font, "אבגדהוזחטיכלמנסעפצקרשתאבגדהוז", 2, hyphen="")
    assert len(lines) == 2 and not any(ln.endswith("-") for ln in lines)


def test_a_word_only_slightly_too_wide_shrinks_instead_of_breaking():
    """A break is visible on every printed card; 5% of type size is not. So a word
    that costs the card less than _BREAK_BELOW stays whole."""
    font, ref = _cafe()
    avail, word = 90.0, "אבגדהוזחט"
    whole = rp._candidates(font, ref, 1, word, avail)[1][2]
    assert list(rp._candidates(font, ref, 1, word, avail,
                               uniform=whole / 0.95)) == [1], \
        "must not break to buy 5% of type size"
    assert len(rp._candidates(font, ref, 1, word, avail,
                              uniform=whole / 0.5)) > 1, \
        "a word that halves the card's type must break"


def test_short_words_are_untouched_by_wrapping():
    font, ref = _cafe()
    words = ["מסיבה", "חברים", "ריקודים", "צחוקים"]
    layouts = _gf_layouts(font, ref, words)
    assert all(len(l[1]) == 1 for l in layouts), "words that fit must not wrap"
    sizes = [l[0] for l in layouts]
    assert max(sizes) - min(sizes) < 1e-9, "and must still share one uniform size"


def _entry_center(layout, slot):
    """Where a laid-out entry's block actually sits: its grid centre, or its slot
    centre when the layout carries none (the v1 sheet, and any undeclared card)."""
    if layout.center is not None:
        return layout.center
    return (slot["y0"] + slot["y1"]) / 2


def test_adjacent_wrapped_entries_do_not_collide():
    """Two neighbours that both wrap must still read as two separate items."""
    font, ref = _cafe()
    words = [_GF_PHRASE, "ביחד סביב השולחן גדול", "מדונה", "לקחת"]
    layouts = _gf_layouts(font, ref, words)
    centers = [_entry_center(l, s) for l, s in zip(layouts, _GF_SLOTS)]
    for a, b in zip(range(len(layouts)), range(1, len(layouts))):
        gap = (abs(centers[b] - centers[a])
               - rp._block_half(layouts[a]) - rp._block_half(layouts[b]))
        assert gap > 0, f"entries {a + 1} and {b + 1} overlap"


def test_wrapped_entry_numbers_itself_once_and_hangs_the_continuation():
    svg = rp.word_lines(190, 50, 20, "#6c4d56", 2, ["להקת שבעת", "הכוכבים"], CAFE)
    assert svg.count(">2</text>") == 1, "the marker belongs to the first line only"
    assert svg.count(">.</text>") == 1
    ys = [float(m) for m in re.findall(r'y="([0-9.]+)"', svg)]
    assert len(set(ys)) == 2, "the two lines sit on two baselines"
    xs = re.findall(r'<text x="([-0-9.]+)"[^>]*>‫(?:להקת שבעת|הכוכבים)‬</text>',
                    svg)
    assert len(set(xs)) == 1, "continuation hangs under the first line's text"


# --- 2c. base direction: a line that STARTS with digits ----------------------
# A <text> run states no base direction, so Chrome assumes LTR and orders the
# line by its first strong character. Hebrew-first words are right by luck;
# "40 מתחת" came out with the 40 on the LEFT, where a browser dir="rtl"
# paragraph in the same face puts it on the RIGHT. Wrapping exposed it:
# splitting "40 מתחת ל40" produces a line that begins with digits.

def _word_runs(svg):
    """The text of every WORD run — the two marker runs (digit, period) out."""
    runs = re.findall(r'<text [^>]*xml:space="preserve">([^<]*)</text>', svg)
    return runs[2:]


def test_a_line_starting_with_digits_carries_an_explicit_rtl_base():
    svg = rp.word_lines(190, 50, 20, "#6c4d56", 1, ["40 מתחת"], CAFE)
    assert "‫40 מתחת‬" in svg, (
        "without the embedding Chrome lays the line out LTR-first and the "
        "numeral lands on the wrong side")


def test_every_wrapped_line_is_embedded_on_its_own():
    """Each line is a separate <text>, so each needs its own base direction."""
    svg = rp.word_lines(190, 50, 20, "#6c4d56", 3, ["40 מתחת", "ל40"], CAFE)
    assert svg.count("‫") == svg.count("‬") == 2
    assert _word_runs(svg) == ["‫40 מתחת‬", "‫ל40‬"]


def test_a_pure_hebrew_line_keeps_its_text_intact():
    """The embedding is a no-op on lines that were already correct."""
    svg = rp.word_lines(190, 50, 20, "#6c4d56", 1, ["מסיבה"], CAFE)
    assert "‫מסיבה‬" in svg
    assert svg.count("‫") == 1


def test_the_marker_runs_are_never_embedded():
    """The digit is deliberately direction="ltr" and the period is its own run
    so bidi cannot reorder them; an RTL embedding there would undo that."""
    svg = rp.word_lines(190, 50, 20, "#6c4d56", 4, ["בת 40"], CAFE)
    assert ">4</text>" in svg and ">.</text>" in svg
    assert "‫4</text>" not in svg and "‫.</text>" not in svg


# --- 2d. the declared column is widened to the house bound -------------------
# A declared column is traced by eye around the ORIGIN card's short words, so its
# left edge is where those words stopped, not a box anyone drew. On the affected
# deck it was 0.448 of the card — 21.7 mm — inside a printed frame leaving
# 61.5 mm clear, so two-word entries wrapped with 27 mm standing empty. The owner
# chose 0.200 as the bound; _declared_left widens any column that starts right of
# it and leaves a wider one alone.

_BP_CELL = [0, 0, 223.92, 312.0]
_BP_SLOTS = _slots([(100.3, 112.1, 161.8, 123.4), (100.3, 140.3, 161.8, 152.6),
                    (100.3, 169.9, 161.8, 183.4), (100.3, 194.6, 161.8, 213.0)])


def test_a_traced_column_is_widened_to_the_house_bound():
    left = rp._declared_left(_BP_SLOTS[0], _BP_CELL)
    assert abs(left - 0.200 * 223.92) < 1e-9, "0.448 of the card must widen to 0.200"


def test_a_column_already_wider_than_the_bound_is_left_alone():
    wide = {"x0": 0.05 * 223.92, "y0": 0, "x1": 160.0, "y1": 10, "color": "#000"}
    assert rp._declared_left(wide, _BP_CELL) == wide["x0"]


def test_a_short_two_word_phrase_no_longer_wraps():
    """The reported card: 'סדנה שמית' and 'אפיה שמרי' wrapped with room to spare."""
    font, ref = _cafe()
    layouts = rp._word_layouts(_BP_SLOTS, ["סין", "מחבת", "סדנה שמית", "אפיה שמרי"],
                               font, ref, cell=_BP_CELL, declared_band=True,
                               safe=rp._CARD_SAFE)
    assert [len(l.lines) for l in layouts] == [1, 1, 1, 1]


def test_a_genuinely_long_phrase_still_wraps():
    font, ref = _cafe()
    layouts = _bp_layouts(font, ref, ["סין", "מחבת", "אהבה", _GF_PHRASE])
    assert len(layouts[3].lines) > 1, "a phrase wider than the whole band must wrap"


# --- 2e. one lead, one anchor, one digit column ------------------------------
# "the spaces between lines should be the same always" and "the numbers should be
# aligned": _lead_for answers per PAIR of lines (0.82..1.52 across these cards)
# and _marker_geometry measured each digit (Cafe sets "1" at 54 of a 200 em
# against "2" at 110), so one card could show two different line gaps and four
# different word starts.

def test_one_lead_for_every_wrapped_entry_on_a_card():
    font, ref = _cafe()
    layouts = _gf_layouts(font, ref, [_GF_PHRASE, "הבדיחה על הנסיעה לאילת",
                                      "ביחד סביב השולחן", "מדונה"])
    leads = {round(l.lead, 9) for l in layouts}
    assert len(leads) == 1, f"one card, one line gap — got {leads}"


def test_the_shared_lead_is_the_widest_pair_a_card_sets():
    """Uniform must mean the WIDEST need, never an average that collides.

    Driven straight at the solver: two entries that must both wrap, one needing
    a 1.50 pitch and one needing 0.85. The card has to use 1.50 for both.
    """
    cands = {0: {1: (["a"], 0.0, 5.0), 2: (["a", "b"], 1.50, 30.0)},
             1: {1: (["c"], 0.0, 5.0), 2: (["c", "d"], 0.85, 30.0)}}
    size, counts, lead = rp._fit_card(cands, {0: 200.0, 1: 200.0}, [50.0, 250.0], 20.0)
    assert counts == {0: 2, 1: 2}, "both entries must wrap for this fixture to mean anything"
    assert lead == 1.50


def test_every_word_on_a_card_starts_at_the_same_x():
    font, ref = _cafe()
    words = ["סין", "מחבת", "סדנה שמית", _GF_PHRASE]
    layouts = rp._word_layouts(_BP_SLOTS, words, font, ref, cell=_BP_CELL,
                               declared_band=True, safe=rp._CARD_SAFE)
    right = rp._card_right_edge(_BP_SLOTS, _BP_CELL)
    adv = rp._marker_advance(font, len(_BP_SLOTS))
    xs = set()
    for i, lay in enumerate(layouts):
        svg = rp.word_lines(right, 100, lay.size, "#000", i + 1, lay.lines, CAFE,
                            lead=lay.lead, marker_advance=adv)
        xs.update(re.findall(r'<text x="([-0-9.]+)"[^>]*>‫', svg))
    assert len(xs) == 1, f"four entries must share one word x — got {sorted(xs)}"


def _digit_ink_right(font, ref, svg, size):
    """Where the digit's INK right edge lands, from the emitted markup.

    The run is anchored by its ADVANCE, so the ink edge is the anchor less the
    glyph's right side bearing — which is the whole point of the alignment.
    """
    m = re.search(r'<text x="([-0-9.]+)"[^>]*direction="ltr"[^>]*>(\d)</text>', svg)
    x, digit = float(m.group(1)), m.group(2)
    return x - rp._glyph_bearings(font, ref, digit)[1] / ref * size


def test_the_digits_share_one_right_ink_edge():
    """Her instruction: "align by the right outer boundry of the number".

    #294 aligned the PERIODS (a side effect of centring each digit in a fixed
    column) and left the digits' own right edges 2.24 units apart.
    """
    font, ref = _cafe()
    adv = rp._marker_advance(font, 4)
    msize = 20 * rp._MARKER_SCALE
    edges = set()
    for num in (1, 2, 3, 4):
        svg = rp.word_lines(190, 50, 20, "#000", num, ["מסיבה"], CAFE,
                            marker_advance=adv)
        edges.add(_digit_ink_right(font, ref, svg, msize))
    # The markup writes x to two decimals, so the four edges agree to within that
    # rounding — 0.01 user units, a fortieth of a printed millimetre.
    assert max(edges) - min(edges) <= 0.01, (
        f"the digits' right edges must line up — got {sorted(edges)}")
    assert abs(max(edges) - 190) <= 0.01, "…on the line's own right edge"


def test_the_periods_are_no_longer_a_column():
    """The accepted trade: a proportional face cannot align both. The period hangs
    off its own digit's ink, so the dots move and the DIGITS line up instead."""
    font, _ = _cafe()
    adv = rp._marker_advance(font, 4)
    dots = {re.search(r'<text x="([-0-9.]+)"[^>]*>\.</text>',
                      rp.word_lines(190, 50, 20, "#000", num, ["מסיבה"], CAFE,
                                    marker_advance=adv)).group(1)
            for num in (1, 2, 3, 4)}
    assert len(dots) > 1, "the dots follow the digits now"


def test_without_a_fixed_advance_the_marker_is_measured_as_before():
    """The v1 sheet passes no advance, so its markup must not move a hair."""
    svg = rp.word_lines(190, 50, 20, "#6c4d56", 1, ["מסיבה"], CAFE)
    assert '<text x="190.00"' in svg, "the digit stays pinned to the line's right edge"


def test_a_leading_numeral_does_not_take_the_next_word_with_it():
    """The real customer entry "40 מתחת ל40". Width alone splits it
    "40 מתחת" / "ל40" — two figures at opposite ends of two lines."""
    font, _ = _cafe()
    assert rp._balanced_split(font, "40 מתחת ל40", 2) == ["40", "מתחת ל40"]


def test_a_numeral_inside_a_phrase_is_left_to_the_width_rule():
    """The rule is narrow on purpose: only a phrase that STARTS with a numeral."""
    font, _ = _cafe()
    lines = rp._balanced_split(font, "מסיבה 40 שנים", 2)
    assert not rp._strands_a_leading_numeral(lines)
    assert " ".join(lines).split() == ["מסיבה", "40", "שנים"]


def test_one_right_anchor_for_a_card_whose_slots_disagree():
    """Detected boxes differ by 2.24 units on the affected deck — 0.8 mm of
    ragged digits. The widest edge is the column's real position."""
    slots = _slots([(100, 10, 159.6, 20), (100, 30, 161.8, 40),
                    (100, 50, 160.7, 60), (100, 70, 161.1, 80)])
    assert rp._card_right_edge(slots, _BP_CELL) == 161.8


def test_detected_slots_are_not_treated_as_a_text_column():
    """The v1 sheet path must be untouched by wrapping.

    Its slots come from auto-detection, so a box is the ink extent of the ORIGIN
    word — narrow, because the origin words were short. Treating that as a text
    column wrapped phrases with room to spare and shrank them to a third of the
    size around them, changing all eight live sheet themes.
    """
    font, ref = _cafe()
    layouts = rp._word_layouts(_GF_SLOTS, [_GF_PHRASE], font, ref, cell=_GF_CELL)
    assert len(layouts[0][1]) == 1, "a detected slot is not a column; do not wrap to it"


def test_one_font_size_per_card_however_uneven_the_words():
    """Every word on a card renders at the SAME size — the origin's look.

    A card must not mix a large short word with a small long one, so the card's
    size is set by its most demanding entry and the rest follow it down.
    """
    font, ref = _cafe()
    layouts = _gf_layouts(font, ref, ["ים", _GF_PHRASE, "הבדיחה על הנסיעה לאילת", "קפה"])
    sizes = {round(l.size, 9) for l in layouts}
    assert len(sizes) == 1, f"one card, one size — got {sizes}"


def test_wrapping_is_only_taken_when_it_buys_size():
    """Ties go to the fewest lines: wrapping is a cost, not a goal."""
    font, ref = _cafe()
    layouts = _gf_layouts(font, ref, ["ים", "קפה", "שירה", "מדונה"])
    assert all(len(l.lines) == 1 for l in layouts)


def test_line_pitch_is_measured_from_the_glyphs_being_set():
    """A fixed lead collided: Cafe draws far outside its em, and by wildly
    differing amounts. Lines that clash need more pitch than lines that don't."""
    font, ref = _cafe()
    clash = rp._lead_for(font, ref, ["הטיול", "לתאילנד"])   # descender over ascender
    calm = rp._lead_for(font, ref, ["ים", "ים"])            # neither
    assert clash > calm, "the pitch must respond to the actual glyphs"
    assert calm > 0


def test_wrapped_lines_ink_never_overlaps():
    """The reported bug: the ל of a continuation struck the line above it."""
    font, ref = _cafe()
    for pair in (["הטיול", "לתאילנד"], ["צוחקת על", "הבדיחות שלה"],
                 ["לקחת", "לקחת"], ["ים", "מדונה"]):
        lead = rp._lead_for(font, ref, pair)
        # Upper line's lowest ink vs lower line's highest, once the baseline has
        # advanced by the lead. Both are measured in the same ref units.
        drop = font.getbbox(pair[0])[3] - font.getbbox(pair[1])[1]
        assert lead * ref >= drop, f"{pair} would collide"


def test_word_text_still_places_a_single_line_on_its_baseline():
    """word_text takes a BASELINE; word_lines takes a block CENTRE."""
    a = rp.word_text(190, 50, 20, "#6c4d56", 1, "מסיבה", CAFE)
    b = rp.word_lines(190, 50 - 20 * 0.34, 20, "#6c4d56", 1, ["מסיבה"], CAFE)
    assert a == b


# --- 2f. ONE gap for every pair of lines on a card ---------------------------
# "the spaces between lines should be the same always!!!" — and, said again on a
# second card, "spacing between different words and spacing between different
# words in the same word when going new line", i.e. ONE value covering both kinds
# of gap. #294 equalised the gaps INSIDE a wrapped entry only; these pin the whole
# card.
#
# The two cards she sent, from the uploaded "Bride in One Pot" deck:
#
#     1. מונדיאל          1. אורגניה
#     2. דובונים          2. מוסיקה
#     3. שיר השירים       3. אוסייתי
#     4. הפועל            4. ארצות
#        תל אביב             הברית
#
# Reproduced against that deck's own traced column (0.448 of the card, the
# calibration those renders were made with — #294 widened the house bound to
# 0.200 afterwards, which is why the same phrases no longer wrap at today's
# band). The layout bug is independent of the band: it shows on any card where
# anything wraps, and — through the slot wobble below — on cards where nothing
# does.

_TRACED_COLUMN = 0.448
_CARD_HAPOEL = ["מונדיאל", "דובונים", "שיר השירים", "הפועל תל אביב"]
_CARD_ARZOT = ["אורגניה", "מוסיקה", "אוסייתי", "ארצות הברית"]


# The room a real card of this size has below its last calibrated line. The
# affected deck is an owner upload and not in this repo, so grapefruit's own
# printed frame — same 223.92 x 312 card — stands in for it: interior bottom
# 287.87, less the reserved bottom margin.
_BP_FRAME_BOTTOM = 287.87


def _bp_room():
    return _BP_FRAME_BOTTOM - rp._BOTTOM_RESERVE_MM * rp._PT_PER_MM


def _bp_layouts(font, ref, words, band=None, slots=None, room=-1):
    """Lay a card out the way the affected deck does, at a given column bound.

    ``room`` defaults to the card's real one (the production path); pass None for
    the legacy no-artwork path.
    """
    saved = rp._BAND_LEFT_MAX
    if band is not None:
        rp._BAND_LEFT_MAX = band
    try:
        return rp._word_layouts(slots or _BP_SLOTS, words, font, ref, cell=_BP_CELL,
                                declared_band=True, safe=rp._CARD_SAFE,
                                room_bottom=_bp_room() if room == -1 else room)
    finally:
        rp._BAND_LEFT_MAX = saved


def _line_centers(layouts, slots):
    """Every PRINTED line's centre, down the card — entries and continuations
    alike. This is the sequence the owner's rule is about."""
    out = []
    for lay, slot in zip(layouts, slots):
        if lay is None:
            continue
        pitch = lay.lead * lay.size
        first = _entry_center(lay, slot) - (len(lay.lines) - 1) * pitch / 2
        out.extend(first + k * pitch for k in range(len(lay.lines)))
    return out


def _line_gaps(layouts, slots):
    cs = _line_centers(layouts, slots)
    return [b - a for a, b in zip(cs, cs[1:])]


def _assert_one_gap(layouts, slots, what):
    gaps = _line_gaps(layouts, slots)
    assert len(gaps) >= 2, f"{what}: needs at least three lines to compare gaps"
    assert max(gaps) - min(gaps) < 1e-9, (
        f"{what}: the gaps down the card must all be the same — got "
        f"{[round(g, 2) for g in gaps]}")


def test_the_reported_card_wraps_its_last_entry():
    """Sanity: without the wrap there is no bug to fix.

    WHICH lines it wraps ONTO is not the property — that is the fit's answer and
    it moves with the pitch. Once the row pitch is read column by column
    (``_card_lead``) this card is no longer height-bound but WIDTH-bound, and a
    third line, being shorter, lets the whole card set 3% larger; the standing
    rule is that wrapping is a cost paid to keep the type big. It only arises at
    all on the ORIGIN's traced column (0.448 of the card) that this fixture pins:
    at the house bound production actually uses, nothing here wraps at all.
    """
    font, ref = _cafe()
    layouts = _bp_layouts(font, ref, _CARD_HAPOEL, band=_TRACED_COLUMN)
    assert len(layouts[3].lines) > 1, layouts[3].lines
    assert "".join(layouts[3].lines).replace(" ", "") == "הפועלתלאביב"
    assert sum(len(l.lines) for l in layouts) > len(layouts), "something must wrap"


def test_centring_each_entry_on_its_own_slot_is_what_made_the_gaps_uneven():
    """The bug, reproduced from the SAME layout: a wrapped entry centred on its
    slot grows BOTH ways, so its first line rises into the gap above it."""
    font, ref = _cafe()
    layouts = _bp_layouts(font, ref, _CARD_HAPOEL, band=_TRACED_COLUMN)
    slot_centers = [(s["y0"] + s["y1"]) / 2 for s in _BP_SLOTS]
    cs = []
    for i, lay in enumerate(layouts):
        pitch = lay.lead * lay.size
        first = slot_centers[i] - (len(lay.lines) - 1) * pitch / 2
        cs.extend(first + k * pitch for k in range(len(lay.lines)))
    gaps = [b - a for a, b in zip(cs, cs[1:])]
    assert max(gaps) - min(gaps) > 3, (
        "the old placement must still measure as uneven, or this fixture has "
        f"stopped reproducing the report — got {[round(g, 2) for g in gaps]}")


def test_the_hapoel_card_has_one_gap_everywhere():
    font, ref = _cafe()
    _assert_one_gap(_bp_layouts(font, ref, _CARD_HAPOEL, band=_TRACED_COLUMN),
                    _BP_SLOTS, "הפועל / תל אביב")


def test_the_arzot_habrit_card_has_one_gap_everywhere():
    """Her second card, where the continuation gap was the TIGHTEST of the three
    kinds and the gap into the wrapped entry the second tightest."""
    font, ref = _cafe()
    _assert_one_gap(_bp_layouts(font, ref, _CARD_ARZOT, band=_TRACED_COLUMN),
                    _BP_SLOTS, "ארצות / הברית")


def test_every_shape_of_card_has_one_gap_everywhere():
    """The five shapes a card can take, including the two the models disagree on:
    a MIDDLE entry wrapping, and an entry wrapping to three lines."""
    font, ref = _cafe()
    cases = {
        "nothing wraps": ["מונדיאל", "דובונים", "אוסייתי", "מדונה"],
        "entry 4 wraps": _CARD_HAPOEL,
        "entry 2 wraps": ["מונדיאל", "הפועל תל אביב", "שיר השירים", "מדונה"],
        "two entries wrap": ["מונדיאל", "הפועל תל אביב", "שיר השירים", "ארצות הברית"],
        "an entry wraps to three": ["מונדיאל", "דובונים", "שיר השירים",
                                    "להקת שבעת הכוכבים הגדולה של אילת"],
    }
    for what, words in cases.items():
        _assert_one_gap(_bp_layouts(font, ref, words, band=_TRACED_COLUMN),
                        _BP_SLOTS, what)


def test_an_entry_can_still_wrap_to_three_lines_on_one_pitch():
    font, ref = _cafe()
    layouts = _bp_layouts(font, ref, ["מונדיאל", "דובונים", "שיר השירים",
                                      "להקת שבעת הכוכבים הגדולה של אילת"],
                          band=_TRACED_COLUMN)
    assert len(layouts[3].lines) == 3, "this fixture must exercise a 3-line entry"
    _assert_one_gap(layouts, _BP_SLOTS, "three-line entry")


def test_the_gap_inside_an_entry_equals_the_gap_between_entries():
    """Her rule, stated directly: the two kinds of gap are ONE number."""
    font, ref = _cafe()
    layouts = _bp_layouts(font, ref, _CARD_ARZOT, band=_TRACED_COLUMN)
    gaps = _line_gaps(layouts, _BP_SLOTS)
    between = gaps[0]                      # entry 1 -> entry 2
    inside = gaps[3]                       # ארצות -> הברית, one entry
    assert abs(between - inside) < 1e-9, f"{between} vs {inside}"


def test_a_card_that_never_wraps_loses_the_slot_wobble_too():
    """The second cause. The four recorded boxes are the ink extents of four
    DIFFERENT origin words, so their centres are 28.70 / 30.20 / 27.15 apart —
    a 3-unit (1.1 mm) wobble on a card where nothing wraps at all."""
    font, ref = _cafe()
    centers = [(s["y0"] + s["y1"]) / 2 for s in _BP_SLOTS]
    raw = [b - a for a, b in zip(centers, centers[1:])]
    assert max(raw) - min(raw) > 2, "this deck's slots must actually be uneven"
    layouts = _bp_layouts(font, ref, ["מונדיאל", "דובונים", "אוסייתי", "מדונה"])
    assert [len(l.lines) for l in layouts] == [1, 1, 1, 1]
    _assert_one_gap(layouts, _BP_SLOTS, "no wrapping at all")


def test_the_grid_is_pinned_to_the_first_calibrated_line_and_grows_downward():
    """The room below the last line is what a wrapped card reaches into, so the
    block grows DOWN. The space above the first line belongs to the title, so the
    first line never moves."""
    font, ref = _cafe()
    centers = [(s["y0"] + s["y1"]) / 2 for s in _BP_SLOTS]
    for words in (["מונדיאל", "דובונים", "אוסייתי", "מדונה"], _CARD_HAPOEL,
                  ["מונדיאל", "הפועל תל אביב", "שיר השירים", "ארצות הברית"]):
        layouts = _bp_layouts(font, ref, words, band=_TRACED_COLUMN)
        cs = _line_centers(layouts, _BP_SLOTS)
        assert abs(cs[0] - centers[0]) < 1e-9, "the first line must stay put"
        assert cs[-1] >= centers[-1] - 1e-9, "and the block may only grow downward"
        below = rp._ink_reach(font, ref, layouts[-1].lines[-1])[1]
        assert cs[-1] + below * layouts[-1].size <= _bp_room() + 1e-9, (
            "…never past the reserved bottom margin")


def test_the_uniform_pitch_clears_the_worst_pair_on_the_card():
    """Uniform must mean the WIDEST need — measured over the card's whole line
    sequence, so a gap that straddles two entries is held to the same clearance
    as a gap inside one. Cafe sets 'לקחת' 1.45x its font size tall, which is why
    the pitch is measured rather than assumed."""
    font, ref = _cafe()
    for words in (_CARD_HAPOEL, _CARD_ARZOT,
                  ["לקחת", "הטיול", "לתאילנד ובחזרה", "ים"]):
        layouts = _bp_layouts(font, ref, words, band=_TRACED_COLUMN)
        flat = [ln for l in layouts if l is not None for ln in l.lines]
        pitch = layouts[0].lead * layouts[0].size
        for upper, lower in zip(flat, flat[1:]):
            drop = (font.getbbox(upper)[3] - font.getbbox(lower)[1]) / ref
            assert pitch >= drop * layouts[0].size - 1e-9, (
                f"{upper!r} over {lower!r} would collide at pitch {pitch:.2f}")


def test_no_line_on_a_gridded_card_crosses_the_trim():
    """Grapefruit's 2.495 mm bleed is 7.1 units: ink outside the safe area is cut
    off the printed card. The grid's own ink, top and bottom, must stay inside."""
    font, ref = _cafe()
    top = _BP_CELL[1] + (_BP_CELL[3] - _BP_CELL[1]) * rp._CARD_SAFE
    bottom = _BP_CELL[3] - (_BP_CELL[3] - _BP_CELL[1]) * rp._CARD_SAFE
    for words in (_CARD_HAPOEL, _CARD_ARZOT,
                  ["מונדיאל", "דובונים", "שיר השירים",
                   "להקת שבעת הכוכבים הגדולה של אילת"],
                  ["", "", "להקת שבעת הכוכבים הגדולה של אילת", ""]):
        layouts = _bp_layouts(font, ref, words, band=_TRACED_COLUMN)
        live = [l for l in layouts if l is not None]
        cs = _line_centers(layouts, _BP_SLOTS)
        flat = [ln for l in live for ln in l.lines]
        size = live[0].size
        above = rp._ink_reach(font, ref, flat[0])[0] * size
        below = rp._ink_reach(font, ref, flat[-1])[1] * size
        assert cs[0] - above >= top - 1e-9, f"{words}: the first line runs off the top"
        assert cs[-1] + below <= bottom + 1e-9, f"{words}: the last line is cut off"


# --- 2g. the room the card actually has -------------------------------------
# #295 treated the calibrated span (first slot centre to last) as a hard envelope
# and justified it as "growing past it puts ink where the origin never had text".
# The artwork says otherwise: grapefruit's printed frame leaves ~77 units of clear
# paper below the last slot centre, and squeezing the pitch to avoid it dropped
# the type from 21.3 to 16.3. These pin the frame scan, the room it opens, and the
# margin the owner asked to keep clear at the bottom of it.

_GF_CLEAN_2 = os.path.join(
    config.REPO, "resources", "canva", "templates", "grapefruit", "clean", "2.svg")


def _gf_clean():
    return open(_GF_CLEAN_2, encoding="utf-8").read()


def test_the_printed_frame_is_scanned_off_the_real_artwork():
    """Not hardcoded: an owner-uploaded template must be measured the same way.

    Cross-checked against a 200-dpi render of this same clean card, which inks the
    bottom stroke from y=288.0 — the scan must land on or just inside that.
    """
    box = rp.frame_box(_gf_clean(), [0, 0, 223.92, 312.0])
    assert box is not None, "grapefruit draws a frame; the scan must find it"
    assert 285.0 < box[3] <= 288.5, f"frame interior bottom looks wrong: {box}"
    assert 20.0 < box[1] < 27.0 and 20.0 < box[0] < 30.0


def test_the_frame_scan_follows_a_transform():
    """Grapefruit's border is a path in its own coordinates under a matrix(); read
    without the transform it would report the frame at 0,0."""
    svg = ('<svg viewBox="0 0 100 200"><path fill="none" stroke="#000" '
           'stroke-width="0" transform="matrix(0.5, 0, 0, 0.5, 10, 20)" '
           'd="M 0 0 L 160 0 L 160 320 L 0 320 Z"/></svg>')
    assert rp.frame_box(svg, [0, 0, 100, 200]) == [10, 20, 90, 180]


def test_a_filled_shape_is_not_a_frame():
    """A frame is a STROKE. The full-bleed background is a filled rect the same
    size as the card, and reading it as the frame would licence ink to the edge."""
    svg = ('<svg viewBox="0 0 100 200"><rect fill="#fff" x="5" y="5" '
           'width="90" height="190"/></svg>')
    assert rp.frame_box(svg, [0, 0, 100, 200]) is None


def test_a_card_with_no_frame_falls_back_to_the_safe_area_less_the_margin():
    """Stated in the code and here: a full-bleed design has no border to stay off,
    only the guillotine — so the trim-safe bound carries the reserve instead."""
    cell = [0, 0, 223.92, 312.0]
    safe = cell[3] - (cell[3] - cell[1]) * rp._CARD_SAFE
    got = rp.room_bottom("no-such-theme", 1, "<svg viewBox='0 0 224 312'></svg>",
                         cell, safe)
    assert abs(got - (safe - rp._BOTTOM_RESERVE_MM * rp._PT_PER_MM)) < 1e-9


def test_the_free_room_below_the_last_line_is_real():
    """The measurement that makes the old envelope indefensible."""
    box = rp.frame_box(_gf_clean(), [0, 0, 223.92, 312.0])
    last_slot_center = (_BP_SLOTS[-1]["y0"] + _BP_SLOTS[-1]["y1"]) / 2
    span = last_slot_center - (_BP_SLOTS[0]["y0"] + _BP_SLOTS[0]["y1"]) / 2
    free = box[3] - last_slot_center
    assert free > 70, f"only {free:.1f} units free below the last line?"
    assert free > 0.8 * span, (
        "the empty paper below the words is comparable to the whole height they "
        f"were allowed ({free:.1f} against {span:.1f})")


def test_the_extra_room_is_what_keeps_the_type_at_full_size():
    """Her card, with and without the room: the same words, the same wrap, and a
    tenth of the type size riding on which envelope is used.

    It used to be a third. The room did not shrink — the OTHER thing squeezing a
    wrapped card got smaller: the line pitch now reserves what this card's own
    glyphs need instead of the worst case over every glyph a card could ever
    print, so the penned card recovered most of the height it was spending on
    leading and the two envelopes moved closer together. The room still matters,
    and this pins that it does; what it no longer has to do is compensate for a
    pitch that was too wide in the first place."""
    font, ref = _cafe()
    penned = _bp_layouts(font, ref, _CARD_HAPOEL, band=_TRACED_COLUMN, room=None)
    roomy = _bp_layouts(font, ref, _CARD_HAPOEL, band=_TRACED_COLUMN)
    assert roomy[0].size > penned[0].size * 1.10, (
        f"{penned[0].size:.2f} -> {roomy[0].size:.2f}")


def test_the_reserved_bottom_margin_is_kept_clear():
    """Her words: "i want to get some empty space from the bottom that the word
    wont get to there (in this case the font will be smaller)". Measured from the
    last line's INK — a descender must not eat the margin."""
    font, ref = _cafe()
    words = ["מונדיאל", "הפועל תל אביב", "שיר השירים", "ארצות הברית"]
    saved = rp._BOTTOM_RESERVE_MM
    try:
        sizes = {}
        for mm in (0, 10):
            rp._BOTTOM_RESERVE_MM = mm
            layouts = _bp_layouts(font, ref, words, band=_TRACED_COLUMN)
            cs = _line_centers(layouts, _BP_SLOTS)
            live = [l for l in layouts if l is not None]
            last = live[-1].lines[-1]
            ink = cs[-1] + rp._ink_reach(font, ref, last)[1] * live[0].size
            assert ink <= _BP_FRAME_BOTTOM - mm * rp._PT_PER_MM + 1e-9, (
                f"{mm}mm reserve: ink reaches {ink:.2f}")
            sizes[mm] = live[0].size
        assert sizes[10] < sizes[0], (
            "reserving 10 mm has to cost type size, or it is not being applied — "
            f"{sizes}")
    finally:
        rp._BOTTOM_RESERVE_MM = saved


def test_the_bottom_margin_is_stated_in_millimetres():
    """It is a printed distance, so it is set as one — and the card's user units
    are points throughout this pipeline (deck_html sets the PDF page box in pt)."""
    assert abs(rp._PT_PER_MM - 72.0 / 25.4) < 1e-12
    assert 0 <= rp._BOTTOM_RESERVE_MM <= 20


def test_the_shipped_margin_is_the_eight_millimetres_the_owner_chose():
    """The default is a DECISION, not a tuning constant, so it is pinned.

    She picked 8 mm off the 0/4/8/12 proof with the cost in front of her: on her
    own wrapped card it takes the type from 21.12 to 19.61, and her second card
    stops wrapping at this margin so the two set at different sizes. Anything
    that quietly walks this back to 4 is undoing her call, not fixing a bug."""
    assert rp._BOTTOM_RESERVE_MM == 8


def test_the_shipped_margin_actually_clears_eight_millimetres_of_ink():
    """The default is only worth pinning if it delivers: her wrapped card's last
    line — descenders and all — must stop a full 8 mm above the frame."""
    font, ref = _cafe()
    layouts = _bp_layouts(font, ref, _CARD_HAPOEL, band=_TRACED_COLUMN)
    live = [l for l in layouts if l is not None]
    ink = (_line_centers(layouts, _BP_SLOTS)[-1]
           + rp._ink_reach(font, ref, live[-1].lines[-1])[1] * live[0].size)
    clear_mm = (_BP_FRAME_BOTTOM - ink) / rp._PT_PER_MM
    assert clear_mm >= 8.0 - 1e-6, f"only {clear_mm:.2f} mm clear at the foot"


# --- 2h. ONE line gap per FONT, not per card --------------------------------
# "i want a fixed gap between lines (the minimum gap (that obey the rule that no 2
# letters touch each other) between the most descent letter (above) and the most
# ascent letter (bottom)) ... this gap should be applied between all lines, same
# phrase or also totally different words."

_BP_FLOOR_PITCH = (((_BP_SLOTS[-1]["y0"] + _BP_SLOTS[-1]["y1"]) / 2
                    - (_BP_SLOTS[0]["y0"] + _BP_SLOTS[0]["y1"]) / 2)
                   / (len(_BP_SLOTS) - 1))


def test_the_line_gap_clears_every_glyph_this_card_actually_sets():
    """The rule is that no two letters touch, and the letters that can touch are
    the ones ON THE CARD. So the pitch carries the deepest ink any of the card's
    own lines puts below its baseline plus the highest any of them puts above it,
    and never less — whatever the card says.

    It used to reserve that worst case over an ABSTRACT repertoire of every glyph
    a card could ever print. That is a different and much larger number, because
    the repertoire's deepest descender and its tallest ascender are rarely on the
    same card: 15% larger on Cafe, 25% on Comix, 40% on FtPilKahol, 52% on Asakim.
    Every one of those percent was spent on line pitch and then taken back out of
    the type size, which is exactly the "type too small, leading too airy, and the
    two cancel" the originals were measured against."""
    font, ref = _cafe()
    for words in (_CARD_HAPOEL, _CARD_ARZOT,
                  ["ים", "ים", "ים", "ים"],            # nothing descends or rises
                  ["לקחת", "לקחת", "לקחת", "לקחת"]):   # both, at their extremes
        layouts = _bp_layouts(font, ref, words, band=_TRACED_COLUMN)
        live = [l for l in layouts if l is not None]
        size = live[0].size
        pitch = live[0].lead * size
        flat = [ln for l in live for ln in l.lines]
        need = rp._card_lead(font, ref, flat) * size
        want = max(_BP_FLOOR_PITCH, need)
        ink = (_line_centers(layouts, _BP_SLOTS)[-1]
               + rp._ink_reach(font, ref, live[-1].lines[-1])[1] * size)
        assert pitch >= need - 1e-9, (
            f"{words}: this card's own glyphs need {need} and got {pitch}")
        assert pitch <= want + 1e-9, (
            f"{words}: nothing may spread the lines past the origin's own "
            f"spacing — {pitch} > {want}")
        if abs(pitch - want) > 1e-9:
            # The only thing allowed to pull the pitch below the floor is the
            # room, and then the block must be sitting ON the room's bottom —
            # not merely somewhere under it.
            assert abs(ink - _bp_room()) < 1e-6, (
                f"{words}: pitch {pitch} is below the floor {want} without the "
                f"room being the reason — ink {ink}, room {_bp_room()}")
        else:
            assert ink <= _bp_room() + 1e-6, f"{words}: ink {ink} past the room"


def test_the_cards_own_gap_is_tighter_than_the_whole_repertoires():
    """The saving is the point of the change, so it is pinned rather than
    assumed: a real Hebrew card must need materially less than the repertoire."""
    font, ref = _cafe()
    card = rp._card_lead(font, ref, _CARD_HAPOEL)
    assert card < rp._font_lead(font, ref), (card, rp._font_lead(font, ref))


def test_one_gap_is_used_for_every_line_of_a_card():
    """The owner's rule — "applied between all lines" — so the reading is the
    worst of the card's stacked pairs and every gap on the card is that one
    number, not each pair's own."""
    font, ref = _cafe()
    words = ["ים", "לקחת", "ךףץ", "מסיבה"]
    lead = rp._card_lead(font, ref, words, count=4)
    pairs = [rp._card_lead(font, ref, [a, b], count=4)
             for a, b in zip(words, words[1:])]
    assert lead == max(pairs), (lead, pairs)
    assert max(pairs) > min(pairs), "the fixture must have pairs that disagree"


def test_no_two_lines_of_a_card_can_touch_at_the_pitch_it_is_given():
    """The owner's rule, checked on the GLYPHS: for every card, every pair of
    lines that end up adjacent, the upper line's lowest ink must stop above the
    lower line's highest ink — with clear air between them, not merely equal.

    Checked over cards chosen to be adversarial (a deep final letter set against
    a tall lamed, and a card that wraps), because the whole risk of tightening the
    pitch is that some pairing collides."""
    font, ref = _cafe()
    cards = [_CARD_HAPOEL, _CARD_ARZOT,
             ["לקחת", "ךףץ", "לקחת", "ךףץ"],
             ["ךףץ", "לקחת", "ךףץ", "לקחת"],
             ["להקת שבעת הכוכבים", "ים", "לקחת", "ךףץ"]]
    for words in cards:
        layouts = _bp_layouts(font, ref, words, band=_TRACED_COLUMN)
        live = [l for l in layouts if l is not None]
        size = live[0].size
        centers = _line_centers(layouts, _BP_SLOTS)
        flat = [ln for l in live for ln in l.lines]
        assert len(centers) == len(flat), (words, len(centers), len(flat))
        asc, _desc = font.getmetrics()
        for i in range(len(flat) - 1):
            # Where each line's ink actually reaches, in card units, using the
            # same centre-to-baseline convention word_lines draws with.
            upper_bottom = (centers[i]
                            + rp._ink_reach(font, ref, flat[i])[1] * size)
            lower_top = (centers[i + 1]
                         - rp._ink_reach(font, ref, flat[i + 1])[0] * size)
            assert upper_bottom < lower_top, (
                f"{words}: line {i} ink reaches {upper_bottom:.3f} and line "
                f"{i + 1} starts at {lower_top:.3f} — they touch")


def test_two_cards_that_set_at_one_size_show_one_gap():
    """The owner's complaint, stated as a test: her two cards side by side."""
    font, ref = _cafe()
    a, b = (_bp_layouts(font, ref, w) for w in (_CARD_HAPOEL, _CARD_ARZOT))
    assert abs(a[0].size - b[0].size) < 1e-9, "this fixture needs one size"
    assert abs(a[0].lead * a[0].size - b[0].lead * b[0].size) < 1e-9


def test_the_font_gap_clears_the_deepest_descender_over_the_tallest_ascender():
    """Cafe runs from y=0 to y=333 of a 200 em across the repertoire, so any two
    lines set at this pitch clear each other whatever letters they carry."""
    font, ref = _cafe()
    lead = rp._font_lead(font, ref)
    worst = 0.0
    for upper in ("ך", "g", "ץ", "לקחת"):
        for lower in ("ל", "h", "אבג"):
            worst = max(worst, (font.getbbox(upper)[3]
                                - font.getbbox(lower)[1]) / ref)
    assert lead >= worst, f"{lead} does not clear {worst}"
    assert lead >= worst + rp._WRAP_GAP - 1e-9, "…with clear air to spare"


def test_a_tighter_face_is_not_spread_by_the_rule():
    """The floor is the FONT's need, so a face that does not draw outside its em
    keeps the origin's own spacing: only Cafe-class faces move."""
    font, ref = _cafe()
    tight = ImageFont.truetype(
        os.path.join(HERE, "word-fonts", "almoni-neue-aaa-bold-OFFICE.ttf"), 200)
    assert rp._font_lead(tight, ref) < rp._font_lead(font, ref) * 0.6


def test_a_lone_entry_still_sits_on_its_own_slot():
    """With one live slot there is no span to divide, so the block is centred on
    that slot and the pitch falls back to what the glyphs need."""
    font, ref = _cafe()
    layouts = _bp_layouts(font, ref, ["", "להקת שבעת הכוכבים", "", ""],
                          band=_TRACED_COLUMN)
    assert [l is None for l in layouts] == [True, False, True, True]
    slot = _BP_SLOTS[1]
    assert abs(layouts[1].center - (slot["y0"] + slot["y1"]) / 2) < 1e-9


def test_one_font_size_survives_the_grid():
    """#289 must not regress: one size per card, however the lines fall."""
    font, ref = _cafe()
    for words in (_CARD_HAPOEL, _CARD_ARZOT,
                  ["ים", _GF_PHRASE, "הבדיחה על הנסיעה לאילת", "קפה"]):
        layouts = _bp_layouts(font, ref, words, band=_TRACED_COLUMN)
        sizes = {round(l.size, 9) for l in layouts if l is not None}
        assert len(sizes) == 1, f"one card, one size — got {sizes}"


def test_the_v1_sheet_gets_no_grid_at_all():
    """An undeclared card keeps its per-slot placement, so the eight live sheet
    themes render exactly as they did. Verified byte for byte against
    origin/main by rendering a bachelorette 8-up on both."""
    font, ref = _cafe()
    layouts = rp._word_layouts(_GF_SLOTS, ["מסיבה", "חברים", "ריקודים", "צחוקים"],
                               font, ref, cell=_GF_CELL)
    assert all(l.center is None for l in layouts), (
        "a detected card must carry no grid centre, so the renderer falls back "
        "to the slot centre it has always used")


def test_the_rendered_lines_land_on_the_grid_centre_it_was_given():
    """The centre the layout computes is the centre the markup uses."""
    layout_center, size, lead = 150.0, 20.0, 1.4
    svg = rp.word_lines(190, layout_center, size, "#000", 4, ["ארצות", "הברית"],
                        CAFE, lead=lead)
    ys = [float(y) for y in re.findall(r'<text x="[-0-9.]+" y="([-0-9.]+)"[^>]*>‫',
                                       svg)]
    assert len(ys) == 2
    assert abs((ys[0] + ys[1]) / 2 - (layout_center + size * rp._CENTER_DROP)) < 0.01
    assert abs((ys[1] - ys[0]) - lead * size) < 0.01


# --- 3. Latin-digit numbering ------------------------------------------------

def test_word_text_marker_is_a_latin_digit_and_period():
    for num in (1, 2, 3, 4):
        svg = rp.word_text(190, 50, 20, "#6c4d56", num, "מסיבה", CAFE)
        assert f">{num}</text>" in svg, "marker digit must be the Latin numeral"
        assert ">.</text>" in svg, "marker must include a period run"
        assert "מסיבה" in svg


def test_word_text_has_no_hebrew_letter_numerals():
    svg = rp.word_text(190, 50, 20, "#6c4d56", 6, "מסיבה", CAFE)
    # Hebrew gematria numbering would render the 6th item as the letter "ו";
    # the marker must be the digit 6, not a Hebrew letter standing in for it.
    assert ">6</text>" in svg


# --- 4. title fits its calibrated box height ---------------------------------

def _rendered_title_stack_units(font_path, lines, size):
    f = ImageFont.truetype(font_path, 200)
    asc, _desc = f.getmetrics()
    ink_above = asc - f.getbbox(lines[0])[1]
    ink_below = f.getbbox(lines[-1])[3] - asc
    stack_ref = ink_above + 0.78 * 200 * (len(lines) - 1) + ink_below
    return stack_ref / 200 * size


def _title_size(svg):
    return float(re.search(r'font-size="([0-9.]+)"', svg).group(1))


def test_title_fits_box_height_for_tall_glyph_display_font():
    # The japanese title face draws glyphs much taller than its em; a 2-line
    # stacked title must still fit inside its (short) calibrated box.
    cfg = config.theme("japanese")
    fp = config.font_path("japanese", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 15.0, "y0": 10.0, "x1": 195.0, "y1": 66.0}
    lines = ["YUKI'S", "30S"]
    svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    size = _title_size(svg)
    stack = _rendered_title_stack_units(fp, lines, size)
    bh = box["y1"] - box["y0"]
    assert stack <= bh + 0.5, f"title stack {stack:.1f} overflows box height {bh:.1f}"


def _pre_pr_size(fp, lines, box):
    """The ORIGINAL (pre-fidelity-PR) title size: the smaller of the width fit and
    the old height cap ``bh/(0.80*n)*1.02``. This is the shipped/calibrated size
    every previously-correct title must keep."""
    f = ImageFont.truetype(fp, 200)
    bw, bh, n = box["x1"] - box["x0"], box["y1"] - box["y0"], len(lines)
    width_fit = bw * 0.89 / max(f.getlength(ln) / 200 for ln in lines)
    old_cap = bh / (0.80 * n) * 1.02
    return min(width_fit, old_cap), width_fit, old_cap


def test_wide_script_title_not_enlarged():
    # A wide MrDafoe script name must render at its pre-PR size (min of width fit
    # and the old height cap) — the ink-fit-only rewrite grew it ~4% by dropping
    # the old height cap. Finding #1: previously-correct titles must NOT grow.
    cfg = config.theme("bachelorette")
    fp = config.font_path("bachelorette", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 80.0, "y0": 29.0, "x1": 186.0, "y1": 60.0}
    lines = ["Shira's", "Bachelorette"]
    svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    size = _title_size(svg)
    pre, width_fit, old_cap = _pre_pr_size(fp, lines, box)
    assert abs(size - pre) < 0.3, "wide script title must keep its pre-PR size"
    # here old_cap < width_fit, so it is capped by height and NOT enlarged to the
    # width fit the ink-fit-only code would have used.
    assert old_cap < width_fit
    assert size <= old_cap + 0.3, "title must be capped by the old height, not enlarged"


def test_shipped_normal_title_not_enlarged_or_shrunk():
    # birthday-girls (CooperLtBTBold) is a NORMAL-height face whose real ink runs
    # ~10% past its approximate recipe box; the ink-fit-only rewrite SHRANK it ~10%
    # below its calibrated size. It must render at the original pre-PR size.
    # Finding #1: a title that already fit keeps its prior size.
    cfg = config.theme("birthday-girls")
    fp = config.font_path("birthday-girls", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 65.6, "y0": 28.9, "x1": 139.1, "y1": 47.2}
    lines = ["Alma's", "B-day"]
    svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    size = _title_size(svg)
    pre, width_fit, old_cap = _pre_pr_size(fp, lines, box)
    assert abs(size - pre) < 0.3, "normal-height title must keep its pre-PR size"
    # it is height-bound here (old_cap < width_fit); the ~10% ink overrun is within
    # the box-approximation tolerance, so it is NOT shrunk to the metric ink-fit.
    assert size > old_cap - 0.3


def test_extreme_tall_face_shrinks_to_fit_when_overflow_exceeds_tolerance():
    # The metric ink-fit safety net must still engage for a genuinely too-tall
    # title: with the overrun tolerance forced to 0 (any overflow triggers it), a
    # face whose ink exceeds the old cap shrinks below old_cap so the painted stack
    # fits the box. Proves the ink-fit path is live, not dead code. (Findings #1/#5.)
    cfg = config.theme("birthday-girls")
    fp = config.font_path("birthday-girls", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 65.6, "y0": 28.9, "x1": 139.1, "y1": 47.2}
    lines = ["Alma's", "B-day"]
    saved = rp._TITLE_OVERFLOW_TOL
    rp._TITLE_OVERFLOW_TOL = 0.0
    try:
        svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                             ts["outline_w"], ts["arch"], ts["shadow"])
    finally:
        rp._TITLE_OVERFLOW_TOL = saved
    size = _title_size(svg)
    _pre, _wf, old_cap = _pre_pr_size(fp, lines, box)
    assert size < old_cap - 0.2, "ink-fit safety net must shrink a too-tall title"
    # and the painted stack (ink + outline + shadow headroom) fits the box height.
    f = ImageFont.truetype(fp, 200)
    stack = rp._title_ink_stack(f, 200, lines) / 200 * size
    pad = (2 * ts["outline_w"] + (0.06 if ts["shadow"] else 0.0)) * size
    bh = box["y1"] - box["y0"]
    assert stack + pad <= bh + 0.5, "painted footprint must stay within the box"


def test_title_ink_stack_includes_middle_line():
    # Finding #6: the stacked-ink extent must be measured over ALL lines. A 3-line
    # title whose tallest/deepest ink is on the MIDDLE line must measure the same
    # extent as when that ink is on an end line (max over all lines is symmetric),
    # and strictly more than a title with no tall line — the old first/last-only
    # measure would under-count the middle line.
    f, ref = _cafe()
    tall = "לקץ"          # ascender-tall lamed + deep final-tsadi descender
    short = "מם"
    mid_tall = [short, tall, short]
    end_tall = [tall, short, short]
    plain = [short, short, short]
    s_mid = rp._title_ink_stack(f, ref, mid_tall)
    s_end = rp._title_ink_stack(f, ref, end_tall)
    s_plain = rp._title_ink_stack(f, ref, plain)
    assert abs(s_mid - s_end) < 1e-9, "a tall MIDDLE line must be measured like an end line"
    assert s_mid > s_plain + 1.0, "the tall line's ink must enlarge the measured stack"


def test_empty_title_degrades_to_nothing():
    # Finding #3: an unfilled title (every line empty/whitespace) must return "" —
    # never crash on max([]) / getlength('') / a zero-width ink stack.
    cfg = config.theme("bachelorette")
    fp = config.font_path("bachelorette", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 80.0, "y0": 29.0, "x1": 186.0, "y1": 60.0}
    for empty in ([""], ["   "], ["", "  ", "\t"]):
        assert rp.title_block(box, empty, ts["fill"], ts["outline"], fp,
                              ts["outline_w"], ts["arch"], ts["shadow"]) == ""
    # a blank line mixed with a real line is dropped, not rendered/crashed.
    svg = rp.title_block(box, ["Shira", ""], ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    assert svg and "Shira" in svg


# --- 4b. per-theme italic title flag -----------------------------------------

def _birthday_italic_fixture():
    """Shared box/lines/style for the birthday-girls italic-title tests."""
    cfg = config.theme("birthday-girls")
    fp = config.font_path("birthday-girls", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 65.6, "y0": 28.9, "x1": 139.1, "y1": 47.2}
    lines = ["Alma's", "B-day"]
    return cfg, fp, ts, box, lines


def test_title_block_emits_font_style_italic_when_italic_true():
    # (a) italic=True must slant the title: every title <text> carries a plain
    # font-style="italic" so headless Chrome synthesizes the oblique from the
    # upright TitleFont (no separate italic font file).
    _cfg, fp, ts, box, lines = _birthday_italic_fixture()
    svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"], italic=True)
    assert 'font-style="italic"' in svg
    # the attribute rides on the title <text> element (before its <textPath>).
    for chunk in svg.split("<text ")[1:]:
        head = chunk.split(">", 1)[0]
        assert 'font-style="italic"' in head, "each title <text> must be italic"


def test_title_block_upright_by_default_has_no_italic():
    # (b) default (italic omitted) and explicit italic=False must NOT slant.
    _cfg, fp, ts, box, lines = _birthday_italic_fixture()
    default_svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                                 ts["outline_w"], ts["arch"], ts["shadow"])
    false_svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                               ts["outline_w"], ts["arch"], ts["shadow"], italic=False)
    assert "font-style" not in default_svg
    assert "font-style" not in false_svg


def test_title_block_italic_only_adds_the_font_style_attr():
    # (c) REGRESSION GUARD: toggling italic must change NOTHING about the output
    # except adding font-style="italic" — stripping that attribute from the italic
    # SVG must reproduce the non-italic SVG byte-for-byte. (Reset the title UID so
    # both calls share the same generated path ids.)
    _cfg, fp, ts, box, lines = _birthday_italic_fixture()
    saved_uid = rp._TITLE_UID[0]
    try:
        rp._TITLE_UID[0] = 0
        plain = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                               ts["outline_w"], ts["arch"], ts["shadow"], italic=False)
        rp._TITLE_UID[0] = 0
        ital = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                              ts["outline_w"], ts["arch"], ts["shadow"], italic=True)
    finally:
        rp._TITLE_UID[0] = saved_uid
    assert ital != plain
    assert ital.replace(' font-style="italic"', "") == plain, (
        "italic must ONLY add the font-style attr; non-italic output is unchanged")


def test_birthday_girls_theme_enables_italic_others_do_not():
    # The flag lives in the theme config: birthday-girls opts in; a representative
    # other theme (bachelorette) stays upright (defaults false).
    assert config.theme("birthday-girls")["title_style"].get("italic") is True
    assert config.theme("bachelorette")["title_style"].get("italic", False) is False


# --- 5. the calibrated font actually renders through headless Chrome -----------

def _chrome_render_glyph(font_path, family, text, size, out_png, embed=True):
    """Render one line of ``text`` in an embedded @font-face through the SAME
    headless-Chrome path + font-load wait the generator uses, and return the
    binarized ink cropped to its bounding box. ``embed=False`` omits the font so
    Chrome falls back to a system face (the failure mode the font-wait guards)."""
    import subprocess
    W, H = 1200, 320
    style = "<style>" + rp.font_face(family, font_path) + "</style>" if embed else ""
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
           f'viewBox="0 0 {W} {H}">{style}<rect width="{W}" height="{H}" fill="white"/>'
           f'<text x="20" y="200" font-family="{family}" font-size="{size}" '
           f'fill="black">{text}</text></svg>')
    sp = out_png.replace(".png", ".svg")
    open(sp, "w", encoding="utf-8").write(svg)
    subprocess.run([rp.CHROME, "--headless", "--no-sandbox", "--disable-gpu",
                    rp.CHROME_FONT_WAIT, "--force-device-scale-factor=1",
                    f"--screenshot={out_png}", f"--window-size={W},{H}", sp],
                   check=True, stderr=subprocess.DEVNULL)
    import numpy as np
    a = np.asarray(Image.open(out_png).convert("L")) < 128
    ys, xs = np.where(a)
    crop = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    return crop


def _ink_iou(crop, font_path, text, N=128):
    """IoU between a rendered ink crop and a PIL rasterization of ``text`` in the
    given font, both normalized to an N×N ink-bbox mask. High IoU == the render
    used THIS font's glyph shapes; a fallback face scores far lower."""
    import numpy as np
    from PIL import ImageDraw
    ref = Image.new("L", (2000, 500), 255)
    ImageDraw.Draw(ref).text((10, 10), text, font=ImageFont.truetype(font_path, 160), fill=0)
    ra = np.asarray(ref) < 128
    ys, xs = np.where(ra)
    rc = ra[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

    def norm(m):
        return np.asarray(Image.fromarray((m * 255).astype("uint8")).resize((N, N),
                          Image.LANCZOS)) > 128
    a, b = norm(crop), norm(rc)
    return (a & b).sum() / max(1, (a | b).sum())


def test_calibrated_font_renders_through_chrome():
    # Finding #2: prove the embedded @font-face actually paints (the font-load wait
    # works) by rendering through real headless Chrome and matching the ink to the
    # font's own glyph shapes. MrDafoe is a distinctive script: its shape IoU is
    # ~0.88 when the calibrated font renders and ~0.24 when Chrome falls back to a
    # system sans — a wide, machine-independent margin.
    fp = config.font_path("bachelorette", config.theme("bachelorette")["title_font"])
    word = "Bachelorette"
    import tempfile
    d = tempfile.mkdtemp(prefix="dugri-fonttest-")
    good = _chrome_render_glyph(fp, "TitleFont", word, 90, os.path.join(d, "g.png"), embed=True)
    fallback = _chrome_render_glyph(fp, "TitleFont", word, 90, os.path.join(d, "f.png"), embed=False)
    iou_good = _ink_iou(good, fp, word)
    iou_fallback = _ink_iou(fallback, fp, word)
    assert iou_good >= 0.6, (
        f"calibrated font did not render (IoU {iou_good:.2f}); font-load wait broken?")
    # control: the metric genuinely discriminates — a fallback face scores far lower.
    assert iou_fallback <= 0.45, f"fallback control unexpectedly high (IoU {iou_fallback:.2f})"
    assert iou_good - iou_fallback > 0.25


# --- 6. title alignment (left / center / right) ------------------------------

def _paths(svg):
    """Every <path> d-string in the title SVG, as (start_x, end_x) pairs."""
    out = []
    for d in re.findall(r'd="M ([\d.]+) [\d.]+ Q [\d.-]+ [\d.-]+ ([\d.]+)', svg):
        out.append((float(d[0]), float(d[1])))
    return out


def _birthday_fixture():
    cfg = config.theme("birthday-girls")
    fp = config.font_path("birthday-girls", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 65.6, "y0": 28.9, "x1": 139.1, "y1": 47.2}
    return fp, ts, box


def test_title_align_left_anchors_lines_to_left_edge():
    fp, ts, box = _birthday_fixture()
    svg = rp.title_block(box, ["Alma's", "B-day"], ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"], align="left")
    assert 'startOffset="0" text-anchor="start"' in svg
    assert 'text-anchor="middle"' not in svg
    # every arced path begins at the box's LEFT edge (x0)
    for start_x, _end_x in _paths(svg):
        assert abs(start_x - box["x0"]) < 0.15, "left-aligned path must start at x0"


def test_title_align_right_anchors_lines_to_right_edge():
    fp, ts, box = _birthday_fixture()
    svg = rp.title_block(box, ["Alma's", "B-day"], ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"], align="right")
    assert 'startOffset="100%" text-anchor="end"' in svg
    assert 'text-anchor="middle"' not in svg
    # every arced path ends at the box's RIGHT edge (x1)
    for _start_x, end_x in _paths(svg):
        assert abs(end_x - box["x1"]) < 0.15, "right-aligned path must end at x1"


def test_title_align_center_is_default_and_symmetric():
    fp, ts, box = _birthday_fixture()
    default_svg = rp.title_block(box, ["Alma's", "B-day"], ts["fill"], ts["outline"],
                                 fp, ts["outline_w"], ts["arch"], ts["shadow"])
    center_svg = rp.title_block(box, ["Alma's", "B-day"], ts["fill"], ts["outline"],
                                fp, ts["outline_w"], ts["arch"], ts["shadow"],
                                align="center")
    assert 'startOffset="50%" text-anchor="middle"' in default_svg
    assert 'text-anchor="start"' not in default_svg and 'text-anchor="end"' not in default_svg
    # default == explicit center; and each path is centred on the box mid-x
    cx = (box["x0"] + box["x1"]) / 2
    for start_x, end_x in _paths(center_svg):
        assert abs((start_x + end_x) / 2 - cx) < 0.15, "centered path must straddle box mid-x"


def test_title_center_straddles_the_ink_not_the_advance():
    """A script face's ink OVERHANGS its advance width, and SVG's text-anchor
    positions a run by the advance — so anchoring the advance leaves the visible
    title off-centre even though the box geometry is correct.

    Measured on daniel-amit (Haglos, "Bride in One Pot": 1050 of ink against a
    1018 advance): the title sat 5.5px right of centre on a 598px card, on BOTH
    faces, margins L=25 R=14, against a Canva original that is centred.
    bachelorette's MrDafoe is the same shape of error at 4.7% of the advance,
    which is what this fixture uses. Eight of the nine shipped title faces have
    NO asymmetry, so the correction is a no-op for them — hence the guard below
    that the fixture font really does overhang, or the assertion proves nothing.
    """
    cfg = config.theme("bachelorette")
    fp = config.font_path("bachelorette", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 40.0, "y0": 30.0, "x1": 180.0, "y1": 55.0}
    line = "Alma's"
    svg = rp.title_block(box, [line], ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"], align="center")
    size = float(re.search(r'font-size="([\d.]+)"', svg).group(1))
    # Measured straight from the font, NOT via the renderer's own helper, so this
    # asserts the resulting geometry rather than restating the implementation.
    f, ref = rp._title_metrics(fp)
    bb, adv = f.getbbox(line), f.getlength(line)
    skew = ((bb[0] + bb[2]) / 2 - adv / 2) / ref * size
    assert abs(skew) > 0.3, f"fixture font must overhang for this to test anything (skew {skew})"
    cx = (box["x0"] + box["x1"]) / 2
    start_x, end_x = _paths(svg)[0]
    advance_centre = (start_x + end_x) / 2
    ink_centre = advance_centre + skew
    assert abs(ink_centre - cx) < 0.15, (
        f"the INK must straddle box mid-x {cx}: ink centre {ink_centre:.2f}, "
        f"advance centre {advance_centre:.2f}")


# --- 7. de-bold: monochrome title = pure fill, contrasting = outline ring -----

def _stroke_widths(svg):
    return [float(w) for w in re.findall(r'stroke-width="([\d.]+)"', svg)]


def test_monochrome_title_emits_no_stroke_ring():
    # outline == fill (a same-colour "outline", e.g. a monochrome theme): the ring
    # would only fatten with no visible edge, so it must NOT be drawn — every run
    # is pure fill (stroke-width 0). De-bold guarantee.
    fp, ts, box = _birthday_fixture()
    svg = rp.title_block(box, ["Alma's", "B-day"], "#101010", "#101010", fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    sw = _stroke_widths(svg)
    assert sw, "title must emit at least the fill run"
    assert max(sw) == 0.0, "monochrome title (outline==fill) must have no non-zero stroke"


def test_contrasting_title_keeps_its_outline_ring():
    # outline != fill: the dark ring behind the light fill IS drawn (a positive
    # stroke-width), so a contrasting title keeps its edge.
    fp, ts, box = _birthday_fixture()
    svg = rp.title_block(box, ["Alma's", "B-day"], "#a4e9ff", "#000000", fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    sw = _stroke_widths(svg)
    assert max(sw) > 0.0, "contrasting title must keep a non-zero outline ring"
    # and the fill body itself is still pure fill (no body-fatten stroke)
    assert 0.0 in sw, "fill body must render at true weight (stroke-width 0)"


# --- 8. GEOMETRIC_TEXT_STYLE (de-bold) on every render path ------------------

def test_geometric_text_style_on_all_render_paths():
    import build
    # (a) fronts: build_page bakes the style block into the page SVG.
    fronts = config.clean_path("birthday-girls", "fronts")
    page = rp.build_page("birthday-girls", fronts, [[] for _ in range(8)],
                         ["Alma's", "B-day"])
    assert rp.GEOMETRIC_TEXT_STYLE in page, "fronts render path missing geometric style"
    # (b) board + (c) backs: capture the SVG each hands to render_svg.
    captured = []
    saved = build.render_svg
    try:
        build.render_svg = lambda svg_text, w, h, out_png: captured.append(svg_text) or out_png
        board = config.clean_path("birthday-girls", "board")
        backs = config.clean_path("birthday-girls", "backs")
        build.render_board("birthday-girls", board, ["Alma's", "B-day"], "/tmp/b.png")
        build.render_backs("birthday-girls", backs, ["Alma's", "B-day"], "/tmp/k.png")
    finally:
        build.render_svg = saved
    assert len(captured) == 2
    for svg_text in captured:
        assert rp.GEOMETRIC_TEXT_STYLE in svg_text, "board/back render path missing geometric style"


# --- 9. per-theme word_size pins the uniform word size -----------------------

def test_word_size_pins_the_uniform_word_size():
    font, ref = _cafe()
    # tall boxes would derive a big median-based size; word_size must override it.
    slots = _slots([(10, 10 + i * 60, 190, 54 + i * 60) for i in range(4)])
    words = ["מסיבה", "חברים", "ריקודים", "צחוקים"]
    derived = rp._word_sizes(slots, words, font, ref, cell=[5, 5, 195, 300])
    pinned = rp._word_sizes(slots, words, font, ref, cell=[5, 5, 195, 300], word_size=17.0)
    assert all(abs(s - 17.0) < 1e-9 for s in pinned), "word_size must pin every word to it"
    assert derived[0] != 17.0, "sanity: the box-derived size differs from the pin"


# --- 10. back_size overrides the back-title size -----------------------------

def test_back_size_overrides_back_title_size():
    # render_backs must pin each back title to the theme's back_size (not its
    # front title `size`). birthday-girls: size=23, back_size=30.
    import build
    ts = config.theme("birthday-girls")["title_style"]
    assert ts.get("back_size") and ts.get("back_size") != ts.get("size")
    seen = []

    # **kwargs so adding a style knob (bold, ...) can't break this spy: the test
    # is about WHICH fixed_size is chosen, not title_block's full signature.
    def spy(box, lines, fill, outline, font_path, outline_w, arch, shadow,
            fixed_size=None, **kwargs):
        seen.append(fixed_size)
        return ""

    saved_tb, saved_rs = rp.title_block, build.render_svg
    try:
        rp.title_block = spy
        build.render_svg = lambda svg_text, w, h, out_png: out_png
        backs = config.clean_path("birthday-girls", "backs")
        build.render_backs("birthday-girls", backs, ["Alma's", "B-day"], "/tmp/k.png")
    finally:
        rp.title_block, build.render_svg = saved_tb, saved_rs
    assert seen, "render_backs must draw at least one back title"
    assert all(fs == ts["back_size"] for fs in seen), (
        f"back titles must use back_size {ts['back_size']}, got {seen}")


# --- 11. word-marker right-edge clamp keeps a slot inside the cell ------------

def test_line_right_edge_clamps_an_edge_pinned_slot_inside_the_cell():
    cell = [10.0, 10.0, 210.0, 300.0]          # 200-wide cell
    margin = rp._LINE_RIGHT_MARGIN * (cell[2] - cell[0])
    # a slot whose right edge collapsed onto the CELL edge must be pulled in.
    pinned = rp._line_right_edge(cell[2], cell)
    assert pinned < cell[2], "edge-pinned slot must be clamped inside the cell"
    assert abs(pinned - (cell[2] - margin)) < 1e-9
    # a slot already well inside the margin is returned unchanged.
    inset = cell[2] - margin - 20.0
    assert rp._line_right_edge(inset, cell) == inset
    # no cell -> raw right edge (back-compat).
    assert rp._line_right_edge(cell[2], None) == cell[2]


# --- 12. title-box union for a 2-box title -----------------------------------

def test_title_box_union_for_two_box_title():
    # birthday-girls records TWO title boxes (one per line). build_page must fit
    # the title into their UNION (min/min .. max/max), not the first box alone.
    import json
    cfg = config.theme("birthday-girls")
    recipe = json.load(open(os.path.join(rp.HERE, "recipes", f"{cfg['recipe']}.json")))
    tb = next(c["title"] for c in recipe["cards"] if c and c.get("title"))
    assert len(tb) == 2, "fixture expects a 2-box title"
    expect = {"x0": min(b["x0"] for b in tb), "y0": min(b["y0"] for b in tb),
              "x1": max(b["x1"] for b in tb), "y1": max(b["y1"] for b in tb)}
    assert cfg["title_style"].get("offset") is None, "fixture assumes no title offset"
    seen = []  # build_page draws a title per card; capture every box it passes

    def spy(box, *a, **k):
        seen.append(dict(box))
        return ""

    saved = rp.title_block
    try:
        rp.title_block = spy
        fronts = config.clean_path("birthday-girls", "fronts")
        rp.build_page("birthday-girls", fronts, [[] for _ in range(8)], ["Alma's", "B-day"])
    finally:
        rp.title_block = saved
    assert seen, "build_page must draw the title"
    # the first card's title must be fit into the UNION of ITS two boxes.
    matched = any(all(abs(b[k] - expect[k]) < 1e-9 for k in ("x0", "y0", "x1", "y1"))
                  for b in seen)
    assert matched, f"no title box equals the 2-box union {expect}; got {seen}"
    # the union is materially taller than the first box alone (guards a regression
    # to card['title'][0] that would cram both lines into ~half the height).
    assert expect["y1"] - expect["y0"] > (tb[0]["y1"] - tb[0]["y0"]) * 1.5


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")


# --- a pinned title size must never overflow the card ------------------------
# A theme may pin title_style.size to the Canva point size. That size was
# measured against the ORIGIN's own title text, not the honoree's name: pin
# grapefruit at 28 and "רווקות לדניאל" fits, while "רווקות לאלכסנדרה-מרגריטה"
# ran clean off BOTH card edges — on all 104 printed cards of a paid order.

_TITLE_BOX = {"x0": 22.0, "y0": 28.0, "x1": 201.0, "y1": 62.0}


def _title_font_size(lines, fixed_size):
    """The font-size title_block actually rendered at."""
    svg = rp.title_block(_TITLE_BOX, lines, "#711d20", "#711d20", CAFE,
                         0.0, 0.0, False, rtl=True, fixed_size=fixed_size)
    sizes = [float(v) for v in re.findall(r'font-size="([\d.]+)"', svg)]
    assert sizes, svg[:200]
    return max(sizes)


def test_a_pinned_title_size_is_kept_when_it_fits():
    assert _title_font_size(["רווקות לדנה"], 28) == 28


def test_a_pinned_title_size_shrinks_rather_than_overflowing():
    long_name = _title_font_size(["רווקות לאלכסנדרה-מרגריטה"], 28)
    assert long_name < 28, "a long title must shrink, not run off the card"
    # And it must land inside the box, allowing the same ink-overrun tolerance
    # the calibrated boxes already carry.
    font, ref = _cafe()
    width_at_1pt = font.getlength("רווקות לאלכסנדרה-מרגריטה") / ref
    box_w = _TITLE_BOX["x1"] - _TITLE_BOX["x0"]
    assert long_name * width_at_1pt <= box_w * (1 + rp._TITLE_OVERFLOW_TOL) + 1


def test_the_clamp_does_not_shrink_a_title_that_already_fits():
    # Every title that fits today must render at exactly its pinned size, or
    # this clamp would quietly restyle every calibrated theme.
    for size in (12, 18, 23.9):
        assert _title_font_size(["OZ'S"], size) == size


# --- per-theme synthetic bold ------------------------------------------------
# A single global stroke width cannot be right for every face. Grapefruit's
# title read too light against its Canva original at the default; measured by
# ink coverage in the title band, the original is 8.72% and the default gave
# 7.41%.

def _title_stroke(bold, bold_w=None, size=28):
    svg = rp.title_block(_TITLE_BOX, ["רווקות לדנה"], "#711d20", "#711d20", CAFE,
                         0.0, 0.0, False, rtl=True, fixed_size=size,
                         bold=bold, bold_w=bold_w)
    return max(float(v) for v in re.findall(r'stroke-width="([\d.]+)"', svg))


def test_bold_off_paints_at_true_outline_weight():
    # The default must stay unfattened — that was a deliberate fidelity fix.
    assert _title_stroke(bold=False) == 0.0


def test_a_theme_can_set_its_own_bold_weight():
    default = _title_stroke(bold=True)
    heavier = _title_stroke(bold=True, bold_w=0.05)
    assert heavier > default, (default, heavier)
    assert abs(heavier - 28 * 0.05) < 0.01, heavier


def test_bold_w_is_ignored_when_bold_is_off():
    # A stray weight must not silently embolden a theme that never asked.
    assert _title_stroke(bold=False, bold_w=0.09) == 0.0


# ---- synthetic-bold WORDS (trip comeback's origin sets them heavier) -------
def _word_markup(bold_w=0.0):
    return rp.word_lines(200, 100, 12, "#017f8d", 1, ["מסיבה"], CAFE,
                         bold_w=bold_w)


def test_words_are_unfattened_by_default():
    # Nine shipped templates were calibrated against the face's own weight, so
    # the no-bold markup must stay byte-for-byte what it always was.
    assert "stroke" not in _word_markup()


def test_a_bold_word_is_stroked_in_its_own_colour():
    markup = _word_markup(bold_w=0.04)
    assert 'stroke="#017f8d"' in markup, markup
    assert 'paint-order="stroke"' in markup, markup
    # 12 * 0.04 = 0.48 on the word run.
    assert 'stroke-width="0.48"' in markup, markup


def test_the_marker_is_fattened_with_the_word():
    # Bold words beside a hairline digit reads as a bug, not a design.
    markup = _word_markup(bold_w=0.04)
    assert markup.count('paint-order="stroke"') == 3, markup


def test_word_bold_is_opt_in_per_theme():
    assert config.word_bold_w({}, 0.028) == 0.0
    assert config.word_bold_w({"word_bold": True}, 0.028) == 0.028
    assert config.word_bold_w({"word_bold": True, "word_bold_w": 0.04}, 0.028) == 0.04
    # A weight without the opt-in must not embolden a theme that never asked.
    assert config.word_bold_w({"word_bold_w": 0.09}, 0.028) == 0.0


def test_a_bold_word_reserves_its_stroke_inside_the_card():
    # The stroke hangs past the advance the fit measures; without the
    # allowance a bold word reaches further left than the fit believed and the
    # guillotine takes it off the printed card.
    slots = [{"x0": 40, "y0": 20, "x1": 180, "y1": 40, "color": "#000"}]
    font, ref = rp._word_metrics(CAFE)
    cell = [0, 0, 200, 300]
    plain = rp._word_layouts(slots, ["מסיבהמסיבהמסיבה"], font, ref, cell=cell)
    bold = rp._word_layouts(slots, ["מסיבהמסיבהמסיבה"], font, ref, cell=cell,
                            bold_w=0.05)
    assert bold[0].size <= plain[0].size, (plain[0].size, bold[0].size)


# ---- per-front title nudge (japanese: the koi swaps corners) --------------
CELL = [0, 0, 100, 200]


def test_a_nudge_moves_the_box():
    box = {"x0": 10, "x1": 50, "y0": 10, "y1": 30}
    out = rp._nudge_title_box(box, CELL, [0.1, 0.05])
    assert (out["x0"], out["x1"]) == (20, 60)
    assert (out["y0"], out["y1"]) == (20, 40)


def test_a_nudge_past_the_card_is_clipped_not_translated():
    # Translating would carry a long honoree name clean past the trim edge.
    box = {"x0": 3, "x1": 97, "y0": 10, "y1": 30}
    out = rp._nudge_title_box(box, CELL, [0.30, 0])
    assert out["x0"] == 33
    assert out["x1"] == 97, "the box must stop at the card, not run past it"
    assert out["x1"] - out["x0"] < box["x1"] - box["x0"], "it shrank, so the fit shrinks"


def test_no_nudge_leaves_the_box_alone():
    box = {"x0": 3, "x1": 97, "y0": 10, "y1": 30}
    assert rp._nudge_title_box(box, CELL, None) is box
    assert rp._nudge_title_box(box, None, [0.3, 0]) is box


def test_a_nudge_that_would_invert_the_box_is_refused():
    box = {"x0": 3, "x1": 97, "y0": 10, "y1": 30}
    assert rp._nudge_title_box(box, CELL, [5.0, 0]) is box


def test_the_sheet_reads_the_per_front_nudge():
    # japanese's koi occupies the top-left on fronts 5-8 only, so the four
    # cards must NOT all take the shared offset.
    cfg = {"title_style": {"offset": [0.06, 0.06],
                           "front_offset": {"5": [0.30, 0.06]}}}
    assert config.front_offset(cfg, 1) == [0.06, 0.06]
    assert config.front_offset(cfg, 5) == [0.30, 0.06]


# --- 11. the LEADING: the spacing calibration measures is the spacing we print -
#
# `title_block` stacked every title's lines one fixed step apart — 0.78 of the
# type size — whatever spacing the design they were copied from was set at. The
# calibrator now MEASURES that spacing (calibrate.solve_size_and_leading), and
# these are the tests that it reaches the ink: the measured number is what the
# baselines are laid out on, a theme without one is untouched, and a spacing
# tighter than the glyphs need is opened up rather than printed as a collision.

LEAD_BOX = {"x0": 20.0, "y0": 30.0, "x1": 210.0, "y1": 120.0}
LEAD_LINES = ["מסיבת רווקות", "לשירה"]
_UNSET = object()


def _hebrew_title_font():
    # A face that really can DRAW the lines below. A Latin-only title font
    # (bachelorette's Mr Dafoe) answers getbbox on Hebrew with the empty
    # .notdef box, which makes the collision floor measure zero and every
    # assertion about it vacuously true.
    return config.font_path("anniversary",
                            config.theme("anniversary")["title_font"])


def _block(lines, leading=_UNSET, font=None, outline_w=0.0, **kw):
    """One title block's markup, with the UID reset so two calls compare."""
    rp._TITLE_UID[0] = 0
    args = {"fixed_size": 24.0}
    args.update(kw)
    if leading is not _UNSET:
        args["leading"] = leading
    return rp.title_block(LEAD_BOX, list(lines), args.pop("fill", "#111111"),
                          args.pop("outline", "#111111"),
                          font or _hebrew_title_font(), outline_w, 0.0, False,
                          **args)


def _baselines(svg):
    """The y of each line's MAIN arc path, in the order they were emitted.

    The `m` in the id matters: a shadowed title also emits an `s` path per line,
    dropped 0.06 of the size lower, and taking every path would read a line's
    own shadow as the next line.
    """
    return [float(y) for y in
            re.findall(r'id="t\d+m\d+" fill="none" d="M [-0-9.]+ ([-0-9.]+) Q', svg)]


def _emitted_size(svg):
    return float(re.findall(r'font-size="([0-9.]+)"', svg)[0])


def test_a_measured_leading_is_what_the_lines_are_stacked_at():
    # The point of the whole change: the number calibration read off the design
    # is the number the baselines are laid out on, not 0.78. Every value here is
    # above this face's collision floor, so the clamp is not what is being
    # measured — the leading is passed straight through.
    font = _hebrew_title_font()
    f, ref = rp._title_metrics(font)
    floor = rp._min_line_pitch(f, ref, LEAD_LINES, 0.0)
    for want in (round(floor + 0.10, 2), round(floor + 0.50, 2),
                 round(floor + 1.00, 2)):
        assert want > floor, (want, floor)
        svg = _block(LEAD_LINES, leading=want, font=font)
        size = _emitted_size(svg)
        got = _baselines(svg)
        step = got[1] - got[0]
        assert abs(step - want * size) < 0.15, (want, size, step)


def test_a_theme_with_no_measured_leading_stacks_at_the_renderers_own_step():
    # An uncalibrated theme — and every theme calibrated before the leading was
    # measured — must be laid out exactly as it was. `leading=None` and omitting
    # the argument are the same thing, and both mean 0.78.
    omitted = _block(LEAD_LINES)
    explicit = _block(LEAD_LINES, leading=None)
    assert omitted == explicit
    size = _emitted_size(omitted)
    got = _baselines(omitted)
    assert abs((got[1] - got[0]) - rp.RENDER_PITCH * size) < 0.15
    assert rp.RENDER_PITCH == 0.78


def test_no_shipped_theme_carries_a_leading_yet():
    # Nine designs are in production. None of them has been re-calibrated, so
    # none may have picked one up by side effect — the test below pins what they
    # render, and this pins WHY they are entitled to be unchanged.
    shipped = json.load(open(os.path.join(HERE, "themes.json"), encoding="utf-8"))
    with_leading = [k for k, e in shipped.items()
                    if (e.get("title_style") or {}).get("leading") is not None]
    assert not with_leading, with_leading


# Two lines of Hebrew, two of Latin, one alone — so the sweep below covers the
# stacked path, the RTL and LTR splits, and the single-line path that has no
# spacing at all.
_TITLE_MARKUP_CASES = (["מסיבת רווקות", "לשירה"],
                       ["Alma's", "Birthday"],
                       ["דנה"])


def _shipped_title(entry, key, lines, **kw):
    ts = entry["title_style"]
    rp._TITLE_UID[0] = 0
    return rp.title_block(
        LEAD_BOX, list(lines), ts["fill"], ts["outline"],
        config.font_path(key, entry["title_font"]),
        ts["outline_w"], ts["arch"], ts["shadow"],
        rtl=(entry.get("language") == "hebrew"),
        fixed_size=ts.get("size"), align=ts.get("align", "center"),
        italic=ts.get("italic", False), bold=ts.get("bold", False),
        bold_w=ts.get("bold_w"), **kw)


def test_the_shipped_themes_titles_render_exactly_as_before():
    # Nine designs are live; re-spacing one by side effect would reprint every
    # card of every order placed against it. So: for every shipped theme, over
    # every shape of title, the markup with the theme's leading (none of them
    # has one) is byte-identical to the markup produced without the argument at
    # all, and the lines come out on exactly the fixed step this renderer has
    # always used. Those two together are the whole guarantee — with no measured
    # leading, `pitch` IS `RENDER_PITCH`, and every place the pitch reaches
    # (the ink stack, the height cap's per-line share, the baseline gap) then
    # sees the identical constant it saw before.
    #
    # Deliberately not a hash of the output: the emitted coordinates come from
    # FreeType's metrics, which differ by a fraction of a unit between a dev
    # machine and CI, so a golden hash would fail for a reason that has nothing
    # to do with this change.
    shipped = json.load(open(os.path.join(HERE, "themes.json"), encoding="utf-8"))
    assert len(shipped) >= 9, "the shipped set shrank — check what was removed"
    for key, entry in sorted(shipped.items()):
        ts = entry["title_style"]
        assert ts.get("leading") is None, key
        for lines in _TITLE_MARKUP_CASES:
            with_arg = _shipped_title(entry, key, lines, leading=ts.get("leading"))
            without = _shipped_title(entry, key, lines)
            assert with_arg == without, f"{key}: {lines} moved"
            got = _baselines(with_arg)
            if len(got) < 2:
                continue
            size = _emitted_size(with_arg)
            for a, b in zip(got, got[1:]):
                assert abs((b - a) - rp.RENDER_PITCH * size) < 0.15, (
                    f"{key}: {lines} is no longer stacked at {rp.RENDER_PITCH}")


def test_the_pitch_falls_back_to_the_renderers_own_step_whatever_is_asked_of_it():
    # The other half of the guarantee above: with no measured leading the clamp
    # cannot fire, for any font, any text and any amount of paint — so there is
    # no input on which an uncalibrated theme picks up a spacing it did not have.
    f, ref = rp._title_metrics(_hebrew_title_font())
    for lines in (["לתמר", "מזל טוב"], ["דנה"], ["א", "ב", "ג"]):
        for pad in (0.0, 0.1, 0.5, 2.0):
            assert rp.title_pitch(f, ref, lines, None, pad) == rp.RENDER_PITCH


def test_a_single_line_title_is_unaffected_by_the_leading():
    # There is no gap between one line and nothing, so the spacing cannot reach
    # the markup — the single-line templates are entitled to be untouched no
    # matter what the theme carries.
    plain = _block(["דנה"])
    for lead in (None, 0.50, 0.78, 1.90):
        assert _block(["דנה"], leading=lead) == plain, lead


def test_each_surface_is_stacked_at_its_own_measured_spacing():
    # A design's front, board and backs CAN be spaced separately — tarifa's back
    # stacks its two lines a third further apart than its front — and where the
    # calibrator finds that (calibrate.couple_leadings refuses to share a
    # leading its surfaces' ink disagrees on) each surface carries its own.
    # Each surface's pinned SIZE was fitted at whatever spacing it ended up
    # with, so drawing a back at the front's prints a size nobody measured:
    # forcing one deck-wide leading put tarifa's back 21% over the Canva value
    # it had been matching to 2%.
    ts = {"leading": 0.90, "back_leading": 1.30, "board_leading": 1.10}
    assert rp.back_leading(ts) == 1.30
    assert rp.board_leading(ts) == 1.10
    # A paired deck measures each back on its own, and that wins over both.
    assert rp.back_leading(ts, {"leading": 1.55}) == 1.55
    # ...and each falls through to the fronts' when it has none of its own,
    # exactly as back_size falls through to size.
    assert rp.back_leading({"leading": 0.90}) == 0.90
    assert rp.board_leading({"leading": 0.90}) == 0.90
    assert rp.back_leading({"leading": 0.90}, {}) == 0.90
    # Nothing measured anywhere is None — the renderer's own step.
    assert rp.back_leading({}) is None and rp.board_leading({}) is None


def test_a_leading_tighter_than_the_glyphs_need_is_opened_up():
    # A measured leading is read against the ORIGINAL's honoree name, and we do
    # not print that name. The owner's rule: the lines may never touch.
    font = _hebrew_title_font()
    f, ref = rp._title_metrics(font)
    lines = ["לתמר", "מזל טוב"]
    floor = rp._min_line_pitch(f, ref, lines, 0.0)
    assert floor > 0.50, ("the face must actually draw these lines, or the "
                          "clamp is never exercised")
    svg = _block(lines, leading=0.50, font=font)
    size = _emitted_size(svg)
    got = _baselines(svg)
    # 0.01 of slack because the path's y is emitted to one decimal place.
    assert (got[1] - got[0]) / size >= floor - 0.01, "the clamp did not hold"
    # ...and it only ever LOOSENS: a design that leads generously keeps its air.
    wide = _block(lines, leading=1.60, font=font)
    assert abs((_baselines(wide)[1] - _baselines(wide)[0])
               / _emitted_size(wide) - 1.60) < 0.01


def test_the_collision_floor_counts_the_painted_ring_not_just_the_glyph():
    # The ring is painted around every glyph, so two lines set as close as their
    # bare ink allows would still overlap once both are ringed.
    font = _hebrew_title_font()
    f, ref = rp._title_metrics(font)
    lines = ["לתמר", "מזל טוב"]
    bare = rp._min_line_pitch(f, ref, lines, 0.0)
    ringed = rp._min_line_pitch(f, ref, lines, 0.10)
    assert abs((ringed - bare) - 0.10) < 1e-9
    # A same-colour "outline" is never painted as a ring, so it must not push
    # the lines apart to clear a ring that is not there.
    tight = _block(lines, leading=0.50, font=font, outline_w=0.10,
                   fill="#111111", outline="#111111")
    step = (_baselines(tight)[1] - _baselines(tight)[0]) / _emitted_size(tight)
    assert abs(step - bare) < 0.01, step


# --- the collision rule, proved on the RENDERED card -------------------------
#
# The owner's rule: a measured leading may never be tighter than the glyphs
# need, and "may never" is not a claim a green arithmetic test settles — the
# spacing is arithmetic but the collision is ink. So every shipped template is
# driven through the SAME headless Chrome the cards are printed with, at the
# tightest leading the store will accept, carrying the longest honoree name that
# can be constructed, and the rendered pixels are asked whether any two lines
# touch.
#
# WHAT "TOUCH" MEANS. This used to demand a fully CLEAR ROW between every pair
# of baselines, which is not the rule — it is a much stronger one, and it is the
# rule that printed סנטוריני at 1.18 where its design sets 0.50 and סיישל at
# 0.887 against 0.68. A design is entitled to let one line's descender hang
# BESIDE the next line's ascender: no row is clear, and no glyph is anywhere
# near another. So the lines are now drawn on separate layers and the question
# put exactly as the owner puts it — does any pixel of one line meet any pixel
# of the next. Each layer is dilated a pixel first, because Chrome's antialiased
# rim welds two outlines that merely abut (#329).

# The longest name a buyer can realistically enter, in each script, chosen to
# hang ink BOTH ways across the gap: the Hebrew ends in a final-kaf that dives
# below the baseline and opens with a lamed that climbs above it; the Latin
# carries a descender (p, y) over an ascender (l, d).
_LONG_NAMES = {"hebrew": "אלכסנדרה-מרגריטה־לך",
               "english": "Alexandrina-Poppylde",
               "english-caps": "ALEXANDRINA-POPPYLDE"}
# The floor of the range validateTitleStyle accepts — the worst case the
# renderer can ever be handed by the store.
_TIGHTEST_ALLOWED_LEADING = 0.50


_TEXT_RE = re.compile(r"<text\b.*?</text>", re.S)
_LINE_RE = re.compile(r'href="#t\d+m(\d+)"')


def _chrome_mask(svg_text, w, h, scale, out_png):
    """Binary ink mask of an SVG rendered through the production rasterizer."""
    import subprocess
    sp = out_png.replace(".png", ".svg")
    open(sp, "w", encoding="utf-8").write(svg_text)
    subprocess.run([rp.CHROME, "--headless", "--no-sandbox", "--disable-gpu",
                    rp.CHROME_FONT_WAIT, f"--force-device-scale-factor={scale}",
                    f"--screenshot={out_png}", f"--window-size={w},{h}", sp],
                   check=True, stderr=subprocess.DEVNULL)
    return (Image.open(out_png).convert("L")
            .point(lambda v: 255 if v < 200 else 0))


def _line_layers(block):
    """The block's markup, once per title LINE, with only that line's <text>.

    Every ``<text>`` rides a ``<textPath href="#t<uid>m<line>">``, so the line a
    layer belongs to is written into the markup and does not have to be guessed
    from the element order (a shadowed title emits more than one element per
    line). Everything that is not a ``<text>`` — the ``<defs>`` the paths live
    in — stays in every layer, so each renders at exactly the position it has in
    the whole block.
    """
    defs = _TEXT_RE.sub("", block)
    per = {}
    for el in _TEXT_RE.findall(block):
        m = _LINE_RE.search(el)
        if m:
            per.setdefault(int(m.group(1)), []).append(el)
    return [defs + "".join(per[i]) for i in sorted(per)]


def test_no_two_title_lines_touch_at_the_tightest_leading_on_any_template():
    import tempfile
    from PIL import ImageChops, ImageFilter
    W, H, SCALE = 460, 300, 3
    d = tempfile.mkdtemp(prefix="dugri-leadtest-")
    shipped = json.load(open(os.path.join(HERE, "themes.json"), encoding="utf-8"))
    checked = 0
    for key, entry in sorted(shipped.items()):
        ts, tmpl = entry["title_style"], entry.get("title_lines") or []
        name = _LONG_NAMES[entry.get("name_form", "english")]
        lines = [ln.replace("{NAME}", name).replace("{NAME1}", name)
                 .replace("{NAME2}", name).replace("{AGE}", "40")
                 .replace("{YEARS}", "40") for ln in tmpl]
        if len(lines) < 2:
            continue          # one line cannot collide with anything
        if ts.get("one_block"):
            # This design sets its title as ONE text box and its lines run
            # together — the owner asked for exactly that (see ``one_block``).
            # Holding it to "no two lines touch" would be holding it to a rule
            # its own artwork does not obey.
            continue
        font = config.font_path(key, entry["title_font"])
        box = {"x0": 20.0, "y0": 20.0, "x1": W - 20.0, "y1": H - 20.0}
        rp._TITLE_UID[0] = 0
        block = rp.title_block(
            box, lines, ts["fill"], ts["outline"], font, ts["outline_w"],
            ts["arch"], ts["shadow"], rtl=(entry.get("language") == "hebrew"),
            align=ts.get("align", "center"), italic=ts.get("italic", False),
            bold=ts.get("bold", False), bold_w=ts.get("bold_w"),
            leading=_TIGHTEST_ALLOWED_LEADING)
        layers = _line_layers(block)
        assert len(layers) == len(lines), f"{key}: {len(layers)} layers"
        masks = []
        for i, body in enumerate(layers):
            svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" '
                   f'height="{H}" viewBox="0 0 {W} {H}">'
                   f'<style>{rp.font_face("TitleFont", font)}</style>'
                   f'<rect width="{W}" height="{H}" fill="white"/>{body}</svg>')
            masks.append(_chrome_mask(svg, W, H, SCALE,
                                      os.path.join(d, f"{key}-{i}.png")))
        for i, m in enumerate(masks):
            assert m.getbbox(), f"{key}: line {i} rendered nothing at all"
        # NEIGHBOURING pairs, not merely somewhere on the card: three lines can
        # be clear at the top and welded together at the bottom.
        for i, (a, b) in enumerate(zip(masks, masks[1:])):
            grown = a.filter(ImageFilter.MaxFilter(3))
            hit = ImageChops.multiply(grown, b).getbbox()
            assert not hit, (
                f"{key}: title lines {i} and {i + 1} touch at leading "
                f"{_TIGHTEST_ALLOWED_LEADING} — their ink meets around {hit}")
        checked += 1
    assert checked >= 6, f"only {checked} multi-line templates were proved"


# --- the floor reads COLUMNS, not boxes --------------------------------------

def test_the_floor_lets_a_short_line_tuck_under_a_descender_beside_it():
    """Two lines only collide where they are ABOVE ONE ANOTHER.

    The old floor compared the upper line's bounding BOX against the lower's, so
    a descender anywhere on one line was charged against an ascender anywhere on
    the other — however far apart the two sat across the card. That is what
    printed סנטוריני at 1.18 where its design sets 0.50, and סיישל at 0.887
    against 0.68.

    Here the upper line's only descender is at its far LEFT and the lower line's
    only ink at its far RIGHT: nothing on one is over anything on the other. Read
    column by column the pair needs less room than the boxes claim.
    """
    font = config.font_path("bachelorette", "MrDafoe-Regular.ttf")
    f, ref = rp._title_metrics(font)
    lines = ["gy                    l", "                       l"]
    by_box = rp._min_line_pitch_by_box(f, ref, lines, 0.0)
    by_column = rp._min_line_pitch(f, ref, lines, 0.0, align="left")
    assert by_column < by_box, (by_column, by_box)


def test_the_floor_still_refuses_a_leading_the_glyphs_cannot_take():
    """The point is a TRUER floor, not a smaller one — a column really stacked
    over another still reserves the whole of both lines' ink."""
    font = config.font_path("bachelorette", "MrDafoe-Regular.ttf")
    f, ref = rp._title_metrics(font)
    lines = ["gggg", "llll"]                 # descenders directly over ascenders
    floor = rp._min_line_pitch(f, ref, lines, 0.0, align="left")
    assert floor > 0.9, floor
    assert rp.title_pitch(f, ref, lines, 0.30, 0.0, align="left") == floor


def test_a_thicker_ring_pushes_the_floor_further_apart():
    font = config.font_path("bachelorette", "MrDafoe-Regular.ttf")
    f, ref = rp._title_metrics(font)
    lines = ["gggg", "llll"]
    bare = rp._min_line_pitch(f, ref, lines, 0.0)
    ringed = rp._min_line_pitch(f, ref, lines, 0.10, grow=0.05)
    assert ringed > bare + 0.09, (bare, ringed)


def test_title_paint_grow_is_the_sideways_half_of_the_paint():
    assert rp.title_paint_grow(0.05) == 0.05
    assert abs(rp.title_paint_grow(0.05, bold=True, bold_w=0.04) - 0.07) < 1e-9
    # a same-colour "outline" is never painted as a ring, so it spreads nothing
    assert rp.title_paint_grow(0.05, ring_visible=False) == 0.0


# --- Hebrew is measured in the order it is DRAWN -----------------------------

def test_visual_order_reverses_a_hebrew_run_and_keeps_its_digits_forward():
    # Chrome, handed direction="rtl", draws the words right to left and the
    # number inside them left to right. Pillow draws the string as given, so the
    # per-column reading has to be handed the picture, not the string.
    assert rp.visual_order("שלום", True) == "םולש"
    assert rp.visual_order("10 שנה", True).endswith("10 ")
    assert rp.visual_order("10 שנה", True)[:3] == "הנש"
    # an LTR title is untouched, whatever it says
    assert rp.visual_order("Shira's", False) == "Shira's"
    assert rp.visual_order("שלום", False) == "שלום"


def test_the_hebrew_floor_is_read_in_visual_order():
    """The final-nun of נישואין is at the LEFT of the drawn line and the 10 at
    its right; fed the logical string Pillow puts them the other way round, and
    the floor is then a reading of a picture nobody prints.

    Stated as the IDENTITY it is, rather than as "the two orders give different
    numbers". That comparison cannot carry the property: reversing both lines of
    a centred block MIRRORS it, and the widest column overlap is mirror
    invariant, so the two readings agree to within rasterizer noise by
    construction. It used to differ by 0.005 on one Pillow build and by nothing
    at all on the next, which is a coin toss, not a proof. What ``rtl=True``
    actually means is exact: measure the strings in the order they are PAINTED.
    """
    font = os.path.join(HERE, "word-fonts", "PlaypenSansHebrew-Medium.ttf")
    f, ref = rp._title_metrics(font)
    lines = ["10 שנה נישואין", "דנה ועומר"]
    drawn = [rp.visual_order(ln, True) for ln in lines]
    assert drawn != lines, "this fixture must actually be reordered"
    assert (rp._min_line_pitch(f, ref, lines, 0.0, rtl=True)
            == rp._min_line_pitch(f, ref, drawn, 0.0, rtl=False))


# --- a variable title face draws the cut the design was set in ---------------

def _as_variable(monkeypatch, axis=(100, 100, 900)):
    """Make a real font file answer as a variable one.

    The owner's variable face lives on her volume, not in the repo — and the
    behaviour under test is what the CSS says about an axis, not which file
    carries it. ``weight_axis`` is the single place the axis is read, so
    substituting its answer exercises every caller with a font CI actually has.
    """
    monkeypatch.setattr(rp, "weight_axis", lambda _path: axis)
    return os.path.join(HERE, "MrDafoe-Regular.ttf")


def test_a_variable_font_face_declares_its_range_and_its_instance(monkeypatch):
    path = _as_variable(monkeypatch)
    css = rp.font_face("TitleFont", path, 700)
    # the RANGE stops Chrome synthesising a fake bold over a 400-only face —
    # measured, that fake grows the ink 4% TALLER at the same width, which is
    # not what a heavier cut looks like...
    assert "font-weight:100 900" in css, css[:200]
    # ...and the instance is the cut the design was actually set in
    assert "font-variation-settings:'wght' 700" in css, css[:200]


def test_a_variable_font_with_no_measured_weight_keeps_its_own_default(monkeypatch):
    path = _as_variable(monkeypatch, (100, 400, 900))
    assert "font-variation-settings:'wght' 400" in rp.font_face("TitleFont", path)


def test_a_weight_outside_the_axis_is_clamped_onto_it(monkeypatch):
    path = _as_variable(monkeypatch, (300, 400, 700))
    assert "'wght' 700" in rp.font_face("TitleFont", path, 900)
    assert "'wght' 300" in rp.font_face("TitleFont", path, 100)


def test_the_real_shipped_variable_face_is_read_when_the_volume_has_it():
    """The owner's own upload, when this runs somewhere the volume is mounted.

    Skipped in CI, which has no template volume — the assertion above covers the
    behaviour; this covers the FILE, and it is the file that surprised us.
    """
    import pytest
    try:
        path = config.font_path("football-boys",
                                "LeagueSpartan-VariableFont_wght.ttf")
    except Exception:                                    # noqa: BLE001
        pytest.skip("no template volume")
    if not os.path.exists(path):
        pytest.skip("no template volume")
    assert rp.weight_axis(path) == (100, 100, 900), (
        "League Spartan's default instance is Thin — the whole reason nothing "
        "may be left to a variable font's default")


def test_a_static_font_face_is_untouched_by_any_of_this():
    path = os.path.join(HERE, "Cafe-Regular.ttf")
    assert rp.weight_axis(path) is None
    css = rp.font_face("TitleFont", path)
    assert "font-weight:400;" in css
    assert "font-variation-settings" not in css
    # ...and a weight handed to a static face changes nothing about it
    assert rp.font_face("TitleFont", path, 700) == css


# --- the WORD rows are spaced the way the DESIGN spaces them -----------------
#
# The owner, beside her סנטוריני original: "the word rows are spaced too far
# apart". They were, and the reason was the same one the title's leading had
# already been through — the floor that keeps two rows from touching was read
# off the lines' bounding BOXES, and a box is not a shape. Read column by column
# the same card asks for far less, and what then sets the card is the design's
# own row spacing: the calibrated word slots, which is where the original puts
# its four rows.
#
# Four slots on the anniversary card's real geometry — 223.92 x 312, rows 31.2
# apart, the type pinned at the size calibration measured. The words are
# constructed, not sampled: the point is the worst case, so each carries the
# deepest descenders and tallest ascenders the face has, placed so that boxed
# they overlap and columnwise they do not.
_DESIGN_PITCH_SLOTS = _slots([(100.3, 112.2, 161.8, 123.5),
                              (100.3, 143.4, 161.8, 154.7),
                              (100.3, 174.6, 161.8, 185.9),
                              (100.3, 205.8, 161.8, 217.1)])
_DESIGN_PITCH = 31.2
_DESIGN_WORD_SIZE = 24.56
# Descenders (ך ן ץ ק) and ascenders (ל) hung at opposite ends of their lines.
_SPREAD_CARD = ["קבמ", "סמבק", "קןקק", "ממקסץל"]


def _design_pitch_layouts(words):
    font, ref = _cafe()
    return rp._word_layouts(_DESIGN_PITCH_SLOTS, words, font, ref,
                            cell=_BP_CELL, word_size=_DESIGN_WORD_SIZE,
                            declared_band=True, safe=rp._CARD_SAFE,
                            room_bottom=_bp_room())


def test_the_card_lead_reads_columns_not_boxes():
    """The defect, isolated: boxed, this card demands 42% more than its ink does.

    Neither reading is arbitrary — both answer "how far apart must the baselines
    be for no ink of one row to meet the row beside it". The box answers it by
    charging the deepest descender ANYWHERE on one line against the tallest
    ascender ANYWHERE on the other, however far apart across the card the two
    sit. The column answers it where the question is actually asked.
    """
    font, ref = _cafe()
    boxed = rp._min_line_pitch_by_box(font, ref, _SPREAD_CARD, 0.0,
                                      clear=rp._WRAP_GAP)
    lead = rp._card_lead(font, ref, _SPREAD_CARD, count=4)
    assert lead < boxed * 0.7, (lead, boxed)


def test_the_card_lead_never_exceeds_the_box_reading():
    """The column reading may only ever be TIGHTER: it asks the same question of
    a subset of the pairs of ink the box charges for."""
    font, ref = _cafe()
    for words in (_SPREAD_CARD, _CARD_HAPOEL, _CARD_ARZOT,
                  ["לללל", "קקקק", "לללל", "קקקק"]):
        boxed = rp._min_line_pitch_by_box(font, ref, words, 0.0,
                                          clear=rp._WRAP_GAP)
        assert rp._card_lead(font, ref, words, count=4) <= boxed + 1e-9, words


def test_the_card_lead_still_refuses_a_pitch_the_glyphs_cannot_take():
    """A truer floor, not a smaller one: rows really stacked over one another
    still reserve the whole of both their inks."""
    font, ref = _cafe()
    stacked = rp._card_lead(font, ref, ["קקקק", "לללל"], count=2)
    assert stacked > 1.0, stacked


def test_the_card_lead_reads_the_rows_the_card_actually_stacks():
    """The pitch answers "does any ink of one row meet the row printed under
    it", so it is read off the pairs the card STACKS and no others.

    #337 asked it of every ORDERED pair, so that a re-deal of the same four words
    would report the same number. That charges a card for collisions it cannot
    have, and it is what the owner was still reading as too much air: on her
    סנטוריני front 2 the deciding pair was "חתן" over "השראה" — a stacking the
    card does not print, since השראה is set ABOVE חתן — and it opened every gap on
    the card by 9%.

    The fixture below is the same shape: one ordering stacks its deep descenders
    over its tall ascenders and must open up, the other does not and must not.
    """
    font, ref = _cafe()
    over = rp._card_lead(font, ref, ["קקקק", "לללל"], count=4)
    under = rp._card_lead(font, ref, ["לללל", "קקקק"], count=4)
    assert over > under * 1.2, (over, under)


def test_a_pair_the_card_never_stacks_does_not_set_its_pitch():
    """Stated on the owner's own card. Read over every ordered pair these four
    words demand 1.385 of the size; read in the order the card prints them they
    demand 1.070, and the design's own row spacing is what sets the card."""
    font, ref = _cafe()
    card = ["סיף", "השראה", "חתן", "אמונה"]
    printed = rp._card_lead(font, ref, card, count=4)
    every_pair = max(rp._card_lead(font, ref, [a, b], count=4)
                     for a in card for b in card if a != b)
    assert printed < every_pair, (printed, every_pair)
    assert printed == max(rp._card_lead(font, ref, [a, b], count=4)
                          for a, b in zip(card, card[1:])), printed


def test_the_markers_are_measured_over_the_digits_this_card_actually_sets():
    """The numbers are their own column — ``word_lines`` sets them as separate
    right-anchored runs a clear ``_WORD_GAP`` right of every word — so they can
    only ever meet another number, and a four-entry card reserves for "1..4",
    not for every digit a card could ever print."""
    font, ref = _cafe()
    four = rp._card_lead(font, ref, ["מ"], count=4)
    ten = rp._card_lead(font, ref, ["מ"], count=10)
    assert four <= ten, (four, ten)


def test_the_card_sets_at_the_row_spacing_the_design_uses():
    """The fix, stated as the owner reads it: our rows land where hers are.

    The calibrated slots ARE the measurement of the original — they are where
    detection found the design's four rows — so a card set at their spacing is a
    card spaced like the original. Boxed, this one could not be: its floor alone
    was 39.1 against the design's 31.2, and every gap on the card opened by 25%.
    """
    font, ref = _cafe()
    boxed = rp._min_line_pitch_by_box(font, ref, _SPREAD_CARD, 0.0,
                                      clear=rp._WRAP_GAP)
    assert boxed * _DESIGN_WORD_SIZE > _DESIGN_PITCH * 1.2, (
        "this fixture must actually reproduce the report — boxed it has to "
        f"overrun the design's spacing, got {boxed * _DESIGN_WORD_SIZE:.1f} "
        f"against {_DESIGN_PITCH}")
    for lay in _design_pitch_layouts(_SPREAD_CARD):
        assert abs(lay.lead * lay.size - _DESIGN_PITCH) < 1e-6, (
            lay.lead * lay.size, _DESIGN_PITCH)


def test_a_card_sets_at_the_design_s_spacing_when_only_an_unprinted_pair_needs_more():
    """The owner's remaining 9%, on the anniversary geometry.

    These are the four words her front 2 carries. Read over every ordered pair
    they demand more than the design's 31.2 and every gap on the card opens; read
    over the pairs the card prints they demand far less, and the card sets at the
    design's own row spacing — which is where her original puts its rows.
    """
    font, ref = _cafe()
    card = ["סיף", "השראה", "חתן", "אמונה"]
    unprinted = max(rp._card_lead(font, ref, [a, b], count=4)
                    for a in card for b in card if a != b)
    assert unprinted * _DESIGN_WORD_SIZE > _DESIGN_PITCH, (
        "this fixture must actually reproduce the report — over every ordered "
        f"pair it has to overrun the design's spacing, got "
        f"{unprinted * _DESIGN_WORD_SIZE:.1f} against {_DESIGN_PITCH}")
    for lay in _design_pitch_layouts(card):
        assert abs(lay.lead * lay.size - _DESIGN_PITCH) < 1e-6, (
            lay.lead * lay.size, _DESIGN_PITCH)


def test_a_card_whose_glyphs_really_need_more_still_gets_more():
    """The design's spacing is a preference; not touching is the rule. A card
    whose rows genuinely stack opens past the design's own pitch rather than
    printing one row into the next."""
    stacked = ["ללללל", "קקקקק", "ללללל", "קקקקק"]
    pitches = {round(lay.lead * lay.size, 6)
               for lay in _design_pitch_layouts(stacked)}
    assert len(pitches) == 1, pitches
    assert pitches.pop() > _DESIGN_PITCH, "a colliding card must open up"


# --- ONE TEXT BOX ------------------------------------------------------------
#
# The owner, on סיישל: "try to make this in 1 textbox the 3 words … so like this
# there will be no spacing between rows." Her original sets that graffiti title
# as a single block with the three words tight against each other, and the ring
# is thick enough that they weld into one mass — which is why calibration cannot
# read a line spacing off the ink at all (calibrate.leading_plateau) and why she
# had to read 0.75 off Canva by hand.
#
# What kept ours apart was never the markup. The renderer already places every
# line on one constant baseline step, which is exactly what a text box does; the
# space between the rows came from the floor that opens a title until no two
# lines' outlines touch. On a design whose outlines DO touch, that floor is the
# defect. ``one_block`` turns it off, and nothing else about the title changes —
# the arch, the per-line alignment and the per-front title boxes all still place
# the lines one at a time.

def _graffiti():
    """A ringed three-line title on the shape סיישל has."""
    font = os.path.join(HERE, "Cafe-Regular.ttf")
    f, ref = rp._title_metrics(font)
    return f, ref, ["SHIRA'S", "WELCOME", "PARTY"]


def test_one_block_stacks_the_lines_at_exactly_the_design_s_leading():
    f, ref, lines = _graffiti()
    pad = rp.title_paint_pad(0.075, 0.0, False)
    assert rp.title_pitch(f, ref, lines, 0.75, pad, one_block=True) == 0.75


def test_without_one_block_the_floor_still_opens_that_same_title():
    """The fixture has to actually reproduce the complaint: left to the floor,
    these three lines are prised apart well beyond the design's own spacing."""
    f, ref, lines = _graffiti()
    pad = rp.title_paint_pad(0.075, 0.0, False)
    opened = rp.title_pitch(f, ref, lines, 0.75, pad)
    assert opened > 0.75 * 1.15, opened


def test_one_block_cannot_invent_a_spacing_the_design_never_stated():
    """It suppresses the floor; it is not itself a spacing. A title with no
    measured leading still gets the renderer's own step, flag or no flag."""
    f, ref, lines = _graffiti()
    assert rp.title_pitch(f, ref, lines, None, 0.0, one_block=True) == rp.RENDER_PITCH


_ARC_START_Y = re.compile(r'd="M [-\d.]+ ([-\d.]+)')


def test_one_block_reaches_the_rendered_title_block():
    """End to end through the markup the card prints: the same title, once with
    the flag and once without, and the flagged one stacks tighter."""
    font = os.path.join(HERE, "Cafe-Regular.ttf")
    box = {"x0": 20.0, "y0": 20.0, "x1": 440.0, "y1": 280.0}
    lines = ["SHIRA'S", "WELCOME", "PARTY"]

    def baselines(one_block):
        rp._TITLE_UID[0] = 0
        block = rp.title_block(box, lines, "#97d8e6", "#0d3e43", font,
                               0.075, 0.0, False, leading=0.75,
                               one_block=one_block)
        return sorted({float(v) for v in _ARC_START_Y.findall(block)})

    tight, loose = baselines(True), baselines(False)
    assert len(tight) == len(loose) == 3, (tight, loose)
    step_t = tight[1] - tight[0]
    step_l = loose[1] - loose[0]
    assert step_t < step_l, (step_t, step_l)
    # ...and a text box's lines sit one CONSTANT step apart, which is what makes
    # placing them individually the same picture as wrapping one element. To the
    # tenth of a unit the path coordinates are written at.
    assert abs((tight[2] - tight[1]) - step_t) <= 0.11, tight


def test_one_block_is_off_everywhere_it_was_not_derived():
    """It is opt-in per template, never a global change: every other shipped
    design still gets the floor."""
    shipped = json.load(open(os.path.join(HERE, "themes.json"), encoding="utf-8"))
    flagged = [k for k, e in shipped.items()
               if (e.get("title_style") or {}).get("one_block")]
    assert len(flagged) <= 1, flagged


# --- the collision rule for WORD ROWS, proved on the RENDERED card -----------
#
# The same standard the title's leading is held to (see the section above), now
# that the word pitch is read off the design instead of off a bounding-box
# reserve. Every shipped template is laid out through the production path, its
# rows are drawn on separate layers through the SAME headless Chrome the cards
# are printed with, and the rendered pixels are asked whether any two rows meet.
#
# The words are CONSTRUCTED, not sampled. A card carries whatever four words a
# customer sends, so the proof has to be against the worst four that can be
# built out of the face: a Hebrew line's ink reaches furthest below its baseline
# on a final kaf/nun/pe/tsadi/qof and furthest above it on a lamed, so the rows
# alternate long runs of the two — every descender of one row directly over an
# ascender of the next, which is precisely the case a per-column reading must
# not get wrong. They are also long enough to wrap, so the gaps INSIDE an entry
# are proved beside the gaps between two.
_COLLIDE_WORDS = ["ךןףץקךןףץק", "לללללללללל", "קץףןךקץףןך", "ללללללללל"]

# Every <text> in a numbered row carries the baseline it is set on, so the row a
# run belongs to is written into the markup rather than guessed from the order
# (each row emits a digit run, a stop run and the word itself).
_TEXT_Y_RE = re.compile(r'<text[^>]*\by="([-\d.]+)"')


def _row_layers(overlay):
    """``overlay``'s markup, once per printed ROW, with only that row's runs."""
    per = {}
    for el in _TEXT_RE.findall(overlay):
        m = _TEXT_Y_RE.search(el)
        if m:
            per.setdefault(round(float(m.group(1)), 2), []).append(el)
    return [(y, "".join(per[y])) for y in sorted(per)]


def test_no_two_word_rows_touch_on_any_template():
    import tempfile
    import pytest
    from PIL import ImageChops, ImageFilter
    SCALE = 3
    d = tempfile.mkdtemp(prefix="dugri-wordtest-")
    shipped = json.load(open(os.path.join(HERE, "themes.json"), encoding="utf-8"))
    checked = 0
    for key, entry in sorted(shipped.items()):
        try:
            cfg = config.theme(key)
            word_font = config.resolve_word_font(key, None)
            recipe = config.load_recipe(cfg["recipe"])
        except Exception:                                    # noqa: BLE001
            continue
        card = recipe.get("card")
        if not isinstance(card, dict) or not card.get("words"):
            continue                       # v1 sheet: its lines ARE its slots
        cell = card["cell"]
        slots = config.card_word_boxes(cfg, recipe, cell)
        if not slots or len(slots) < 2:
            continue
        safe_bottom = cell[3] - (cell[3] - cell[1]) * rp._CARD_SAFE
        try:
            art = open(config.card_path(key, config.fronts(cfg)[0]),
                       encoding="utf-8").read()
        except Exception:                                    # noqa: BLE001
            art = ""
        room = rp.room_bottom(key, config.fronts(cfg)[0], art, cell, safe_bottom)
        overlay = rp._words_overlay(slots, _COLLIDE_WORDS, cfg, word_font, cell,
                                    room=room)
        rows = _row_layers(overlay)
        assert len(rows) >= len(slots), f"{key}: only {len(rows)} rows drawn"
        W, H = int(cell[2] - cell[0]), int(cell[3] - cell[1])
        masks = []
        for i, (_y, body) in enumerate(rows):
            svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" '
                   f'height="{H}" viewBox="{cell[0]} {cell[1]} {W} {H}">'
                   f'<style>{rp.font_face("HebWord", word_font)}</style>'
                   f'<rect x="{cell[0]}" y="{cell[1]}" width="{W}" height="{H}" '
                   f'fill="white"/>{body}</svg>')
            masks.append(_chrome_mask(svg, W, H, SCALE,
                                      os.path.join(d, f"{key}-w{i}.png")))
        for i, m in enumerate(masks):
            assert m.getbbox(), f"{key}: word row {i} rendered nothing at all"
        # Neighbours only: three rows can stand clear at the top of the card and
        # weld at the bottom. Each layer is grown a pixel first, because Chrome's
        # antialiased rim welds two glyphs that merely abut (#329).
        for i, (a, b) in enumerate(zip(masks, masks[1:])):
            hit = ImageChops.multiply(a.filter(ImageFilter.MaxFilter(3)),
                                      b).getbbox()
            assert not hit, (
                f"{key}: word rows {i} and {i + 1} touch — their ink meets "
                f"around {hit}")
        checked += 1
    if not checked:
        pytest.skip("no single-card template with declared word slots available")
    assert checked >= 1


# --- the ruler has to be the same ruler on every machine ---------------------
#
# Pillow lays text out with one of two engines, and which one you get is decided
# by the WHEEL: the manylinux builds bundle Raqm, the macOS ones do not. BASIC
# walks the string in logical order; RAQM runs the Unicode bidi algorithm and
# reorders a Hebrew run itself.
#
# Every reading in this module compensates for BASIC — ``visual_order`` exists
# precisely to put a string into paint order by hand, because Pillow will not.
# Hand that already-reordered string to RAQM and it is reordered a SECOND time,
# and the measurement is taken of a picture nothing ever prints. Caught by CI:
# the same four Hebrew words measured a 0.92 row floor on a Raqm-less laptop and
# 1.49 on a Raqm CI runner — a 62% difference in the number that decides how far
# apart a card's rows sit, from nothing but the installed wheel.

def test_every_font_this_module_measures_with_is_pinned_to_one_layout_engine():
    from PIL import ImageFont
    cafe = os.path.join(HERE, "word-fonts", "Cafe Regular.ttf")
    for f, _ref in (rp._word_metrics(cafe), rp._title_metrics(cafe)):
        assert f.layout_engine == ImageFont.Layout.BASIC, f.layout_engine


def test_the_row_floor_does_not_depend_on_which_pillow_wheel_is_installed():
    """The value itself, so a regression shows up as the number that moved."""
    font, ref = rp._word_metrics(os.path.join(HERE, "word-fonts",
                                              "Cafe Regular.ttf"))
    assert abs(rp._card_lead(font, ref, _SPREAD_CARD, count=4) - 0.92) < 0.01
