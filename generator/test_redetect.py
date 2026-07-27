#!/usr/bin/env python3
"""Tests for generator/redetect.py — the re-detection DRIFT REPORT.

These exercise the comparison layer on synthetic recipes and calibration blobs,
so they need neither Chrome nor any template art and run instantly. What they
cannot cover is the re-measurement itself (that needs a real filled/clean pair
rendered by Chrome); that side is validated by running the module against the
shipped themes, where every value must come back ``same`` because the stored
recipe was detected from the very art being re-measured.

Note CI does NOT run Python tests today (there is no pytest step in
.github/workflows/ci.yml) — these are the generator's own regression net, run by
hand or by whatever adds that step later.

Run: python3 generator/test_redetect.py   (or via pytest)
"""
import redetect as R


def _slot(x0, y0, x1, y1, color="#222220"):
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "color": color}


def _recipe(cards=None, cell=(0, 0, 100, 200), page=200.0):
    """A one-card recipe on a ``page``-wide sheet: 4 word slots and a title."""
    if cards is None:
        cards = [{
            "cell": list(cell),
            "words": [_slot(10, 50 + 20 * i, 90, 65 + 20 * i) for i in range(4)],
            "title": [_slot(10, 10, 90, 40, "#d42a2a")],
        }]
    return {"theme": "t", "viewBox": [0, 0, page, page], "cards": cards}


def _status(rows, path):
    for row in rows:
        if row["path"] == path:
            return row["status"]
    raise AssertionError(f"no row for {path!r}; have {[r['path'] for r in rows]}")


def _row(rows, path):
    for row in rows:
        if row["path"] == path:
            return row
    raise AssertionError(f"no row for {path!r}")


# --- the baseline: identical inputs must be reported as identical -----------


def test_identical_recipes_report_no_drift():
    # The regression this guards: a comparison that reports phantom movement
    # would make every re-detection look like the art changed, and the report
    # would be ignored within a week.
    rows = R.compare_recipe(_recipe(), _recipe())
    assert all(r["status"] == R.SAME for r in rows), (
        [r for r in rows if r["status"] != R.SAME])
    assert R.verdict(rows) == "in-sync"


def test_sub_tolerance_movement_is_not_a_change():
    # Both passes re-rasterize through headless Chrome, so a box edge can land a
    # pixel either way between two runs of the SAME art. That is jitter, not drift.
    moved = _recipe()
    moved["cards"][0]["words"][0]["y0"] += 0.2  # 0.1% of the 200-unit cell
    rows = R.compare_recipe(_recipe(), moved)
    assert _status(rows, "recipe.card1.word1.y0") == R.SAME


def test_real_movement_is_reported_with_its_distance():
    moved = _recipe()
    moved["cards"][0]["words"][0]["y0"] += 6.0  # 3% of the 200-unit cell height
    rows = R.compare_recipe(_recipe(), moved)
    row = _row(rows, "recipe.card1.word1.y0")
    assert row["status"] == R.CHANGED
    assert row["delta_pct"] == 3.0, f"expected 3% of the cell, got {row}"
    assert row["stored"] == 50 and row["detected"] == 56.0, (
        "the report must carry BOTH values, not just the new one")


def test_word_slot_drift_is_measured_against_the_card_not_the_page():
    # 6 units is 3% of a 200-tall card cell but only 0.75% of an 800-tall page.
    # The card is what a human is looking at when they judge a printed slot, so
    # the page-relative number would under-report the problem into silence.
    stored = _recipe(page=800.0)
    moved = _recipe(page=800.0)
    moved["cards"][0]["words"][0]["y0"] += 6.0
    row = _row(R.compare_recipe(stored, moved), "recipe.card1.word1.y0")
    assert row["delta_pct"] == 3.0
    assert row["status"] == R.CHANGED


def test_colour_change_is_reported_as_colour_not_geometry():
    recoloured = _recipe()
    recoloured["cards"][0]["words"][0]["color"] = "#ff0000"
    rows = R.compare_recipe(_recipe(), recoloured)
    row = _row(rows, "recipe.card1.word1.color")
    assert row["status"] == R.CHANGED and row["kind"] == R.COLOR
    summary = R.summarize(rows)
    assert summary[R.COLOR][R.CHANGED] == 1
    assert summary[R.GEOMETRY][R.CHANGED] == 0, (
        "geometry must be graded separately — a recoloured word has not moved")


# --- honesty about failure --------------------------------------------------


def test_a_card_detection_could_not_read_is_unmeasured_not_removed():
    # The distinction the whole module rests on: failing to SEE a card and a card
    # having been deleted look nothing alike, and only one is a reason to act.
    rows = R.compare_recipe(_recipe(), _recipe(cards=[None]))
    row = _row(rows, "recipe.card1")
    assert row["status"] == R.UNMEASURED
    assert row["stored"] == "slots" and row["detected"] is None
    assert "stand" in row["note"], "the report must say the stored value stands"
    assert R.verdict(rows) != "drifted", "an unreadable card is not drift"


def test_a_detection_that_read_no_card_at_all_is_not_reported_as_drift():
    # Observed on the shipped 'football-boys': the fronts sheet split into 2 cells
    # and neither yielded slots. Diffing that all-empty result against the stored
    # 8 cards reads like the artwork was gutted (and as a card-count change, like
    # drift) when in truth nothing was measured — so it is turned into an error.
    reason = R.empty_recipe_reason(2, [None, None])
    assert reason and "no card yielded word slots" in reason
    assert R.empty_recipe_reason(8, [None, {"cell": []}, None]) is None, (
        "one readable card is a partial reading, not a failed one")


def test_unmeasured_values_never_become_a_number():
    row = R._num_row("x", 0.5, None)
    assert row["status"] == R.UNMEASURED
    assert row["detected"] is None and "delta" not in row, (
        "a value that could not be measured has no distance from anything")


def test_nothing_stored_yet_is_new_not_changed():
    row = R._color_row("title_style.fill", None, "#d3292a")
    assert row["status"] == R.NEW
    row = R._num_row("board.frac.x0", None, 0.4)
    assert row["status"] == R.NEW


def test_verdict_reports_unmeasured_when_nothing_could_be_read():
    rows = [R._num_row("a", 1.0, None), R._color_row("b", "#000000", None)]
    assert R.verdict(rows) == "unmeasured", (
        "a run that measured nothing must not read as 'in-sync'")


# --- calibration side -------------------------------------------------------


_CFG = {
    "title_style": {"fill": "#d3292a", "outline": "#000000", "outline_w": 0.02,
                    "align": "left", "shadow": False, "size": 23.9,
                    "offset": [0.06, 0.06]},
    "board": {"frac": {"x0": 0.012, "y0": 0.885, "x1": 0.136, "y1": 0.972},
              "fill": "#d3292a", "outline": "#000000"},
    "back": None,
}


def _blob(**over):
    blob = {"title_style": dict(_CFG["title_style"]),
            "board": {"frac": dict(_CFG["board"]["frac"]),
                      "fill": "#d3292a", "outline": "#000000"},
            "back": None}
    blob.update(over)
    return blob


def test_calibration_in_sync_reports_no_drift():
    rows = R.compare_calibration(_CFG, _blob())
    changed = [r for r in rows if r["status"] == R.CHANGED]
    assert not changed, changed


def test_board_slot_movement_is_reported_as_a_page_fraction():
    blob = _blob()
    blob["board"]["frac"]["y0"] = 0.9137  # the board title moved 2.87% down the page
    row = _row(R.compare_calibration(_CFG, blob), "board.frac.y0")
    assert row["status"] == R.CHANGED
    assert row["delta_pct"] == 2.87, row


def test_a_board_title_that_could_not_be_isolated_keeps_the_stored_slot():
    rows = R.compare_calibration(_CFG, _blob(board=None))
    row = _row(rows, "board")
    assert row["status"] == R.UNMEASURED
    assert "stands" in row["note"]
    assert not any(r["path"].startswith("board.frac") for r in rows), (
        "an unmeasured surface must not emit per-coordinate rows at all")


def test_a_surface_absent_from_both_sides_is_unmeasured_not_in_sync():
    # 'japanese' ships back:null and calibrate finds no back title — that is two
    # absences agreeing, which is not evidence that anything was verified.
    row = _row(R.compare_calibration(_CFG, _blob()), "back")
    assert row["status"] == R.UNMEASURED


def test_align_and_shadow_compare_categorically():
    blob = _blob()
    blob["title_style"]["align"] = "center"
    rows = R.compare_calibration(_CFG, blob)
    row = _row(rows, "title_style.align")
    assert row["status"] == R.CHANGED and row["kind"] == R.FLAG
    assert "delta" not in row, "there is no distance between 'left' and 'center'"


def test_knobs_calibration_never_measures_are_listed_not_compared():
    # size/arch/offset/word_size are visual calls. They must not appear as
    # 'same' rows — that would claim they were checked when nothing looked at them.
    rows = R.compare_calibration(_CFG, _blob())
    paths = {r["path"] for r in rows}
    for unchecked in R.NOT_CHECKED:
        assert unchecked not in paths, f"{unchecked} must not be compared"
    assert "title_style.size" in R.NOT_CHECKED
    assert "word_size" in R.NOT_CHECKED
    assert R._stored_at(_CFG, "title_style.size") == 23.9
    assert R._stored_at(_CFG, "title_style.arch") is None


# --- grading + presentation -------------------------------------------------


def test_summary_points_at_the_worst_offender():
    stored, moved = _recipe(), _recipe()
    moved["cards"][0]["words"][0]["y0"] += 2.0   # 1%
    moved["cards"][0]["words"][1]["y0"] += 10.0  # 5% — the one to look at
    summary = R.summarize(R.compare_recipe(stored, moved))
    assert summary[R.GEOMETRY][R.CHANGED] == 2
    assert summary[R.GEOMETRY]["worst"]["path"] == "recipe.card1.word2.y0"
    assert summary[R.GEOMETRY]["worst"]["delta_pct"] == 5.0


def test_report_text_names_the_moved_value_and_says_nothing_was_written():
    moved = _recipe()
    moved["cards"][0]["title"][0]["y1"] += 8.0
    report = {
        "theme": "japanese", "verdict": "drifted",
        "recipe": {"error": None, "note": None,
                   "rows": R.compare_recipe(_recipe(), moved),
                   "summary": R.summarize(R.compare_recipe(_recipe(), moved))},
        "calibration": {"error": None, "note": None, "rows": [], "summary": {},
                        "notes": ["board: colours need confirming"]},
    }
    text = R.report_text(report)
    assert "recipe.card1.title1.y1" in text
    assert "4.0%" in text, text
    assert "nothing was written" in text
    assert "board: colours need confirming" in text


def test_report_text_surfaces_a_pass_that_could_not_run_at_all():
    text = R.report_text({
        "theme": "x", "verdict": "unmeasured",
        "recipe": {"error": "headless render failed", "rows": [], "summary": {}},
        "calibration": {"error": None, "note": None, "rows": [], "summary": {},
                        "notes": []},
    })
    assert "could not measure" in text and "headless render failed" in text


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
