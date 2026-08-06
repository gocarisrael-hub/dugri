#!/usr/bin/env python3
"""Tests for generator/card_frame.py — the pawn card is the shape of its deck.

The owner's words: "the card with the pawns should be exactly same size and
roundness as the rest of the cards in this template."

What these pin:

  * OUTER SIZE, the hard requirement, because these cards are printed and cut in
    a stack: every pawn card is drawn on the same viewBox as the deck's own
    cards, and nothing here may change that;
  * the corner radius is READ OFF THE ARTWORK, and read from the points the path
    passes THROUGH — a coordinate-pair parse reports grapefruit's 7.50 as 3.36,
    because a cubic's control point sits on the same horizontal as the corner;
  * the shipped radii genuinely DIFFER between templates, which is why the frame
    is applied per deck at composition time instead of being drawn into the one
    shared photo.svg that ten templates use;
  * grapefruit — the one pawn card authored BY HAND to match its deck — comes out
    byte-identical, i.e. the measurement agrees with a human's answer;
  * every failure leaves the card exactly as shipped: nothing to measure, nothing
    marked, or a frame that would be drawn THROUGH the pawns;
  * the pawn card is still a pawn card afterwards — four slots, white halo, and
    the copy #336 fixed.

Run: python3 -m pytest generator/test_card_frame.py
"""
import os
import re

import pytest

import card_assets
import card_frame
import config
import deck_html
import render_page as rp

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
GENERIC = os.path.join(REPO, "resources", "canva", "templates", "_shared",
                       "photo-card", "photo.svg")
GRAPEFRUIT = os.path.join(REPO, "resources", "canva", "templates", "grapefruit",
                          "clean", "photo.svg")

CARD = [0.0, 0.0, 223.92, 312.0]
VIEWBOX = "0 0 223.92 312"


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _card(body, view_box=VIEWBOX):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s">%s</svg>'
            % (view_box, body))


@pytest.fixture(autouse=True)
def _clear_cache():
    card_frame._cache.clear()
    yield
    card_frame._cache.clear()


# --------------------------------------------------------------------------
# the hard requirement: outer size
# --------------------------------------------------------------------------

def test_every_pawn_card_is_the_same_size_as_the_deck_it_ships_with():
    """These are printed and cut in a stack. A pawn card of another size is a
    mismatched card, whatever it looks like."""
    front = card_assets.read_svg(config.card_path("grapefruit", 2))
    deck_vb = deck_html.view_box(front)
    for path in (GENERIC, GRAPEFRUIT):
        assert deck_html.view_box(_read(path)) == deck_vb, path


def test_composing_a_pawn_card_never_changes_its_outer_size():
    for theme in ("grapefruit", "bachelorette"):
        svg = rp.photo_card_svg(theme, [])
        assert deck_html.view_box(svg) == [0.0, 0.0, 223.92, 312.0], theme


# --------------------------------------------------------------------------
# reading a card's shape off its artwork
# --------------------------------------------------------------------------

def test_a_stroked_rounded_rect_reports_its_box_radius_and_stroke():
    svg = _card('<rect x="10" y="12" width="200" height="288" rx="8" ry="8" '
                'fill="none" stroke="#ff7aa9" stroke-width="4"/>')
    f = card_frame.frame(svg, CARD)
    assert (f["x"], f["y"], f["w"], f["h"]) == (10.0, 12.0, 200.0, 288.0)
    assert f["r"] == 8.0
    assert f["stroke"] == "#ff7aa9" and f["stroke_width"] == 4.0


def test_the_answer_is_the_stroke_CENTRELINE_not_its_interior():
    """``render_page.frame_box`` answers with the interior because it is deciding
    where words may go. The pawn card has to REDRAW this stroke, in its place."""
    svg = _card('<rect x="10" y="10" width="200" height="290" fill="none" '
                'stroke="#000" stroke-width="6"/>')
    f = card_frame.frame(svg, CARD)
    assert f["x"] == 10.0 and f["w"] == 200.0
    assert rp.frame_box(svg, CARD)[0] > f["x"]     # the interior is inside it


def test_a_full_bleed_background_is_never_mistaken_for_a_frame():
    svg = _card('<rect x="0" y="0" width="223.92" height="312" fill="#ffc6d7"/>')
    assert card_frame.frame(svg, CARD) is None


def test_a_decoration_is_too_small_to_be_a_frame():
    svg = _card('<rect x="80" y="120" width="60" height="60" fill="none" '
                'stroke="#000"/>')
    assert card_frame.frame(svg, CARD) is None


def test_a_frame_drawn_at_the_trim_still_counts():
    """Six of the eight shipped designs draw theirs flush with the card edge.
    ``frame_box`` requires an inset — right for word layout, and it would no-op
    this fix on exactly the templates that need it."""
    svg = _card('<rect x="-0.7" y="0.1" width="224.3" height="312.1" rx="31" '
                'fill="none" stroke="#e9062a" stroke-width="12"/>')
    f = card_frame.frame(svg, CARD)
    assert f and round(f["r"], 1) == 31.0


def test_the_innermost_of_two_borders_wins():
    svg = _card('<rect x="4" y="4" width="215" height="304" fill="none" stroke="#111"/>'
                '<rect x="20" y="20" width="183" height="272" fill="none" stroke="#222"/>')
    assert card_frame.frame(svg, CARD)["x"] == 20.0


def test_a_transform_is_resolved_rather_than_ignored():
    """Canva wraps its border in a matrix; ignoring it puts the frame at 0,0."""
    svg = _card('<g transform="matrix(0.75, 0, 0, 0.75, 24, 22)">'
                '<rect x="0" y="0" width="234" height="356" rx="10" fill="none" '
                'stroke="#711d20" stroke-width="2"/></g>')
    f = card_frame.frame(svg, CARD)
    assert round(f["x"], 2) == 24.0 and round(f["y"], 2) == 22.0
    assert round(f["w"], 2) == 175.5 and round(f["r"], 2) == 7.5
    assert round(f["stroke_width"], 2) == 1.5


# --------------------------------------------------------------------------
# the radius, which is the whole reason the path reader is not a number scan
# --------------------------------------------------------------------------

def test_control_points_are_not_read_as_geometry():
    """The bug this module exists to avoid.

    A rounded corner is a cubic, and its first control point sits on the SAME
    horizontal as the corner's on-curve point, 0.4477 x r along the top edge. A
    coordinate-pair reading of ``d`` finds that first and reports 0.4477 r.
    """
    d = ("M 10 0 L 190 0 C 195.52 0 200 4.48 200 10 L 200 290 "
         "C 200 295.52 195.52 300 190 300 L 10 300 "
         "C 4.48 300 0 295.52 0 290 L 0 10 C 0 4.48 4.48 0 10 0 Z")
    svg = _card('<path d="%s" fill="none" stroke="#000" stroke-width="2"/>' % d)
    assert round(card_frame.frame(svg, CARD)["r"], 2) == 10.0
    # …and the naive reading, for the record: it lands on the control point.
    naive = rp._path_points(d)
    top = [x for x, y in naive if abs(y) < 0.01]
    assert round(min(top), 2) == 4.48


def test_grapefruits_real_border_measures_the_radius_it_was_drawn_with():
    front = card_assets.read_svg(config.card_path("grapefruit", 2))
    f = card_frame.frame(front, CARD)
    assert round(f["r"], 2) == 7.50
    assert round(f["stroke_width"], 2) == 1.50
    assert f["stroke"] == "#711d20"


def test_sharp_corners_report_no_radius():
    svg = _card('<path d="M0 0 L 200 0 L 200 300 L 0 300 Z" fill="none" '
                'stroke="#111" stroke-width="1"/>')
    assert card_frame.frame(svg, CARD)["r"] == 0.0


def test_an_unreadable_path_is_skipped_rather_than_mis_measured():
    svg = _card('<path d="M0 0 L not-a-number" fill="none" stroke="#111"/>')
    assert card_frame.frame(svg, CARD) is None


# --------------------------------------------------------------------------
# which card to measure
# --------------------------------------------------------------------------

def test_a_v1_template_has_no_card_to_match():
    """A v1 (8-up sheet) template has no numbered cards, and the v2 deck is the
    only thing that prints a pawn card at all. Answering None keeps its pawn card
    exactly as shipped instead of inventing a shape for a deck it cannot build."""
    assert card_frame.front_frame("bachelorette") is None


def test_a_v2_template_measures_its_first_shipped_front():
    f = card_frame.front_frame("grapefruit")
    assert f and round(f["x"], 2) == 24.34 and round(f["r"], 2) == 7.50


def test_the_same_artwork_is_only_parsed_once():
    card_frame.front_frame("grapefruit")
    assert len(card_frame._cache) == 1
    card_frame.front_frame("grapefruit")
    assert len(card_frame._cache) == 1


def test_a_missing_front_reports_nothing_rather_than_raising(tmp_path):
    assert card_frame._frame_of_file(str(tmp_path / "nope.svg")) is None


def test_a_front_that_draws_no_frame_says_so(tmp_path, capsys):
    src = tmp_path / "front.svg"
    src.write_text(_card('<rect x="0" y="0" width="223.92" height="312" '
                         'fill="#fff"/>'), encoding="utf-8")
    assert card_frame._frame_of_file(str(src)) is None
    assert "draws no frame" in capsys.readouterr().err


# --------------------------------------------------------------------------
# reading, and rewriting, the pawn card's own frame
# --------------------------------------------------------------------------

def test_both_shipped_pawn_cards_mark_exactly_one_frame():
    for path in (GENERIC, GRAPEFRUIT):
        markup = _read(path)
        assert len(card_frame._FRAME_EL.findall(markup)) == 1, path
        assert card_frame.own_frame(markup) is not None, path


def test_the_generic_card_ships_the_shape_it_has_always_had():
    """Marking it changed nothing about how it draws — square, at grapefruit's
    box. That is the state the owner objected to, and the fix is the reframing
    below, not a different file."""
    f = card_frame.own_frame(_read(GENERIC))
    assert (f["x"], f["y"], f["w"], f["h"], f["r"]) == (24.34, 22.44, 175.18,
                                                        266.93, 0.0)


def test_reframing_moves_the_box_the_radius_and_the_stroke():
    target = {"x": 9.14, "y": 10.6, "w": 190.79, "h": 276.0, "r": 27.72,
              "stroke": "#ff7aa9", "stroke_width": 14.0}
    out = card_frame.reframe(_read(GENERIC), target)
    got = card_frame.own_frame(out)
    for key in ("x", "y", "w", "h", "r", "stroke_width"):
        assert abs(got[key] - target[key]) <= card_frame.FRAME_TOL, key
    assert got["stroke"] == "#ff7aa9"


def test_reframing_keeps_the_cards_own_fill():
    """Shape is this module's business; ``card_paper`` owns colour of paper."""
    target = {"x": 9.14, "y": 10.6, "w": 190.79, "h": 276.0, "r": 27.72,
              "stroke": "#ff7aa9", "stroke_width": 14.0}
    assert 'fill="none"' in card_frame._FRAME_EL.search(
        card_frame.reframe(_read(GENERIC), target)).group(0)
    assert 'fill="#fffdf1"' in card_frame._FRAME_EL.search(
        card_frame.reframe(_read(GRAPEFRUIT), target)).group(0)


def test_a_rule_anchored_to_the_frame_moves_with_it():
    target = {"x": 9.14, "y": 10.6, "w": 190.79, "h": 276.0, "r": 27.72,
              "stroke": "#ff7aa9", "stroke_width": 14.0}
    rule = card_frame._RULE_EL.search(
        card_frame.reframe(_read(GENERIC), target)).group(0)
    # re-spanned across the new frame, at its OWN height
    assert 'd="M9.14 78.44H199.93"' in rule


def test_nothing_to_measure_leaves_the_card_exactly_as_shipped():
    markup = _read(GENERIC)
    assert card_frame.reframe(markup, None) is markup


def test_a_card_that_marks_no_frame_is_left_alone():
    markup = _card('<rect x="0" y="0" width="223.92" height="312" fill="#fff"/>')
    assert card_frame.reframe(markup, {"x": 1, "y": 1, "w": 200, "h": 300,
                                       "r": 5, "stroke": "#000",
                                       "stroke_width": 1}) is markup


def test_a_frame_that_already_agrees_is_not_rewritten():
    markup = _read(GRAPEFRUIT)
    assert card_frame.reframe(markup, card_frame.front_frame("grapefruit")) is markup


def test_a_frame_that_would_cross_the_pawns_is_refused(capsys):
    """A border drawn THROUGH the pawn grid is worse than one that merely does
    not match, so this is the one case where mismatching is the right answer."""
    markup = _read(GENERIC)
    tight = {"x": 60, "y": 60, "w": 100, "h": 150, "r": 4, "stroke": "#000",
             "stroke_width": 1}
    assert card_frame.reframe(markup, tight) is markup
    assert "does not contain the pawn card's own content" in capsys.readouterr().err


def test_the_content_box_covers_the_slots_their_halo_and_the_copy():
    box = card_frame.content_box(_read(GENERIC))
    # slots span 39.93..183.93 and 87..231; the halo prints and so counts
    assert box[0] <= 39.93 - 2.4 and box[2] >= 183.93 + 2.4
    assert box[3] >= 231 + 2.4
    assert box[1] < 87        # the heading and caption are above the grid


# --------------------------------------------------------------------------
# end to end, through the one composition helper
# --------------------------------------------------------------------------

def test_the_hand_authored_pawn_card_comes_out_byte_identical():
    """grapefruit's pawn card was drawn BY HAND to match its deck. Measuring its
    deck and redrawing from that measurement must reproduce it exactly — which is
    the strongest evidence available that the measurement is right."""
    assert rp.photo_card_svg("grapefruit", [], paper=None) == _read(GRAPEFRUIT)


def test_a_pawn_card_is_still_a_pawn_card_after_reframing():
    """Everything #336 settled has to survive: four fillable slots, a white halo,
    the caption, and nothing below the pawn grid."""
    target = {"x": 9.14, "y": 10.6, "w": 190.79, "h": 276.0, "r": 27.72,
              "stroke": "#ff7aa9", "stroke_width": 14.0}
    out = card_frame.reframe(_read(GENERIC), target)
    assert rp.photo_slot_count(out) == 4
    assert 'flood-color="#ffffff"' in out
    assert 'data-copy="גזרו אותם לפי הקווים"' in out
    assert "דוגרי" not in re.sub(r"<title>.*?</title>", "", out, flags=re.S)


def test_an_explicit_frame_overrides_the_measurement():
    target = {"x": 9.14, "y": 10.6, "w": 190.79, "h": 276.0, "r": 27.72,
              "stroke": "#ff7aa9", "stroke_width": 14.0}
    out = rp.photo_card_svg("grapefruit", [], paper=None, frame=target)
    assert round(card_frame.own_frame(out)["r"], 2) == 27.72


def test_passing_no_frame_prints_the_card_exactly_as_shipped():
    assert rp.photo_card_svg("grapefruit", [], paper=None, frame=None) == _read(GRAPEFRUIT)


def test_the_deck_prints_the_pawn_card_in_the_decks_own_shape(tmp_path):
    """End to end through the deck assembler, and still without a browser."""
    import build
    import pack

    csvp = str(tmp_path / "deck.csv")
    pack.pack(["מילה%d" % i for i in range(40)], csvp, photo_card=True)
    doc, _vb = build.deck_document("grapefruit", csvp, ["בדיקה"],
                                   workdir=str(tmp_path))
    frame = card_frame.own_frame(doc._designs["photo"])
    front = card_frame.front_frame("grapefruit")
    for key in ("x", "y", "w", "h", "r", "stroke_width"):
        assert abs(frame[key] - front[key]) <= card_frame.FRAME_TOL, key
