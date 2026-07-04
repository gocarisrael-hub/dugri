#!/usr/bin/env python3
"""Tests for generator/config.py title-line substitution.

Run: python3 generator/test_config.py   (or via pytest)
"""
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
    cfg = config.theme("japanese")
    raised = False
    try:
        config.ensure_calibrated(cfg)
    except RuntimeError:
        raised = True
    assert raised, "expected ensure_calibrated to raise for a non-calibrated theme"


def test_trip_is_calibrated():
    config.ensure_calibrated(config.theme("trip comeback"))  # must not raise


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
