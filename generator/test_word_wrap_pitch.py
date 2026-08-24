"""word_wrap_pitch: how far apart the two lines of ONE wrapped entry sit.

The generator has only ever answered that from the ink — ``_card_lead``, the
tightest spacing at which no two letters touch. That is a FLOOR, not a look: it
leaves a wrapped phrase reading as one word when the design wants two. This knob
opens the gap up to the step between entries, and no further.

Two properties matter more than the number itself, and each has a test here:
the floor is never crossed (letters cannot be made to touch), and the block the
fit reserved still covers what is drawn (the knob is applied INSIDE the fit, so
the size pays for the wider gap).
"""
import os

from PIL import ImageFont

import config
import render_page as R

CAFE = os.path.join(os.path.dirname(__file__), "Cafe-Regular.ttf")
# A row that a two-word phrase cannot hold on one line, so it must wrap.
SLOTS = [{"x0": 40.0, "y0": 60.0 + i * 40, "x1": 150.0, "y1": 80.0 + i * 40,
          "color": "#000"} for i in range(4)]
WORDS = ["מסיבה גדולה מאוד בבית", "ים", "כלב", "גן"]


def _font():
    return ImageFont.truetype(CAFE, 200), 200


def _lay(**kw):
    font, ref = _font()
    return R._word_layouts(SLOTS, WORDS, font, ref, **kw)


# ------------------------------------------------------------ the reader
def test_absent_and_junk_and_out_of_range_all_mean_the_ink_floor():
    for cfg in ({}, {"word_wrap_pitch": None}, {"word_wrap_pitch": "wide"},
                {"word_wrap_pitch": 0}, {"word_wrap_pitch": -1},
                {"word_wrap_pitch": 1.5}, {"word_wrap_pitch": ""}):
        assert config.word_wrap_pitch(cfg) is None


def test_a_number_in_range_reads_as_a_number():
    assert config.word_wrap_pitch({"word_wrap_pitch": 1}) == 1.0
    assert config.word_wrap_pitch({"word_wrap_pitch": "0.85"}) == 0.85


def test_one_is_the_top_of_the_range():
    """Past the entry step a continuation sits further from its own first line
    than from the next entry."""
    assert config.word_wrap_pitch({"word_wrap_pitch": 1}) == 1.0
    assert config.word_wrap_pitch({"word_wrap_pitch": 1.01}) is None


# ------------------------------------------------------- the entry step
def test_the_entry_step_is_the_smallest_gap():
    # An unevenly spaced card must still keep every continuation inside its own
    # entry, so the tightest pair is what a wrap is measured against.
    assert R._entry_step([10.0, 40.0, 60.0, 100.0]) == 20.0
    assert R._entry_step([]) == 0.0
    assert R._entry_step([5.0]) == 0.0


# ------------------------------------------------------------ what it does
def test_it_opens_the_gap_inside_a_wrapped_entry():
    tight = _lay()
    loose = _lay(wrap_pitch=1.0)
    wrapped = [i for i, l in enumerate(tight) if l and len(l.lines) > 1]
    assert wrapped, "fixture must produce a wrapped entry"
    i = wrapped[0]
    assert loose[i].lead > tight[i].lead


def test_it_never_goes_below_the_ink_floor():
    """The floor is what stops two letters touching, so a small fraction must
    change nothing at all rather than tighten past it."""
    floor = _lay()
    asked = _lay(wrap_pitch=0.01)
    for a, b in zip(floor, asked):
        if a is None or b is None:
            assert a is b
            continue
        assert b.lead == a.lead


def test_a_card_with_nothing_wrapped_is_untouched():
    font, ref = _font()
    short = ["אמא", "ים", "כלב", "גן"]
    a = R._word_layouts(SLOTS, short, font, ref)
    b = R._word_layouts(SLOTS, short, font, ref, wrap_pitch=1.0)
    assert [None if l is None else round(l.size, 6) for l in a] == \
           [None if l is None else round(l.size, 6) for l in b]


def test_the_wider_gap_is_paid_for_in_size_not_in_overflow():
    """It is applied inside the fit, so a card that opens its wrap gap comes
    back no larger than the one that did not — never a taller block on the same
    paper."""
    tight = _lay()
    loose = _lay(wrap_pitch=1.0)
    live = [(a, b) for a, b in zip(tight, loose) if a and b]
    assert live
    for a, b in live:
        assert b.size <= a.size + 1e-9
