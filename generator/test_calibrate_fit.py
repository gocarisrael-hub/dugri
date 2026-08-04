#!/usr/bin/env python3
"""Tests for the AUTO-FIT half of generator/calibrate.py.

The fits answer "what size, and what weight, did the ORIGIN print at" by painting
our own font at candidate values until its ink matches the origin's. That makes
them testable without any artwork and without a browser: paint a known value,
hand the result back as if it were the origin's ink, and the fit must return the
value it was painted at. Everything below is that round trip, plus the refusals —
which matter more than the fits, because a wrong pinned size is worse than none.

Run: python3 -m pytest generator/test_calibrate_fit.py -q
"""
import os

from PIL import Image

import calibrate as C

HERE = os.path.dirname(os.path.abspath(__file__))
# Two fonts that ship in the repo for exactly this kind of measurement: one with
# Hebrew glyphs and one Latin-only (which is what makes the coverage test real).
HEBREW_FONT = os.path.join(HERE, "Cafe-Regular.ttf")
LATIN_FONT = os.path.join(HERE, "MrDafoe-Regular.ttf")

PPU = 2.0
ALPHA = 128
LINES = ["מסיבה גדולה"]


def _origin(ink, ppu=PPU, pad=60):
    """An ink mask + white artwork + the recipe box, as the fits see them.

    ``pad`` keeps the ink well clear of the crop's edges, which is what the real
    thing looks like: the recipe box is a region the origin's text sits inside.
    """
    mask = Image.new("L", (ink.size[0] + 2 * pad, ink.size[1] + 2 * pad), 0)
    mask.paste(ink, (pad, pad))
    image = Image.new("RGB", mask.size, (255, 255, 255))
    box = {"x0": pad / ppu, "y0": pad / ppu,
           "x1": (pad + ink.size[0]) / ppu, "y1": (pad + ink.size[1]) / ppu}
    return mask, image, box


# ---- the size round trip ----------------------------------------------------


def test_the_fit_returns_the_size_the_ink_was_painted_at():
    for size in (14.0, 24.0, 40.0):
        ink = C._paint(HEBREW_FONT, LINES, size * PPU, ALPHA)
        got = C._fit_size(ink.size[1], HEBREW_FONT, [LINES], PPU, ALPHA)
        assert abs(got - size) <= 0.5, (size, got)


def test_a_whole_surface_fit_returns_that_size_and_grades_it_high():
    # Both axes are fitted from the SAME painting here, so they agree exactly —
    # which is the "the theme's font really is the design's font" case.
    size = 26.0
    ink = C._paint(HEBREW_FONT, LINES, size * PPU, ALPHA)
    mask, image, box = _origin(ink)
    got, grade, note, ctx = C.fit_title_size(mask, image, box, PPU, 0.0, 0.0,
                                             HEBREW_FONT, [LINES], "#000000")
    assert abs(got - size) <= 0.5, got
    assert grade == "high" and note is None
    assert ctx and len(ctx) == 2


# ---- the LEADING, solved beside the size ------------------------------------
#
# A design stacks its title lines at its own spacing, the renderer at a fixed
# 0.78. Fitting the BLOCK's height with the renderer's step charges the whole
# difference to the size, which is every one of the multi-line errors measured
# against the owner's Canva numbers. So the leading is solved for as well.

_TWO = [["נעמה", "מסיבה גדולה"]]


def test_a_title_set_tighter_or_looser_than_the_renderer_still_fits_its_size():
    for leading in (0.55, 0.78, 1.30):
        size = 24.0
        ink = C._paint(HEBREW_FONT, _TWO[0], size * PPU, ALPHA, pitch=leading)
        got, found, _score = C.solve_size_and_leading(
            ink, HEBREW_FONT, _TWO, PPU, ALPHA)
        assert abs(got - size) / size <= 0.03, (leading, size, got)
        assert abs(found - leading) <= 0.06, (leading, found)


def test_the_old_single_bisection_would_have_missed_those_sizes():
    """The point of the pair: with the renderer's own step assumed, a title set
    at another spacing reports a size that is wrong by the whole difference."""
    size = 24.0
    ink = C._paint(HEBREW_FONT, _TWO[0], size * PPU, ALPHA, pitch=1.30)
    naive = C._fit_size(ink.size[1], HEBREW_FONT, _TWO, PPU, ALPHA)
    assert naive > size * 1.15, naive


def test_a_single_line_title_keeps_the_renderers_own_step():
    # There is no leading to solve for, so this stays the one bisection that
    # shipped — which is why the single-line templates do not move.
    ink = C._paint(HEBREW_FONT, LINES, 26.0 * PPU, ALPHA)
    got, found, score = C.solve_size_and_leading(
        ink, HEBREW_FONT, [LINES], PPU, ALPHA)
    assert found == C.RENDER_PITCH and score is None
    assert abs(got - 26.0) <= 0.5, got


def test_a_leading_unlike_the_renderers_is_reported_to_the_owner():
    size = 24.0
    ink = C._paint(HEBREW_FONT, _TWO[0], size * PPU, ALPHA, pitch=1.30)
    mask, image, box = _origin(ink)
    got, grade, note, _ctx = C.fit_title_size(
        mask, image, box, PPU, 0.0, 0.0, HEBREW_FONT, _TWO, "#000000")
    assert abs(got - size) / size <= 0.03, got
    assert grade in ("high", "medium")
    assert note and "stacks its title lines" in note


def test_the_profile_match_compares_shape_and_not_amount():
    # The origin says another honoree's name, so the AMOUNT of ink can never
    # agree; where down the block it sits can.
    a = [0, 4, 8, 4, 0, 0, 2, 6, 2]
    assert C._profile_match(a, a) > 0.99
    assert C._profile_match(a, [2 * v for v in a]) > 0.99
    assert C._profile_match(a, list(reversed(a))) < 0.85


def test_the_word_fit_returns_the_size_its_rows_were_painted_at():
    size = 18.0
    words = ["מסיבה", "חברים", "ריקודים", "צחוקים"]
    rows = [C._paint(HEBREW_FONT, [w], size * PPU, ALPHA, marker=i + 1)
            for i, w in enumerate(words)]
    width = max(r.size[0] for r in rows)
    pad, gap = 40, 30
    mask = Image.new("L", (width + 2 * pad,
                           sum(r.size[1] for r in rows) + gap * 5), 0)
    slots, y = [], gap
    for row in rows:
        mask.paste(row, (pad, y))
        slots.append({"x0": pad / PPU, "y0": y / PPU,
                      "x1": (pad + row.size[0]) / PPU,
                      "y1": (y + row.size[1]) / PPU, "color": "#000000"})
        y += row.size[1] + gap
    image = Image.new("RGB", mask.size, (255, 255, 255))
    got, grade, note = C.fit_word_size(mask, image, slots, PPU, 0.0, 0.0,
                                       HEBREW_FONT, words)
    assert abs(got - size) <= 1.0, got
    # The grade is now how far the FOUR ROWS disagree, which is a real question
    # about the artwork, rather than a blanket "low" that dropped every fit and
    # left the words auto-fitting from a constant. Four rows set at one size —
    # which is what these are — must agree, so this must not grade itself out.
    assert grade in ("high", "medium"), (grade, note)
    assert "word_size" in note


def test_a_word_font_lighter_than_the_design_is_named_not_swallowed():
    """There is no word-weight knob, so this cannot be calibrated away — which is
    precisely why it must be said. Otherwise the size measures perfectly, the
    words still print lighter than the original, and nothing tells the owner that
    the font FILE is the wrong cut.

    Built by painting the "origin" with a synthetic stroke our own cut has no way
    to reach."""
    size, words = 18.0, ["מסיבה", "חברים", "ריקודים", "צחוקים"]

    def sheet(stroke):
        rows = [C._paint(HEBREW_FONT, [w], size * PPU, ALPHA, stroke=stroke,
                         marker=i + 1) for i, w in enumerate(words)]
        pad, gap = 40, 30
        width = max(r.size[0] for r in rows)
        mask = Image.new("L", (width + 2 * pad,
                               sum(r.size[1] for r in rows) + gap * 5), 0)
        regions, y = [], gap
        for row in rows:
            mask.paste(row, (pad, y))
            regions.append((pad, y, pad + row.size[0], y + row.size[1]))
            y += row.size[1] + gap
        return mask, regions

    mask, regions = sheet(2.0)
    said = C.word_weight_gap(mask, regions, HEBREW_FONT, words, size, PPU, ALPHA)
    assert said and "LIGHTER cut" in said, said
    # ...and the same face against itself says nothing at all.
    mask, regions = sheet(0.0)
    assert C.word_weight_gap(mask, regions, HEBREW_FONT, words, size, PPU,
                             ALPHA) is None


# ---- the refusals -----------------------------------------------------------


def test_no_ink_is_measured_as_nothing_rather_than_as_a_size():
    blank = Image.new("L", (200, 120), 0)
    image = Image.new("RGB", blank.size, (255, 255, 255))
    box = {"x0": 10, "y0": 10, "x1": 90, "y1": 50}
    assert C._ink_extent(blank, box, PPU, 0.0, 0.0) is None
    got, grade, _note, ctx = C.fit_title_size(blank, image, box, PPU, 0.0, 0.0,
                                              HEBREW_FONT, [LINES], "#000000")
    assert got is None and grade is None and ctx is None


def test_ink_that_runs_off_the_crop_is_refused_rather_than_measured():
    # A neighbouring line bleeding into the crop (or a filled/clean pair that
    # differs across the whole surface) makes the "ink height" the crop's height.
    # Then the number describes the crop, not the text, and must not be written.
    ink = C._paint(HEBREW_FONT, LINES, 24 * PPU, ALPHA)
    mask, _image, box = _origin(ink, pad=60)
    assert C._ink_extent(mask, box, PPU, 0.0, 0.0) is not None
    bleed = mask.copy()
    bleed.paste(ink, (60, 60 + int(ink.size[1] * 1.2)))
    assert C._ink_extent(bleed, box, PPU, 0.0, 0.0) is None


def test_a_size_that_is_absurd_for_its_box_is_left_unset():
    # The bound is against the box the ink was measured in: a title that fits a
    # box 30x its own height was never that box's title.
    assert C._in_box(24.0, 26.0)
    assert not C._in_box(24.0, 600.0)
    assert not C._in_box(240.0, 26.0)
    ink = C._paint(HEBREW_FONT, LINES, 24 * PPU, ALPHA)
    mask, image, box = _origin(ink, pad=600)
    box["y1"] = box["y0"] + 600.0
    got, grade, note, _ctx = C.fit_title_size(mask, image, box, PPU, 0.0, 0.0,
                                              HEBREW_FONT, [LINES], "#000000")
    assert got is None and grade is None and "plausible" in note


def test_a_font_that_cannot_draw_the_title_is_refused_not_measured():
    # Chrome silently falls back to a system face for missing glyphs, so a fit
    # against such a sample would measure a typeface the generator never uses.
    assert C._covers(HEBREW_FONT, "מסיבה")
    assert C._covers(LATIN_FONT, "Dana's")
    assert not C._covers(LATIN_FONT, "מסיבה")
    ink = C._paint(HEBREW_FONT, LINES, 24 * PPU, ALPHA)
    mask, image, box = _origin(ink)
    got, grade, note, _ctx = C.fit_title_size(mask, image, box, PPU, 0.0, 0.0,
                                              LATIN_FONT, [LINES], "#000000")
    assert got is None and grade is None and "no glyphs" in note


def test_the_word_fit_refuses_degenerate_input():
    blank = Image.new("L", (200, 200), 0)
    image = Image.new("RGB", blank.size, (255, 255, 255))
    slot = {"x0": 10, "y0": 10, "x1": 80, "y1": 30, "color": "#000000"}
    assert C.fit_word_size(blank, image, [], PPU, 0, 0, HEBREW_FONT, ["a"])[0] is None
    assert C.fit_word_size(blank, image, [slot], PPU, 0, 0, HEBREW_FONT, [])[0] is None
    got, grade, note = C.fit_word_size(blank, image, [slot, slot], PPU, 0, 0,
                                       HEBREW_FONT, ["מסיבה"])
    assert got is None and grade is None and "auto-fit" in note


# ---- bold ------------------------------------------------------------------


def _weigh(stroke, size=26.0):
    ink = C._paint(HEBREW_FONT, LINES, size * PPU, ALPHA, stroke=stroke * size * PPU)
    mask, _image, _box = _origin(ink)
    region = (60, 60, 60 + ink.size[0], 60 + ink.size[1])
    return C.fit_bold(mask, region, HEBREW_FONT, [LINES], size, PPU, ALPHA)


def test_bold_is_not_set_for_a_design_whose_weight_already_matches():
    # The one outcome this must never produce: emboldening a design that is not
    # bold. Here the "origin" IS our own unfattened cut.
    bold, weight, note = _weigh(0.0)
    assert bold is False and weight is None and note is None


def test_bold_recovers_the_weight_the_origin_was_fattened_by():
    bold, weight, note = _weigh(0.05)
    assert bold is True and note is None
    # Within one grid step: the synthetic stroke is painted in WHOLE device
    # pixels, so at a card-sized title one step is worth ~0.014 of the glyph.
    assert abs(weight - 0.05) <= 0.015, weight


def test_a_weight_no_amount_of_stroke_can_reach_is_left_unset():
    # A face far lighter than the design's is a font problem, not a weight knob,
    # and fattening a hairline into a blob would not fix it.
    bold, weight, note = _weigh(0.30)
    assert bold is None and weight is None and "lighter cut" in note


def test_the_search_stays_under_the_weight_that_closes_hebrew_counters():
    assert max(C._BOLD_W_GRID) <= 0.08
    assert min(C._BOLD_W_GRID) == 0.0


# ---- the raster is thresholded the way the origin's ink was ------------------


def test_the_alpha_threshold_tracks_how_far_the_ink_sits_from_its_background():
    # Pale ink on a pale background survives the diff only where it is nearly
    # opaque, so the candidate raster has to be cut at a HIGHER alpha than dark
    # ink on white would be.
    dark = C._alpha_threshold("#000000", (255, 255, 255))
    pale = C._alpha_threshold("#dddddd", (255, 255, 255))
    assert dark < pale
    assert 20 <= dark <= 160 and 20 <= pale <= 160
    # Ink the same colour as its background carries no signal at all.
    assert C._alpha_threshold("#ffffff", (255, 255, 255)) == 128
    assert C._alpha_threshold(None, (255, 255, 255)) == 128


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")


# --- a low-confidence fit is never written -----------------------------------
# Detection PROPOSES; it must not propose what it does not believe. Measured
# against grapefruit's Canva original, two of the four fitters are not good
# enough yet — word_size fitted 14.81 against a truth of 21.3, and is WORSE than
# the existing box-height heuristic (20.72). Both grade themselves low, so the
# grade is honoured rather than the number shipped.

def test_a_low_confidence_fit_is_dropped():
    out = {"title_style": {"size": 27.56, "bold": True, "bold_w": 0.015}, "word_size": 14.81}
    conf = {
        "title_style.size": "low",
        "title_style.bold": "medium",
        "title_style.bold_w": "low",
        "word_size": "low",
    }
    notes = []
    C._drop_low_confidence(out, conf, notes)
    assert "size" not in out["title_style"]
    assert "bold_w" not in out["title_style"]
    assert "word_size" not in out
    # ...and the one it DOES believe survives.
    assert out["title_style"]["bold"] is True
    assert conf["title_style.bold"] == "medium"


def test_dropping_says_so_in_the_notes():
    out = {"title_style": {"size": 9.9}, "word_size": 1.0}
    conf = {"title_style.size": "low", "word_size": "low"}
    notes = []
    C._drop_low_confidence(out, conf, notes)
    assert notes and "auto-fit" in notes[0]
    assert "title_style.size" in notes[0] and "word_size" in notes[0]


def test_high_and_medium_fits_are_kept():
    out = {"title_style": {"size": 28.0, "bold": True}, "word_size": 21.3}
    conf = {"title_style.size": "high", "title_style.bold": "medium", "word_size": "medium"}
    dropped = C._drop_low_confidence(out, conf, [])
    assert dropped == []
    assert out["title_style"]["size"] == 28.0
    assert out["word_size"] == 21.3


# --- re-detecting may never leave a template worse than it was ---------------
# "זהה מחדש" re-measures from the artwork, and a measurement can come back empty.
# title_style is written to the theme as a WHOLE dict, so a knob missing from the
# new blob is ERASED and that surface silently reverts to auto-fit — a button
# called "detect again" undoing a calibration the owner had signed off.

def test_a_knob_this_pass_could_not_measure_keeps_its_calibrated_value():
    out = {"title_style": {"fill": "#111111"}, "word_size": None}
    cfg = {"title_style": {"size": 28.0, "back_size": 23.4, "outline_w": 0.05},
           "word_size": 21.3}
    notes, conf = [], {}
    kept = C._carry_forward(out, cfg, notes, conf)
    assert out["title_style"]["size"] == 28.0
    assert out["title_style"]["back_size"] == 23.4
    assert out["title_style"]["outline_w"] == 0.05
    assert out["word_size"] == 21.3
    assert len(kept) == 4
    # Flagged with a level the admin form actually reacts to — an inherited
    # value is one for the owner to check, and a level the form does not
    # recognise would present it as a confident fresh reading.
    assert conf["word_size"] == "low"
    assert notes and "KEPT" in notes[0]


def test_a_carried_value_is_not_then_dropped_as_low_confidence():
    """Order matters: the low-confidence drop runs BEFORE the carry, so marking
    a carried value "low" must not feed it back into the shredder."""
    out = {"title_style": {}, "word_size": None}
    cfg = {"title_style": {"size": 28.0}, "word_size": 21.3}
    conf, notes = {}, []
    C._carry_forward(out, cfg, notes, conf)
    C._drop_low_confidence(out, conf, notes)
    assert out["title_style"]["size"] == 28.0
    assert out["word_size"] == 21.3


def test_a_fresh_measurement_always_beats_the_carried_one():
    """The guard fills gaps. It must never be able to freeze a template against
    a better reading, or every future improvement would stop at the first
    calibration the template ever got."""
    out = {"title_style": {"size": 31.0}, "word_size": 19.0}
    cfg = {"title_style": {"size": 28.0}, "word_size": 21.3}
    kept = C._carry_forward(out, cfg, [], {})
    assert kept == []
    assert out["title_style"]["size"] == 31.0
    assert out["word_size"] == 19.0


def test_nothing_is_invented_for_a_template_with_no_calibration_yet():
    out = {"title_style": {}, "word_size": None}
    kept = C._carry_forward(out, {"title_style": {}}, [], {})
    assert kept == []
    assert "size" not in out["title_style"] and out["word_size"] is None
