"""A slash is a break opportunity, and the best one there is.

Buyers write a phrase and its English beside it — "צער גידול בנות/Full house" —
and a slash is the only mark that says "these two are the same thing". Splitting
at spaces alone cannot see it: "בנות/Full" is a single token, so the
width-optimal split tore the pair in half and a printed card read

    צער גידול
    Full house/בנות

— two fragments, neither of which is what she wrote.

The second thing every test here guards is that text WITHOUT a slash is
untouched. The new rank term is constant across candidates then, so the ranking
falls through to width exactly as it did before.
"""
import os

from PIL import ImageFont

import render_page as R

CAFE = os.path.join(os.path.dirname(__file__), "Cafe-Regular.ttf")


def _font():
    return ImageFont.truetype(CAFE, 200)


# ----------------------------------------------------------------- the pieces
def test_a_slash_ends_a_piece_and_keeps_itself():
    # The slash stays with the text before it: it is the join, and a line that
    # ends "בנות/" reads as a phrase continuing, where a bare "בנות" does not.
    assert R._units("צער גידול בנות/Full house") == [
        ("צער", " "), ("גידול", " "), ("בנות/", ""), ("Full", " "), ("house", "")
    ]


def test_pieces_rejoin_into_exactly_what_she_wrote():
    for text in ("צער גידול בנות/Full house", "בלגן/mess", "מסיבה גדולה", "א/ב/ג",
                 "one two three"):
        assert R._join(R._units(text)) == text


def test_a_word_with_no_slash_is_one_piece():
    assert R._units("מסיבה") == [("מסיבה", "")]


# ------------------------------------------------------------------ the break
def test_it_breaks_at_the_slash_rather_than_mid_phrase():
    got = R._balanced_split(_font(), "צער גידול בנות/Full house", 2)
    assert got == ["צער גידול בנות/", "Full house"], got


def test_each_side_of_the_slash_stays_whole():
    lines = R._balanced_split(_font(), "צער גידול בנות/Full house", 2)
    assert "".join(lines).replace("/", "/") == "צער גידול בנות/Full house"
    assert lines[1] == "Full house"          # the English is not split off midway


def test_the_break_is_won_on_width_not_forced():
    """Once the slash is a place a line MAY end, the narrowest split is already
    the readable one — so no rule has to override width, and no input can be
    dragged into a worse-fitting split in the name of a slash."""
    f = _font()
    chosen = R._balanced_split(f, "צער גידול בנות/Full house", 2)
    assert chosen == ["צער גידול בנות/", "Full house"]
    # …and it is genuinely the narrowest of the four candidates
    others = (["צער גידול", "בנות/Full house"],
              ["צער גידול בנות/Full", "house"],
              ["צער", "גידול בנות/Full house"])
    mine = max(f.getlength(l) for l in chosen)
    for other in others:
        assert mine <= max(f.getlength(l) for l in other), other


def test_a_slash_near_the_start_is_not_forced_into_a_ragged_split():
    """The slash is an opportunity, not an order. A break right after a leading
    "א/" would leave one near-empty line and one very long one, and a long line
    costs the whole card type size."""
    got = R._balanced_split(_font(), "א/one two three four five", 2)
    assert got == ["א/one two", "three four five"], got


# ------------------------------------------------------- nothing else changes
def test_text_without_a_slash_splits_exactly_as_before():
    f = _font()
    # the same brute force over spaces, ranked by width — the slash term is
    # constant across every candidate here and cannot move the answer
    assert R._balanced_split(f, "מסיבה גדולה מאוד בבית", 2) == ["מסיבה גדולה", "מאוד בבית"]
    assert R._balanced_split(f, "one two three four", 2) == ["one two", "three four"]


def test_too_few_pieces_for_the_lines_asked_for():
    assert R._balanced_split(_font(), "מסיבה", 2) is None
    # …but a slash MAKES a second piece, so this one can wrap where it could not
    assert R._balanced_split(_font(), "בלגן/mess", 2) == ["בלגן/", "mess"]


def test_one_line_is_the_text_itself():
    assert R._balanced_split(_font(), "צער גידול בנות/Full house", 1) == \
        ["צער גידול בנות/Full house"]


def test_the_leading_numeral_rule_still_wins():
    """It ranks ahead of the slash term, as it always ranked ahead of width."""
    f = _font()
    lines = R._balanced_split(f, "40 שנה יחד/Together", 2)
    assert not R._strands_a_leading_numeral(lines), lines
