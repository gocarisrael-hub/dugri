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


def test_anniversary_title_uses_standard_script_font():
    # Regression (bug 8.2): the marriage/anniversary title used to render in a
    # heavy display font (Shmulik CLM) with a graffiti outline + drop shadow, so
    # it looked like a completely different font than the card words. The real
    # Canva design draws the title in the SAME flowing script as the words, just
    # larger. Guard that the title font matches the word font and no heavy
    # outline/shadow is applied.
    cfg = config.theme("anniversary")
    assert cfg["title_font"] == cfg["word_font"], (
        "anniversary title must use the same script font as the words"
    )
    assert cfg["title_style"]["outline_w"] == 0, "no heavy outline ring on the title"
    assert cfg["title_style"]["shadow"] is False, "no drop shadow on the title"


def test_title_is_rtl_by_language():
    # RTL handling is keyed off the theme's language: Hebrew titles are RTL,
    # English ones are not. (bug: anniversary "{YEARS} שנה נישואין" had the number
    # on the wrong/left side because the title text had no base direction.)
    import render_page

    assert render_page.title_is_rtl(config.theme("anniversary")) is True
    assert render_page.title_is_rtl(config.theme("birthday-boys-basketball")) is True
    assert render_page.title_is_rtl(config.theme("trip comeback")) is False
    assert render_page.title_is_rtl(config.theme("bachelorette")) is False


def test_title_block_applies_rtl_for_hebrew_digit_title():
    # Regression: a Hebrew title that mixes a number with Hebrew words (e.g.
    # "30 שנה נישואין") must be drawn with a right-to-left BASE direction so the
    # number reads on the RIGHT (Hebrew start), not the left. Assert the emitted
    # SVG <text> carries direction="rtl" for a Hebrew title and NOT for English.
    import render_page

    font = os.path.join(config.HERE, "Cafe-Regular.ttf")  # a real font in generator/
    box = {"x0": 0, "y0": 0, "x1": 400, "y1": 200}

    he = render_page.title_block(
        box, ["30 שנה נישואין"], "#004aad", "#004aad", font, 0, 0, False, rtl=True
    )
    assert 'direction="rtl"' in he, "Hebrew digit title must render right-to-left"
    # the digits are kept as one unit ("30"), not reversed/split into the markup
    assert "30 שנה נישואין" in he

    en = render_page.title_block(
        box, ["OZ'S"], "#000", "#000", font, 0, 0, False, rtl=False
    )
    assert 'direction="rtl"' not in en, "English titles must stay left-to-right"


def test_board_and_backs_render_paths_wire_rtl():
    # Regression: the RTL base-direction fix must reach the BOARD and card-BACK
    # title paths too, not only the front card. A Hebrew digit title (anniversary
    # "30 שנה נישואין") would otherwise keep the number on the wrong side on the
    # board + backs. Spy on title_block to assert render_board/render_backs pass
    # rtl=True for a Hebrew theme and rtl=False for an English one.
    import json
    import tempfile

    import render_page as rp
    import build

    font = os.path.join(config.HERE, "Cafe-Regular.ttf")  # a real font in generator/
    tmp = tempfile.mkdtemp(prefix="dugri-test-rtl-")

    def make_svg(p):
        with open(p, "w", encoding="utf-8") as f:
            f.write('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" '
                    'viewBox="0 0 100 100"></svg>')

    board_svg = os.path.join(tmp, "board.svg")
    backs_svg = os.path.join(tmp, "backs.svg")
    make_svg(board_svg)
    make_svg(backs_svg)

    def make_cfg(language):
        return {
            "slug": "synthetic", "calibrated": True, "language": language,
            "recipe": "synthetic-rtl-test",
            "title_font": "Cafe-Regular.ttf", "word_font": "Cafe-Regular.ttf",
            "title_style": {"fill": "#fff", "outline": "#000", "outline_w": 0.0,
                            "arch": 0.1, "shadow": False},
            "board": {"fill": "#fff", "outline": "#000",
                      "frac": {"x0": 0.1, "y0": 0.1, "x1": 0.9, "y1": 0.3}},
            "back": {"fill": "#fff", "outline": "#000",
                     "frac": {"x0": 0.1, "y0": 0.1, "x1": 0.9, "y1": 0.9}},
        }

    recipe = {"viewBox": [0, 0, 100, 100], "cards": [{"cell": [0, 0, 50, 50]}]}
    recipe_path = os.path.join(rp.HERE, "recipes", "synthetic-rtl-test.json")

    calls = []  # each captured rtl kwarg from a title_block call

    def spy_title_block(box, lines, fill, outline, font_path, outline_w, arch,
                        shadow, rtl=False):
        calls.append(rtl)
        return "<g/>"

    saved = {
        "theme": config.theme, "ensure": config.ensure_calibrated,
        "fp": config.font_path, "tb": rp.title_block,
        "rs": build.render_svg, "ff": rp.font_face,
    }
    try:
        with open(recipe_path, "w", encoding="utf-8") as f:
            json.dump(recipe, f)
        config.ensure_calibrated = lambda c: None
        config.font_path = lambda name, fn: font
        rp.font_face = lambda name, path: ""
        rp.title_block = spy_title_block
        build.render_svg = lambda svg_text, w, h, out_png: out_png

        # Hebrew theme -> both surfaces must be RTL.
        config.theme = lambda name: make_cfg("hebrew")
        calls.clear()
        build.render_board("x", board_svg, ["30 שנה נישואין"], os.path.join(tmp, "b.png"))
        build.render_backs("x", backs_svg, ["30 שנה נישואין"], os.path.join(tmp, "k.png"))
        assert calls and all(c is True for c in calls), (
            "board + back titles must be RTL for a Hebrew theme, got " + repr(calls)
        )

        # English theme -> both surfaces must stay LTR.
        config.theme = lambda name: make_cfg("english")
        calls.clear()
        build.render_board("x", board_svg, ["OZ'S"], os.path.join(tmp, "b2.png"))
        build.render_backs("x", backs_svg, ["OZ'S"], os.path.join(tmp, "k2.png"))
        assert calls and all(c is False for c in calls), (
            "board + back titles must stay LTR for an English theme, got " + repr(calls)
        )
    finally:
        config.theme = saved["theme"]
        config.ensure_calibrated = saved["ensure"]
        config.font_path = saved["fp"]
        rp.title_block = saved["tb"]
        build.render_svg = saved["rs"]
        rp.font_face = saved["ff"]
        if os.path.exists(recipe_path):
            os.remove(recipe_path)


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
