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


# ---- ONE TEXT BOX, SEVERAL SURFACES -----------------------------------------
#
# A design's front, board and card back are usually the same title laid out once
# and reused at three scales, and a block reused at another scale is stacked at
# the same leading. Measured on the shipped set: פריז's front settles at 0.72
# and its back one step away at 0.74, and that ONE STEP is the whole of the
# back's error against the owner's Canva value (−3.2% at 0.74, −1.4% at 0.72).
# But טריפה's back genuinely stacks a third wider than its front, so the sharing
# has to be tested against the ink rather than assumed.

_TITLE_SAMPLES = [["נעמה", "מסיבה גדולה"], ["לירן", "מסיבה גדולה"],
                  ["דן", "מסיבה גדולה"], ["לילך", "מסיבה גדולה"]]


def _curve(peak, scatter=0.0, sharpness=0.4, n=4):
    """A leading curve with a KNOWN peak and a known per-name scatter.

    The decision `couple_leadings` makes is arithmetic over the curves, so it is
    tested on curves rather than on painted ink: a real block's argmax depends
    on FreeType's rasterisation, which differs between a dev machine and CI by
    enough to move it a step or two (this file's own header says as much), and a
    test of the ARITHMETIC must not fail for that reason. The painted round trip
    below covers the physical half.

    ``scatter`` is how far apart the sample honoree names score, which is what
    `_score_noise` reads the noise floor off. ``sharpness`` is how fast the
    score falls away from the peak — a surface whose ink pins its spacing
    tightly, against one whose ink barely can.
    """
    rows = []
    for pitch in C._PITCH_GRID:
        score = 1.0 - sharpness * abs(pitch - peak)
        half = scatter / 2.0
        # Symmetric about the median, so the median IS ``score`` and only the
        # spread — the noise floor — changes with ``scatter``.
        samples = [score - half, score - half, score + half, score + half][:n]
        rows.append((pitch, 24.0, score, samples))
    return rows


def test_surfaces_that_are_one_block_at_two_scales_share_one_leading():
    # פריז: its front settles one grid step from its back, and the ink of each
    # is content at the other's. The shared answer is their median, and it is a
    # value on the grid they were scored at.
    front, back = _curve(0.72, scatter=0.04), _curve(0.74, scatter=0.04)
    shared, why = C.couple_leadings({"front": front, "back": back})
    assert why is None, why
    assert shared in C._PITCH_GRID and 0.72 <= shared <= 0.74, shared


def test_a_surface_stacked_differently_is_left_alone():
    # טריפה: its back stacks its two lines a third further apart than its front,
    # and both surfaces pin their own spacing tightly. Sharing one would put a
    # size far out, so the whole set keeps what its own ink said — and the owner
    # is told WHICH surface disagreed and what it reads.
    front, back = _curve(1.00, scatter=0.001), _curve(1.40, scatter=0.001)
    shared, why = C.couple_leadings({"front": front, "back": back})
    assert shared is None
    assert why and "NOT one block" in why
    assert "front" in why or "back" in why, why


def test_a_third_surface_that_agrees_with_neither_stops_the_whole_set():
    # סנטוריני: its front and back both read 0.50 and its board 0.98. The two
    # that agree do not get to couple over the one that does not — the claim
    # being tested is "this design reuses ONE block", and a surface that plainly
    # does not refutes it for the design.
    curves = {"front": _curve(0.50, scatter=0.001),
              "back": _curve(0.50, scatter=0.001),
              "board": _curve(0.98, scatter=0.001)}
    shared, why = C.couple_leadings(curves)
    assert shared is None
    assert why and "board" in why, why


def test_surfaces_whose_names_scatter_too_far_to_tell_apart_are_coupled():
    # The other side of the same rule, stated honestly: the refusal is "the ink
    # can TELL these apart", not "the peaks differ". Identical peaks to the
    # refusal above, but sample names that disagree far more than the peaks do —
    # so nothing here is evidence about the spacing, and the design's several
    # readings are pooled rather than each trusted on its own.
    front, back = _curve(1.00, scatter=0.9), _curve(1.40, scatter=0.9)
    shared, why = C.couple_leadings({"front": front, "back": back})
    assert why is None, why
    assert shared is not None and 1.00 <= shared <= 1.40, shared


def test_one_surface_on_its_own_has_nothing_to_couple():
    front = _curve(0.90, scatter=0.01)
    assert C.couple_leadings({"front": front}) == (None, None)
    assert C.couple_leadings({}) == (None, None)
    assert C.couple_leadings(None) == (None, None)
    # ...and a surface whose fit produced no curve at all (a single-line title)
    # cannot drag the others: it simply is not one of the readings.
    assert C.couple_leadings({"front": front, "back": []}) == (None, None)


def test_the_painted_round_trip_couples_two_scales_of_one_block():
    # The physical half: the SAME block painted large and small at one spacing.
    # Asserted against what the two surfaces themselves answered rather than
    # against the number they were painted at — FreeType moves an argmax by a
    # step between machines, and what this has to guarantee is that the shared
    # answer sits among its surfaces' own readings and that re-solving each
    # size at it returns that surface to the size it was painted at.
    origin, pitch = _TITLE_SAMPLES[1], 0.92
    sizes = {"front": 22.0, "back": 34.0}
    inks = {k: C._paint(HEBREW_FONT, origin, v * PPU, ALPHA, pitch=pitch)
            for k, v in sizes.items()}
    curves = {k: C.leading_curve(v, HEBREW_FONT, _TITLE_SAMPLES, PPU, ALPHA)
              for k, v in inks.items()}
    own = {k: max(v, key=lambda row: row[2])[0] for k, v in curves.items()}
    shared, why = C.couple_leadings(curves)
    assert why is None, (why, own)
    assert min(own.values()) <= shared <= max(own.values()), (shared, own)
    for key, ink in inks.items():
        fit = {"ink": ink, "font": HEBREW_FONT, "samples": _TITLE_SAMPLES,
               "ppu": PPU, "alpha": ALPHA, "ring": 0.0}
        got = C.refit_at_leading(fit, pitch)
        assert abs(got - sizes[key]) / sizes[key] <= 0.03, (key, got)


def test_the_shared_leading_is_one_the_curves_were_actually_swept_at():
    # The median of an even number of surfaces lands between two grid steps, and
    # no score was ever measured there — so the answer is snapped back onto the
    # grid the curves were swept on rather than interpolated onto a value no
    # surface was scored at. Two surfaces a single step apart is exactly that
    # case: their median is half a step, which is not on the grid.
    one, two = _curve(0.90, scatter=0.04), _curve(0.92, scatter=0.04)
    shared, why = C.couple_leadings({"front": one, "back": two})
    assert why is None, why
    assert shared in C._PITCH_GRID, shared
    assert shared in (0.90, 0.92), shared


def test_a_coupled_surface_is_re_solved_at_the_shared_leading():
    # The size and the leading are one answer, so a surface handed a spacing
    # from elsewhere must have its SIZE re-solved at it — not kept from the fit
    # that assumed a different one. Painted at 26 and 0.92, a size re-solved at
    # 0.92 has to come back to 26 whatever the surface's own argmax was.
    size, pitch = 26.0, 0.92
    ink = C._paint(HEBREW_FONT, _TITLE_SAMPLES[1], size * PPU, ALPHA, pitch=pitch)
    fit = {"ink": ink, "font": HEBREW_FONT, "samples": _TITLE_SAMPLES,
           "ppu": PPU, "alpha": ALPHA, "ring": 0.0}
    got = C.refit_at_leading(fit, pitch)
    assert abs(got - size) / size <= 0.03, got
    assert C.refit_at_leading(fit, None) is None
    assert C.refit_at_leading(None, pitch) is None


def test_a_score_difference_smaller_than_the_names_disagree_is_not_evidence():
    # The noise floor the agreement is tested against: the score IS a median
    # over the sample honoree names, so how much those names disagree is how
    # finely it can be read at all. Names that agree exactly leave no room —
    # anything can then be told apart — and names that scatter leave a lot.
    assert C._score_noise([0.5, 0.5, 0.5, 0.5]) == 0.0
    assert C._score_noise([0.5]) == 0.0
    assert C._score_noise([0.4, 0.6, 0.4, 0.6]) > C._score_noise(
        [0.49, 0.51, 0.49, 0.51])


def test_the_leading_curve_leaves_the_solve_rather_than_being_swept_twice():
    # Sweeping the grid is the whole cost of the title fit, and the coupling
    # needs every surface's curve — so the solve hands out the one it took its
    # argmax of instead of the caller measuring it again.
    ink = C._paint(HEBREW_FONT, _TWO[0], 24.0 * PPU, ALPHA, pitch=1.10)
    curve = []
    size, lead, score = C.solve_size_and_leading(ink, HEBREW_FONT, _TWO, PPU,
                                                 ALPHA, curve_out=curve)
    assert curve, "the curve must come back out"
    best = max(curve, key=lambda row: row[2])
    assert abs(best[0] - lead) < 1e-9 and abs(best[2] - score) < 1e-9
    assert all(row[0] in C._PITCH_GRID for row in curve)
    assert size is not None


def test_a_surfaces_whole_reading_is_recorded_for_the_coupling():
    # ...and it has to be the reading, not a copy of some of it: the coupling
    # re-solves the size off exactly the ink, ring and alpha the first fit used.
    ink = C._paint(HEBREW_FONT, _TWO[0], 24.0 * PPU, ALPHA, pitch=1.10)
    mask, image, box = _origin(ink)
    fit = {}
    size, _grade, _note, _ctx, lead = C.fit_title_size(
        mask, image, box, PPU, 0.0, 0.0, HEBREW_FONT, _TWO, "#000000",
        fit_out=fit)
    for field in ("ink", "font", "samples", "ppu", "alpha", "ring", "curve",
                  "size", "leading", "box_h"):
        assert field in fit, field
    assert fit["size"] == size and fit["leading"] == lead
    assert abs(C.refit_at_leading(fit, lead) - size) < 1e-9


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
    out = {"title_style": {"size": 27.56, "italic": True}, "word_size": 14.81}
    conf = {
        "title_style.size": "low",
        "word_size": "low",
    }
    notes = []
    C._drop_low_confidence(out, conf, notes)
    assert "size" not in out["title_style"]
    assert "word_size" not in out
    # ...and a knob it was not asked about survives.
    assert out["title_style"]["italic"] is True


def test_dropping_the_bold_weight_drops_the_bold_flag_with_it():
    """``bold`` without ``bold_w`` is not a smaller answer, it is a different one.

    The renderer falls back to its HOUSE weight (0.035 of the type size) for a
    bold with no measured stroke, and the house weight is another design's
    answer: טריפה measured 0.015 and סנטוריני 0.010, so both shipped titles more
    than twice as fat as the artwork they were fitted to — which is exactly the
    "too bold" the owner reported on both. The weight is graded low by
    construction (whole-pixel strokes), so half this pair was ALWAYS dropped;
    the flag has to leave with it.
    """
    out = {"title_style": {"bold": True, "bold_w": 0.015}}
    conf = {"title_style.bold": "medium", "title_style.bold_w": "low"}
    dropped = C._drop_low_confidence(out, conf, [])
    assert "bold_w" not in out["title_style"]
    assert "bold" not in out["title_style"]
    assert set(dropped) == {"title_style.bold", "title_style.bold_w"}


def test_a_believed_bold_keeps_both_halves():
    out = {"title_style": {"bold": True, "bold_w": 0.015}}
    conf = {"title_style.bold": "medium", "title_style.bold_w": "medium"}
    C._drop_low_confidence(out, conf, [])
    assert out["title_style"] == {"bold": True, "bold_w": 0.015}


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


class _FakeMask:
    def crop(self, _box):
        return _ORIGIN


_ORIGIN = object()
_CANDIDATE = object()


# --- the weight is read per unit of SIZE, not per unit of block height --------
#
# ``_stroke_ratio`` divided by the ink's HEIGHT, and a stacked title's ink height
# is mostly its LEADING. So the weight reading was a reading of the line spacing:
# our own unfattened טריפה measured HEAVIER than its origin at the renderer's
# 0.78 and LIGHTER at the 1.0 its design sets — same glyphs, same strokes,
# opposite verdicts — and סנטוריני, which leads at 0.5, came out "bold" and
# printed a title the owner could see was too fat.

def test_stroke_per_size_does_not_move_with_the_leading():
    from PIL import Image, ImageDraw
    ink = Image.new("L", (60, 20), 0)
    ImageDraw.Draw(ink).rectangle((5, 5, 55, 12), fill=255)
    tight = C.stroke_per_size(ink, 40.0)
    # the same strokes in a block twice as tall (a looser leading) weigh the same
    tall = Image.new("L", (60, 40), 0)
    tall.paste(ink, (0, 0))
    assert abs(C.stroke_per_size(tall, 40.0) - tight) < 1e-9
    # ...whereas the old per-ink-height reading halves
    assert C._stroke_ratio(tall) < C._stroke_ratio(ink) * 0.75


def test_stroke_per_size_scales_with_the_type_size():
    from PIL import Image, ImageDraw
    ink = Image.new("L", (60, 20), 0)
    ImageDraw.Draw(ink).rectangle((5, 5, 55, 12), fill=255)
    assert C.stroke_per_size(ink, 80.0) == C.stroke_per_size(ink, 40.0) / 2


class _Curve:
    """A fit_bold stand-in: paints whose measured weight we control."""

    def __init__(self, values):
        self.values = values


def test_fit_bold_refuses_a_grid_the_raster_cannot_resolve(monkeypatch):
    """A fatter stroke that measures THINNER is not a measurement.

    A card title is drawn about one device pixel of stroke wide and
    ``_mean_stroke`` counts whole-pixel erosions, so on a light face one step of
    the grid can move the reading less than rasterising noise does. טריפה is
    exactly that — 0.0131, 0.0162, 0.0140, 0.0130 for 0.000, 0.005, 0.010,
    0.015 of the size — and the search picked a weight out of that noise and
    shipped a design that is not bold as bold.
    """
    from PIL import Image
    noisy = [0.0131, 0.0162, 0.0140, 0.0130, 0.0134] + [0.0143] * 12
    seq = iter(noisy)
    monkeypatch.setattr(C, "stroke_per_size",
                        lambda ink, em: 0.0140 if ink is _ORIGIN else next(seq, 0.0143))
    monkeypatch.setattr(C, "_paint", lambda *a, **k: _CANDIDATE)
    mask = _FakeMask()
    bold, bold_w, note = C.fit_bold(mask, (0, 0, 1, 1), "f.ttf", [["a"]], 10, 1, 128)
    assert bold is None and bold_w is None
    assert note and "one device pixel" in note


def test_fit_bold_answers_when_the_grid_does_climb(monkeypatch):
    rising = [0.010 + 0.002 * i for i in range(len(C._BOLD_W_GRID))]
    seq = iter(rising)
    monkeypatch.setattr(C, "stroke_per_size",
                        lambda ink, em: 0.020 if ink is _ORIGIN else next(seq, 0.05))
    monkeypatch.setattr(C, "_paint", lambda *a, **k: _CANDIDATE)
    bold, bold_w, note = C.fit_bold(_FakeMask(), (0, 0, 1, 1), "f.ttf", [["a"]],
                                    10, 1, 128)
    assert bold is True and bold_w and note is None


# --- the leading a design does not show ---------------------------------------

def _flat_curve(rows):
    """A leading curve in the shape ``leading_curve`` produces:
    ``(pitch, size, score, per_sample_scores)``."""
    return [(p, 20.0, s, [s]) for p, s in rows]


def test_a_flat_sweep_is_reported_as_undetermined_not_as_its_argmax():
    """A band of spacings that all reproduce the ink equally well means the
    artwork does not say — not that the middle of the band is the answer.

    Measured on the shipped set: every surface whose title ink has row structure
    comes back under a tenth; סיישל, whose ring welds its three lines into one
    mass, comes back at 21-29% on all three of its surfaces.
    """
    flat = [(0.60 + 0.02 * i, 1.0) for i in range(14)]
    curve = _flat_curve([(0.30, 0.2)] + flat + [(0.90, 0.2)])
    assert C.leading_plateau(curve, 0.70) > C._PLATEAU_MAX


def test_a_peaked_sweep_measures_a_narrow_plateau():
    curve = _flat_curve([(0.60, 0.5), (0.62, 0.8), (0.64, 1.0),
                         (0.66, 0.8), (0.68, 0.5)])
    assert C.leading_plateau(curve, 0.64) < C._PLATEAU_MAX


def test_a_sweep_with_no_range_at_all_says_nothing():
    curve = _flat_curve([(0.60, 1.0), (0.62, 1.0), (0.64, 1.0)])
    assert C.leading_plateau(curve, 0.62) == float("inf")


def test_undetermined_is_not_none():
    """None means "there is no spacing to measure" (a one-line title);
    UNDETERMINED means "there is one and this ink cannot show it". Only the
    second is a reason to ask the owner."""
    assert C.UNDETERMINED is not None
    assert not C.UNDETERMINED
    assert isinstance(C.UNDETERMINED, C.Undetermined)
    # ...and it carries the argmax it declined to trust, so a template with no
    # owner value keeps a guess rather than losing its spacing altogether
    got = C.Undetermined(0.70, 22.3, 0.21)
    assert (got.leading, got.size) == (0.70, 22.3)
    assert "21%" in repr(got)


# --- per-front alignment ------------------------------------------------------
#
# Every other title knob is one deck-wide answer. Alignment is not: טוקיו sets
# the same two lines flush RIGHT on four of its eight fronts and flush LEFT on
# the other four, so one answer misprints half the deck. The owner reported it
# twice — "the titles are centered in the preview and they are not like this in
# the origin" — and it stayed unaddressed because nothing asked per front.

def _block(lines, w=200, h=120):
    """A mask with one horizontal bar per line at the given (x0, x1)."""
    from PIL import Image, ImageDraw
    im = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(im)
    step = h // (len(lines) + 1)
    for i, (x0, x1) in enumerate(lines):
        top = step * i + 6
        d.rectangle((x0, top, x1, top + step - 12), fill=255)
    return im


def test_alignment_reads_left_right_and_centre():
    from PIL import Image
    def align(lines, want=2):
        m = Image.new("L", (220, 140), 0)
        m.paste(_block(lines), (10, 10))
        return C._alignment(m, (0, 0, 220, 140), want)
    assert align([(0, 190), (0, 90)]) == "left"
    assert align([(0, 190), (100, 190)]) == "right"
    assert align([(0, 190), (50, 140)]) == "center"


def test_a_near_tie_is_refused_rather_than_guessed():
    """פריז's eight identical titles scored "left" on three fronts and "centre"
    on four, on spreads of 0.4-6% of the block width — a coin flip. טוקיו, which
    really does align, wins by 28%. The bar sits in the empty band between."""
    from PIL import Image
    m = Image.new("L", (220, 140), 0)
    m.paste(_block([(0, 190), (4, 186)]), (10, 10))
    assert C._alignment(m, (0, 0, 220, 140), 2) is None


def test_lines_whose_ink_touches_are_still_split_into_bands():
    """טוקיו's second line starts on the row the first one's ink ends, so the
    whole title reads as ONE run and every per-line question went unanswered.
    Where the clear row is missing the boundary is still in the block's shape."""
    from PIL import Image, ImageDraw
    m = Image.new("L", (200, 100), 0)
    d = ImageDraw.Draw(m)
    d.rectangle((10, 10, 190, 54), fill=255)      # wide upper line
    d.rectangle((120, 55, 190, 90), fill=255)     # short lower line, abutting
    assert len(C._row_runs(m)) == 1, "the fixture must have no clear row"
    assert len(C._line_bands(m, 2)) == 2
    assert C._alignment(m, (0, 0, 200, 100), 2) == "right"


def test_the_band_split_leaves_a_block_that_already_reads_alone():
    from PIL import Image
    m = Image.new("L", (220, 140), 0)
    m.paste(_block([(0, 190), (0, 90)]), (10, 10))
    assert C._line_bands(m, 2) == C._row_runs(m)


def test_the_deck_wide_alignment_is_the_commonest_reading():
    assert C._majority_alignment({2: "center", 3: "center", 4: "left"}) == "center"
    assert C._majority_alignment({2: None, 3: None}) is None
    # a deck that splits down the middle answers deterministically — and the
    # other half is recorded per front, so which way the tie falls prints nothing
    assert C._majority_alignment({2: "right", 3: "left", 4: "right",
                                  5: "left"}) == "right"


# --- a variable title face's own cut ------------------------------------------
#
# THE WEIGHT AND THE SIZE ARE ONE ANSWER. What makes them inseparable is the one
# property of a weight axis these tests model: running `wght` 100 -> 900 leaves
# the ink's HEIGHT untouched and moves only its WIDTH (measured on League
# Spartan: 90px tall at size 100 at every instance, 19% wider across the axis).
# So the height fit cannot see the weight and the width fit sees nothing else,
# and the design's cut is the one at which the two answer the same size.
#
# The repo ships no variable font — the only one in play is a file the OWNER
# uploaded into her template — so the axis is modelled here instead of loaded.
# That is not a weaker test: the model IS the measured property, and pinning it
# in a fixture is what keeps the next change to the fit honest about it.

_MODEL_WIDTH_PER_WGHT = {100: 2.20, 200: 2.24, 300: 2.28, 400: 2.34,
                         500: 2.39, 600: 2.44, 700: 2.49, 800: 2.55, 900: 2.60}
# The model paints whole pixels, so the fits below are run at a title big enough
# that one raster step is worth well under a step of the axis — which is also
# true of the artwork this measures (מרקאנה's title ink is 182x122 device px).
_MODEL_SIZE = 100.0
# How long each line of the model's text sets, per unit of the face's own width.
# A line not named here sets 1.0. Used to give the NAME line a different length
# from the artwork's name, which is the whole difficulty the literal-line
# reading exists to sidestep.
_MODEL_LINE_LEN = {"NAME1": 1.8, "NAME2": 1.8, "BEN": 1.0, "ANA": 1.0,
                   "lit": 1.4}


def _variable_face(monkeypatch, axis=(100, 100, 900), drawn=None):
    """Pretend ``"var.ttf"`` is a variable face whose width alone tracks wght.

    Paints a real multi-line block — a filled band per line with a clear row
    between — so that the line split the fit relies on has something to find.

    Returns the list every ``_paint`` call is recorded into, so a test can also
    assert WHICH cut the size fit was measured against.
    """
    from PIL import ImageDraw
    drawn = [] if drawn is None else drawn
    monkeypatch.setattr(C.render_page, "weight_axis",
                        lambda path: axis if path == "var.ttf" else None)
    real = C._paint

    def paint(font_path, lines, em, alpha, stroke=0.0, marker=None,
              pitch=C.RENDER_PITCH, weight=None):
        if font_path != "var.ttf":
            return real(font_path, lines, em, alpha, stroke=stroke,
                        marker=marker, pitch=pitch, weight=weight)
        drawn.append(weight)
        # Width per em tracks the axis; the band HEIGHT does not, which is the
        # measured property this whole strand turns on.
        w = _MODEL_WIDTH_PER_WGHT[weight if weight is not None else axis[1]]
        drawn_lines = [ln for ln in lines if ln and ln.strip()]
        if not drawn_lines:
            return None
        band, gap = max(1, round(em * 0.6)), max(1, round(em * 0.3))
        widths = [max(1, round(em * w * _MODEL_LINE_LEN.get(ln, 1.0)))
                  for ln in drawn_lines]
        img = Image.new(
            "L", (max(widths),
                  band * len(widths) + gap * (len(widths) - 1)), 0)
        d = ImageDraw.Draw(img)
        y = 0
        for one in widths:
            d.rectangle((0, y, one - 1, y + band - 1), fill=255)
            y += band + gap
        return img

    monkeypatch.setattr(C, "_paint", paint)
    return drawn


def test_a_static_face_has_no_weight_to_fit():
    ink = C._paint(HEBREW_FONT, LINES, 26.0 * PPU, ALPHA)
    got, note = C.fit_font_weight(ink, LATIN_FONT, [["a"]], 26.0, PPU, ALPHA)
    assert got is None and note is None


def test_a_static_face_paints_identically_whatever_weight_is_passed():
    """The whole variable-font strand must be a NO-OP over a static face.

    Every fit below now carries a ``weight`` argument, and a static face is nine
    of the ten shipped templates — so the guarantee that matters is not "it still
    works" but "it is the same bytes". A face with no axis has one cut and there
    is nothing to select, so asking for one may not change a single pixel.
    """
    bare = C._paint(HEBREW_FONT, LINES, 26.0 * PPU, ALPHA)
    for weight in (None, 100, 400, 900):
        got = C._paint(HEBREW_FONT, LINES, 26.0 * PPU, ALPHA, weight=weight)
        assert got.tobytes() == bare.tobytes(), weight
        assert got.size == bare.size
    # and the same through the fit that calls it
    assert (C._fit_size(bare.size[1], HEBREW_FONT, [LINES], PPU, ALPHA)
            == C._fit_size(bare.size[1], HEBREW_FONT, [LINES], PPU, ALPHA,
                           weight=900))


def _model_ink(cut, lines=("x",), size=_MODEL_SIZE):
    """The artwork, as the model's face sets it at a known cut. Painted rather
    than constructed, so the fit is held to reproducing a real round trip."""
    return C._paint("var.ttf", list(lines), size * PPU, ALPHA, weight=cut)


def test_the_cut_is_the_one_where_the_height_fit_and_the_width_fit_agree(monkeypatch):
    """מרקאנה: the artwork's own ink says 600, not the 800 the strokes said."""
    _variable_face(monkeypatch)
    got, note = C.fit_font_weight(_model_ink(600), "var.ttf", [["x"]],
                                  _MODEL_SIZE, PPU, ALPHA)
    assert got == 600, got
    assert "600" in note and "width" in note


def test_every_cut_of_the_axis_answers_the_same_size_by_HEIGHT(monkeypatch):
    """The premise, pinned: this is why the size fit alone cannot see the cut.

    An earlier round measured the ink height across the axis, saw it flat, and
    concluded the weight did not matter to the size. The height genuinely does
    not move — the WIDTH does, and the width is the half that was not measured.
    """
    _variable_face(monkeypatch)
    ink = _model_ink(600)
    by_height = {w: C._fit_size(ink.size[1], "var.ttf", [["x"]], PPU, ALPHA,
                                weight=w)
                 for w in _MODEL_WIDTH_PER_WGHT}
    assert len(set(by_height.values())) == 1, by_height
    by_width = {w: C._fit_size(ink.size[0], "var.ttf", [["x"]], PPU, ALPHA,
                               axis=1, weight=w)
                for w in _MODEL_WIDTH_PER_WGHT}
    assert len(set(by_width.values())) == len(by_width), by_width


def test_the_size_is_fitted_against_the_cut_that_will_be_printed(monkeypatch):
    """A size measured against the file's DEFAULT cut is measured against the
    wrong picture — which is the defect, since League Spartan defaults to Thin."""
    drawn = _variable_face(monkeypatch)
    ink = _model_ink(600)
    drawn.clear()
    C.size_from_matching_samples(ink, "var.ttf", [["x"], ["y"]], PPU, ALPHA,
                                 0.0, None, 600)
    assert drawn and set(drawn) == {600}, set(drawn)


def test_a_cut_the_file_does_not_carry_is_never_named(monkeypatch):
    """The grid is the nine CSS steps; a narrower axis simply has fewer of them.

    Nothing here may answer with an instance outside the file's own range — the
    renderer would clamp it and print a cut nobody chose.
    """
    _variable_face(monkeypatch, axis=(300, 300, 500))
    # artwork set in a cut heavier than this file carries: the answer must still
    # be one of ITS instances, and the heaviest of them is the nearest
    ink = _model_ink(900)
    got, _note = C.fit_font_weight(ink, "var.ttf", [["x"]], _MODEL_SIZE, PPU,
                                   ALPHA)
    assert got == 500, got


def test_a_face_that_reaches_the_width_at_no_cut_at_all_is_refused(monkeypatch):
    """A width no instance can reach is not a cut, it is the wrong FONT — and
    pinning one of its cuts would print the wrong face confidently."""
    _variable_face(monkeypatch)
    ink = _model_ink(600)
    # far wider than the heaviest cut of this face sets at the fitted size
    ink = ink.resize((ink.size[0] * 2, ink.size[1]))
    got, note = C.fit_font_weight(ink, "var.ttf", [["x"]], _MODEL_SIZE, PPU,
                                  ALPHA)
    assert got is None
    assert "left alone" in note and "different typeface" in note


def test_the_width_at_the_fitted_size_answers_what_bisecting_both_axes_would(
        monkeypatch):
    """The shortcut is a shortcut, not a different question.

    "The cut where the height fit and the width fit agree" is what this means;
    one width comparison at the fitted size is how it is computed, because the
    painted extent is linear in the size and the reference cancels out of the
    ratio of the two fits. Bisecting both axes at every instance is the literal
    reading — some 4,700 paintings a pass against 36 — so it is written out here
    once and the cheap answer is held to it.
    """
    _variable_face(monkeypatch)
    for cut in (300, 600, 900):
        ink = _model_ink(cut)
        by_bisection = []
        for wght in _MODEL_WIDTH_PER_WGHT:
            by_h = C._fit_size(ink.size[1], "var.ttf", [["x"]], PPU, ALPHA,
                               axis=0, weight=wght)
            by_w = C._fit_size(ink.size[0], "var.ttf", [["x"]], PPU, ALPHA,
                               axis=1, weight=wght)
            by_bisection.append((abs(by_w / by_h - 1), wght))
        got, _note = C.fit_font_weight(ink, "var.ttf", [["x"]], _MODEL_SIZE,
                                       PPU, ALPHA)
        assert got == min(by_bisection)[1] == cut, (cut, got, min(by_bisection))


def test_the_cut_is_read_off_the_lines_no_honoree_name_reaches(monkeypatch):
    """מרקאנה sets "{NAME}'s" over "B-day", and the artwork says "B-day" too.

    Matching the whole BLOCK instead lets the sample names' own length decide:
    where the artwork's honoree name is short and ours are long, the block we
    paint is wider than the artwork's at the very cut that is correct, and the
    fit walks down the axis to compensate. That is the real measured effect —
    it drags מרקאנה's answer to 500 where its literal line says 600.
    """
    _variable_face(monkeypatch)
    # A line that reads the SAME in every sample is a line no name reaches —
    # which is how the literal line is found without knowing the placeholders.
    samples = [["NAME1", "lit"], ["NAME2", "lit"]]
    # The artwork: a SHORT honoree name over the same literal line, set at 600.
    ink = _model_ink(600, lines=("BEN", "lit"))
    # The block is the literal line's width here, and the samples' name line is
    # wider than it — so a whole-block match cannot see the right cut at all.
    assert (_MODEL_LINE_LEN["NAME1"] > _MODEL_LINE_LEN["lit"]
            > _MODEL_LINE_LEN["BEN"]), "the fixture must have that shape"
    got, note = C.fit_font_weight(ink, "var.ttf", samples, _MODEL_SIZE, PPU,
                                  ALPHA)
    assert got == 600, got
    assert "no honoree name reaches" in note


def test_a_title_that_is_all_name_still_answers_from_its_geometry(monkeypatch):
    """Every line carries the name, so there is no literal line to prefer. The
    whole block is then the best available reading — still geometry, and still
    far better than the strokes it replaced."""
    _variable_face(monkeypatch)
    ink = _model_ink(600, lines=("BEN",))
    got, note = C.fit_font_weight(ink, "var.ttf", [["BEN"], ["ANA"]],
                                  _MODEL_SIZE, PPU, ALPHA)
    assert got == 600, got
    assert "no honoree name reaches" not in note
