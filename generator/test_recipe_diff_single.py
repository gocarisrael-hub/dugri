#!/usr/bin/env python3
"""Tests for the v2 single-card half of generator/recipe_diff.py.

Detection is image-based and its last mile needs headless Chrome, which is not
present everywhere the suite runs. So everything that can be tested WITHOUT a
rasterizer is: the structure gate, the viewBox->pixel mapping, the clustering of
one card's ink (fed a synthetic mask), the median reconciliation across the eight
fronts, and the assembly of the recipe.

The recipe assertions read the emitted JSON DIRECTLY rather than through
``config``'s accessors. That is on purpose: the recipe file is the contract, and
the accessors layer renderer-side fallbacks (a union title box for an undetected
front, a default photo grid) on top of it — asserting through them cannot tell
"detection wrote this" from "the reader invented it".

The two end-to-end tests build a throwaway template and drive Chrome; they skip
(never fail) where the binary is absent, the same way ``test_svg_rings`` and
``test_config`` do.

Run: python3 generator/test_recipe_diff_single.py   (or via pytest)
"""
import inspect
import json
import os
import shutil
import tempfile

from PIL import Image

import config
import recipe_diff as R


# ---- fixtures ---------------------------------------------------------------

# A card in miniature: one title band near the top, four evenly-spaced word bands
# below it. Sized so the bands clear rows_in_cell's minimum run height.
_CARD_W, _CARD_H = 400, 600
_TITLE_BAND = (80, 40, 320, 100)
_WORD_BANDS = [(120, 220, 300, 250), (110, 300, 300, 330),
               (100, 380, 300, 410), (90, 460, 300, 490)]


def _synthetic_card(bands, w=_CARD_W, h=_CARD_H, ink=(113, 29, 32)):
    """``(mask, filled_image)`` for a card whose ink is exactly ``bands``."""
    mask = Image.new("L", (w, h), 0)
    image = Image.new("RGB", (w, h), (253, 246, 236))
    for x0, y0, x1, y1 in bands:
        for y in range(y0, y1):
            for x in range(x0, x1):
                mask.putpixel((x, y), 255)
                image.putpixel((x, y), ink)
    return mask, image


def _slots(x0=10.0, y0=20.0, step=30.0, colour="#711d20"):
    """Four word slots stacked down a card — one front's measurement."""
    return [{"x0": x0, "y0": y0 + i * step, "x1": x0 + 50.0,
             "y1": y0 + i * step + 15.0, "color": colour} for i in range(4)]


def _shift(slots, dx):
    return [dict(s, x0=s["x0"] + dx, x1=s["x1"] + dx) for s in slots]


# ---- the structure gate -----------------------------------------------------
# This is what decides v1 vs v2, and it runs at UPLOAD time — before anything has
# written card_layout into themes.json — so it can only read the folder.


def _template(files):
    d = tempfile.mkdtemp(prefix="dugri-tpl-")
    for rel in files:
        path = os.path.join(d, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("<svg/>")
    return d


def test_template_layout_reads_the_numbered_deck_as_single():
    d = _template(["clean/1.svg", "clean/2.svg", "filled/1.svg", "filled/2.svg"])
    try:
        assert R.template_layout(d) == "single"
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_template_layout_keeps_the_sheet_templates_on_v1():
    d = _template(["clean/fronts.svg", "clean/backs.svg", "clean/board.svg"])
    try:
        assert R.template_layout(d) == "sheet"
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_a_folder_shipping_both_stays_on_the_path_its_recipe_describes():
    # v1 must win the tie: seven themes have not migrated, and a half-migrated
    # folder must not silently change shape underneath a calibrated theme.
    d = _template(["clean/fronts.svg", "clean/1.svg", "clean/2.svg"])
    try:
        assert R.template_layout(d) == "sheet"
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_an_empty_folder_is_not_mistaken_for_a_deck():
    d = _template(["fonts/x.ttf"])
    try:
        assert R.template_layout(d) == "sheet"
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ---- viewBox -> pixels ------------------------------------------------------


def test_viewport_is_the_real_xmidymid_meet_mapping():
    # The reference card: a 223.92x312 viewBox in a 299x416 window. The two axis
    # ratios differ, so a width-only scale would be 0.15% out — half a user unit
    # at the foot of the card, landing entirely on the bottom word slot.
    vb = [0.0, 0.0, 223.92, 312.0]
    ppu, ox, oy = R.viewport(vb, 299, 416)
    assert abs(ppu - (416 * R.SCALE) / 312.0) < 1e-9, "scale is the SMALLER ratio"
    assert ppu < (299 * R.SCALE) / 223.92
    assert oy == 0.0 and ox > 0, "the art is centred on the axis with slack"
    # and the mapping round-trips: a box at the very foot of the card comes back
    # at the foot of the card, not half a unit past it.
    bottom = {"x0": 0.0, "y0": 312.0, "x1": 0.0, "y1": 312.0}
    px = {k: bottom[k] * ppu + (ox if k[0] == "x" else oy) for k in bottom}
    back = R.to_units({"x0": px["x0"], "y0": px["y0"], "x1": px["x1"],
                       "y1": px["y1"]}, ppu, ox, oy)
    assert abs(back["y1"] - 312.0) < 1e-6


# ---- clustering one whole card ---------------------------------------------


def test_detect_front_finds_four_words_and_the_title_above_them():
    mask, image = _synthetic_card([_TITLE_BAND] + _WORD_BANDS)
    got = R.detect_front(mask, image, [0, 0, _CARD_W, _CARD_H], 1.0, 0.0, 0.0)
    assert got, "a card with 5 clean bands must cluster"
    assert len(got["words"]) == 4
    assert len(got["title"]) == 1
    assert got["title"][0]["y1"] <= got["words"][0]["y0"], "title sits above word 1"
    # words come out top-to-bottom, which is the order they are printed in
    ys = [w["y0"] for w in got["words"]]
    assert ys == sorted(ys)
    assert all(w["color"].startswith("#") for w in got["words"])


def test_detect_front_declines_a_card_whose_whole_surface_differs():
    # The failure this guards: a filled/clean pair that differs everywhere (a
    # background one export carries and the other doesn't) diffs to "text" the
    # size of the card. Reporting nothing beats writing a confident wrong slot.
    mask, image = _synthetic_card([(0, 0, _CARD_W, _CARD_H)] + _WORD_BANDS)
    assert R.detect_front(mask, image, [0, 0, _CARD_W, _CARD_H],
                          1.0, 0.0, 0.0) is None


def test_detect_front_declines_a_card_with_too_little_ink_to_read():
    mask, image = _synthetic_card(_WORD_BANDS[:2])
    assert R.detect_front(mask, image, [0, 0, _CARD_W, _CARD_H],
                          1.0, 0.0, 0.0) is None


def test_detect_back_title_keeps_one_box_per_title_line():
    # A back carries no words, so group_words cannot be used: every band IS a
    # title line, and a two-line honoree title must survive as two boxes.
    mask, image = _synthetic_card([(80, 40, 320, 100), (100, 120, 300, 180)])
    got = R.detect_back_title(mask, image, [0, 0, _CARD_W, _CARD_H], 1.0, 0.0, 0.0)
    assert len(got) == 2, f"expected one box per title line, got {got}"
    assert got[0]["y0"] < got[1]["y0"]


def test_detect_back_title_reports_a_back_with_no_title_as_empty():
    # A real answer, not a failure: the grapefruit reference export's back is
    # identical clean vs filled — that design prints no name on the back.
    mask, image = _synthetic_card([])
    assert R.detect_back_title(mask, image, [0, 0, _CARD_W, _CARD_H],
                               1.0, 0.0, 0.0) == []


def test_detect_photo_slots_reads_a_two_by_two_grid():
    quads = [(40, 40, 180, 260), (220, 40, 360, 260),
             (40, 320, 180, 540), (220, 320, 360, 540)]
    mask, _image = _synthetic_card(quads)
    got = R.detect_photo_slots(mask, [0, 0, _CARD_W, _CARD_H], 1.0, 0.0, 0.0)
    assert got and len(got) == 4
    assert got[0]["x0"] < got[1]["x0"], "reading order: left before right"
    assert got[0]["y0"] < got[2]["y0"], "reading order: top row before bottom"


def test_detect_photo_slots_declines_anything_that_is_not_a_grid():
    # Not a 2x2 -> None, so config.photo_slots lays out its default inset grid
    # rather than the recipe carrying a guessed geometry.
    mask, _image = _synthetic_card([(40, 40, 360, 260)])
    assert R.detect_photo_slots(mask, [0, 0, _CARD_W, _CARD_H],
                                1.0, 0.0, 0.0) is None


# ---- the shared-slot vote ---------------------------------------------------
# The contract: word slots are SHARED by all eight fronts, only the title moves.
# Eight independent measurements therefore have to collapse to one answer.


def test_word_slots_are_one_shared_set_across_the_fronts():
    per_front = [_slots() for _ in range(8)]
    shared = R.reconcile_word_slots(per_front)
    assert len(shared) == 4
    for i, slot in enumerate(shared):
        assert slot["x0"] == per_front[0][i]["x0"]
        assert slot["y1"] == per_front[0][i]["y1"]


def test_one_misdetected_front_does_not_move_the_shared_slots():
    # THE median property. Seven fronts agree; the eighth is wrong by 40 units.
    # A mean would drag every printed card by 5 units; the median does not move
    # at all until half the fronts agree with the outlier.
    good = _slots()
    per_front = [_slots() for _ in range(7)] + [_shift(good, 40.0)]
    shared = R.reconcile_word_slots(per_front)
    for i, slot in enumerate(shared):
        assert slot["x0"] == good[i]["x0"], "the outlier moved the shared slot"
    mean = sum(f[0]["x0"] for f in per_front) / len(per_front)
    assert mean != shared[0]["x0"], "a mean would have moved — that is the point"


def test_two_outliers_in_opposite_directions_still_leave_the_slots_put():
    good = _slots()
    per_front = ([_slots() for _ in range(6)]
                 + [_shift(good, 40.0), _shift(good, -40.0)])
    shared = R.reconcile_word_slots(per_front)
    assert shared[0]["x0"] == good[0]["x0"]


def test_fronts_that_measured_nothing_are_dropped_not_counted_as_zero():
    # A front that detected nothing contributes None. Folding it in as a zero box
    # would drag the shared slots far harder than any mis-detection could.
    per_front = [None, _slots(), _slots(), None, _slots()]
    shared = R.reconcile_word_slots(per_front)
    assert shared and shared[0]["x0"] == 10.0


def test_no_front_measured_anything_yields_no_slots():
    assert R.reconcile_word_slots([None, None]) == []
    assert R.reconcile_word_slots([]) == []


def test_slot_colour_is_voted_not_blended():
    # Flat vector fills: the right answer is a colour that actually occurs in the
    # artwork, never the average of two.
    per_front = [_slots(colour="#711d20") for _ in range(5)]
    per_front += [_slots(colour="#000000") for _ in range(2)]
    shared = R.reconcile_word_slots(per_front)
    assert shared[0]["color"] == "#711d20"


# ---- regularising the measured layout ---------------------------------------
# Detection measures the ORIGIN's ink, so it reproduces the origin's own
# sloppiness. The owner was correcting that BY HAND in themes.json; these tests
# pin the automatic correction — and, just as importantly, pin that a design
# which is genuinely irregular is left exactly as measured.

_VB = [0.0, 0.0, 223.92, 312.0]

# The real grapefruit measurement, as fractions of the card. The midpoint gaps
# are 0.095 / 0.110 / 0.091 for a design that plainly means four even lines; the
# right edges are one intended edge measured four slightly different ways.
_GRAPEFRUIT_MIDS = [0.377, 0.472, 0.582, 0.673]
_GRAPEFRUIT_X1 = [0.7026, 0.6993, 0.7010, 0.6959]

# The SAME grapefruit artwork, measured by the CONTAINER instead of a laptop.
# Ink boxes move with the rasteriser — Chrome does not lay text out identically
# across platforms — so production reads two of the four mids 3-5 units away and
# lands 18% off an even run where the laptop lands 7%. Under the old 0.15
# tolerance that meant the snap declined in the only place it matters: the owner
# pressed "זהה מחדש" and got the uneven card back. Pinned as its own fixture
# because the laptop numbers alone cannot catch that regression.
_GRAPEFRUIT_MIDS_IN_CONTAINER = [118.50 / 312, 144.38 / 312, 186.75 / 312, 213.00 / 312]


def _measured(mids, x1s=None, heights=None, width=0.30):
    """Word slots built from fractions of the card, as detection would emit."""
    x1s = x1s or [_GRAPEFRUIT_X1[0]] * len(mids)
    heights = heights or [0.04] * len(mids)
    return [{"x0": (x - width) * _VB[2], "x1": x * _VB[2],
             "y0": (m - h / 2) * _VB[3], "y1": (m + h / 2) * _VB[3],
             "color": "#711d20"}
            for m, x, h in zip(mids, x1s, heights)]


def _mids_of(slots):
    return [(s["y0"] + s["y1"]) / 2 / _VB[3] for s in slots]


def _quiet(*_a):
    pass


def test_grapefruits_uneven_lines_are_snapped_onto_an_even_run():
    got = R.regularise_word_slots(_measured(_GRAPEFRUIT_MIDS), _VB, log=_quiet)
    mids = _mids_of(got)
    gaps = [mids[i + 1] - mids[i] for i in range(3)]
    assert max(gaps) - min(gaps) < 1e-9, f"still uneven: {gaps}"
    assert abs(gaps[0] - 0.0987) < 1e-3, f"the design's own spacing, not a guess: {gaps}"


def test_the_measurement_production_actually_makes_is_snapped_too():
    """The regression this tolerance exists to survive.

    A tolerance calibrated on one rasteriser is not a tolerance. These are the
    mids the container logged for grapefruit — "worst fit 18% of the spacing,
    tolerance 15% — left as measured" — while the laptop fitted the same design
    to 7% and snapped it. The card the customer would have printed had four
    unevenly spaced lines.
    """
    got = R.regularise_word_slots(_measured(_GRAPEFRUIT_MIDS_IN_CONTAINER), _VB,
                                  log=_quiet)
    mids = _mids_of(got)
    gaps = [mids[i + 1] - mids[i] for i in range(3)]
    assert max(gaps) - min(gaps) < 1e-9, f"production measurement left uneven: {gaps}"


def test_the_snap_moves_every_slot_less_than_the_error_it_corrects():
    # The point of centring the run instead of anchoring slot 1: the correction
    # is shared out. The worst gap was 0.110 against a 0.0987 spacing — an error
    # of 0.0113 of the card. No slot may move further than that to fix it.
    got = R.regularise_word_slots(_measured(_GRAPEFRUIT_MIDS), _VB, log=_quiet)
    moves = [abs(a - b) for a, b in zip(_mids_of(got), _GRAPEFRUIT_MIDS)]
    assert max(moves) < 0.0113, f"the cure moved more than the disease: {moves}"


def test_a_genuinely_irregular_layout_is_left_exactly_as_measured():
    # THE guard on the whole feature. Some design really may space its lines
    # unevenly, and quietly evening it out would be a worse bug than the one
    # being fixed. These mids need a 32% drag to fit one progression.
    mids = [0.20, 0.30, 0.55, 0.70]
    got = R.regularise_word_slots(_measured(mids), _VB, log=_quiet)
    assert _mids_of(got) == mids


def test_one_intended_right_edge_measured_four_ways_collapses_to_one():
    got = R.regularise_word_slots(
        _measured(_GRAPEFRUIT_MIDS, x1s=_GRAPEFRUIT_X1), _VB, log=_quiet)
    edges = {round(s["x1"], 9) for s in got}
    assert len(edges) == 1, f"four edges survived: {edges}"
    assert abs(edges.pop() / _VB[2] - 0.70015) < 1e-4, "the median, not an average"


def test_edges_that_are_really_staggered_are_not_pooled():
    staggered = [0.70, 0.50, 0.70, 0.30]
    got = R.regularise_word_slots(
        _measured(_GRAPEFRUIT_MIDS, x1s=staggered), _VB, log=_quiet)
    assert [round(s["x1"] / _VB[2], 6) for s in got] == staggered


def test_the_left_bound_keeps_the_leftmost_extent_so_no_word_is_squeezed():
    # x0 is not a position — the renderer pins the marker to x1 and flows left,
    # so x0 only bounds the shrink guard. A median would squeeze the longest
    # word; the leftmost measurement is the honest bound.
    slots = _measured(_GRAPEFRUIT_MIDS, x1s=_GRAPEFRUIT_X1)
    slots[2]["x0"] -= 20.0
    want = min(s["x0"] for s in slots)
    got = R.regularise_word_slots(slots, _VB, log=_quiet)
    assert all(abs(s["x0"] - want) < 1e-9 for s in got)


def test_heights_that_differ_only_by_ascenders_are_unified():
    # An ink box, so a line whose sample word carries a descender measures taller
    # than one that does not. Same box, different words — one height.
    got = R.regularise_word_slots(
        _measured(_GRAPEFRUIT_MIDS, heights=[0.040, 0.046, 0.038, 0.044]),
        _VB, log=_quiet)
    hs = {round(s["y1"] - s["y0"], 9) for s in got}
    assert len(hs) == 1
    assert abs(hs.pop() / _VB[3] - 0.042) < 1e-6, "the median height"


def test_heights_that_are_far_apart_are_left_alone():
    heights = [0.04, 0.04, 0.10, 0.04]
    got = R.regularise_word_slots(
        _measured(_GRAPEFRUIT_MIDS, heights=heights), _VB, log=_quiet)
    assert [round((s["y1"] - s["y0"]) / _VB[3], 6) for s in got] == heights


def test_unifying_the_heights_keeps_the_snapped_midpoints():
    # Heights grow and shrink AROUND the midpoint, so the height snap can never
    # undo the spacing snap.
    got = R.regularise_word_slots(
        _measured(_GRAPEFRUIT_MIDS, heights=[0.040, 0.046, 0.038, 0.044]),
        _VB, log=_quiet)
    mids = _mids_of(got)
    gaps = [mids[i + 1] - mids[i] for i in range(3)]
    assert max(gaps) - min(gaps) < 1e-9


def test_regularising_preserves_order_and_stays_on_the_card():
    got = R.regularise_word_slots(_measured(_GRAPEFRUIT_MIDS, _GRAPEFRUIT_X1),
                                  _VB, log=_quiet)
    ys = [s["y0"] for s in got]
    assert ys == sorted(ys), "slots must still read top to bottom"
    for s in got:
        assert s["x0"] < s["x1"] and s["y0"] < s["y1"]
        assert _VB[0] <= s["x0"] and s["x1"] <= _VB[0] + _VB[2]
        assert _VB[1] <= s["y0"] and s["y1"] <= _VB[1] + _VB[3]


def test_a_slot_list_that_is_not_four_long_does_not_crash():
    # Detection only ever emits four, but this is a pure function and a caller is
    # entitled to hand it anything.
    assert R.regularise_word_slots([], _VB, log=_quiet) == []
    one = _measured([0.5])
    assert R.regularise_word_slots(one, _VB, log=_quiet) == one
    for n in (2, 3, 5, 6):
        mids = [0.2 + 0.1 * i for i in range(n)]
        got = R.regularise_word_slots(_measured(mids), _VB, log=_quiet)
        assert len(got) == n
        assert [round(m, 6) for m in _mids_of(got)] == [round(m, 6) for m in mids]


def test_the_slot_colour_survives_regularising():
    got = R.regularise_word_slots(_measured(_GRAPEFRUIT_MIDS), _VB, log=_quiet)
    assert all(s["color"] == "#711d20" for s in got)


def test_every_snap_is_logged_with_its_before_and_after():
    # The owner has to be able to see that it happened and that it was small —
    # that is what replaces the hand-correction they used to make in themes.json.
    lines = []
    R.regularise_word_slots(
        _measured(_GRAPEFRUIT_MIDS, _GRAPEFRUIT_X1,
                  heights=[0.040, 0.046, 0.038, 0.044]),
        _VB, log=lambda m: lines.append(m))
    joined = "\n".join(lines)
    assert len(lines) == 3, joined
    assert "->" in joined and "largest move" in joined, joined
    assert "was" in joined, joined


def test_leaving_a_layout_alone_is_logged_too():
    lines = []
    R.regularise_word_slots(_measured([0.20, 0.30, 0.55, 0.70]), _VB,
                            log=lambda m: lines.append(m))
    assert any("left as measured" in m for m in lines), lines


def test_the_tolerances_are_env_overridable_like_the_other_knobs():
    # Same shape as DUGRI_WORD_K and friends: a module constant read from the
    # environment, so a stubborn template can be nudged without an edit.
    assert 0 < R._SPACING_TOL < 1 and 0 < R._EDGE_TOL < 1 and 0 < R._HEIGHT_TOL < 1


# ---- the emitted recipe -----------------------------------------------------
# Asserted on the JSON itself: this shape IS the cross-agent contract, so a test
# that only checked what a reader makes of it would pass on a recipe nobody else
# can parse.


def _recipe(front_titles=None, **kw):
    titles = {n: [{"x0": 20.0, "y0": 10.0, "x1": 200.0, "y1": 40.0,
                   "color": "#711d20"}] for n in R.DEFAULT_FRONTS}
    if front_titles is not None:
        titles = front_titles
    return R.assemble_single_recipe(
        "grapefruit", [0.0, 0.0, 223.92, 312.0],
        R.reconcile_word_slots([_slots() for _ in range(8)]), titles, **kw)


def test_the_recipe_declares_format_2_with_its_titles_inside_the_card():
    # The era marker and the placement of the per-front titles are the two things
    # every other agent codes against, so they get their own assertion.
    recipe = _recipe()
    assert recipe["format"] == 2, "absent or 1 would mean the legacy 8-up sheet"
    assert "layout" not in recipe, "the old discriminator must be gone"
    assert "fronts" not in recipe, "titles live in the card, not at the top level"
    titles = recipe["card"]["title"]
    assert sorted(titles) == sorted(str(n) for n in R.DEFAULT_FRONTS)
    for n in R.DEFAULT_FRONTS:
        assert isinstance(titles[str(n)], list), "a title is a LIST, one box per line"


def test_the_card_block_gets_the_whole_page_as_its_cell():
    # The grid split is gone: the page IS the card, so the cell is the viewBox.
    card = _recipe()["card"]
    assert card["cell"] == [0.0, 0.0, 223.92, 312.0]
    assert len(card["words"]) == 4


def test_each_front_keeps_its_own_title_box():
    titles = {n: [{"x0": float(n), "y0": 10.0, "x1": 200.0, "y1": 40.0,
                   "color": "#711d20"}] for n in R.DEFAULT_FRONTS}
    recipe = _recipe(front_titles=titles)
    for n in R.DEFAULT_FRONTS:
        got = recipe["card"]["title"][str(n)]
        assert len(got) == 1 and got[0]["x0"] == float(n)


def test_a_multi_line_title_survives_as_several_boxes():
    two_lines = [{"x0": 20.0, "y0": 10.0, "x1": 200.0, "y1": 40.0, "color": "#111"},
                 {"x0": 30.0, "y0": 44.0, "x1": 190.0, "y1": 70.0, "color": "#111"}]
    recipe = _recipe(front_titles={2: two_lines})
    assert recipe["card"]["title"]["2"] == two_lines


def test_an_undetected_front_is_omitted_not_written_as_an_empty_title():
    # An empty list and a missing key take the SAME renderer fallback, so writing
    # one would only pretend something was measured. The recipe records only what
    # was actually seen; supplying the fallback box is the reader's job.
    titles = {2: [{"x0": 20.0, "y0": 10.0, "x1": 100.0, "y1": 40.0, "color": "#111"}],
              3: [{"x0": 60.0, "y0": 14.0, "x1": 200.0, "y1": 50.0, "color": "#111"}],
              4: []}
    recipe = _recipe(front_titles=titles)
    assert sorted(recipe["card"]["title"]) == ["2", "3"]


def test_undetected_photo_slots_leave_the_key_off_entirely():
    # Optional by contract: the reader then lays out its default inset grid,
    # rather than the recipe carrying a guessed geometry.
    assert "photo" not in _recipe()


def test_detected_photo_slots_are_recorded_verbatim():
    quads = [{"x0": 10.0, "y0": 10.0, "x1": 100.0, "y1": 140.0},
             {"x0": 120.0, "y0": 10.0, "x1": 210.0, "y1": 140.0},
             {"x0": 10.0, "y0": 160.0, "x1": 100.0, "y1": 300.0},
             {"x0": 120.0, "y0": 160.0, "x1": 210.0, "y1": 300.0}]
    assert _recipe(photo_slots=quads)["photo"]["slots"] == quads


def test_a_back_with_no_title_is_recorded_as_an_explicit_null():
    # Not an omission: grapefruit's back is a full-bleed pattern with no text slot
    # at all, and null is the measured answer "asked, nothing there". The renderer
    # then uses the theme's back.frac.
    recipe = _recipe(back_title=[])
    assert "back" in recipe and recipe["back"] is None
    assert _recipe(back_title=[{"x0": 1.0, "y0": 2.0, "x1": 3.0, "y1": 4.0}])["back"]


def test_the_recipe_round_trips_through_json_unchanged():
    # It is written to disk and read back by other processes, so nothing in the
    # emitted shape may depend on Python-only key types (a front number keyed as
    # an int would come back as a string and silently miss every lookup).
    recipe = _recipe(back_title=[{"x0": 1.0, "y0": 2.0, "x1": 3.0, "y1": 4.0}])
    assert json.loads(json.dumps(recipe)) == recipe


# ---- the v1 path is untouched ----------------------------------------------


def test_the_shipped_v1_recipes_still_read_as_sheet_recipes():
    checked = 0
    for name in sorted(os.listdir(os.path.join(R.HERE, "recipes"))):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(R.HERE, "recipes", name), encoding="utf-8") as f:
            recipe = json.load(f)
        if "cards" not in recipe:
            continue
        # Nothing about a v1 recipe may read as v2: no era marker, no card block.
        assert recipe.get("format", 1) == 1, name
        assert "card" not in recipe, name
        checked += 1
    assert checked, "no shipped v1 recipe was exercised"


def test_both_detectors_write_where_the_generator_reads_back():
    """``write_recipe`` exists because ``generator/recipes/`` is INSIDE the
    container image, which on Railway is ephemeral: a recipe written there
    survives until the next deploy and then silently reverts, so the owner
    presses "detect again", it reports success, and some time later the
    calibration screen says the recipe is missing.

    It was only ever wired into the single-card branch. The 8-up sheet branch
    wrote straight into the image, so every v1 template kept losing its
    re-detected recipe — and, on a developer's machine, wrote into the checkout.
    """


    with tempfile.TemporaryDirectory() as store:
        was = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = store
        try:
            path = R.write_recipe("some-theme", {"theme": "some-theme"})
        finally:
            if was is None:
                os.environ.pop("DATA_DIR", None)
            else:
                os.environ["DATA_DIR"] = was
        assert path.startswith(store), path
        assert os.path.exists(path)
        assert not os.path.exists(
            os.path.join(R.HERE, "recipes", "some-theme.json")), (
            "the sheet path must not write into the image")
    # And the sheet branch reaches it rather than opening a file of its own.
    src = inspect.getsource(R.main_sheet)
    assert "write_recipe(" in src, "main_sheet bypasses write_recipe"
    assert 'os.path.join(HERE, "recipes"' not in src, (
        "main_sheet still writes into the image")


def test_the_cli_sends_each_structure_down_its_own_path():
    """The gate, without Chrome: which detector does each invocation reach?"""
    import sys

    calls = []
    sheet, single = R.main_sheet, R.main_single
    R.main_sheet = lambda *a: calls.append(("sheet",) + a) or 0
    R.main_single = lambda *a: calls.append(("single",) + a) or 0
    v1 = _template(["clean/fronts.svg", "filled/fronts.svg"])
    v2 = _template(["clean/1.svg", "clean/2.svg", "filled/1.svg", "filled/2.svg"])
    argv = sys.argv
    try:
        sys.argv = ["recipe_diff.py", os.path.join(v1, "filled", "fronts.svg"),
                    os.path.join(v1, "clean", "fronts.svg"), "t1"]
        assert R.main() == 0
        assert calls[-1][0] == "sheet"

        sys.argv = ["recipe_diff.py", "--single", v2, "t2"]
        assert R.main() == 0
        assert calls[-1] == ("single", v2, "t2")

        # a bare "<dir> <theme>" is unambiguous — the sheet form takes two FILES
        sys.argv = ["recipe_diff.py", v2, "t3"]
        assert R.main() == 0
        assert calls[-1] == ("single", v2, "t3")

        # and the server's existing three-argument call auto-upgrades: a v2
        # template ships no fronts.svg, so the sheet path could not even start.
        sys.argv = ["recipe_diff.py", os.path.join(v2, "filled", "fronts.svg"),
                    os.path.join(v2, "clean", "fronts.svg"), "t4"]
        assert R.main() == 0
        assert calls[-1] == ("single", v2, "t4")

        sys.argv = ["recipe_diff.py", "only-one-arg"]
        assert R.main() == 2
    finally:
        sys.argv = argv
        R.main_sheet, R.main_single = sheet, single
        shutil.rmtree(v1, ignore_errors=True)
        shutil.rmtree(v2, ignore_errors=True)


# ---- a template may declare FEWER fronts than the default eight -------------
# A deck where every card carries the SAME design ships clean/1.svg + clean/2.svg
# and says so with `cards: {fronts: [2]}`. Detection must walk THAT list: walking
# 2..9 still works (missing pairs are skipped) but reports seven absent files,
# which reads to the owner like a broken upload.

def test_detection_walks_the_themes_own_front_list():
    root = tempfile.mkdtemp(prefix="dugri-fronts-")
    prev = os.environ.get("DATA_DIR")
    try:
        os.makedirs(os.path.join(root, "templates"))
        with open(os.path.join(root, "templates", "themes.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"onefront": {"slug": "onefront", "card_structure": "cards",
                                    "cards": {"back": 1, "fronts": [2]}},
                       "eightfront": {"slug": "eightfront",
                                      "card_structure": "cards"}}, f)
        os.environ["DATA_DIR"] = root
        config.clear_preview_overrides()
        assert R.theme_fronts("onefront") == [2]
        assert R.theme_fronts("eightfront") == R.DEFAULT_FRONTS
        # An UNREGISTERED theme is the normal case when a template is measured
        # before its entry exists — never fatal, just "no opinion".
        assert R.theme_fronts("no-such-theme") is None
    finally:
        if prev is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = prev
        shutil.rmtree(root, ignore_errors=True)


def test_a_one_front_template_measures_only_the_front_it_has():
    """detect_single_card over a one-element list touches 2.svg and nothing else."""
    seen = []

    def fake_card_diff(filled, clean, workdir, tag=None, reg=None):
        seen.append(os.path.basename(clean))
        raise RuntimeError("stop once the walked file list is known")

    real = R.card_diff
    R.card_diff = fake_card_diff
    d = _template(["clean/1.svg", "clean/2.svg", "filled/1.svg", "filled/2.svg"])
    try:
        try:
            R.detect_single_card("t", d, fronts=[2], log=lambda *a: None)
        except RuntimeError:
            pass
        assert seen == ["2.svg"], seen
    finally:
        R.card_diff = real
        shutil.rmtree(d, ignore_errors=True)


# ---- end to end, where a rasterizer exists ---------------------------------

_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="224" height="312" '
        'viewBox="0 0 223.92 312" preserveAspectRatio="xMidYMid meet">'
        '<rect width="223.92" height="312" fill="#fdf6ec"/>{ink}</svg>')
# Bands drawn as rects rather than text: the geometry under test is the banding,
# and a rect needs no font to be present for the render to be reproducible.
_E2E_TITLE = '<rect x="40" y="20" width="140" height="30" fill="#711d20"/>'
_E2E_WORDS = "".join(
    f'<rect x="{60 + 10 * i}" y="{110 + 30 * i}" width="{100 - 5 * i}" '
    f'height="16" fill="#711d20"/>' for i in range(4))


def _chrome():
    return R.CHROME if os.path.exists(R.CHROME) else None


def _e2e_template(back_ink=""):
    d = tempfile.mkdtemp(prefix="dugri-e2e-")
    for half in ("clean", "filled"):
        os.makedirs(os.path.join(d, half))
    for index in R.DEFAULT_FRONTS:
        # the icon that differs per front is background art: it is in BOTH halves
        # and therefore cancels out of the diff, exactly as in a real export.
        icon = f'<circle cx="{20 + index}" cy="290" r="6" fill="#f4a259"/>'
        _write(d, "clean", index, icon)
        _write(d, "filled", index, icon + _E2E_TITLE + _E2E_WORDS)
    _write(d, "clean", 1, "")
    _write(d, "filled", 1, back_ink)
    return d


def _write(d, half, index, ink):
    with open(os.path.join(d, half, f"{index}.svg"), "w", encoding="utf-8") as f:
        f.write(_SVG.format(ink=ink))


def test_end_to_end_on_a_rendered_deck():
    chrome = _chrome()
    if not chrome:
        print("  (skip end-to-end: Chrome not found)")
        return
    d = _e2e_template(back_ink='<rect x="50" y="120" width="120" height="34" '
                               'fill="#711d20"/>')
    try:
        recipe = R.detect_single_card("e2e", d, fronts=[2, 3], log=lambda *a: None)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    assert recipe["format"] == 2
    card = recipe["card"]
    assert len(card["words"]) == 4
    # the drawn word bands, recovered in the card's own user units
    for i, slot in enumerate(card["words"]):
        assert abs(slot["y0"] - (110 + 30 * i)) < 1.5, slot
        assert abs(slot["x0"] - (60 + 10 * i)) < 1.5, slot
    for n in (2, 3):
        title = card["title"][str(n)]
        assert len(title) == 1
        assert abs(title[0]["y0"] - 20) < 1.5 and abs(title[0]["x0"] - 40) < 1.5
    assert recipe["back"]["title"], "the back's title must be detected"
    assert abs(recipe["back"]["title"][0]["y0"] - 120) < 1.5


def test_end_to_end_a_back_with_no_personalization_records_no_title():
    chrome = _chrome()
    if not chrome:
        print("  (skip end-to-end: Chrome not found)")
        return
    d = _e2e_template(back_ink="")
    try:
        recipe = R.detect_single_card("e2e", d, fronts=[2], log=lambda *a: None)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    # null, not a bogus box: the diff found nothing because there is nothing.
    assert recipe["back"] is None, "an identical clean/filled back has no title"


def test_end_to_end_on_the_shipped_grapefruit_export():
    """The real reference export, when it is present in this checkout.

    Skipped rather than failed where the assets are not there: they arrive with
    the migration, and until then this test is dormant. Only two fronts are
    measured — the point is that the real art detects at all, and the
    eight-front agreement is covered by the reconciliation tests above.
    """
    chrome = _chrome()
    src = os.path.join(config.REPO, "resources", "canva", "templates",
                       "grapefruit", "new structure")
    if not chrome or not os.path.isdir(os.path.join(src, "clean")):
        print("  (skip grapefruit: no Chrome or no reference export here)")
        return
    recipe = R.detect_single_card("grapefruit", src, fronts=[2, 3],
                                  log=lambda *a: None)
    card = recipe["card"]
    assert len(card["words"]) == 4
    assert card["cell"][2] > 200 and card["cell"][3] > 300, "a portrait card"
    assert card["title"].get("2"), "front 2 must carry a title"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")


# --- a detection failure must say WHAT it saw --------------------------------
# "not one front yielded four word slots" was true but unusable: the per-front
# reasons went to stdout, and the server reports stderr when a run fails, so the
# owner got a bare traceback. The three failures need opposite fixes, so the
# message has to tell them apart.

def _mask(w, h, fill):
    from PIL import Image, ImageDraw
    m = Image.new("1", (w, h), 0)
    if fill:
        d = ImageDraw.Draw(m)
        d.rectangle(fill, fill=1)
    return m


def test_an_empty_diff_says_the_exports_are_identical():
    why = R._diff_shape(_mask(400, 560, None))
    assert "identical" in why, why
    assert "no personalized text" in why


def test_a_saturated_diff_says_the_pair_does_not_correspond():
    # Ink over most of the card means the two files differ everywhere — a
    # mismatched pair, not a text diff.
    why = R._diff_shape(_mask(400, 560, (0, 0, 399, 559)))
    assert "%" in why and "not just in the text" in why, why


def test_a_sparse_but_unstructured_diff_says_so():
    why = R._diff_shape(_mask(400, 560, (10, 10, 120, 60)))
    assert "does not form four evenly spaced word rows" in why, why


def test_the_failure_lists_every_front_it_tried():
    # The reasons are collected per front and folded into the error itself, so
    # they survive being reported through stderr.
    import inspect
    src = inspect.getsource(R.detect_single_card)
    assert "reasons.append" in src
    assert "What each front actually produced" in src


def test_a_refused_snap_is_reported_not_just_logged():
    """The gap that let grapefruit's uneven card survive repeated re-detections.

    The refusal was always computed and always logged — on a container, into a
    stream nobody reads, while the detector reported success. Collect it so it
    can reach the owner.
    """
    declined = []
    R.regularise_word_slots(_measured([0.20, 0.30, 0.55, 0.70]), _VB,
                            log=_quiet, declined=declined)
    assert declined, "a refused snap must be reported, not only logged"
    assert any("not one progression" in m for m in declined), declined


def test_a_clean_detection_reports_nothing_refused():
    # The other half: no false alarms. A layout that snaps cleanly must leave
    # the list empty, or the warning stops meaning anything.
    declined = []
    R.regularise_word_slots(_measured(_GRAPEFRUIT_MIDS), _VB,
                            log=_quiet, declined=declined)
    assert declined == [], declined


# --- a per-front title box that does not look like the rest of the deck --------
#
# Detection reads one front at a time and cannot, per front, tell the honoree's
# name from a patch of artwork the clean export happens to be missing. Read
# together the fronts DO tell: the title is the same text on every one of them,
# so its box is the same SIZE wherever on the card it sits. Card 9's clean plate
# is missing artwork its filled twin has on three unrelated designs, and
# ``filled − clean`` reads that as text — giving a box 2.3x wide on סיישל, 1.7x
# on פריז and 2.3x on קליפורניה, with an identical runaway origin on two designs
# that share nothing else.

def _tbox(x0, y0, w=80.0, h=30.0):
    return [{"x0": x0, "y0": y0, "x1": x0 + w, "y1": y0 + h, "color": "#111111"}]


def test_a_runaway_title_box_is_refused_and_reported():
    titles = {2: _tbox(20.0, 10.0), 3: _tbox(60.0, 11.0), 4: _tbox(100.0, 10.0),
              5: _tbox(20.0, 12.0), 9: _tbox(5.0, 4.0, w=190.0, h=70.0)}
    said, declined = [], []
    got = R.reconcile_front_titles(titles, log=said.append, declined=declined)
    assert 9 not in got, "the runaway box must not be written"
    assert set(got) == {2, 3, 4, 5}
    assert declined and "front 9" in declined[0]
    assert "clean/9.svg" in declined[0], "say WHERE to look"


def test_fronts_that_merely_move_across_the_card_are_all_kept():
    # קליפורניה's title moves a third of the card between fronts; its SIZE does
    # not, which is the whole signal.
    titles = {2: _tbox(20.0, 10.0), 3: _tbox(60.0, 11.0), 4: _tbox(120.0, 10.0),
              5: _tbox(150.0, 12.0)}
    declined = []
    assert R.reconcile_front_titles(titles, declined=declined) == titles
    assert not declined


def test_a_box_within_tolerance_of_its_siblings_is_kept():
    # a descender or a swash moves the box a few percent; that is not a runaway
    titles = {2: _tbox(20.0, 10.0), 3: _tbox(60.0, 11.0),
              4: _tbox(100.0, 10.0, w=88.0), 5: _tbox(20.0, 12.0, h=33.0)}
    assert R.reconcile_front_titles(titles) == titles


def test_too_few_fronts_to_have_a_consensus_are_left_alone():
    titles = {2: _tbox(20.0, 10.0), 3: _tbox(5.0, 4.0, w=190.0, h=70.0)}
    assert R.reconcile_front_titles(titles) == titles


# ---- a title that does not sit above the words -------------------------------
#
# The detector used to define a title as "ink above the topmost word row", which
# is a layout assumption, not a measurement. מרקאנה (football-boys) breaks it:
# its front 9 carries ``Ben's B-day`` at the FOOT of the card, under the four
# words, where fronts 2-8 carry it at the top. That front therefore detected
# ``title == []``, was written with no title box, and silently inherited the
# median of its siblings' — putting the honoree's name at the top of a card whose
# design puts it at the bottom. The owner found it by eye.

# The same card, with its title band moved BELOW the four word rows.
_LOW_TITLE_BAND = (80, 520, 320, 580)


def test_a_title_below_the_words_is_found():
    mask, image = _synthetic_card(_WORD_BANDS + [_LOW_TITLE_BAND])
    got = R.detect_front(mask, image, [0, 0, _CARD_W, _CARD_H], 1.0, 0.0, 0.0)
    assert got, "a card whose title sits low must still cluster"
    assert len(got["words"]) == 4
    assert len(got["title"]) == 1, "the low band is the title, not a fifth word"
    assert got["title"][0]["y0"] >= got["words"][-1]["y1"], "title sits BELOW word 4"
    assert abs(got["title"][0]["y0"] - _LOW_TITLE_BAND[1]) < 1e-6


def test_the_word_rows_are_the_marker_aligned_ones_wherever_the_title_is():
    # The signal that replaces the position assumption: the four word rows share
    # a right edge (each carries its "N." marker), a title does not. Assert it
    # directly so a future change cannot quietly go back to sorting by cy.
    for bands in (_WORD_BANDS + [_LOW_TITLE_BAND], [_TITLE_BAND] + _WORD_BANDS):
        grouped = R.group_words(
            [[y0, y1, x0, x1] for x0, y0, x1, y1 in bands], _CARD_H,
            whole_card=True)
        assert [w["x1"] for w in grouped["words"]] == [300] * 4, bands
        assert [t["x1"] for t in grouped["title"]] == [320], bands


def test_a_title_split_over_two_lines_below_the_words_stays_two_boxes():
    low = [(80, 500, 320, 540), (100, 550, 310, 590)]
    mask, image = _synthetic_card(_WORD_BANDS + low)
    got = R.detect_front(mask, image, [0, 0, _CARD_W, _CARD_H], 1.0, 0.0, 0.0)
    assert got and len(got["words"]) == 4
    assert len(got["title"]) == 2, "one box per title line, as for a high title"


def test_a_title_above_AND_below_the_words_keeps_both():
    # Nothing says a design may not do both — a name over the list and a date
    # under it. Neither band is a word row, so both are title ink.
    mask, image = _synthetic_card([_TITLE_BAND] + _WORD_BANDS + [_LOW_TITLE_BAND])
    got = R.detect_front(mask, image, [0, 0, _CARD_W, _CARD_H], 1.0, 0.0, 0.0)
    assert got and len(got["words"]) == 4
    assert len(got["title"]) == 2
    ys = sorted(t["y0"] for t in got["title"])
    assert abs(ys[0] - _TITLE_BAND[1]) < 1e-6
    assert abs(ys[1] - _LOW_TITLE_BAND[1]) < 1e-6


def test_end_to_end_a_deck_whose_title_sits_under_the_words():
    # The whole defect, through the real rasterizer: bands drawn low on the card
    # must come back as this front's OWN title box, not as a missing entry.
    if not _chrome():
        print("  (skip end-to-end low title: Chrome not found)")
        return
    low = '<rect x="40" y="250" width="140" height="30" fill="#711d20"/>'
    d = tempfile.mkdtemp(prefix="dugri-e2e-low-")
    try:
        for half in ("clean", "filled"):
            os.makedirs(os.path.join(d, half))
        for index in (2, 3):
            _write(d, "clean", index, "")
            _write(d, "filled", index, _E2E_WORDS + low)
        recipe = R.detect_single_card("e2e-low", d, fronts=[2, 3],
                                      log=lambda *a: None)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    for n in (2, 3):
        title = recipe["card"]["title"][str(n)]
        assert len(title) == 1, title
        assert abs(title[0]["y0"] - 250) < 1.5, title
        assert title[0]["y0"] > recipe["card"]["words"][-1]["y0"], "below the words"
    # A low title is a NORMAL reading, not a refusal: nothing about this front
    # may reach ``declined``. (The fixture's word rects are deliberately drawn
    # with staggered right edges, so the edge SNAP declines — that is the
    # fixture's geometry, and it is not a complaint about a front.)
    assert not [m for m in recipe.get("declined") or []
                if m.startswith("front ")], recipe.get("declined")


# ---- a pair whose two plates draw the card at different scales ----------------
#
# The REAL reason מרקאנה's front 9 measured nothing. Of the eleven templates in
# the owner's store, four ship a clean/9.svg at viewBox 224.25x311.999995 whose
# filled/9.svg twin — and every other plate in the same deck — is 223.92x312, with
# the artwork inside scaled to match (0.747953 against 0.749732). Both plates are
# then drawn into the same window at different sizes, so filled-clean is the whole
# design ghosted against itself rather than the text: on מרקאנה that collapses a
# card's worth of ink into ONE band spanning the page. The other three
# (סיישל, פריז, קליפורניה) produce the runaway title box that
# ``_TITLE_BOX_TOL`` refuses — the same cause, caught one step later and blamed
# on "a clean plate missing artwork", which is not what the files show.

_VB_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="299" height="416" '
           'viewBox="{vb}" preserveAspectRatio="xMidYMid meet"></svg>')


def _plate(path, vb):
    with open(path, "w", encoding="utf-8") as f:
        f.write(_VB_SVG.format(vb=vb))
    return path


def test_a_matching_pair_reports_no_mismatch():
    d = tempfile.mkdtemp(prefix="dugri-vb-")
    try:
        a = _plate(os.path.join(d, "2.svg"), "0 0 223.92 312")
        b = _plate(os.path.join(d, "2c.svg"), "0 0 223.92 312")
        assert R.viewbox_mismatch(a, b) is None
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_the_canva_rounding_artifact_alone_is_not_a_mismatch():
    # 311.999995 against 312 is float dust in the export, not a different card.
    d = tempfile.mkdtemp(prefix="dugri-vb-")
    try:
        a = _plate(os.path.join(d, "2.svg"), "0 0 223.92 312")
        b = _plate(os.path.join(d, "2c.svg"), "0 0 223.92 311.999995")
        assert R.viewbox_mismatch(a, b) is None
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_a_mismatched_pair_names_both_plates_and_says_which_to_re_export():
    d = tempfile.mkdtemp(prefix="dugri-vb-")
    try:
        a = _plate(os.path.join(d, "9.svg"), "0 0 223.92 312")
        b = _plate(os.path.join(d, "9c.svg"), "0 0 224.25 311.999995")
        why = R.viewbox_mismatch(a, b)
        assert why, "a 0.15% difference in the coordinate space must be caught"
        assert "9.svg" in why and "9c.svg" in why, why
        assert "223.92" in why and "224.25" in why, "quote both, so it is checkable"
        assert "Re-export" in why, "say what to DO about it"
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_a_mismatched_front_is_declined_by_name_without_rendering_it():
    # Checked from the two file headers, BEFORE Chrome — so this runs everywhere
    # and a broken pair costs nothing to diagnose. Every front is mismatched
    # here, so nothing is measurable and the failure must carry the reason.
    d = tempfile.mkdtemp(prefix="dugri-vb-")
    try:
        for half in ("clean", "filled"):
            os.makedirs(os.path.join(d, half))
        for index in (2, 3):
            _plate(os.path.join(d, "filled", f"{index}.svg"), "0 0 223.92 312")
            _plate(os.path.join(d, "clean", f"{index}.svg"), "0 0 224.25 312")
        said = []
        try:
            R.detect_single_card("vb", d, fronts=[2, 3], log=said.append)
            raise AssertionError("an unmeasurable deck must not report success")
        except RuntimeError as e:
            assert "224.25" in str(e), str(e)
            assert "clean/2.svg" in str(e), "name the file to re-export"
        assert any("224.25" in m for m in said), said
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ---- ...and a mismatch that CAN be registered is measured, not refused --------
#
# Reporting the mismatch is the last resort, not the answer. The two plates draw
# the same shapes, so the similarity between them is arithmetic on their own path
# geometry (generator/svg_register.py); rendering the clean plate through it puts
# them back on one pixel grid and the diff is the text again. On מרקאנה that is
# the difference between front 9's title being measured at the FOOT of the card,
# where the design puts it, and the card silently inheriting its siblings' box at
# the top.

_REG_SCALE = 1.002384          # מרקאנה's two export passes, to the digit
_REG_SHIFT = -0.4646
_REG_CLEAN_VB = "0 0 224.25 311.999995"

# Artwork both plates carry, in the four margins so it never touches the text.
# Four different aspect ratios, so each shape is findable in the other plate.
_REG_ART = [(4, 4, 52, 306), (176, 4, 220, 306),
            (60, 4, 164, 24), (60, 292, 164, 306)]
# Four word rows sharing ONE right edge, the way a rendered card's "N." markers
# do — that shared edge is what ``_marker_aligned`` reads to tell a word row from
# a title, so the title is set to end well clear of it.
_REG_WORDS = "".join(
    f'<rect x="{70 + 8 * i}" y="{110 + 30 * i}" width="{80 - 8 * i}" '
    f'height="16" fill="#711d20"/>' for i in range(4))
_REG_HIGH_TITLE = '<rect x="75" y="40" width="60" height="30" fill="#711d20"/>'
_REG_LOW_TITLE = '<rect x="75" y="250" width="60" height="30" fill="#711d20"/>'


def _reg_art(scale=1.0, shift=0.0):
    """The margin artwork as ONE plate draws it: filled = scale*clean + shift."""
    out = []
    for x0, y0, x1, y1 in _REG_ART:
        cx0, cx1 = (x0 - 0.0) / scale, (x1 - 0.0) / scale
        cy0, cy1 = (y0 - shift) / scale, (y1 - shift) / scale
        out.append(f'<path fill="#2340a0" d="M {cx0} {cy0} L {cx1} {cy0} '
                   f'L {cx1} {cy1} L {cx0} {cy1} Z"/>')
    return "".join(out)


def _reg_plate(path, vb, art, ink):
    with open(path, "w", encoding="utf-8") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" width="299" '
                f'height="416" viewBox="{vb}" '
                'preserveAspectRatio="xMidYMid meet">'
                '<rect width="100%" height="100%" fill="#fdf6ec"/>'
                + art + ink + "</svg>")


def _reg_template():
    """A deck whose front 3 is exported exactly the way Canva broke מרקאנה's 9.

    Front 2 is an ordinary matching pair. Front 3's clean plate declares the
    other viewBox and draws the artwork at the other scale — and carries the
    title LOW, so a fallback to its sibling's box would be visible.
    """
    d = tempfile.mkdtemp(prefix="dugri-reg-")
    for half in ("clean", "filled"):
        os.makedirs(os.path.join(d, half))
    good = _reg_art()
    _reg_plate(os.path.join(d, "clean", "2.svg"), "0 0 223.92 312", good, "")
    _reg_plate(os.path.join(d, "filled", "2.svg"), "0 0 223.92 312", good,
               _REG_WORDS + _REG_HIGH_TITLE)
    _reg_plate(os.path.join(d, "clean", "3.svg"), _REG_CLEAN_VB,
               _reg_art(_REG_SCALE, _REG_SHIFT), "")
    _reg_plate(os.path.join(d, "filled", "3.svg"), "0 0 223.92 312", good,
               _REG_WORDS + _REG_LOW_TITLE)
    return d


def test_a_mismatched_front_is_registered_and_measured_not_refused():
    if not _chrome():
        print("  (skip registered front: Chrome not found)")
        return
    d = _reg_template()
    said = []
    try:
        recipe = R.detect_single_card("reg", d, fronts=[2, 3], log=said.append)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    low = recipe["card"]["title"].get("3")
    assert low, "the mis-exported front must be MEASURED, not dropped"
    box = {k: min(b[k] for b in low) if k[1] == "0" else max(b[k] for b in low)
           for k in ("x0", "y0", "x1", "y1")}
    assert abs(box["y0"] - 250) < 2, box
    assert abs(box["x0"] - 75) < 2 and abs(box["x1"] - 135) < 2, box
    assert box["y0"] > recipe["card"]["words"][-1]["y0"], "below the words"
    assert not [m for m in recipe.get("declined") or []
                if m.startswith("front 3")], recipe.get("declined")
    assert any("registered" in m for m in said), said


def test_registering_one_front_leaves_its_matching_siblings_alone():
    """The correction must reach ONLY the pair that needs it.

    Front 2's plates agree, so nothing is derived and nothing is applied — its
    boxes must come out exactly as they do in a deck with no mismatch at all.
    """
    if not _chrome():
        print("  (skip registration blast radius: Chrome not found)")
        return
    d = _reg_template()
    clean = tempfile.mkdtemp(prefix="dugri-reg-ok-")
    try:
        for half in ("clean", "filled"):
            os.makedirs(os.path.join(clean, half))
        for src in ("clean/2.svg", "filled/2.svg"):
            shutil.copy(os.path.join(d, src), os.path.join(clean, src))
        with_mismatch = R.detect_single_card("reg", d, fronts=[2],
                                             log=lambda *a: None)
        without = R.detect_single_card("ok", clean, fronts=[2],
                                       log=lambda *a: None)
    finally:
        shutil.rmtree(d, ignore_errors=True)
        shutil.rmtree(clean, ignore_errors=True)
    assert with_mismatch["card"] == without["card"]


def test_a_registered_front_does_not_move_the_shared_word_slots():
    """It answers the question only it can, and nothing else.

    The four word slots are the SAME on every front by contract, so a registered
    front tells the deck nothing about them its siblings have not already said
    directly — while its title box is per-front and has no other source at all.
    Letting the corrected reading into the shared vote moves the words on every
    card of the deck for no gain (``_median`` of eight averages the two middle
    values where seven takes the middle one), so it is kept out.
    """
    if not _chrome():
        print("  (skip shared-slot blast radius: Chrome not found)")
        return
    both = _reg_template()
    alone = tempfile.mkdtemp(prefix="dugri-reg-alone-")
    try:
        for half in ("clean", "filled"):
            os.makedirs(os.path.join(alone, half))
        for src in ("clean/2.svg", "filled/2.svg"):
            shutil.copy(os.path.join(both, src), os.path.join(alone, src))
        with_nine = R.detect_single_card("reg", both, fronts=[2, 3],
                                         log=lambda *a: None)
        without = R.detect_single_card("ok", alone, fronts=[2],
                                       log=lambda *a: None)
    finally:
        shutil.rmtree(both, ignore_errors=True)
        shutil.rmtree(alone, ignore_errors=True)
    assert with_nine["card"]["words"] == without["card"]["words"]
    assert with_nine["card"]["title"].get("3"), "...but its title IS recorded"


def test_a_deck_read_only_through_registration_still_gets_word_slots():
    """Keeping a corrected reading out of the vote must not mean discarding it.

    A deck whose EVERY plate pair needs registering has no direct reading to
    prefer, and refusing the corrected ones would fail a template that is
    perfectly measurable.
    """
    if not _chrome():
        print("  (skip registered-only deck: Chrome not found)")
        return
    d = tempfile.mkdtemp(prefix="dugri-reg-only-")
    try:
        for half in ("clean", "filled"):
            os.makedirs(os.path.join(d, half))
        for index in (2, 3):
            _reg_plate(os.path.join(d, "clean", f"{index}.svg"), _REG_CLEAN_VB,
                       _reg_art(_REG_SCALE, _REG_SHIFT), "")
            _reg_plate(os.path.join(d, "filled", f"{index}.svg"),
                       "0 0 223.92 312", _reg_art(),
                       _REG_WORDS + _REG_HIGH_TITLE)
        recipe = R.detect_single_card("only", d, fronts=[2, 3],
                                      log=lambda *a: None)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    words = recipe["card"]["words"]
    assert len(words) == 4, words
    for i, slot in enumerate(words):
        assert abs(slot["y0"] - (110 + 30 * i)) < 2, slot


def test_the_page_edge_is_not_read_as_ink():
    """The last pixel column is paper on one plate and card on the other.

    מרקאנה's clean/9 has the window's exact aspect so its card is drawn edge to
    edge; its filled twin is a hair narrower and gets 0.22px of paper down each
    side. Registered, that column differs on every row — and it stretched EVERY
    band on the card out to the right edge, turning a title 68 units wide into
    one 144 units wide that ``_TITLE_BOX_TOL`` then refused.
    """
    mask = Image.new("L", (598, 832), 0)
    for y in range(832):
        mask.putpixel((597, y), 255)          # the page-edge column
    mask.putpixel((300, 400), 255)            # real ink, well inside the card
    out = R._both_plates_drawn(
        mask, (1.002384, 0.2209, -0.6195), [0, 0, 223.92, 312],
        (299, 416, [0, 0, 224.25, 311.999995]), 299, 416)
    assert out.getbbox() == (300, 400, 301, 401), out.getbbox()


# ---- a front that yielded nothing must say so --------------------------------
#
# ``reasons`` is only ever raised when the WHOLE deck fails, so a single front
# that measured nothing while its siblings succeeded fell out of the loop into
# silence: no card.title entry, no warning, and config.recipe_front_title quietly
# handing it the median of the others. That is precisely how מרקאנה shipped.


def test_a_single_front_that_measured_nothing_is_reported():
    real = R.detect_front

    def only_the_first(mask, image, vb, ppu, ox, oy):
        got = real(mask, image, vb, ppu, ox, oy)
        only_the_first.seen += 1
        return got if only_the_first.seen == 1 else None

    only_the_first.seen = 0
    if not _chrome():
        print("  (skip lone-front report: Chrome not found)")
        return
    d = _e2e_template()
    R.detect_front = only_the_first
    try:
        recipe = R.detect_single_card("lone", d, fronts=[2, 3],
                                      log=lambda *a: None)
    finally:
        R.detect_front = real
        shutil.rmtree(d, ignore_errors=True)
    assert "3" not in recipe["card"]["title"], "the front measured nothing"
    said = recipe.get("declined") or []
    assert any("front 3" in m for m in said), said
    assert any("clean/3.svg" in m for m in said), "say WHERE to look"


def test_a_front_with_words_but_no_title_ink_is_reported():
    if not _chrome():
        print("  (skip no-title report: Chrome not found)")
        return
    d = tempfile.mkdtemp(prefix="dugri-e2e-notitle-")
    try:
        for half in ("clean", "filled"):
            os.makedirs(os.path.join(d, half))
        for index in (2, 3):
            _write(d, "clean", index, "")
            # front 3 carries the words only — no title band anywhere on it
            _write(d, "filled", index,
                   _E2E_WORDS + (_E2E_TITLE if index == 2 else ""))
        recipe = R.detect_single_card("notitle", d, fronts=[2, 3],
                                      log=lambda *a: None)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    assert "3" not in recipe["card"]["title"]
    said = recipe.get("declined") or []
    assert any("front 3" in m and "no title ink" in m for m in said), said


# ---- stray ink alongside a perfectly good title ------------------------------
#
# The cost of dropping the "title is above the words" assumption: stray ink now
# lands in the same bucket as the title. קליפורניה's front 5 has its two real
# title lines at the top and a patch of artwork the diff caught near the foot, so
# "everything that is not a word" unions to 244 units where the deck's title
# measures 42. Position cannot separate those — the DECK can, because the same
# title is on every front.


def test_a_front_that_also_caught_artwork_keeps_its_real_title():
    good = {n: _tbox(20.0 + 10 * n, 10.0) for n in (2, 3, 4, 6)}
    stray = _tbox(22.0, 11.0) + [{"x0": 5.0, "y0": 250.0, "x1": 95.0,
                                  "y1": 300.0, "color": "#111111"}]
    said = []
    got = R.reconcile_front_titles({**good, 5: stray}, log=said.append)
    assert 5 in got, "the front's real title must survive the stray band"
    assert got[5] == [stray[0]], got[5]
    assert any("front 5" in m and "set aside" in m for m in said), said


def test_the_kept_run_is_the_one_that_measures_like_the_deck():
    # Two candidate runs, only one of which is title-sized.
    good = {n: _tbox(20.0, 10.0) for n in (2, 3, 4)}
    real = {"x0": 30.0, "y0": 12.0, "x1": 110.0, "y1": 42.0, "color": "#111111"}
    junk = {"x0": 0.0, "y0": 200.0, "x1": 190.0, "y1": 290.0, "color": "#111111"}
    got = R.reconcile_front_titles({**good, 5: [junk, real]})
    assert got[5] == [real]


def test_a_front_with_no_title_shaped_ink_at_all_is_still_refused():
    # The backstop must not be softened: a front whose every band is the wrong
    # size has no title to keep, and inventing one is the bug this guards.
    good = {n: _tbox(20.0, 10.0) for n in (2, 3, 4)}
    junk = [{"x0": 0.0, "y0": 200.0, "x1": 190.0, "y1": 290.0, "color": "#111111"}]
    declined = []
    got = R.reconcile_front_titles({**good, 5: junk}, declined=declined)
    assert 5 not in got
    assert declined and "front 5" in declined[0]


def test_a_multi_line_title_is_kept_whole_when_it_already_matches():
    # Two lines that TOGETHER measure like the deck must not be split apart.
    two = [{"x0": 20.0, "y0": 10.0, "x1": 100.0, "y1": 22.0, "color": "#111111"},
           {"x0": 24.0, "y0": 26.0, "x1": 100.0, "y1": 40.0, "color": "#111111"}]
    titles = {2: two, 3: two, 4: two, 5: two}
    assert R.reconcile_front_titles(titles) == titles
