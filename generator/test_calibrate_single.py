#!/usr/bin/env python3
"""Tests for the v2 single-card half of generator/calibrate.py.

calibrate.py keeps owning the STYLE knobs — the title's paints, ring thickness,
alignment, shadow — and those are SHARED across the eight fronts, so the v2 work
is entirely about WHICH surface it reads them off. That routing is what is tested
here, on synthetic inputs; the measurement maths it feeds is already covered by
``test_calibrate.py`` and is untouched by the migration.

The one end-to-end test builds a throwaway template plus an owner store and drives
Chrome; it skips (never fails) where the binary is absent, the same way
``test_svg_rings`` and ``test_config`` do.

Run: python3 generator/test_calibrate_single.py   (or via pytest)
"""
import json
import os
import shutil
import tempfile

import calibrate as C
import calibration_health as H
import config
import recipe_diff as R


def _template(files):
    d = tempfile.mkdtemp(prefix="dugri-cal-")
    for rel in files:
        path = os.path.join(d, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("<svg/>")
    return d


# ---- which structure does this template calibrate as? -----------------------


def test_the_themes_entry_wins_over_whatever_the_folder_holds():
    # card_layout is the discriminator the schema locks and the renderer obeys,
    # so calibration must agree with it rather than second-guess from files.
    d = _template(["clean/fronts.svg"])
    try:
        assert C.is_single_card({"card_layout": "single"}, d)
        assert not C.is_single_card({}, d)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_an_undeclared_template_still_calibrates_off_the_art_it_ships():
    # The window between "uploaded" and "entry flipped": without this fallback
    # every surface would report "filled/clean pair missing, skipped" and the
    # owner would be handed an empty calibration for a measurable template.
    d = _template(["clean/1.svg", "clean/2.svg", "filled/1.svg", "filled/2.svg"])
    try:
        assert C.is_single_card({}, d)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_the_seven_unmigrated_themes_stay_on_the_sheet_path():
    checked = 0
    for key in config.load_themes():
        cfg = config.theme(key)
        if config.is_single_card(cfg):
            continue
        try:
            tdir = config.theme_dir(key)
        except (KeyError, RuntimeError):
            continue
        assert not C.is_single_card(cfg, tdir), key
        checked += 1
    assert checked, "no shipped theme was exercised"


# ---- which title box does it read the paints off? ---------------------------


def _v2_recipe(fronts):
    return R.assemble_single_recipe(
        "t", [0.0, 0.0, 223.92, 312.0],
        [{"x0": 10.0, "y0": 100.0 + 20 * i, "x1": 60.0, "y1": 115.0 + 20 * i,
          "color": "#711d20"} for i in range(4)],
        fronts)


def test_v2_reads_the_first_front_that_actually_carries_a_title():
    # The paints are SHARED, so one measured surface settles them for the deck —
    # but it has to be a surface with ink on it.
    cfg = {"fronts": [2, 3, 4]}
    box = [{"x0": 20.0, "y0": 10.0, "x1": 200.0, "y1": 40.0, "color": "#111111"}]
    recipe = _v2_recipe({2: [], 3: box})
    # the shape it is read out of: per-front titles live inside the card block
    assert recipe["format"] == 2 and recipe["card"]["title"]["3"] == box
    assert C._front_title_boxes(recipe, cfg, True) == box


def test_v2_moves_on_when_the_first_front_measured_nothing():
    # A partially-detected template still gets its paints read instead of landing
    # on the owner's desk as "no card carries a title slot" — but off a front that
    # was really measured, never off a fallback box no export has ink in.
    cfg = {"fronts": [2, 3]}
    recipe = _v2_recipe({3: [{"x0": 20.0, "y0": 10.0, "x1": 200.0, "y1": 40.0,
                              "color": "#111111"}]})
    assert "2" not in recipe["card"]["title"]
    got = C._front_title_boxes(recipe, cfg, True)
    assert got and got[0]["x1"] == 200.0


def test_v2_reports_nothing_when_no_front_carries_a_title():
    assert C._front_title_boxes(_v2_recipe({}), {"fronts": [2, 3]}, True) is None


def test_v1_still_takes_the_first_card_on_the_sheet_with_a_title():
    box = [{"x0": 5.0, "y0": 5.0, "x1": 50.0, "y1": 20.0, "color": "#111111"}]
    recipe = {"cards": [None, {"cell": [0, 0, 10, 10], "words": [], "title": []},
                        {"cell": [0, 0, 10, 10], "words": [], "title": box}]}
    assert C._front_title_boxes(recipe, {}, False) == box
    assert C._front_title_boxes({"cards": [None]}, {}, False) is None


# ---- the word colours excluded from the title's paint candidates ------------


def test_word_colours_are_read_out_of_either_recipe_structure():
    v2 = _v2_recipe({2: []})
    assert C._word_colours(v2) == {"#711d20"}
    v1 = {"cards": [None, {"words": [{"color": "#AABBCC"}, {"color": "#112233"}]}]}
    assert C._word_colours(v1) == {"#aabbcc", "#112233"}
    assert C._word_colours({"cards": [None]}) == set()


# ---- the crop mapping -------------------------------------------------------


def test_the_viewport_mapping_is_the_one_the_recipe_was_measured_with():
    # The recipe's boxes and calibration's crops must land on the same pixels;
    # they would not if one used a width-only scale and the other did not.
    class _Mask:
        size = (299 * C.SCALE, 416 * C.SCALE)

    assert C._viewport(_Mask(), [0.0, 0.0, 223.92, 312.0]) == R.viewport(
        [0.0, 0.0, 223.92, 312.0], 299, 416)


# ---- end to end, where a rasterizer exists ---------------------------------

_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="224" height="312" '
        'viewBox="0 0 223.92 312" preserveAspectRatio="xMidYMid meet">'
        '<rect width="223.92" height="312" fill="#fdf6ec"/>{ink}</svg>')
# A ringed title: an outer paint enclosing an inner one, which is what every
# shipped design's title actually is and what assign_paints has to tell apart.
_FILL, _OUTLINE = "#ffdd55", "#333333"
_TITLE = (f'<rect x="40" y="20" width="140" height="40" fill="{_OUTLINE}"/>'
          f'<rect x="46" y="26" width="128" height="28" fill="{_FILL}"/>')
_WORDS = "".join(f'<rect x="{60 + 10 * i}" y="{110 + 30 * i}" '
                 f'width="{100 - 5 * i}" height="16" fill="#711d20"/>'
                 for i in range(4))
_BACK_TITLE = f'<rect x="50" y="120" width="120" height="40" fill="{_OUTLINE}"/>'


def _chrome():
    return C.CHROME if os.path.exists(C.CHROME) else None


class _owner_store:
    """Register a synthetic single-card template as an owner-store theme.

    DATA_DIR is read on EVERY config call rather than captured at import, so a
    test can point the store at a temp dir without re-importing anything.
    """

    def __init__(self, key="e2e-single"):
        self.key = key

    def __enter__(self):
        self.root = tempfile.mkdtemp(prefix="dugri-store-")
        store = os.path.join(self.root, "templates")
        tdir = os.path.join(store, self.key)
        os.makedirs(os.path.join(store, "recipes"))
        for half in ("clean", "filled"):
            os.makedirs(os.path.join(tdir, half))
        for index in (2, 3):
            _write(tdir, "clean", index, "")
            _write(tdir, "filled", index, _TITLE + _WORDS)
        _write(tdir, "clean", 1, "")
        _write(tdir, "filled", 1, _BACK_TITLE)
        with open(os.path.join(store, "themes.json"), "w", encoding="utf-8") as f:
            json.dump({self.key: {
                "slug": self.key, "dir": f"resources/canva/templates/{self.key}",
                "recipe": self.key, "wordlist": "friends-350.txt",
                "display_he": "בדיקה", "visibility": "private",
                "title_lines": ["{NAME}"], "language": "he",
                "title_font": "x.ttf", "word_font": "y.ttf",
                "card_layout": "single", "fronts": [2, 3], "back_index": 1,
                "calibrated": False}}, f)
        self.prev = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.root
        self.recipe_path = os.path.join(store, "recipes", f"{self.key}.json")
        return self

    def __exit__(self, *exc):
        if self.prev is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.prev
        shutil.rmtree(self.root, ignore_errors=True)
        return False


def _write(tdir, half, index, ink):
    with open(os.path.join(tdir, half, f"{index}.svg"), "w", encoding="utf-8") as f:
        f.write(_SVG.format(ink=ink))


def test_end_to_end_calibrates_a_single_card_template():
    chrome = _chrome()
    if not chrome:
        print("  (skip end-to-end: Chrome not found)")
        return
    with _owner_store() as store:
        recipe = R.detect_single_card(store.key, config.theme_dir(store.key),
                                      fronts=[2, 3], log=lambda *a: None)
        with open(store.recipe_path, "w", encoding="utf-8") as f:
            json.dump(recipe, f, ensure_ascii=False)
        blob = C.calibrate(store.key)

    ts = blob["title_style"]
    assert ts.get("fill") == _FILL, f"fill misread: {ts}"
    assert ts.get("outline") == _OUTLINE, f"outline misread: {ts}"
    # A calibration must emit EVERY key the renderer indexes and the server
    # validates. title_style is accepted or rejected as a whole, so one absent
    # field throws away the colours measured beside it and the template keeps
    # reporting itself as never calibrated even though detection succeeded —
    # which is exactly what "arch is a visual call" cost daniel-amit. Sourced
    # from calibration_health so the producer and the contract cannot drift.
    missing = [k for k in H._TITLE_STYLE_REQUIRED if k not in ts]
    assert not missing, f"calibrate omitted {missing} — blob is unusable: {ts}"
    # the back's title box, as a fraction of the card cell (which IS the page)
    frac = blob["back"]["frac"]
    assert abs(frac["y0"] - 120 / 312) < 0.02, frac
    assert abs(frac["x0"] - 50 / 223.92) < 0.02, frac
    # the board is a separate named file in v2 too, and this template ships none
    assert blob["board"] is None
    assert any("board" in n for n in blob["notes"])
    # deliberately never guessed, on either structure
    assert blob["word_size"] is None


def test_redetecting_does_not_straighten_a_curved_title():
    # Nothing in this pass MEASURES the arch, so writing a flat 0.0 over a
    # template the owner had curved is not a reading, it is an erasure. It
    # happened: pressing "detect again" straightened סיישל's graffiti title,
    # whose design plainly arcs, and nothing anywhere said so. The shadow beside
    # it already inherits; the arch must too.
    chrome = _chrome()
    if not chrome:
        print("  (skip curved-title re-detect: Chrome not found)")
        return
    with _owner_store() as store:
        recipe = R.detect_single_card(store.key, config.theme_dir(store.key),
                                      fronts=[2, 3], log=lambda *a: None)
        with open(store.recipe_path, "w", encoding="utf-8") as f:
            json.dump(recipe, f, ensure_ascii=False)
        themes_path = os.path.join(store.root, "templates", "themes.json")
        themes = json.load(open(themes_path, encoding="utf-8"))
        themes[store.key]["title_style"] = {
            "fill": _FILL, "outline": _OUTLINE, "outline_w": 0.05,
            "arch": 0.11, "shadow": False}
        themes[store.key]["calibrated"] = True
        with open(themes_path, "w", encoding="utf-8") as f:
            json.dump(themes, f, ensure_ascii=False)
        config._THEMES_CACHE = None
        blob = C.calibrate(store.key)
    assert blob["title_style"]["arch"] == 0.11, (
        "a re-detect flattened a curved title: " + repr(blob["title_style"]))


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")


# ---- the card_slots map must cover every front, or nothing is saved at all ----
#
# server/templates.js `validateCardSlots` refuses a titles map missing any of
# cards.fronts, and `applyCalibration` then drops the WHOLE card_slots block
# silently while still reporting calibrated: true. So a deck with one
# unmeasurable card used to write nothing at all — on מרקאנה the owner pressed
# "זהה מחדש", was told it succeeded, and the geometry never moved.

_CARD_VB = [0.0, 0.0, 200.0, 400.0]


def _recipe_with(title):
    return {"theme": "t", "format": 2, "viewBox": list(_CARD_VB),
            "card": {"cell": [0.0, 0.0, 200.0, 400.0],
                     "words": [{"x0": 20.0, "y0": 100.0 + 30 * i,
                                "x1": 160.0, "y1": 120.0 + 30 * i}
                               for i in range(4)],
                     "title": title},
            "back": None}


def _slots_for(recipe, fronts):
    cfg = {"recipe": "t", "cards": {"fronts": list(fronts)}}
    real = config.load_recipe
    config.load_recipe = lambda _name: recipe
    try:
        return C._card_slots_from_recipe(cfg)
    finally:
        config.load_recipe = real


def _title(x0, y0, x1, y1):
    return [{"x0": x0, "y0": y0, "x1": x1, "y1": y1, "color": "#000000"}]


def test_card_slots_covers_every_front_the_theme_declares():
    recipe = _recipe_with({"2": _title(20.0, 10.0, 100.0, 50.0),
                           "3": _title(30.0, 12.0, 110.0, 52.0),
                           "4": _title(40.0, 14.0, 120.0, 54.0)})
    got = _slots_for(recipe, [2, 3, 4, 5])
    assert got, "a usable recipe must produce card_slots"
    assert sorted(got["titles"], key=int) == ["2", "3", "4", "5"], got["titles"]


def test_an_unmeasured_front_is_filled_with_what_the_renderer_would_use():
    # Not an invention: config.recipe_front_title is the SAME median the renderer
    # falls back to for that front, so the stored value equals what prints.
    recipe = _recipe_with({"2": _title(20.0, 10.0, 100.0, 50.0),
                           "3": _title(30.0, 12.0, 110.0, 52.0),
                           "4": _title(40.0, 14.0, 120.0, 54.0)})
    got = _slots_for(recipe, [2, 3, 4, 9])
    want = config.recipe_front_title(recipe, 9)
    assert want, "the fallback is what this test is about"
    assert got["titles"]["9"] == {
        "x0": round(want[0]["x0"] / 200.0, 4), "y0": round(want[0]["y0"] / 400.0, 4),
        "x1": round(want[0]["x1"] / 200.0, 4), "y1": round(want[0]["y1"] / 400.0, 4)}


def test_a_measured_front_is_never_replaced_by_the_fallback():
    recipe = _recipe_with({"2": _title(20.0, 10.0, 100.0, 50.0),
                           "3": _title(30.0, 12.0, 110.0, 52.0),
                           "4": _title(40.0, 14.0, 120.0, 54.0)})
    got = _slots_for(recipe, [2, 3, 4])
    assert got["titles"]["2"] == {"x0": 0.1, "y0": 0.025, "x1": 0.5, "y1": 0.125}


def test_a_recipe_with_no_title_anywhere_still_reports_nothing():
    assert _slots_for(_recipe_with({}), [2, 3]) is None
