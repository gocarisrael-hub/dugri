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
    got, grade, note, ctx, lead = C.fit_title_size(mask, image, box, PPU, 0.0, 0.0,
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
    # shipped — which is why the single-line templates do not move. It reports
    # its leading as None rather than as the renderer's own number: the renderer
    # must be left on its default step, and pinning 0.78 into the theme would
    # claim a measurement that was never taken.
    ink = C._paint(HEBREW_FONT, LINES, 26.0 * PPU, ALPHA)
    got, found, score = C.solve_size_and_leading(
        ink, HEBREW_FONT, [LINES], PPU, ALPHA)
    assert found is None and score is None
    assert abs(got - 26.0) <= 0.5, got


def test_the_fit_answers_over_the_sample_names_the_artwork_looks_like():
    """The artwork carries ONE honoree name; the samples straddle the extremes.

    A Hebrew line with a lamed is much taller than one without, so a median over
    the whole spread charges the size with the difference between the original's
    name and ours — three percent under Canva on ברוקלין. The row profile can
    tell which samples the artwork is like, so the fit answers over those.

    Built as the real case: an "original" painted in a name with NO ascender,
    fitted against four samples of which half carry one.
    """
    size = 26.0
    plain = ["חן בן 30"]
    tall = ["לירן בן 30"]
    samples = [plain, tall, ["דן בן 30"], ["לילך בן 30"]]
    ink = C._paint(HEBREW_FONT, plain, size * PPU, ALPHA)
    naive = C._fit_size(ink.size[1], HEBREW_FONT, samples, PPU, ALPHA)
    matched = C.size_from_matching_samples(ink, HEBREW_FONT, samples, PPU, ALPHA,
                                           0.0, None)
    # The ascender-carrying samples paint taller ink, so the blanket median fits
    # the size DOWN; matching must land closer to what the ink was painted at.
    assert abs(C._paint(HEBREW_FONT, tall, size * PPU, ALPHA).size[1]
               - ink.size[1]) > 2, "the samples must differ in ink height"
    assert abs(matched - size) < abs(naive - size), (naive, matched)
    assert abs(matched - size) / size <= 0.03, matched


def test_matching_cannot_let_one_sample_decide():
    """It stays a MEDIAN over the better-matching half, never a single pick.

    With four samples the half is two, so the answer is their midpoint — a lone
    sample that matches best cannot carry the size on its own.
    """
    size = 22.0
    samples = [["נעמה"], ["לירן"], ["יונתן"], ["לירון"]]
    ink = C._paint(HEBREW_FONT, samples[0], size * PPU, ALPHA)
    got = C.size_from_matching_samples(ink, HEBREW_FONT, samples, PPU, ALPHA,
                                       0.0, None)
    each = sorted(C._fit_size(ink.size[1], HEBREW_FONT, [s], PPU, ALPHA)
                  for s in samples)
    assert each[0] <= got <= each[-1], (each, got)


def test_a_title_with_no_name_in_it_cannot_be_moved_by_matching():
    # קופקבנה's title says the same thing whoever the honoree is, so its four
    # samples are identical and the matching pass has nothing to choose between.
    samples = [LINES, LINES, LINES, LINES]
    ink = C._paint(HEBREW_FONT, LINES, 24.0 * PPU, ALPHA)
    assert (C.size_from_matching_samples(ink, HEBREW_FONT, samples, PPU, ALPHA,
                                         0.0, None)
            == C._fit_size(ink.size[1], HEBREW_FONT, samples, PPU, ALPHA))


def test_the_leading_is_scored_at_the_size_the_fit_answers_over_every_name():
    """The block painted for the profile score is painted AT the candidate size.

    So bisecting that size against one sample name let that name decide the
    spacing after all — the very thing scoring over every name exists to prevent
    — and scored a (size, leading) pair the fit would never return.

    Built as a two-line block set at a leading the renderer does not use, with a
    first line whose name is NOT the one that comes first in the samples.
    """
    size, leading = 24.0, 1.10
    origin = ["לירון", "מסיבה גדולה"]
    samples = [["נעמה", "מסיבה גדולה"], origin,
               ["דן", "מסיבה גדולה"], ["לילך", "מסיבה גדולה"]]
    ink = C._paint(HEBREW_FONT, origin, size * PPU, ALPHA, pitch=leading)
    got, found, _score = C.solve_size_and_leading(ink, HEBREW_FONT, samples,
                                                  PPU, ALPHA)
    assert abs(found - leading) <= 0.06, found
    assert abs(got - size) / size <= 0.03, got


def test_a_leading_unlike_the_renderers_is_reported_to_the_owner():
    size = 24.0
    ink = C._paint(HEBREW_FONT, _TWO[0], size * PPU, ALPHA, pitch=1.30)
    mask, image, box = _origin(ink)
    got, grade, note, _ctx, _lead = C.fit_title_size(
        mask, image, box, PPU, 0.0, 0.0, HEBREW_FONT, _TWO, "#000000")
    assert abs(got - size) / size <= 0.03, got
    assert grade in ("high", "medium")
    assert note and "stacks its title lines" in note


def test_the_measured_leading_comes_back_out_with_the_size():
    # Measuring the spacing is only half the job — it has to LEAVE the fit, or
    # the renderer goes on stacking at 0.78 and the size that was measured with
    # the design's own spacing prints at the wrong one.
    size = 24.0
    ink = C._paint(HEBREW_FONT, _TWO[0], size * PPU, ALPHA, pitch=1.30)
    mask, image, box = _origin(ink)
    _got, _grade, _note, _ctx, lead = C.fit_title_size(
        mask, image, box, PPU, 0.0, 0.0, HEBREW_FONT, _TWO, "#000000")
    assert lead is not None and abs(lead - 1.30) <= 0.06, lead
    # ...and a single-line title reports None, so the theme is left without a
    # leading and the renderer keeps its own step.
    one = C._paint(HEBREW_FONT, LINES, size * PPU, ALPHA)
    mask, image, box = _origin(one)
    *_rest, lead = C.fit_title_size(mask, image, box, PPU, 0.0, 0.0,
                                    HEBREW_FONT, [LINES], "#000000")
    assert lead is None


def test_the_search_may_report_a_leading_tighter_than_the_lines_can_be_drawn():
    # The grid's floor used to be a PHYSICAL claim — "below half the type size
    # the lines would overprint" — asserted inside the measurement, where it
    # cannot be checked. render_page.title_pitch enforces it where it can be, so
    # the search is free to report what the ink says. It matters: סנטוריני's
    # back's optimum was sitting ON the old 0.50 rail and reads 0.48.
    assert C._PITCH_GRID[0] <= 0.30, C._PITCH_GRID[0]
    assert C._PITCH_GRID[-1] >= 2.0, C._PITCH_GRID[-1]
    size = 24.0
    ink = C._paint(HEBREW_FONT, _TWO[0], size * PPU, ALPHA, pitch=0.42)
    got, found, _score = C.solve_size_and_leading(
        ink, HEBREW_FONT, _TWO, PPU, ALPHA)
    assert abs(found - 0.42) <= 0.06, found
    assert abs(got - size) / size <= 0.03, got
    # ...and the renderer will not DRAW it that tight: the clamp opens it to what
    # these glyphs need, so the measurement stays honest and the card stays legible.
    import render_page as rp
    f, ref = rp._title_metrics(HEBREW_FONT)
    assert rp.title_pitch(f, ref, _TWO[0], found, 0.0) > found


def test_a_leading_already_settled_is_used_rather_than_searched_again():
    # A caller that already knows the spacing must be able to say so and get the
    # size fitted at it rather than pay for the grid again — and get back the
    # spacing it gave, so the size and the number it was measured at stay one
    # answer however the fit was reached.
    size = 24.0
    ink = C._paint(HEBREW_FONT, _TWO[0], size * PPU, ALPHA, pitch=1.30)
    got, found, score = C.solve_size_and_leading(
        ink, HEBREW_FONT, _TWO, PPU, ALPHA, pitch=1.30)
    assert found == 1.30 and score is None, "the grid must not have been swept"
    assert abs(got - size) / size <= 0.03, got
    # Handed the WRONG spacing it must not quietly re-solve: it answers at the
    # spacing it was given, which is what keeps the deck's surfaces consistent.
    _got2, found2, _ = C.solve_size_and_leading(
        ink, HEBREW_FONT, _TWO, PPU, ALPHA, pitch=0.78)
    assert found2 == 0.78


def test_the_calibrators_and_the_renderers_block_are_the_same_block():
    # The number only means anything if both sides stack the lines the same way.
    # The calibrator paints with PIL and the renderer emits SVG baselines, and
    # the two do not measure a block's ABSOLUTE height alike — the renderer's
    # is a deliberate over-estimate, taking the tallest ascender and the deepest
    # descender from ANY line so a middle line can never spill. What they must
    # agree on is what the LEADING does: one step of spacing has to move the
    # block by the same amount, or a leading measured off the artwork would
    # print as a different one.
    import render_page as rp
    f, ref = rp._title_metrics(HEBREW_FONT)
    size, n = 30.0, len(_TWO[0])
    base = C._paint(HEBREW_FONT, _TWO[0], size * PPU, ALPHA, pitch=0.78)
    for pitch in (0.60, 1.00, 1.30):
        ink = C._paint(HEBREW_FONT, _TWO[0], size * PPU, ALPHA, pitch=pitch)
        want = (pitch - 0.78) * size * PPU * (n - 1)
        assert abs((ink.size[1] - base.size[1]) - want) <= 2, (
            pitch, ink.size[1], base.size[1], want)
        # the renderer's own model moves by exactly the same amount
        moved = (rp._title_ink_stack(f, ref, _TWO[0], pitch)
                 - rp._title_ink_stack(f, ref, _TWO[0], 0.78)) / ref * size * PPU
        assert abs(moved - want) < 1e-6, (pitch, moved, want)


def test_the_profile_match_compares_shape_and_not_amount():
    # The origin says another honoree's name, so the AMOUNT of ink can never
    # agree; where down the block it sits can.
    a = [0, 4, 8, 4, 0, 0, 2, 6, 2]
    assert C._profile_match(a, a) > 0.99
    assert C._profile_match(a, [2 * v for v in a]) > 0.99
    assert C._profile_match(a, list(reversed(a))) < 0.85


def _word_surface(words, size, marker_from=1):
    """One front's ``(mask, image, slots, ppu, ox, oy)`` painted at ``size``."""
    rows = [C._paint(HEBREW_FONT, [w], size * PPU, ALPHA, marker=marker_from + i)
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
    return (mask, image, slots, PPU, 0.0, 0.0)


def test_the_word_fit_returns_the_size_its_rows_were_painted_at():
    size = 18.0
    words = ["מסיבה", "חברים", "ריקודים", "צחוקים"]
    got, grade, note = C.fit_word_size([_word_surface(words, size)],
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
    got, grade, _note, ctx, _lead = C.fit_title_size(blank, image, box, PPU, 0.0, 0.0,
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
    got, grade, note, _ctx, _lead = C.fit_title_size(mask, image, box, PPU, 0.0, 0.0,
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
    got, grade, note, _ctx, _lead = C.fit_title_size(mask, image, box, PPU, 0.0, 0.0,
                                                     LATIN_FONT, [LINES], "#000000")
    assert got is None and grade is None and "no glyphs" in note


def test_the_word_fit_refuses_degenerate_input():
    blank = Image.new("L", (200, 200), 0)
    image = Image.new("RGB", blank.size, (255, 255, 255))
    slot = {"x0": 10, "y0": 10, "x1": 80, "y1": 30, "color": "#000000"}
    assert C.fit_word_size([(blank, image, [], PPU, 0, 0)],
                           HEBREW_FONT, ["a"])[0] is None
    assert C.fit_word_size([(blank, image, [slot], PPU, 0, 0)],
                           HEBREW_FONT, [])[0] is None
    got, grade, note = C.fit_word_size([(blank, image, [slot, slot], PPU, 0, 0)],
                                       HEBREW_FONT, ["מסיבה"])
    assert got is None and grade is None and "auto-fit" in note


def test_the_word_fit_reads_every_front_and_not_only_the_first():
    """The deck sets ONE word size, so every front's rows are evidence about it.

    Reading one card makes the answer a median of four rows, and a numbered row's
    body band moves with how long its entry is (the marker is set at 0.9 of the
    word size beside a word set at it). So a card whose four entries are unusually
    short pulls the whole deck's size off — which is exactly what happened on פריז
    (−4.5%) and סיישל (−12.3%) against the owner's Canva values.

    Proved on two fronts deliberately painted at DIFFERENT sizes, which real
    artwork never is: read alone, the first answers its own size, and read
    together the pair answers between the two. A fit that still looked at one
    card would return the same number both times.
    """
    words = ["מסיבה", "חברים", "ריקודים", "צחוקים"]
    one = _word_surface(words, 18.0)
    two = _word_surface(words, 20.0)
    from_one = C.fit_word_size([one], HEBREW_FONT, words)[0]
    from_both = C.fit_word_size([one, two], HEBREW_FONT, words)[0]
    assert abs(from_one - 18.0) <= 1.0, from_one
    assert from_one < from_both < 20.0, (from_one, from_both)


def test_a_v1_sheet_pays_no_extra_render_for_its_other_cards():
    """A sheet holds all eight cards in ONE raster, so pooling them is free.

    The surfaces it returns must all be that same already-rendered mask, with only
    the recipe's per-cell slots differing — anything else would mean the pass had
    gone back to Chrome for artwork it already has.
    """
    mask, image, slots, ppu, ox, oy = _word_surface(["מסיבה", "חברים"], 18.0)
    first = (mask, image, slots, ppu, ox, oy)
    recipe = {"cards": [{"words": slots}, {"words": slots}, None,
                        {"words": []}]}
    got = C.word_surfaces("t", {}, recipe, False, "/nonexistent", first)
    assert len(got) == 2
    assert all(s[0] is mask and s[1] is image for s in got)


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
