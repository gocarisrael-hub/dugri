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
                        shadow, rtl=False, italic=False, **kw):
        # render_board/render_backs also pass fixed_size=/align= now; accept and
        # ignore them here — this spy only asserts the rtl kwarg is threaded.
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


def test_title_block_rtl_reorders_digit_in_raster():
    # The substring tests above prove the rtl WIRING (direction="rtl" reaches the
    # SVG); this proves the SEMANTICS — that this generator's headless-Chrome SVG
    # rasterizer actually HONORS direction="rtl" on a textPath title (word_text
    # documents Chrome ignoring it for a different, neutral-punctuation-in-one-
    # <text> path, so a "present but no-op" false green is the risk). We render the
    # Hebrew digit title "30 שנה נישואין" both ways and require the rasters to
    # DIFFER: if direction="rtl" were a no-op the two PNGs would be byte-identical.
    # Chrome-guarded so it skips where the rasterizer is absent (e.g. CI, which
    # runs only the JS suite) rather than failing.
    import hashlib
    import subprocess
    import tempfile

    import render_page as rp

    if not os.path.exists(rp.CHROME):
        return  # no rasterizer here (CI/JS-only) -> skip, don't fail

    font = os.path.join(config.HERE, "Cafe-Regular.ttf")
    box = {"x0": 0, "y0": 0, "x1": 600, "y1": 200}
    tmp = tempfile.mkdtemp(prefix="dugri-test-raster-")

    def raster(rtl, name):
        body = rp.title_block(box, ["30 שנה נישואין"], "#000", "#000", font,
                              0.0, 0.0, False, rtl=rtl)
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" '
               'viewBox="0 0 600 200"><rect width="600" height="200" fill="#fff"/>'
               "<style>" + rp.font_face("TitleFont", font) + "</style>" + body + "</svg>")
        svg_p = os.path.join(tmp, name + ".svg")
        png_p = os.path.join(tmp, name + ".png")
        with open(svg_p, "w", encoding="utf-8") as f:
            f.write(svg)
        subprocess.run([rp.CHROME, "--headless", "--disable-gpu",
                        "--force-device-scale-factor=2", f"--screenshot={png_p}",
                        "--window-size=600,200", svg_p], check=True,
                       stderr=subprocess.DEVNULL)
        return hashlib.md5(open(png_p, "rb").read()).hexdigest()

    assert raster(True, "rtl_on") != raster(False, "rtl_off"), (
        "direction=\"rtl\" must actually change the raster (else the fix is a "
        "silent no-op the substring test would still pass)"
    )


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
    assert p.endswith("aharoni/aharoniclm-book-webfont.ttf")
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


def test_board_clean_path_prefers_chasers_variant_when_present():
    # chasers on + a board-chasers.svg on disk -> that variant; chasers off (or the
    # default) -> always the normal board.svg, even when the variant exists.
    import tempfile

    tmp = tempfile.mkdtemp(prefix="dugri-test-board-")
    clean = os.path.join(tmp, "clean")
    os.makedirs(clean, exist_ok=True)
    board = os.path.join(clean, "board.svg")
    chasers = os.path.join(clean, "board-chasers.svg")
    open(board, "w", encoding="utf-8").write("<svg/>")
    open(chasers, "w", encoding="utf-8").write("<svg/>")
    saved = config.theme_dir
    try:
        config.theme_dir = lambda name: tmp
        assert config.board_clean_path("x", chasers=True) == chasers
        assert config.board_clean_path("x", chasers=False) == board
        assert config.board_clean_path("x") == board  # default is chasers off
    finally:
        config.theme_dir = saved


def test_board_clean_path_falls_back_when_no_chasers_variant():
    # chasers on but NO board-chasers.svg -> gracefully falls back to board.svg
    # (the feature is additive and never raises for a missing chasers asset).
    import tempfile

    tmp = tempfile.mkdtemp(prefix="dugri-test-board-")
    clean = os.path.join(tmp, "clean")
    os.makedirs(clean, exist_ok=True)
    board = os.path.join(clean, "board.svg")
    open(board, "w", encoding="utf-8").write("<svg/>")
    saved = config.theme_dir
    try:
        config.theme_dir = lambda name: tmp
        assert config.board_clean_path("x", chasers=True) == board
    finally:
        config.theme_dir = saved


def test_render_board_reads_chasers_variant_when_flagged():
    # render_board must READ the theme's board-chasers.svg when chasers=True and it
    # exists, and the plain board.svg otherwise. Capture the SVG text handed to
    # render_svg (no Chrome) to prove which clean board file won.
    import tempfile

    import build

    tmp = tempfile.mkdtemp(prefix="dugri-test-boardsel-")
    clean = os.path.join(tmp, "clean")
    os.makedirs(clean, exist_ok=True)
    hdr = ('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" '
           'viewBox="0 0 100 100">{}</svg>')
    board = os.path.join(clean, "board.svg")
    chasers = os.path.join(clean, "board-chasers.svg")
    open(board, "w", encoding="utf-8").write(hdr.format("<!--PLAIN-BOARD-->"))
    open(chasers, "w", encoding="utf-8").write(hdr.format("<!--CHASERS-BOARD-->"))

    # A board-less (no personalized title) calibrated theme -> render_board renders
    # the clean board file as-is, so the captured SVG reveals which file was read.
    cfg = {"slug": "synthetic", "calibrated": True, "board": None,
           "title_style": {"outline_w": 0, "arch": 0, "shadow": False}}
    captured = {}
    saved = {"theme": config.theme, "ensure": config.ensure_calibrated,
             "td": config.theme_dir, "rs": build.render_svg}
    try:
        config.theme = lambda name: cfg
        config.ensure_calibrated = lambda c: None
        config.theme_dir = lambda name: tmp
        build.render_svg = lambda svg_text, w, h, out: captured.setdefault("svg", svg_text)

        captured.clear()
        build.render_board("x", board, ["T"], os.path.join(tmp, "p.png"), chasers=False)
        assert "PLAIN-BOARD" in captured["svg"] and "CHASERS" not in captured["svg"]

        captured.clear()
        build.render_board("x", board, ["T"], os.path.join(tmp, "c.png"), chasers=True)
        assert "CHASERS-BOARD" in captured["svg"], "chasers=True must read board-chasers.svg"
    finally:
        config.theme = saved["theme"]
        config.ensure_calibrated = saved["ensure"]
        config.theme_dir = saved["td"]
        build.render_svg = saved["rs"]


def test_render_board_chasers_falls_back_when_viewbox_differs():
    # SAFETY: a TITLED board places the honoree name by fractions calibrated against
    # the PLAIN board's viewBox. If an admin uploads a board-chasers.svg with a
    # DIFFERENT viewBox, trusting it would put the name off-position on the customer's
    # PDF. render_board must fall back to the plain board in that case; when the
    # viewBox MATCHES it uses the chasers variant as normal.
    import tempfile

    import build
    import render_page as rp

    tmp = tempfile.mkdtemp(prefix="dugri-test-boardvb-")
    clean = os.path.join(tmp, "clean")
    os.makedirs(clean, exist_ok=True)

    def hdr(vb, marker):
        w, h = vb[2], vb[3]
        return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
                'viewBox="0 0 %d %d">%s</svg>' % (w, h, w, h, marker))

    board = os.path.join(clean, "board.svg")
    chasers = os.path.join(clean, "board-chasers.svg")
    open(board, "w", encoding="utf-8").write(hdr([0, 0, 100, 100], "<!--PLAIN-BOARD-->"))

    # A TITLED synthetic theme (bd truthy) so the name-placement calibration matters.
    cfg = {"slug": "synthetic", "calibrated": True, "language": "english",
           "title_font": "Cafe-Regular.ttf",
           "title_style": {"fill": "#fff", "outline": "#000", "outline_w": 0.0,
                           "arch": 0.0, "shadow": False},
           "board": {"fill": "#fff", "outline": "#000",
                     "frac": {"x0": 0.1, "y0": 0.1, "x1": 0.9, "y1": 0.3}}}
    captured = {}
    saved = {"theme": config.theme, "ensure": config.ensure_calibrated,
             "td": config.theme_dir, "fp": config.font_path,
             "tb": rp.title_block, "ff": rp.font_face, "rs": build.render_svg}
    try:
        config.theme = lambda name: cfg
        config.ensure_calibrated = lambda c: None
        config.theme_dir = lambda name: tmp
        config.font_path = lambda name, fn: fn
        rp.font_face = lambda name, path: ""
        rp.title_block = lambda *a, **k: "<g/>"
        build.render_svg = lambda svg_text, w, h, out: captured.setdefault("svg", svg_text)

        # Chasers board with a DIFFERENT viewBox -> must fall back to the plain board.
        open(chasers, "w", encoding="utf-8").write(hdr([0, 0, 200, 90], "<!--CHASERS-BOARD-->"))
        captured.clear()
        build.render_board("x", board, ["T"], os.path.join(tmp, "d.png"), chasers=True)
        assert "PLAIN-BOARD" in captured["svg"] and "CHASERS" not in captured["svg"], (
            "mismatched-viewBox chasers board must fall back to the plain board")

        # Chasers board with a MATCHING viewBox -> the variant is used.
        open(chasers, "w", encoding="utf-8").write(hdr([0, 0, 100, 100], "<!--CHASERS-BOARD-->"))
        captured.clear()
        build.render_board("x", board, ["T"], os.path.join(tmp, "m.png"), chasers=True)
        assert "CHASERS-BOARD" in captured["svg"], (
            "matching-viewBox chasers board must be used for a titled board")
    finally:
        config.theme = saved["theme"]
        config.ensure_calibrated = saved["ensure"]
        config.theme_dir = saved["td"]
        config.font_path = saved["fp"]
        rp.title_block = saved["tb"]
        rp.font_face = saved["ff"]
        build.render_svg = saved["rs"]


def test_render_board_chasers_raster_differs_from_plain():
    # Semantics (not just wiring): the chasers board actually rasterizes to a
    # DIFFERENT image than the plain board when a chasers asset is present. Rendered
    # through this generator's headless-Chrome path. Chrome-guarded so it skips where
    # the rasterizer is absent (e.g. the JS-only CI) rather than failing.
    import hashlib
    import tempfile

    import build
    import render_page as rp

    if not os.path.exists(rp.CHROME):
        return  # no rasterizer here -> skip, don't fail

    tmp = tempfile.mkdtemp(prefix="dugri-test-boardraster-")
    clean = os.path.join(tmp, "clean")
    os.makedirs(clean, exist_ok=True)

    def svg(fill):
        return ('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" '
                'viewBox="0 0 120 80"><rect width="120" height="80" fill="%s"/></svg>' % fill)

    board = os.path.join(clean, "board.svg")
    open(board, "w", encoding="utf-8").write(svg("#ffffff"))
    open(os.path.join(clean, "board-chasers.svg"), "w", encoding="utf-8").write(svg("#c81e1e"))

    cfg = {"slug": "synthetic", "calibrated": True, "board": None,
           "title_style": {"outline_w": 0, "arch": 0, "shadow": False}}
    saved = {"theme": config.theme, "ensure": config.ensure_calibrated, "td": config.theme_dir}
    try:
        config.theme = lambda name: cfg
        config.ensure_calibrated = lambda c: None
        config.theme_dir = lambda name: tmp
        p_plain = build.render_board("x", board, ["T"], os.path.join(tmp, "plain.png"),
                                     chasers=False)
        p_ch = build.render_board("x", board, ["T"], os.path.join(tmp, "ch.png"), chasers=True)
        h_plain = hashlib.md5(open(p_plain, "rb").read()).hexdigest()
        h_ch = hashlib.md5(open(p_ch, "rb").read()).hexdigest()
        assert h_plain != h_ch, "chasers board raster must differ from the plain board"
    finally:
        config.theme = saved["theme"]
        config.ensure_calibrated = saved["ensure"]
        config.theme_dir = saved["td"]


def test_custom_title_overrides_theme_derived_lines():
    # F7 (a): an order-level custom title REPLACES the theme-derived title_lines.
    # Multi-line titles split on newlines (each line trimmed, blanks dropped).
    cfg = config.theme("trip comeback")  # normally -> ["OZ'S", "WELCOME", "PARTY"]
    assert config.title_lines(cfg, "oz", {}, custom_title="ליאת חוגגת 40") == ["ליאת חוגגת 40"]
    assert config.title_lines(cfg, "oz", {}, custom_title="שורה 1\nשורה 2") == ["שורה 1", "שורה 2"]
    # surrounding + blank-line whitespace is cleaned; empty lines never render
    assert config.title_lines(cfg, "oz", {}, custom_title="  A  \n\n  B  ") == ["A", "B"]


def test_no_custom_title_leaves_title_lines_byte_identical():
    # F7 (b): with NO custom title (None / "" / whitespace-only) the output is
    # byte-identical to today's theme-derived lines — default behavior preserved.
    for cfg, name, extra in [
        (config.theme("trip comeback"), "oz", {}),
        (config.theme("japanese"), "tomer", {"AGE": "30"}),
        (config.theme("anniversary"), "", {"YEARS": "30", "NAME1": "מיכל", "NAME2": "זאבי"}),
    ]:
        base = config.title_lines(cfg, name, extra)
        assert config.title_lines(cfg, name, extra, custom_title=None) == base
        assert config.title_lines(cfg, name, extra, custom_title="") == base
        assert config.title_lines(cfg, name, extra, custom_title="   \n  ") == base


def test_custom_title_routes_through_board_title_block():
    # F7 (c) wiring: render_board must feed the OVERRIDE lines (not the theme's)
    # into title_block — the same auto-fitting title renderer every title uses.
    # Spy on title_block to capture the lines it receives.
    import tempfile

    import render_page as rp
    import build

    font = os.path.join(config.HERE, "Cafe-Regular.ttf")
    tmp = tempfile.mkdtemp(prefix="dugri-test-customtitle-")
    board_svg = os.path.join(tmp, "board.svg")
    with open(board_svg, "w", encoding="utf-8") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" '
                'viewBox="0 0 100 100"></svg>')

    cfg = {"slug": "synthetic", "calibrated": True, "language": "hebrew",
           "title_font": "Cafe-Regular.ttf", "word_font": "Cafe-Regular.ttf",
           "title_style": {"fill": "#fff", "outline": "#000", "outline_w": 0.0,
                           "arch": 0.0, "shadow": False},
           "board": {"fill": "#fff", "outline": "#000",
                     "frac": {"x0": 0.1, "y0": 0.1, "x1": 0.9, "y1": 0.3}}}
    captured = {}

    def spy_title_block(box, lines, *a, **k):
        captured["lines"] = lines
        return "<g/>"

    saved = {"theme": config.theme, "ensure": config.ensure_calibrated,
             "fp": config.font_path, "tb": rp.title_block,
             "rs": build.render_svg, "ff": rp.font_face}
    try:
        config.theme = lambda name: cfg
        config.ensure_calibrated = lambda c: None
        config.font_path = lambda name, fn: font
        rp.font_face = lambda name, path: ""
        rp.title_block = spy_title_block
        build.render_svg = lambda svg_text, w, h, out_png: out_png

        # The override lines the CALLER computes (config.title_lines override path)
        # are what build passes to render_board; assert render_board hands them on.
        override = config.title_lines(cfg, "x", {}, custom_title="כותרת מיוחדת מאוד")
        build.render_board("x", board_svg, override, os.path.join(tmp, "b.png"))
        assert captured["lines"] == ["כותרת מיוחדת מאוד"], (
            "render_board must feed the custom-title lines into title_block")
    finally:
        config.theme = saved["theme"]
        config.ensure_calibrated = saved["ensure"]
        config.font_path = saved["fp"]
        rp.title_block = saved["tb"]
        build.render_svg = saved["rs"]
        rp.font_face = saved["ff"]


def test_title_block_autofits_overlong_title_within_box():
    # F7 (c) SAFETY: a long title can NEVER overflow — title_block sizes it to the
    # SMALLER of fit-to-width / fit-to-height, so an over-long override just renders
    # SMALLER. Assert the emitted font-size for a long single-line title (1) is
    # smaller than for a short one in the SAME box, and (2) still fits the box width.
    import re

    import render_page as rp

    font = os.path.join(config.HERE, "Cafe-Regular.ttf")
    box = {"x0": 0, "y0": 0, "x1": 400, "y1": 200}

    def emitted_size(line):
        svg = rp.title_block(box, [line], "#000", "#000", font, 0, 0, False)
        return float(re.search(r'font-size="([0-9.]+)"', svg).group(1))

    short = emitted_size("קצר")
    long = emitted_size("כותרת ארוכה מאוד מאוד שלא נגמרת")
    assert long < short, "a longer title must auto-fit to a SMALLER font size"

    # And it fits the box WIDTH: rendered width = size * (glyph width per unit) must
    # not exceed the box width (that is exactly what the width term guarantees).
    from PIL import ImageFont

    f, ref = rp._title_metrics(font)
    for line in ("קצר", "כותרת ארוכה מאוד מאוד שלא נגמרת"):
        size = emitted_size(line)
        rendered_w = f.getlength(line) / ref * size
        assert rendered_w <= (box["x1"] - box["x0"]) + 1e-6, (
            "auto-fit must keep the title within the box width (no overflow)")


# ---- Preview calibration overrides ----------------------------------------
# The owner's calibration form previews an UNCALIBRATED template with knobs it
# has not saved yet. These guard the two halves of that: the knobs really reach
# every config read, and the exemption NEVER widens to production.

# A minimal uncalibrated entry, exactly as server/templates.js writes one for a
# freshly onboarded template (title_style/board/back null, calibrated false).
_UNCAL = {
    "slug": "fresh", "dir": "resources/canva/templates/fresh", "recipe": "fresh",
    "display_he": "חדש", "title_text": "{NAME}", "title_lines": ["{NAME}"],
    "language": "hebrew", "name_form": "hebrew", "extra_fields": [],
    "title_font": "X.ttf", "word_font": "Y.ttf",
    "title_style": None, "board": None, "back": None, "calibrated": False,
}

# A valid blob in the shape server/templates.js validateCalibration emits.
_KNOBS = {
    "title_style": {"fill": "#ffffff", "outline": "#000000", "outline_w": 0.05,
                    "arch": 0.1, "shadow": True, "size": 24},
    "board": None, "back": None, "word_size": 12,
}


def _with_uncalibrated_themes(fn):
    """Run ``fn`` against a themes.json holding only the uncalibrated entry."""
    import json
    import tempfile
    saved = config.THEMES_JSON
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                      encoding="utf-8")
    json.dump({"fresh": _UNCAL}, tmp)
    tmp.close()
    config.THEMES_JSON = tmp.name
    try:
        fn()
    finally:
        config.THEMES_JSON = saved
        config.clear_preview_overrides()
        os.unlink(tmp.name)


def test_uncalibrated_theme_is_refused_without_knobs():
    def check():
        try:
            config.ensure_calibrated(config.theme("fresh"))
        except RuntimeError as e:
            assert "not calibrated" in str(e)
        else:
            raise AssertionError("an uncalibrated theme must not render")
    _with_uncalibrated_themes(check)


def test_supplied_knobs_let_an_uncalibrated_theme_preview():
    def check():
        config.set_preview_overrides("fresh", _KNOBS)
        cfg = config.theme("fresh")
        # No raise: the preview is allowed through on the supplied knobs alone.
        config.ensure_calibrated(cfg)
        # ...and it renders with THOSE values, not the stored nulls.
        assert cfg["title_style"]["fill"] == "#ffffff"
        assert cfg["title_style"]["outline_w"] == 0.05
        assert cfg["title_style"]["size"] == 24
        assert cfg["word_size"] == 12
        # themes.json is untouched — overrides are in-memory only.
        assert config.load_themes()["fresh"]["title_style"] is None
        assert config.load_themes()["fresh"]["calibrated"] is False
    _with_uncalibrated_themes(check)


def test_knobs_reach_every_later_config_read():
    # render_page.build_page / build.render_board / build.render_backs each
    # re-read config.theme() themselves. If overrides didn't survive a re-read,
    # the card front would preview with the knobs while the board/back died on
    # the stored null title_style.
    def check():
        config.set_preview_overrides("fresh", _KNOBS)
        for _ in range(3):
            cfg = config.theme("fresh")
            config.ensure_calibrated(cfg)
            assert cfg["title_style"]["arch"] == 0.1
    _with_uncalibrated_themes(check)


def test_knobs_cannot_repoint_a_theme_at_other_files():
    # Only the look knobs are overridable — never identity/asset config, so a
    # preview can't be steered at another template's art or fonts.
    def check():
        config.set_preview_overrides("fresh", dict(
            _KNOBS, dir="resources/canva/templates/anniversary",
            recipe="anniversary", title_font="Evil.ttf"))
        cfg = config.theme("fresh")
        assert cfg["dir"] == "resources/canva/templates/fresh"
        assert cfg["recipe"] == "fresh"
        assert cfg["title_font"] == "X.ttf"
    _with_uncalibrated_themes(check)


def test_knobs_without_a_usable_title_style_still_refuse():
    # The exemption is not a blanket bypass: knobs that don't actually supply a
    # title_style must fail HERE with the clear "not calibrated" message rather
    # than deeper in the renderer on a missing fill/outline.
    def check():
        for bad in ({"word_size": 12}, {"title_style": None},
                    {"title_style": "big"}):
            config.clear_preview_overrides()
            config.set_preview_overrides("fresh", bad)
            try:
                config.ensure_calibrated(config.theme("fresh"))
            except RuntimeError:
                pass
            else:
                raise AssertionError(f"{bad!r} must not unlock rendering")
    _with_uncalibrated_themes(check)


def test_production_themes_are_unaffected_by_the_override_hook():
    # With nothing installed, every shipped theme reads exactly as before and a
    # real PDF still requires calibrated:true.
    #
    # A theme STAGED for a redesign is the one exception: while its artwork is
    # being migrated it sits in themes.json as visibility:private +
    # calibrated:false, geometry not yet detected (grapefruit, during the move to
    # portrait single cards). The storefront skips a non-public entry, so it is
    # not a production theme. The invariant that actually matters is asserted
    # here instead: anything a customer CAN reach must be calibrated.
    config.clear_preview_overrides()
    for name in config.load_themes():
        cfg = config.theme(name)
        assert config._PREVIEW_MARK not in cfg
        if not cfg.get("calibrated", False):
            assert (cfg.get("visibility") or "public") != "public", (
                f"{name} is uncalibrated but PUBLIC — the storefront would offer "
                "a theme that cannot render")
            continue
        config.ensure_calibrated(cfg)


# ---- Owner template store overlay ------------------------------------------
# Templates the owner uploads (and calibrations they save) are written at runtime
# and only survive a deploy if they land on the DATA_DIR volume. These guard the
# reader half: the merged view, who wins a clash, and — critically — that with
# DATA_DIR UNSET everything resolves to the image exactly as it did before.


def _with_store(fn, shipped=None):
    """Run ``fn(store_root)`` against a temp DATA_DIR + a temp shipped themes.json.

    Both halves are temporary so a test can assert on the merge without depending
    on (or touching) the real catalog. DATA_DIR is restored afterwards, since it
    is read from the environment on every lookup.
    """
    import json
    import shutil
    import tempfile

    data_dir = tempfile.mkdtemp(prefix="dugri-test-store-")
    store = os.path.join(data_dir, "templates")
    os.makedirs(store, exist_ok=True)
    saved_env = os.environ.get("DATA_DIR")
    saved_themes = config.THEMES_JSON
    shipped_file = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                               encoding="utf-8")
    json.dump(shipped if shipped is not None else {}, shipped_file)
    shipped_file.close()
    os.environ["DATA_DIR"] = data_dir
    config.THEMES_JSON = shipped_file.name
    try:
        fn(store)
    finally:
        if saved_env is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = saved_env
        config.THEMES_JSON = saved_themes
        os.unlink(shipped_file.name)
        shutil.rmtree(data_dir, ignore_errors=True)


def _write_owner_themes(store, entries):
    import json

    with open(os.path.join(store, "themes.json"), "w", encoding="utf-8") as f:
        json.dump(entries, f)


def test_merged_themes_hold_shipped_plus_owner():
    shipped = {"shipped-one": dict(_UNCAL, slug="shipped-one",
                                   dir="resources/canva/templates/shipped-one")}

    def check(store):
        _write_owner_themes(store, {"owner-one": dict(_UNCAL, slug="owner-one")})
        themes = config.load_themes()
        assert set(themes) == {"shipped-one", "owner-one"}, themes
        assert config.theme("owner-one")["slug"] == "owner-one"
        assert config.theme("shipped-one")["slug"] == "shipped-one"

    _with_store(check, shipped)


def test_owner_entry_overrides_a_same_key_shipped_one():
    # A whole-entry override, not a deep merge: the owner's saved calibration
    # replaces the shipped entry outright rather than leaving half of each.
    shipped = {"dup": dict(_UNCAL, slug="dup", display_he="ישן", calibrated=False,
                           title_style=None, word_font="OLD.ttf")}

    def check(store):
        _write_owner_themes(store, {"dup": dict(_UNCAL, slug="dup",
                                                display_he="חדש", calibrated=True,
                                                title_style={"fill": "#fff"})})
        cfg = config.theme("dup")
        assert cfg["display_he"] == "חדש"
        assert cfg["calibrated"] is True
        assert cfg["title_style"] == {"fill": "#fff"}
        # not a deep merge — the owner entry is taken whole
        assert cfg["word_font"] == _UNCAL["word_font"]

    _with_store(check, shipped)


def test_theme_dir_prefers_the_volume_and_falls_back_to_the_image():
    # An owner template's assets resolve to DATA_DIR/templates/<key>/; a shipped
    # one still resolves through its own `dir` inside the image.
    shipped = {"trip comeback": config.load_themes()["trip comeback"]}

    def check(store):
        _write_owner_themes(store, {"owner-one": dict(_UNCAL, slug="owner-one")})
        os.makedirs(os.path.join(store, "owner-one", "clean"), exist_ok=True)
        assert config.theme_dir("owner-one") == os.path.join(store, "owner-one")
        shipped_dir = config.theme_dir("trip comeback")
        assert shipped_dir == os.path.join(config.REPO,
                                           "resources/canva/templates/trip comeback")
        assert store not in shipped_dir
        # assets under the volume dir are what clean_path/font_path now point at
        assert config.clean_path("owner-one", "fronts").startswith(
            os.path.join(store, "owner-one"))
        assert config.font_path("owner-one", "X.ttf").startswith(
            os.path.join(store, "owner-one"))

    _with_store(check, shipped)


def test_theme_dir_resolves_by_key_not_the_stored_dir_field():
    # The server writes an owner entry whose `dir` names an IN-IMAGE path — the
    # very location that does not survive a deploy. It must be ignored.
    def check(store):
        _write_owner_themes(store, {"owner-one": dict(
            _UNCAL, slug="owner-one", dir="resources/canva/templates/anniversary")})
        os.makedirs(os.path.join(store, "owner-one"), exist_ok=True)
        assert config.theme_dir("owner-one") == os.path.join(store, "owner-one")
        assert "anniversary" not in config.theme_dir("owner-one")

    _with_store(check)


def test_owner_entry_without_assets_fails_with_a_clear_error():
    # Registered on the volume but its files are gone (the classic "uploaded into
    # the container image, lost on deploy"). That must say so, not die on a bare
    # FileNotFoundError deep inside a render.
    def check(store):
        _write_owner_themes(store, {"ghost": dict(_UNCAL, slug="ghost")})
        try:
            config.theme_dir("ghost")
        except RuntimeError as e:
            msg = str(e)
            assert "ghost" in msg and "Re-upload" in msg, msg
            assert store in msg, "the error must name where the assets were expected"
        else:
            raise AssertionError("a template with no assets anywhere must not "
                                 "silently resolve to a path")

    _with_store(check)


def test_owner_entry_may_override_a_shipped_theme_and_keep_the_image_assets():
    # Calibrating a SHIPPED design writes only the ENTRY to the volume; its art
    # stays in the image. That combination must still resolve to the image dir.
    shipped = {"trip comeback": config.load_themes()["trip comeback"]}

    def check(store):
        _write_owner_themes(store, {"trip comeback": dict(
            config.load_themes()["trip comeback"], display_he="מכויל מחדש")})
        assert config.theme("trip comeback")["display_he"] == "מכויל מחדש"
        assert config.theme_dir("trip comeback") == os.path.join(
            config.REPO, "resources/canva/templates/trip comeback")

    _with_store(check, shipped)


def test_recipe_resolves_owner_first_then_image():
    import json

    def check(store):
        os.makedirs(os.path.join(store, "recipes"), exist_ok=True)
        owned = os.path.join(store, "recipes", "owner-one.json")
        with open(owned, "w", encoding="utf-8") as f:
            json.dump({"viewBox": [0, 0, 10, 10], "cards": []}, f)
        assert config.recipe_path("owner-one") == owned
        assert config.load_recipe("owner-one")["viewBox"] == [0, 0, 10, 10]
        # a recipe that exists only in the image still resolves there
        assert config.recipe_path("trip") == os.path.join(config.HERE, "recipes",
                                                          "trip.json")
        assert os.path.exists(config.recipe_path("trip"))

    _with_store(check)


def test_missing_recipe_raises_an_actionable_error():
    def check(store):
        try:
            config.load_recipe("nope-not-a-recipe")
        except RuntimeError as e:
            assert "nope-not-a-recipe" in str(e) and "recipe" in str(e)
        else:
            raise AssertionError("a missing recipe must raise a clear error")

    _with_store(check)


def test_corrupt_owner_store_raises_rather_than_silently_dropping_entries():
    # Ignoring a corrupt store would silently render the SHIPPED design for any
    # key the owner had overridden — the wrong artwork on a customer's PDF.
    def check(store):
        with open(os.path.join(store, "themes.json"), "w", encoding="utf-8") as f:
            f.write("{not json")
        try:
            config.load_themes()
        except RuntimeError as e:
            assert "unreadable" in str(e) and store in str(e)
        else:
            raise AssertionError("a corrupt owner store must not be ignored")

    _with_store(check)


def test_display_path_keeps_repo_paths_relative_and_volume_paths_whole():
    # Owner files live outside the repo, where a relpath is a meaningless ladder
    # of "../.." — those are shown in full; in-repo paths read as they always did.
    inside = os.path.join(config.REPO, "resources", "canva", "templates", "japanese")
    assert config.display_path(inside) == "resources/canva/templates/japanese"
    outside = "/data/templates/owner-one/clean/fronts.svg"
    assert config.display_path(outside) == outside


def test_without_data_dir_everything_resolves_to_the_image():
    # The local-dev / test / CLI case: no store at all, so every lookup is exactly
    # what it was before the overlay existed.
    saved = os.environ.pop("DATA_DIR", None)
    try:
        assert config.owner_store() is None
        assert config.owner_themes_path() is None
        assert config.owner_themes() == {}
        import json
        with open(config.THEMES_JSON, encoding="utf-8") as f:
            assert config.load_themes() == json.load(f)
        for name, cfg in config.load_themes().items():
            assert config.theme_dir(name) == os.path.join(config.REPO, cfg["dir"])
            assert config.recipe_path(cfg["recipe"]) == os.path.join(
                config.HERE, "recipes", cfg["recipe"] + ".json")
    finally:
        if saved is not None:
            os.environ["DATA_DIR"] = saved


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")


# ---- the three fidelity fixes of #316, pinned as INTENT not as numbers -----
def _themes():
    import json
    here = os.path.dirname(os.path.abspath(__file__))
    return json.load(open(os.path.join(here, "themes.json"), encoding="utf-8"))


def test_japanese_nudges_the_fronts_whose_koi_takes_the_top_left():
    ts = _themes()["japanese"]["title_style"]
    per = ts.get("front_offset") or {}
    assert set(per) == {"5", "6", "7", "8"}, per
    for n in ("5", "6", "7", "8"):
        assert per[n][0] > ts["offset"][0], (
            f"front {n} must clear the koi, not take the shared offset")


def test_football_pins_a_size_for_the_front_and_its_own_for_the_back():
    ts = _themes()["football-boys"]["title_style"]
    assert ts.get("size"), "the front auto-fit printed the title over-size"
    assert ts.get("back_size"), "the back needs its OWN size, bigger than the front"
    assert ts["back_size"] > ts["size"]


def test_trip_comeback_sets_its_words_in_the_origin_s_heavier_weight():
    cfg = _themes()["trip comeback"]
    assert cfg.get("word_bold") is True
    assert cfg.get("word_size"), "the origin's words are larger than the detected fit"
