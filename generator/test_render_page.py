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

from PIL import ImageFont

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


def test_wide_name_title_stays_width_bound():
    # A wide script name (bachelorette) is limited by the box WIDTH, not height —
    # the metrics-based height cap must not shrink it below the width fit.
    cfg = config.theme("bachelorette")
    fp = config.font_path("bachelorette", cfg["title_font"])
    ts = cfg["title_style"]
    box = {"x0": 80.0, "y0": 29.0, "x1": 186.0, "y1": 60.0}
    lines = ["Shira's", "Bachelorette"]
    svg = rp.title_block(box, lines, ts["fill"], ts["outline"], fp,
                         ts["outline_w"], ts["arch"], ts["shadow"])
    size = _title_size(svg)
    f = ImageFont.truetype(fp, 200)
    widest = max(f.getlength(ln) / 200 for ln in lines)
    bw = box["x1"] - box["x0"]
    # width-bound size == bw*0.89/widest; assert we're at (not below) that fit.
    assert abs(size - bw * 0.89 / widest) < 0.5, "wide title must be width-bound"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
