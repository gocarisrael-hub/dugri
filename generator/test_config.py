#!/usr/bin/env python3
"""Tests for generator/config.py title-line substitution.

Run: python3 generator/test_config.py   (or via pytest)
"""
import os

import config


def test_trip_english_caps():
    cfg = config.theme("trip comeback")
    assert config.title_lines(cfg, "oz", {}) == ["OZ'S", "WELCOME", "PARTY"]
    # already-uppercase name stays the same
    assert config.title_lines(cfg, "OZ", {}) == ["OZ'S", "WELCOME", "PARTY"]


def test_japanese_english_caps_with_age():
    cfg = config.theme("japanese")
    assert config.title_lines(cfg, "tomer", {"AGE": "30"}) == ["TOMER'S", "30S"]


def test_anniversary_hebrew_years_and_two_names():
    cfg = config.theme("anniversary")
    lines = config.title_lines(
        cfg, "", {"YEARS": "30", "NAME1": "מיכל", "NAME2": "זאבי"}
    )
    assert lines == ["30 שנה נישואין", "מיכל וזאבי"]


def test_uncalibrated_raises():
    # all real themes are now calibrated, so use a synthetic uncalibrated config
    cfg = {"slug": "x", "calibrated": False}
    raised = False
    try:
        config.ensure_calibrated(cfg)
    except RuntimeError:
        raised = True
    assert raised, "expected ensure_calibrated to raise for a non-calibrated theme"


def test_trip_is_calibrated():
    config.ensure_calibrated(config.theme("trip comeback"))  # must not raise


def test_word_font_options_are_five_with_files():
    opts = config.word_font_options()
    assert len(opts) == 5, f"expected 5 shared word fonts, got {len(opts)}"
    for o in opts:
        assert o.get("label") and o.get("file")


def test_resolve_word_font_default_is_theme_own():
    # no override -> the theme's configured word_font, inside the theme fonts dir
    p = config.resolve_word_font("trip comeback")
    assert p.endswith("almoni-neue-aaa-bold-OFFICE.ttf")
    assert "trip comeback/fonts" in p


def test_resolve_word_font_shared_pool_fallback():
    # a filename NOT in the theme's own fonts/ resolves to the shared pool
    p = config.resolve_word_font("trip comeback", "Fredoka-Medium.ttf")
    assert p == os.path.join(config.WORD_FONTS_DIR, "Fredoka-Medium.ttf")
    assert os.path.exists(p)


def test_resolve_word_font_prefers_theme_own_dir():
    # bachelorette ships its own "Cafe Regular.ttf"; that copy wins over the pool
    p = config.resolve_word_font("bachelorette", "Cafe Regular.ttf")
    assert "bachelorette/fonts" in p
    assert config.WORD_FONTS_DIR not in p


def test_resolve_word_font_missing_override_falls_back_to_theme_default():
    # an override filename that exists in NEITHER the theme fonts/ nor the shared
    # pool must NOT return a non-existent path (opaque FileNotFoundError mid-render)
    # — it falls back to the theme's own default word_font, which is trusted.
    p = config.resolve_word_font("trip comeback", "does-not-exist-anywhere.ttf")
    default = config.font_path("trip comeback", config.theme("trip comeback")["word_font"])
    assert p == default
    assert os.path.exists(p)


def test_title_lines_blanks_unfilled_placeholders():
    # a required extra field missing from the dict must never print raw braces
    # like "{AGE}" — the token is blanked out after substitution (defense-in-depth).
    cfg = {"name_form": "english", "title_lines": ["{NAME}'S {AGE} PARTY"]}
    out = config.title_lines(cfg, "oz", {})
    assert out == ["oz'S  PARTY"]
    assert "{" not in out[0] and "}" not in out[0]


def test_build_page_survives_card_with_no_word_slots():
    # A non-null recipe card with an empty "words" list (e.g. a title-only card)
    # used to crash build_page via statistics.median([]) -> StatisticsError. The
    # page must still render (the empty-slot card is skipped).
    import json
    import tempfile

    import render_page

    font = os.path.join(config.HERE, "Cafe-Regular.ttf")  # a real font in generator/
    tmp = tempfile.mkdtemp(prefix="dugri-test-build-")
    clean = os.path.join(tmp, "clean.svg")
    with open(clean, "w", encoding="utf-8") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>')

    cfg = {
        "slug": "synthetic",
        "calibrated": True,
        "recipe": "synthetic-empty-words-test",
        "title_font": "Cafe-Regular.ttf",
        "word_font": "Cafe-Regular.ttf",
        "title_style": {
            "fill": "#fff", "outline": "#000", "outline_w": 0.05,
            "arch": 0.1, "shadow": True,
        },
    }
    recipe = {
        "viewBox": [0, 0, 100, 100],
        "cards": [
            {"words": []},  # non-null but NO word slots -> would crash median([])
            {"words": [{"x0": 0, "y0": 30, "x1": 100, "y1": 50, "color": "#000"}]},
        ],
    }
    recipe_path = os.path.join(render_page.HERE, "recipes", cfg["recipe"] + ".json")
    saved = {
        "theme": config.theme,
        "ensure": config.ensure_calibrated,
        "rwf": config.resolve_word_font,
        "fp": config.font_path,
    }
    try:
        config.theme = lambda name: cfg
        config.ensure_calibrated = lambda c: None
        config.resolve_word_font = lambda name, fn=None: font
        config.font_path = lambda name, fn: font
        with open(recipe_path, "w", encoding="utf-8") as f:
            json.dump(recipe, f)
        out = render_page.build_page("synthetic", clean, [["a"], ["b"]], [], word_font=None)
        assert "<svg" in out
    finally:
        config.theme = saved["theme"]
        config.ensure_calibrated = saved["ensure"]
        config.resolve_word_font = saved["rwf"]
        config.font_path = saved["fp"]
        if os.path.exists(recipe_path):
            os.remove(recipe_path)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
