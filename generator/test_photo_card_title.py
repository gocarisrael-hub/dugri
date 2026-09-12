#!/usr/bin/env python3
"""THE ORDER TITLE ON THE PAWN CARD.

Every card in the deck carries the honoree's title — the fronts at the top, the
backs in the theme's own back slot — except the pawn card, which carried none.
The owner asked for it, and there is exactly one place it can go: the band of
paper BELOW the pawn grid. Above the grid is the card's own copy ("החיילים שלכם"
and the cut-along-the-lines line); the four slots between them are byte-identical
on every template (docs/photo-card.md). The top band is spoken for; the bottom
band is not.

What these pin:

  * WHERE the band is — under the pawns, inside the frame, as wide as the grid;
  * that an unmeasurable card, or one that draws something down there, gets NO
    title rather than a title stamped over its artwork;
  * that a card asked for no title is byte-for-byte the card it always was;
  * that the deck and the single-card preview both put it there, through the same
    helper, so the picture on her collection page cannot drift from the print.

Run: python3 -m pytest generator/test_photo_card_title.py
"""
import os
import re

import card_frame
import card_paper
import config
import render_page as rp

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.join(HERE, "..", "resources", "canva", "templates", "_shared",
                      "photo-card", "photo.svg")

TITLE = "שירה כהן"


def _shared_card():
    return open(SHARED, encoding="utf-8").read()


# --- where the band is ------------------------------------------------------

def test_the_band_sits_under_the_pawns_and_inside_the_frame():
    svg = _shared_card()
    band = card_frame.title_band(svg)
    slots = card_frame.slots_box(svg)
    frame = card_frame.own_frame(svg)
    assert band, "the shipped pawn card has room for a title"
    # Below the lowest pawn...
    assert band["y0"] > slots[3]
    # ...and clear of the frame's own stroke, which is drawn on its centreline.
    assert band["y1"] < frame["y"] + frame["h"] - frame["stroke_width"] / 2


def test_the_band_is_as_wide_as_the_pawn_grid():
    # So the title reads as a caption under the pawns rather than a line
    # floating in the margin.
    svg = _shared_card()
    band = card_frame.title_band(svg)
    slots = card_frame.slots_box(svg)
    assert (band["x0"], band["x1"]) == (slots[0], slots[2])


def test_slots_box_measures_the_grid_without_the_halo():
    # content_box grows the slots by the sticker's reach because that reach
    # PRINTS; this answers a different question — how wide is the block of pawns
    # — and must not inherit the halo.
    svg = _shared_card()
    assert card_frame.slots_box(svg) == [39.93, 87.0, 183.93, 231.0]


# --- when there is no band --------------------------------------------------

def test_a_card_that_marks_no_frame_gets_no_title():
    # Same degradation as everything else in card_frame: an unmeasurable card is
    # left exactly as it shipped (see that module's docstring).
    svg = _shared_card().replace('class="card-frame"', 'class="not-the-frame"')
    assert card_frame.title_band(svg) is None
    assert rp.photo_card_title_markup("grapefruit", svg, [TITLE]) == ""


def test_a_card_with_no_slots_gets_no_title():
    svg = re.sub(r'<image\b[^>]*\bid="photo-slot-[1-9]"[^>]*/\s*>', "", _shared_card())
    assert card_frame.title_band(svg) is None


def test_artwork_under_the_pawns_wins_over_the_title():
    # A template that draws something in that band keeps it. A card missing its
    # title looks like last month's card; a title drawn through the artwork is a
    # card nobody can sell.
    svg = _shared_card().replace(
        "</svg>", '<path d="M 40 280 L 180 280 L 180 284 L 40 284 Z"/></svg>')
    assert card_frame.title_band(svg) is None
    assert rp.photo_card_title_markup("grapefruit", svg, [TITLE]) == ""


def test_no_title_lines_is_no_markup():
    for empty in (None, [], [""], ["   "]):
        assert rp.photo_card_title_markup("grapefruit", _shared_card(), empty) == ""


# --- the card itself --------------------------------------------------------

def test_the_pawn_card_carries_the_title():
    svg = rp.photo_card_svg("grapefruit", [], paper=None, frame=None,
                            title_lines=[TITLE])
    assert TITLE in svg
    # Set in the theme's own title colours, so it reads as one of the deck.
    assert config.theme("grapefruit")["title_style"]["fill"] in svg


def test_a_card_asked_for_no_title_is_what_it_always_was():
    # An order that predates this — and any template whose band is unusable —
    # must produce the card byte-for-byte.
    plain = rp.photo_card_svg("grapefruit", [], paper=None, frame=None)
    explicit = rp.photo_card_svg("grapefruit", [], paper=None, frame=None,
                                 title_lines=None)
    assert plain == explicit
    assert "<text" not in plain


def test_the_title_lands_inside_the_band_it_was_measured_for():
    # The markup is a baseline path plus centred text: the BASELINE may run wider
    # than the box (it is only a guide), but it must be centred on the band, or
    # the title prints off-centre under the pawns.
    svg = rp.photo_card_svg("grapefruit", [], paper=None, frame=None,
                            title_lines=[TITLE])
    band = card_frame.title_band(_shared_card())
    ys = [float(y) for y in re.findall(r'\bd="M [\d.]+ ([\d.]+)', svg)]
    baselines = [y for y in ys if band["y0"] <= y <= band["y1"]]
    assert baselines, f"no baseline inside {band['y0']:.1f}..{band['y1']:.1f}: {ys}"


# --- the preview draws the same card ----------------------------------------

def test_the_single_card_preview_carries_the_title_and_its_font():
    # The collection page says "this is exactly how the card will be printed".
    # The deck's stylesheet already carries the title faces for every other card;
    # a standalone card has no stylesheet, so this path has to bring its own or
    # the title renders in a fallback face the printer never uses.
    svg = rp.build_single_card_svg("grapefruit", config.photo_card_path("grapefruit"),
                                   [], [TITLE], kind="photo", photos=[])
    assert TITLE in svg
    assert "@font-face" in svg


def test_the_single_card_preview_with_no_title_injects_nothing():
    svg = rp.build_single_card_svg("grapefruit", config.photo_card_path("grapefruit"),
                                   [], [], kind="photo", photos=[])
    assert "@font-face" not in svg
    assert "<text" not in svg


def test_a_card_with_no_room_for_a_title_carries_no_title_FONTS_either():
    """A title ASKED FOR is not a title DRAWN, and the fonts follow the drawing.

    A template whose band is unmeasurable or too short prints without a title
    (``photo_card_title_markup`` answers ``""``) — and the standalone preview used
    to embed the base64 title faces anyway, because it decided from the ARGUMENT.
    That is hundreds of kilobytes of font in an SVG with no ``<text>`` in it, on
    every preview of that template.
    """
    real = card_frame.title_band
    card_frame.title_band = lambda svg_text: None   # no room, whatever the artwork
    try:
        svg = rp.build_single_card_svg("grapefruit", config.photo_card_path("grapefruit"),
                                       [], [TITLE], kind="photo", photos=[])
    finally:
        card_frame.title_band = real
    assert "<text" not in svg, "a card with no band must print no title"
    assert "@font-face" not in svg, "…and carry no fonts for the title it has not got"
    # The card itself is untouched — this is the card that always printed.
    assert svg == rp.photo_card_svg("grapefruit", [],
                                    paper=card_paper.front_paper("grapefruit"))


def test_photo_card_parts_reports_whether_the_title_was_drawn():
    # The one thing photo_card_svg cannot tell its caller, which is why the pair
    # exists. Given room, markup; given none, "" — and the svg still comes back.
    svg, title = rp.photo_card_parts("grapefruit", [], paper=None, frame=None,
                                     title_lines=[TITLE])
    assert title and title in svg
    real = card_frame.title_band
    card_frame.title_band = lambda svg_text: None
    try:
        svg, title = rp.photo_card_parts("grapefruit", [], paper=None, frame=None,
                                         title_lines=[TITLE])
    finally:
        card_frame.title_band = real
    assert title == ""
    assert svg == rp.photo_card_svg("grapefruit", [], paper=None, frame=None)
