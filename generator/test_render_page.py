#!/usr/bin/env python3
"""Tests for generator/render_page.py — the card-fidelity fixes that make the
generated cards match the origin Canva templates:

  1. CHROME_FONT_WAIT — headless Chrome must wait for the embedded @font-face
     fonts before screenshotting, otherwise every word/title falls back to a
     heavy default Hebrew face instead of the calibrated theme font.
  2. _word_sizes — ONE uniform word size per card (matching the origin's single
     size), fit from the recipe box heights, with a per-word shrink guard so a
     long word can never spill past the card edge into the artwork.
  3. word_text — numbered lines use Latin-digit markers ("1." "2." …) placed
     RTL, never Hebrew-letter numerals.
  4. title_block — the stacked title is sized to fit its calibrated box HEIGHT
     even for display fonts whose glyphs are far taller than their em (the
     japanese/neon title faces), using real font metrics rather than a fixed
     per-line fraction.

Run: python3 generator/test_render_page.py   (or via pytest)
"""
import os
import re

from PIL import Image, ImageFont

import config
import render_page as rp

HERE = os.path.dirname(os.path.abspath(__file__))
CAFE = os.path.join(HERE, "word-fonts", "Cafe Regular.ttf")


def _cafe():
    return ImageFont.truetype(CAFE, 200), 200


# --- 1. font-load wait -------------------------------------------------------

def test_chrome_font_wait_is_a_virtual_time_budget():
    assert rp.CHROME_FONT_WAIT.startswith("--virtual-time-budget=")
    ms = int(rp.CHROME_FONT_WAIT.split("=", 1)[1])
    assert ms >= 1000, "font-load wait must give Chrome real time to load fonts"


def test_build_render_svg_passes_the_font_wait_flag():
    # The production board/back render path (build.render_svg) must carry the same
    # font-load wait so titles/words don't fall back there either.
    import build
    src = open(os.path.join(HERE, "build.py"), encoding="utf-8").read()
    assert "rp.CHROME_FONT_WAIT" in src
    assert build.CHROME  # sanity: build shares render_page's Chrome binary


# --- 2. uniform word sizing + shrink guard -----------------------------------

def _slots(boxes):
    return [{"x0": x0, "y0": y0, "x1": x1, "y1": y1} for (x0, y0, x1, y1) in boxes]


def test_word_sizes_are_uniform_when_every_word_fits():
    font, ref = _cafe()
    # four generous, equal-height boxes; short words -> nothing overflows.
    slots = _slots([(10, 10 + i * 40, 190, 34 + i * 40) for i in range(4)])
    words = ["מסיבה", "חברים", "ריקודים", "צחוקים"]
    sizes = rp._word_sizes(slots, words, font, ref, cell=[5, 5, 195, 240])
    assert all(s is not None for s in sizes)
    assert max(sizes) - min(sizes) < 1e-9, "words that all fit must share one size"


def test_word_sizes_scale_with_box_height():
    font, ref = _cafe()
    small = rp._word_sizes(_slots([(10, 10, 190, 26)]), ["מסיבה"], font, ref)
    big = rp._word_sizes(_slots([(10, 10, 190, 50)]), ["מסיבה"], font, ref)
    assert big[0] > small[0], "taller recipe boxes -> larger uniform word size"


def test_word_sizes_shrinks_only_the_overflowing_word_to_stay_in_the_cell():
    font, ref = _cafe()
    # a tall box (big uniform size) + one very long word right-anchored near x1.
    slots = _slots([(100, 10, 190, 44)])
    long = "אבגדהוזחטיכלמנסעפצקרשת"
    cell = [5, 5, 195, 240]
    sizes = rp._word_sizes(slots, [long], font, ref, cell=cell)
    left_bound = cell[0] + (cell[2] - cell[0]) * 0.02
    rendered_line = rp._line_width_at(font, ref, 1, long) * sizes[0] / ref
    assert rendered_line <= (190 - left_bound) + 1e-6, "long word must fit the card"


def test_word_sizes_no_cell_means_no_shrink():
    font, ref = _cafe()
    slots = _slots([(100, 10, 190, 44)])
    long = "אבגדהוזחטיכלמנסעפצקרשת"
    uni = rp._word_sizes(slots, [long], font, ref, cell=None)[0]
    med = (slots[0]["y1"] - slots[0]["y0"]) * rp._WORD_SIZE_K
    assert abs(uni - med) < 1e-9, "without a cell the uniform size is used as-is"


def test_word_sizes_skips_empty_and_missing_slots():
    font, ref = _cafe()
    slots = _slots([(10, 10, 190, 40), (10, 50, 190, 80), (10, 90, 190, 120)])
    sizes = rp._word_sizes(slots, ["מסיבה", ""], font, ref, cell=[5, 5, 195, 240])
    assert sizes[0] is not None
    assert sizes[1] is None  # blank word
    assert sizes[2] is None  # no word supplied for this slot


# --- 3. Latin-digit numbering ------------------------------------------------

def test_word_text_marker_is_a_latin_digit_and_period():
    for num in (1, 2, 3, 4):
        svg = rp.word_text(190, 50, 20, "#6c4d56", num, "מסיבה", CAFE)
        assert f">{num}</text>" in svg, "marker digit must be the Latin numeral"
        assert ">.</text>" in svg, "marker must include a period run"
        assert "מסיבה" in svg


def test_word_text_has_no_hebrew_letter_numerals():
    svg = rp.word_text(190, 50, 20, "#6c4d56", 6, "מסיבה", CAFE)
    # Hebrew gematria numbering would render the 6th item as the letter "ו";
    # the marker must be the digit 6, not a Hebrew letter standing in for it.
    assert ">6</text>" in svg


# --- 4. title fits its calibrated box height ---------------------------------

def _rendered_title_stack_units(font_path, lines, size):
    f = ImageFont.truetype(font_path, 200)
    asc, _desc = f.getmetrics()
    ink_above = asc - f.getbbox(lines[0])[1]
    ink_below = f.getbbox(lines[-1])[3] - asc
    stack_ref = ink_above + 0.78 * 200 * (len(lines) - 1) + ink_below
    return stack_ref / 200 * size


def _title_size(svg):
    return float(re.search(r'font-size="([0-9.]+)"', svg).group(1))


def test_title_fits_box_height_for_tall_glyph_display_font():
    # The japanese title face draws glyphs much taller than its em; a 2-line
    # stacked title must still fit inside its (short) calibrated box.
    cfg = config.theme("japanese")
    fp = config.font_path("japanese", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 15.0, "y0": 10.0, "x1": 195.0, "y1": 66.0}
    lines = ["YUKI'S", "30S"]
    svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    size = _title_size(svg)
    stack = _rendered_title_stack_units(fp, lines, size)
    bh = box["y1"] - box["y0"]
    assert stack <= bh + 0.5, f"title stack {stack:.1f} overflows box height {bh:.1f}"


def _pre_pr_size(fp, lines, box):
    """The ORIGINAL (pre-fidelity-PR) title size: the smaller of the width fit and
    the old height cap ``bh/(0.80*n)*1.02``. This is the shipped/calibrated size
    every previously-correct title must keep."""
    f = ImageFont.truetype(fp, 200)
    bw, bh, n = box["x1"] - box["x0"], box["y1"] - box["y0"], len(lines)
    width_fit = bw * 0.89 / max(f.getlength(ln) / 200 for ln in lines)
    old_cap = bh / (0.80 * n) * 1.02
    return min(width_fit, old_cap), width_fit, old_cap


def test_wide_script_title_not_enlarged():
    # A wide MrDafoe script name must render at its pre-PR size (min of width fit
    # and the old height cap) — the ink-fit-only rewrite grew it ~4% by dropping
    # the old height cap. Finding #1: previously-correct titles must NOT grow.
    cfg = config.theme("bachelorette")
    fp = config.font_path("bachelorette", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 80.0, "y0": 29.0, "x1": 186.0, "y1": 60.0}
    lines = ["Shira's", "Bachelorette"]
    svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    size = _title_size(svg)
    pre, width_fit, old_cap = _pre_pr_size(fp, lines, box)
    assert abs(size - pre) < 0.3, "wide script title must keep its pre-PR size"
    # here old_cap < width_fit, so it is capped by height and NOT enlarged to the
    # width fit the ink-fit-only code would have used.
    assert old_cap < width_fit
    assert size <= old_cap + 0.3, "title must be capped by the old height, not enlarged"


def test_shipped_normal_title_not_enlarged_or_shrunk():
    # birthday-girls (CooperLtBTBold) is a NORMAL-height face whose real ink runs
    # ~10% past its approximate recipe box; the ink-fit-only rewrite SHRANK it ~10%
    # below its calibrated size. It must render at the original pre-PR size.
    # Finding #1: a title that already fit keeps its prior size.
    cfg = config.theme("birthday-girls")
    fp = config.font_path("birthday-girls", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 65.6, "y0": 28.9, "x1": 139.1, "y1": 47.2}
    lines = ["Alma's", "B-day"]
    svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    size = _title_size(svg)
    pre, width_fit, old_cap = _pre_pr_size(fp, lines, box)
    assert abs(size - pre) < 0.3, "normal-height title must keep its pre-PR size"
    # it is height-bound here (old_cap < width_fit); the ~10% ink overrun is within
    # the box-approximation tolerance, so it is NOT shrunk to the metric ink-fit.
    assert size > old_cap - 0.3


def test_extreme_tall_face_shrinks_to_fit_when_overflow_exceeds_tolerance():
    # The metric ink-fit safety net must still engage for a genuinely too-tall
    # title: with the overrun tolerance forced to 0 (any overflow triggers it), a
    # face whose ink exceeds the old cap shrinks below old_cap so the painted stack
    # fits the box. Proves the ink-fit path is live, not dead code. (Findings #1/#5.)
    cfg = config.theme("birthday-girls")
    fp = config.font_path("birthday-girls", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 65.6, "y0": 28.9, "x1": 139.1, "y1": 47.2}
    lines = ["Alma's", "B-day"]
    saved = rp._TITLE_OVERFLOW_TOL
    rp._TITLE_OVERFLOW_TOL = 0.0
    try:
        svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                             ts["outline_w"], ts["arch"], ts["shadow"])
    finally:
        rp._TITLE_OVERFLOW_TOL = saved
    size = _title_size(svg)
    _pre, _wf, old_cap = _pre_pr_size(fp, lines, box)
    assert size < old_cap - 0.2, "ink-fit safety net must shrink a too-tall title"
    # and the painted stack (ink + outline + shadow headroom) fits the box height.
    f = ImageFont.truetype(fp, 200)
    stack = rp._title_ink_stack(f, 200, lines) / 200 * size
    pad = (2 * ts["outline_w"] + (0.06 if ts["shadow"] else 0.0)) * size
    bh = box["y1"] - box["y0"]
    assert stack + pad <= bh + 0.5, "painted footprint must stay within the box"


def test_title_ink_stack_includes_middle_line():
    # Finding #6: the stacked-ink extent must be measured over ALL lines. A 3-line
    # title whose tallest/deepest ink is on the MIDDLE line must measure the same
    # extent as when that ink is on an end line (max over all lines is symmetric),
    # and strictly more than a title with no tall line — the old first/last-only
    # measure would under-count the middle line.
    f, ref = _cafe()
    tall = "לקץ"          # ascender-tall lamed + deep final-tsadi descender
    short = "מם"
    mid_tall = [short, tall, short]
    end_tall = [tall, short, short]
    plain = [short, short, short]
    s_mid = rp._title_ink_stack(f, ref, mid_tall)
    s_end = rp._title_ink_stack(f, ref, end_tall)
    s_plain = rp._title_ink_stack(f, ref, plain)
    assert abs(s_mid - s_end) < 1e-9, "a tall MIDDLE line must be measured like an end line"
    assert s_mid > s_plain + 1.0, "the tall line's ink must enlarge the measured stack"


def test_empty_title_degrades_to_nothing():
    # Finding #3: an unfilled title (every line empty/whitespace) must return "" —
    # never crash on max([]) / getlength('') / a zero-width ink stack.
    cfg = config.theme("bachelorette")
    fp = config.font_path("bachelorette", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 80.0, "y0": 29.0, "x1": 186.0, "y1": 60.0}
    for empty in ([""], ["   "], ["", "  ", "\t"]):
        assert rp.title_block(box, empty, ts["fill"], ts["outline"], fp,
                              ts["outline_w"], ts["arch"], ts["shadow"]) == ""
    # a blank line mixed with a real line is dropped, not rendered/crashed.
    svg = rp.title_block(box, ["Shira", ""], ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    assert svg and "Shira" in svg


# --- 4b. per-theme italic title flag -----------------------------------------

def _birthday_italic_fixture():
    """Shared box/lines/style for the birthday-girls italic-title tests."""
    cfg = config.theme("birthday-girls")
    fp = config.font_path("birthday-girls", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 65.6, "y0": 28.9, "x1": 139.1, "y1": 47.2}
    lines = ["Alma's", "B-day"]
    return cfg, fp, ts, box, lines


def test_title_block_emits_font_style_italic_when_italic_true():
    # (a) italic=True must slant the title: every title <text> carries a plain
    # font-style="italic" so headless Chrome synthesizes the oblique from the
    # upright TitleFont (no separate italic font file).
    _cfg, fp, ts, box, lines = _birthday_italic_fixture()
    svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"], italic=True)
    assert 'font-style="italic"' in svg
    # the attribute rides on the title <text> element (before its <textPath>).
    for chunk in svg.split("<text ")[1:]:
        head = chunk.split(">", 1)[0]
        assert 'font-style="italic"' in head, "each title <text> must be italic"


def test_title_block_upright_by_default_has_no_italic():
    # (b) default (italic omitted) and explicit italic=False must NOT slant.
    _cfg, fp, ts, box, lines = _birthday_italic_fixture()
    default_svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                                 ts["outline_w"], ts["arch"], ts["shadow"])
    false_svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                               ts["outline_w"], ts["arch"], ts["shadow"], italic=False)
    assert "font-style" not in default_svg
    assert "font-style" not in false_svg


def test_title_block_italic_only_adds_the_font_style_attr():
    # (c) REGRESSION GUARD: toggling italic must change NOTHING about the output
    # except adding font-style="italic" — stripping that attribute from the italic
    # SVG must reproduce the non-italic SVG byte-for-byte. (Reset the title UID so
    # both calls share the same generated path ids.)
    _cfg, fp, ts, box, lines = _birthday_italic_fixture()
    saved_uid = rp._TITLE_UID[0]
    try:
        rp._TITLE_UID[0] = 0
        plain = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                               ts["outline_w"], ts["arch"], ts["shadow"], italic=False)
        rp._TITLE_UID[0] = 0
        ital = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                              ts["outline_w"], ts["arch"], ts["shadow"], italic=True)
    finally:
        rp._TITLE_UID[0] = saved_uid
    assert ital != plain
    assert ital.replace(' font-style="italic"', "") == plain, (
        "italic must ONLY add the font-style attr; non-italic output is unchanged")


def test_birthday_girls_theme_enables_italic_others_do_not():
    # The flag lives in the theme config: birthday-girls opts in; a representative
    # other theme (bachelorette) stays upright (defaults false).
    assert config.theme("birthday-girls")["title_style"].get("italic") is True
    assert config.theme("bachelorette")["title_style"].get("italic", False) is False


# --- 5. the calibrated font actually renders through headless Chrome -----------

def _chrome_render_glyph(font_path, family, text, size, out_png, embed=True):
    """Render one line of ``text`` in an embedded @font-face through the SAME
    headless-Chrome path + font-load wait the generator uses, and return the
    binarized ink cropped to its bounding box. ``embed=False`` omits the font so
    Chrome falls back to a system face (the failure mode the font-wait guards)."""
    import subprocess
    W, H = 1200, 320
    style = "<style>" + rp.font_face(family, font_path) + "</style>" if embed else ""
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
           f'viewBox="0 0 {W} {H}">{style}<rect width="{W}" height="{H}" fill="white"/>'
           f'<text x="20" y="200" font-family="{family}" font-size="{size}" '
           f'fill="black">{text}</text></svg>')
    sp = out_png.replace(".png", ".svg")
    open(sp, "w", encoding="utf-8").write(svg)
    subprocess.run([rp.CHROME, "--headless", "--no-sandbox", "--disable-gpu",
                    rp.CHROME_FONT_WAIT, "--force-device-scale-factor=1",
                    f"--screenshot={out_png}", f"--window-size={W},{H}", sp],
                   check=True, stderr=subprocess.DEVNULL)
    import numpy as np
    a = np.asarray(Image.open(out_png).convert("L")) < 128
    ys, xs = np.where(a)
    crop = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    return crop


def _ink_iou(crop, font_path, text, N=128):
    """IoU between a rendered ink crop and a PIL rasterization of ``text`` in the
    given font, both normalized to an N×N ink-bbox mask. High IoU == the render
    used THIS font's glyph shapes; a fallback face scores far lower."""
    import numpy as np
    from PIL import ImageDraw
    ref = Image.new("L", (2000, 500), 255)
    ImageDraw.Draw(ref).text((10, 10), text, font=ImageFont.truetype(font_path, 160), fill=0)
    ra = np.asarray(ref) < 128
    ys, xs = np.where(ra)
    rc = ra[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

    def norm(m):
        return np.asarray(Image.fromarray((m * 255).astype("uint8")).resize((N, N),
                          Image.LANCZOS)) > 128
    a, b = norm(crop), norm(rc)
    return (a & b).sum() / max(1, (a | b).sum())


def test_calibrated_font_renders_through_chrome():
    # Finding #2: prove the embedded @font-face actually paints (the font-load wait
    # works) by rendering through real headless Chrome and matching the ink to the
    # font's own glyph shapes. MrDafoe is a distinctive script: its shape IoU is
    # ~0.88 when the calibrated font renders and ~0.24 when Chrome falls back to a
    # system sans — a wide, machine-independent margin.
    fp = config.font_path("bachelorette", config.theme("bachelorette")["title_font"])
    word = "Bachelorette"
    import tempfile
    d = tempfile.mkdtemp(prefix="dugri-fonttest-")
    good = _chrome_render_glyph(fp, "TitleFont", word, 90, os.path.join(d, "g.png"), embed=True)
    fallback = _chrome_render_glyph(fp, "TitleFont", word, 90, os.path.join(d, "f.png"), embed=False)
    iou_good = _ink_iou(good, fp, word)
    iou_fallback = _ink_iou(fallback, fp, word)
    assert iou_good >= 0.6, (
        f"calibrated font did not render (IoU {iou_good:.2f}); font-load wait broken?")
    # control: the metric genuinely discriminates — a fallback face scores far lower.
    assert iou_fallback <= 0.45, f"fallback control unexpectedly high (IoU {iou_fallback:.2f})"
    assert iou_good - iou_fallback > 0.25


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
