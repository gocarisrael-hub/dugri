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


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
