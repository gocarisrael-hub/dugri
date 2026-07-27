#!/usr/bin/env python3
"""Tests for generator/preview.py --calibration (render an UNCALIBRATED template
from owner-supplied, not-yet-persisted knobs).

Run: python3 generator/test_preview.py   (or via pytest)

These tests never invoke real Chrome: they stub ``subprocess.run`` to write a
dummy PNG at the ``--screenshot`` path, so the REAL preview pipeline (build_page
front title + render_board + render_backs) runs and writes its SVGs, which we
then inspect. That proves the calibration blob's title_style/board/back actually
reach every render path — WITHOUT writing themes.json.
"""
import copy
import json
import os
import subprocess
import tempfile

from PIL import Image

import config
import preview as pv

HERE = os.path.dirname(os.path.abspath(__file__))

# An uncalibrated theme, cloned from a calibrated one that ships board + back +
# fronts art, so the clean SVGs, recipe and fonts all exist on disk. Only the
# calibration is stripped (title_style/board/back = null, calibrated:false) —
# exactly the shape a freshly-uploaded template has before a calibration pass.
UNCAL_KEY = "test-uncal-preview"

# Distinct colours so each surface's fill is unambiguously greppable in its SVG.
BLOB = {
    "title_style": {
        "fill": "#123456", "outline": "#654321", "outline_w": 0.05, "arch": 0.11,
        "shadow": True, "size": 23.9, "board_size": 20, "back_size": 18,
        "align": "center", "offset": [0, 0], "italic": False,
    },
    "board": {"frac": {"x0": 0.01, "y0": 0.9, "x1": 0.11, "y1": 0.98},
              "fill": "#aa11bb", "outline": "#bb22cc"},
    "back": {"frac": {"x0": 0.2, "y0": 0.4, "x1": 0.75, "y1": 0.55},
             "fill": "#22ccdd", "outline": "#33ddee"},
    "word_size": 12,
}


def _uncal_themes():
    """Real themes.json + an injected uncalibrated clone of 'birthday-girls'."""
    # Read the file directly (NOT config.load_themes — it's patched to call us).
    with open(config.THEMES_JSON, encoding="utf-8") as f:
        themes = json.load(f)
    base = copy.deepcopy(themes["birthday-girls"])
    base["slug"] = UNCAL_KEY
    base["calibrated"] = False
    base["title_style"] = None
    base["board"] = None
    base["back"] = None
    base.pop("word_size", None)
    themes[UNCAL_KEY] = base
    return themes


def _fake_chrome_run(cmd, *a, **k):
    """Stand in for headless Chrome: write a small white PNG at --screenshot."""
    scr = ws = None
    for c in cmd:
        if isinstance(c, str) and c.startswith("--screenshot="):
            scr = c.split("=", 1)[1]
        elif isinstance(c, str) and c.startswith("--window-size="):
            ws = c.split("=", 1)[1]
    if scr:
        if ws:
            w, h = (int(x) for x in ws.split(","))
        else:
            w, h = 8, 8
        # Cap so a large print-size window can't allocate a huge test bitmap; the
        # crop math is proportional (img.width / viewBox width), so any size works.
        Image.new("RGB", (min(max(1, w), 1000), min(max(1, h), 1000)), "white").save(scr)

    class _R:
        returncode = 0

    return _R()


def _patched(fn):
    """Run fn() with load_themes injecting the uncalibrated theme and Chrome stubbed."""
    real_load, real_run = config.load_themes, subprocess.run
    config.load_themes = _uncal_themes
    subprocess.run = _fake_chrome_run
    try:
        return fn()
    finally:
        config.load_themes = real_load
        subprocess.run = real_run
        config.set_theme_override(UNCAL_KEY, None)  # belt-and-braces cleanup


def test_uncalibrated_theme_renders_with_calibration_blob():
    themes_bytes_before = open(config.THEMES_JSON, "rb").read()

    def run():
        workdir = tempfile.mkdtemp(prefix="dugri-preview-test-")
        out = pv.preview(UNCAL_KEY, "Alma", {}, workdir=workdir, calibration=BLOB)
        # All three surfaces are produced (the theme ships board + back art).
        assert "card" in out and os.path.exists(out["card"]), out
        assert "board" in out and os.path.exists(out["board"]), out
        assert "back" in out and os.path.exists(out["back"]), out

        def read(name):
            return open(os.path.join(workdir, name), encoding="utf-8").read().lower()

        # The blob's title_style/board/back fills reach EACH real render path.
        assert "#123456" in read("front_full.svg"), "front title fill from blob not applied"
        assert "#aa11bb" in read("board.svg"), "board fill from blob not applied"
        assert "#22ccdd" in read("back_full.svg"), "back fill from blob not applied"
        return workdir

    workdir = _patched(run)

    # The merge was in-memory only: themes.json on disk is byte-for-byte unchanged.
    assert open(config.THEMES_JSON, "rb").read() == themes_bytes_before, (
        "preview must NOT write themes.json"
    )
    # And the in-memory override is cleared after the render (no leak).
    assert UNCAL_KEY not in config._OVERRIDES, "calibration override leaked past the render"
    import shutil
    shutil.rmtree(workdir, ignore_errors=True)


def test_uncalibrated_theme_without_calibration_still_errors():
    def run():
        try:
            pv.preview(UNCAL_KEY, "Alma", {})
        except RuntimeError as e:
            assert "not calibrated" in str(e), f"wrong error: {e}"
            return
        raise AssertionError("expected preview to refuse an uncalibrated theme")

    _patched(run)


def test_merge_calibration_does_not_mutate_source_and_maps_schema():
    src = {"dir": "x", "recipe": "r", "calibrated": False,
           "title_style": None, "board": None, "back": None}
    merged = pv._merge_calibration(src, BLOB)
    assert merged["title_style"] == BLOB["title_style"]
    assert merged["board"] == BLOB["board"]
    assert merged["back"] == BLOB["back"]
    assert merged["word_size"] == 12
    assert merged["calibrated"] is True
    # source dict untouched (we merge into a copy)
    assert src["title_style"] is None and src["calibrated"] is False
    assert "word_size" not in src


def test_merge_calibration_allows_null_board_back_wordsize():
    src = {"calibrated": False, "title_style": None, "board": None, "back": None}
    blob = {"title_style": {"fill": "#000", "outline": "#000",
                            "outline_w": 0, "arch": 0, "shadow": False}}
    merged = pv._merge_calibration(src, blob)
    assert merged["board"] is None and merged["back"] is None
    assert "word_size" not in merged  # absent word_size leaves the theme default
    assert merged["calibrated"] is True


def test_load_calibration_reads_valid_and_rejects_bad_json():
    d = tempfile.mkdtemp(prefix="dugri-calib-test-")
    good = os.path.join(d, "good.json")
    open(good, "w", encoding="utf-8").write(json.dumps(BLOB))
    assert pv._load_calibration(good)["word_size"] == 12
    assert pv._load_calibration(None) is None

    bad = os.path.join(d, "bad.json")
    open(bad, "w", encoding="utf-8").write("{ not json ]")
    try:
        pv._load_calibration(bad)
    except SystemExit as e:
        assert "bad --calibration" in str(e)
    else:
        raise AssertionError("bad JSON must sys.exit, not return")

    no_ts = os.path.join(d, "no_ts.json")
    open(no_ts, "w", encoding="utf-8").write(json.dumps({"board": None}))
    try:
        pv._load_calibration(no_ts)
    except SystemExit as e:
        assert "title_style" in str(e)
    else:
        raise AssertionError("a blob without title_style must sys.exit")


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
