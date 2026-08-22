"""The six type ceilings: the largest the type may ever set on a design.

A ceiling is not a pin and not a fit. It can only ever bring an answer DOWN, so
every test here is a pair: the same card with the ceiling absent and with it set,
asserting the ceiling is what moved and that a box already giving less never
notices it is there.
"""
import os
import re

from PIL import ImageFont

import config
import render_page as R

CAFE = os.path.join(os.path.dirname(__file__), "Cafe-Regular.ttf")


def _cafe():
    return ImageFont.truetype(CAFE, 200), 200


BOX = {"x0": 20.0, "y0": 20.0, "x1": 200.0, "y1": 90.0}
HEB = ["מזל טוב"]
ENG = ["MAZAL TOV"]


def _sizes(svg):
    return [float(m) for m in re.findall(r'font-size="([0-9.]+)"', svg)]


def _title(lines, **kw):
    return R.title_block(BOX, lines, "#000", "#000", config.resolve_title_font("bachelorette"),
                         0.0, 0.0, False, **kw)


# ---------------------------------------------------------------- the reader
def test_absent_and_null_and_junk_all_mean_no_ceiling():
    for cfg in ({}, {"word_max_he": None}, {"word_max_he": ""},
                {"word_max_he": "wide"}, {"word_max_he": 0}, {"word_max_he": -3}):
        assert config.type_ceiling(cfg, "word_max_he") is None


def test_a_number_reads_as_a_number():
    assert config.type_ceiling({"title_max_en": 21}, "title_max_en") == 21.0
    assert config.type_ceiling({"title_max_en": "21.5"}, "title_max_en") == 21.5


def test_an_unknown_name_is_a_programming_error_not_a_silent_none():
    try:
        config.type_ceiling({}, "word_max_klingon")
    except KeyError:
        return
    raise AssertionError("an unknown ceiling name must raise, not return None")


# ---------------------------------------------------------------- the title
def test_a_title_ceiling_brings_the_size_down():
    free = max(_sizes(_title(ENG)))
    held = max(_sizes(_title(ENG, max_size=free / 2)))
    assert held < free
    assert abs(held - free / 2) < 0.01


def test_a_ceiling_above_what_the_box_gives_changes_nothing():
    free = max(_sizes(_title(ENG)))
    assert max(_sizes(_title(ENG, max_size=free * 3))) == free


def test_a_ceiling_cannot_grow_a_title_past_its_box():
    """The box still wins: a ceiling is a maximum, never a target."""
    free = max(_sizes(_title(ENG)))
    assert max(_sizes(_title(ENG, max_size=999))) == free


def test_a_pinned_title_is_still_held_by_its_ceiling():
    pinned = max(_sizes(_title(ENG, fixed_size=14)))
    assert abs(pinned - 14) < 0.01
    assert max(_sizes(_title(ENG, fixed_size=14, max_size=9))) < pinned


# ------------------------------------------------- which ceiling, by script
def test_the_script_of_the_title_picks_the_ceiling():
    cfg = {"title_max_en": 11, "title_max_he": 22,
           "back_title_max_en": 33, "back_title_max_he": 44}
    assert R.title_ceiling(cfg, ENG) == 11
    assert R.title_ceiling(cfg, HEB) == 22
    assert R.title_ceiling(cfg, ENG, back=True) == 33
    assert R.title_ceiling(cfg, HEB, back=True) == 44


def test_the_script_is_read_off_the_text_not_the_theme():
    """A buyer may write the honoree in the other language; title_font_for
    already swaps the face for that, and the ceiling has to follow the face."""
    cfg = {"language": "english", "title_max_en": 11, "title_max_he": 22}
    assert R.title_ceiling(cfg, ["מיה'S WELCOME PARTY"]) == 22


def test_a_design_with_no_ceilings_asks_for_none():
    assert R.title_ceiling({}, ENG) is None
    assert R.title_ceiling({}, HEB, back=True) is None


# ---------------------------------------------------------------- the words
def test_the_word_ceiling_lowers_the_cards_target_size():
    """It rides `uniform`, which is both the cap _fit_card honours and what
    _candidates measures a mid-word break against — so the wrapping stays
    solved for the size that actually prints."""
    slots = [{"x0": 40.0, "y0": 100.0 + i * 30, "x1": 180.0, "y1": 120.0 + i * 30,
              "color": "#000"} for i in range(4)]
    words = ["אמא", "ים", "כלב", "גן"]
    font, ref = _cafe()
    free = R._word_layouts(slots, words, font, ref)
    held = R._word_layouts(slots, words, font, ref, max_size=6.0)
    assert max(l.size for l in free if l) > 6.0, "short words must be free to grow"
    assert all(abs(l.size - 6.0) < 0.01 for l in held if l)


def test_a_word_ceiling_above_the_box_changes_nothing():
    slots = [{"x0": 40.0, "y0": 100.0 + i * 30, "x1": 180.0, "y1": 120.0 + i * 30,
              "color": "#000"} for i in range(4)]
    words = ["אמא", "ים", "כלב", "גן"]
    font, ref = _cafe()
    free = R._word_layouts(slots, words, font, ref)
    high = R._word_layouts(slots, words, font, ref, max_size=999.0)
    assert [None if l is None else round(l.size, 6) for l in free] == \
           [None if l is None else round(l.size, 6) for l in high]


# ------------------------------------------------- the english word ceiling
def test_the_english_ceiling_only_shrinks_the_latin_run():
    """Expressed back as a ratio because that is what the Face carries — and it
    can only come down, so every width the fit reserved is still enough."""
    cfg = {"word_max_en": 8.0}
    assert R.latin_scale(cfg, 20.0, 0.8) == 8.0 / 20.0        # 0.4, below the design's 0.8
    assert R.latin_scale(cfg, 8.0, 0.8) == 0.8                 # already under it


def test_no_english_ceiling_leaves_the_designs_own_ratio():
    assert R.latin_scale({}, 20.0, 0.8) == 0.8
    assert R.latin_scale({"word_alt_scale": 1.26}, 20.0, 0.8) == 1.26
