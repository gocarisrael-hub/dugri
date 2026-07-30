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
