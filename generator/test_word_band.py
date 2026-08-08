#!/usr/bin/env python3
"""Tests for the card's TEXT BOX: one left line, one rhythm, one floor.

The owner's rule, off a rendered card of אואזיס: *all text boxes are aligned to
the same invisible left line* — on every card of every template. Until now only a
template that STATED its column had a box at all. Everything else fell back to
the trim-safe area, 5% in from the paper edge, so a long entry on פריז ran to
within 5% of the card while the same card kept a 23% margin on the right — and,
having no box to wrap inside, it bought the room by shrinking the whole card
(15.25, where אואזיס set 21.25 by wrapping).

Two decisions are pinned here, and she made both off rendered cards:

  * the LINE is the mirror of the card's own numbered column, so the block is
    centred by the card's own measurements rather than by a house constant;
  * the card is laid on ONE RHYTHM anchored at the first calibrated line, so a
    wrapped entry is paid for in the empty paper at the foot of the card instead
    of in type size (פריז 15.3 -> 17.0, קליפורניה 13.4 -> 17.8).

Run: python3 -m pytest generator/test_word_band.py
"""
import json
import os

import pytest

import card_assets
import config
import render_page as rp

HERE = os.path.dirname(os.path.abspath(__file__))
CAFE = os.path.join(HERE, "word-fonts", "Cafe Regular.ttf")
# A long entry and three short ones — the shape of a real order, and the shape
# that shows what a text box is for.
WORDS = ["מסיבת רווקות בתל אביב", "אבא", "הופעה של להקת הבלוז", "ריקודים"]
# One phrase, long enough to wrap on every shipped card.
_LONG = "הבדיחה על הנסיעה לאילת"


def _cafe():
    return rp._word_metrics(CAFE)


def _themes():
    with open(os.path.join(HERE, "themes.json"), encoding="utf-8") as f:
        return json.load(f)


def _first_card(theme):
    """``(cell, slots, index, artwork)`` for one front of a shipped template."""
    cfg = config.theme(theme)
    recipe = config.recipe_or_empty(cfg)
    if config.is_single_card_recipe(recipe):
        front = config.fronts(cfg)[0]
        cell = (recipe.get("card") or {}).get("cell")
        return (cell, config.card_word_boxes(cfg, recipe, cell), front,
                card_assets.read_svg(config.card_path(theme, front)))
    card = next(c for c in recipe["cards"] if c and c.get("words"))
    return (card["cell"], card["words"], 1 + recipe["cards"].index(card),
            card_assets.read_svg(config.clean_path(theme, "fronts")))


def _layout(theme, words=None):
    cfg = config.theme(theme)
    cell, slots, idx, svg = _first_card(theme)
    face = rp._word_face(config.resolve_word_font(theme), rp.word_font_alt(theme))
    safe_bottom = cell[3] - (cell[3] - cell[1]) * rp._CARD_SAFE
    return slots, cell, rp._word_layouts(
        slots, words or WORDS, face, face.ref, cell=cell,
        word_size=cfg.get("word_size"), safe=rp._CARD_SAFE,
        room_bottom=rp.room_bottom(theme, idx, svg, cell, safe_bottom),
        bold_w=config.word_bold_w(cfg, rp._WORD_BOLD_W),
        obstacles=rp.card_obstacle_rects(theme, idx, svg, cell))


def _reach(theme, slots, cell, layouts):
    """The left-most ink any entry on the card reaches, in card units."""
    face = rp._word_face(config.resolve_word_font(theme), rp.word_font_alt(theme))
    right = rp._card_right_edge(slots, cell)
    advance = rp._marker_advance(face.primary, len(slots))
    out = []
    for wi, lay in enumerate(layouts):
        if lay is None:
            continue
        widest = max(rp._line_width_at(face, face.ref, wi + 1, ln, advance=advance)
                     for ln in lay.lines)
        out.append(right - widest * lay.size / face.ref)
    return min(out)


# --- the line ---------------------------------------------------------------


def test_every_shipped_card_keeps_its_words_off_the_left_edge():
    """The complaint, as a number: a long entry used to reach 5% of the card."""
    for theme in _themes():
        slots, cell, layouts = _layout(theme)
        frac = (_reach(theme, slots, cell, layouts) - cell[0]) / (cell[2] - cell[0])
        assert frac >= 0.20, f"{theme}: words reach {frac:.3f} of the card"


def test_the_line_is_where_the_numbers_say_it_is():
    """One rule for every template: as far from the left edge as the numbered
    column sits from the right. Nothing per-theme, nothing hand-set."""
    for theme in _themes():
        slots, cell, _ = _layout(theme)
        right = rp._card_right_edge(slots, cell)
        left = rp._card_left_edge(slots, cell)
        assert abs((left - cell[0]) - (cell[2] - right)) < 1e-9, theme


def test_all_four_entries_share_that_one_line():
    """Not four traced boxes with four different left edges — one line.

    On a card with nothing in the way, the proof is that the same phrase in all
    four slots wraps the SAME way: the traced boxes disagree by up to 45 units on
    a shipped card, and if any of that reached the fit the four entries would
    break at different words. Where an ICON stands beside an entry the split may
    differ — that entry has less room, which is the icon rule doing its job — so
    the card-wide claim is checked on the designs that have no icons, and the
    line itself is checked everywhere.
    """
    clear = [t for t in _themes()
             if not rp.card_obstacle_rects(t, *_obstacle_args(t))]
    assert clear, "some shipped design must be free of icons for this to mean anything"
    for theme in clear:
        _slots, _cell, layouts = _layout(theme, [_LONG] * 4)
        assert len({tuple(l.lines) for l in layouts if l}) == 1, (
            f"{theme}: one phrase, four splits — {[l.lines for l in layouts]}")
    for theme in _themes():
        slots, cell, _ = _layout(theme)
        # ...and the line never sits right of where the design's own words start.
        assert rp._card_left_edge(slots, cell) <= min(s["x0"] for s in slots) + 1e-9


def _obstacle_args(theme):
    """``(front, artwork, cell)`` for ``card_obstacle_rects`` on a theme's first card."""
    cell, _slots, idx, svg = _first_card(theme)
    return idx, svg, cell


# --- the rhythm -------------------------------------------------------------


def test_a_card_wraps_before_it_shrinks():
    """The owner's order, and it now holds on every template: an entry too wide
    for the box takes a second line; the card only sets smaller when it cannot."""
    for theme in _themes():
        _slots, _cell, layouts = _layout(theme)
        assert sum(len(l.lines) for l in layouts if l) > len(
            [l for l in layouts if l]), f"{theme} shrank instead of wrapping"


def test_every_gap_on_a_card_is_the_same_gap():
    """One rhythm: the gap inside a wrapped entry IS the gap between entries."""
    for theme in _themes():
        slots, _cell, layouts = _layout(theme)
        centres = []
        for lay, slot in zip(layouts, slots):
            if lay is None:
                continue
            pitch = lay.lead * lay.size
            first = lay.center - (len(lay.lines) - 1) * pitch / 2
            centres.extend(first + k * pitch for k in range(len(lay.lines)))
        gaps = [round(b - a, 6) for a, b in zip(centres, centres[1:])]
        assert len(set(gaps)) == 1, f"{theme}: {gaps}"


def test_the_rhythm_starts_at_the_line_the_design_calibrated():
    """The paper above the first line belongs to the title, so the block grows
    down into the foot of the card and never up into the name."""
    for theme in _themes():
        slots, _cell, layouts = _layout(theme)
        first = next(l for l in layouts if l)
        top = (slots[0]["y0"] + slots[0]["y1"]) / 2
        assert first.center >= top - 0.51, (
            f"{theme}: the block starts {top - first.center:.2f} above its first "
            f"calibrated line")


def test_wrapping_is_paid_for_in_paper_not_in_type():
    """The whole reason she chose this layout. Same card, same words: the sheet
    themes set BIGGER than they did while gaining a left line they never had."""
    slots, cell, layouts = _layout("bachelorette")
    assert layouts[0].size > 16.0, layouts[0].size


# --- the floor --------------------------------------------------------------


def test_no_card_of_any_template_prints_below_its_bottom_margin():
    """The orange line on every card of every design, not only on a card that
    happens to carry an icon — the v1 sheet used to skip it entirely."""
    for theme in _themes():
        cfg = config.theme(theme)
        cell, slots, idx, svg = _first_card(theme)
        face = rp._word_face(config.resolve_word_font(theme),
                             rp.word_font_alt(theme))
        safe_bottom = cell[3] - (cell[3] - cell[1]) * rp._CARD_SAFE
        floor = rp.room_bottom(theme, idx, svg, cell, safe_bottom)
        _s, _c, layouts = _layout(theme)
        last = [l for l in layouts if l][-1]
        pitch = last.lead * last.size
        bottom = (last.center + (len(last.lines) - 1) * pitch / 2
                  + rp._ink_reach(face, face.ref, last.lines[-1])[1] * last.size)
        assert bottom <= floor + 1e-6, (
            f"{theme}: ink reaches {bottom:.2f}, past the {floor:.2f} floor")


def test_the_block_stops_at_an_icon_under_the_words():
    """A card laid on one rhythm grows downward, and the paper it grows into is
    not always empty: פריז's shoes sit in exactly that space, and the last entry
    printed across them until the room took the icon as a ceiling."""
    theme = "bachelorette"
    cfg = config.theme(theme)
    cell, slots, idx, svg = _first_card(theme)
    icons = rp._grown(rp.card_obstacle_rects(theme, idx, svg, cell),
                      rp._ICON_CLEAR_MM * rp._PT_PER_MM)
    face = rp._word_face(config.resolve_word_font(theme), rp.word_font_alt(theme))
    _s, _c, layouts = _layout(theme)
    last = [l for l in layouts if l][-1]
    pitch = last.lead * last.size
    bottom = (last.center + (len(last.lines) - 1) * pitch / 2
              + rp._ink_reach(face, face.ref, last.lines[-1])[1] * last.size)
    below = [o for o in icons if o[1] > (slots[0]["y0"] + slots[0]["y1"]) / 2]
    assert below, "this card must have an icon under its words to mean anything"
    assert bottom <= min(o[1] for o in below) + 1e-6, (
        f"the words reach {bottom:.2f}, into an icon that starts at "
        f"{min(o[1] for o in below):.2f}")


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__]))


# --- the three the review caught --------------------------------------------


def test_a_wrapped_line_is_measured_where_the_grid_puts_it():
    """The regression: the icons were read at each entry's CALIBRATED centre and
    the grid then moved the lines, so a second line could land on artwork the
    first line had cleared — 49 of them across a sweep of the catalogue. The fit
    is a fixed point now: place, re-read the icons THERE, place again."""
    for theme in _themes():
        cell, slots, idx, svg = _first_card(theme)
        icons = rp.card_obstacle_rects(theme, idx, svg, cell)
        if not icons:
            continue
        face = rp._word_face(config.resolve_word_font(theme),
                             rp.word_font_alt(theme))
        _s, _c, layouts = _layout(theme, [_LONG] * 4)
        right = rp._card_right_edge(slots, cell)
        advance = rp._marker_advance(face.primary, len(slots))
        for wi, lay in enumerate(layouts):
            if lay is None:
                continue
            pitch = lay.lead * lay.size
            block = (len(lay.lines) - 1) * pitch / 2
            top = lay.center - block - rp._ink_reach(
                face, face.ref, lay.lines[0])[0] * lay.size
            bottom = lay.center + block + rp._ink_reach(
                face, face.ref, lay.lines[-1])[1] * lay.size
            width = max(rp._line_width_at(face, face.ref, wi + 1, ln,
                                          advance=advance)
                        for ln in lay.lines) * lay.size / face.ref
            for box in icons:
                # An icon under the numbered column itself is a calibration
                # matter and predates the grid (ברוקלין card 1 seats its last row
                # 1.6 units above one); what this pins is that WRAPPING never
                # walks a line onto artwork the entry had cleared.
                if len(lay.lines) == 1:
                    continue
                assert not (box[0] < right and box[2] > right - width
                            and box[1] < bottom and box[3] > top), (
                    f"{theme} entry {wi + 1}: {lay.lines} lands on {box}")


def test_a_short_word_is_never_broken_across_lines():
    """Her rule has a parenthesis: "(of course not if it's a 1 word word)". A
    card whose band an icon had crushed answered it with "א-ב-א" on eight decks
    that have never hyphenated anything."""
    for theme in _themes():
        for words in (["אבא", "אמא", "סבתא", "דוד"],
                      ["אבא", "מסיבת רווקות", "ריקודים", "הופעה של להקה"]):
            _s, _c, layouts = _layout(theme, words)
            for lay in layouts:
                if lay is None:
                    continue
                assert not any(rp._BREAK_HYPHEN in ln for ln in lay.lines), (
                    f"{theme}: {lay.lines}")


def test_a_card_with_one_entry_does_not_grow_into_the_title():
    """A single entry has no neighbour to stop it, so it grew symmetrically about
    its own centre and reached up into the honoree's name. It happens on any
    order whose word count leaves one word on the last card."""
    for theme in _themes():
        cell, slots, idx, svg = _first_card(theme)
        face = rp._word_face(config.resolve_word_font(theme),
                             rp.word_font_alt(theme))
        _s, _c, layouts = _layout(theme, ["אבא"])
        lay = next(l for l in layouts if l)
        top = lay.center - rp._ink_reach(face, face.ref, lay.lines[0])[0] * lay.size
        assert top >= slots[0]["y0"] - 1, (
            f"{theme}: one entry reaches {slots[0]['y0'] - top:.1f} above the "
            f"line the design drew for it")


def test_every_card_of_a_deck_starts_its_words_at_the_same_height():
    """The owner, looking at a deck laid out side by side: "should be the same in
    all the cards in template". The rows were detected card by card off eight
    different origin words, so קליפורניה's first row sat anywhere from 84.5 to
    107.8 units below the card's top — 8 mm of drift across one deck."""
    for theme in _themes():
        cell, slots, _idx, _svg = _first_card(theme)
        offsets, _colour = rp._deck_rows(theme)
        if not offsets:
            continue
        seated = rp.deck_slots(theme, slots, cell)
        for i, slot in enumerate(seated):
            centre = (slot["y0"] + slot["y1"]) / 2 - cell[1]
            assert abs(centre - offsets[i]) < 1e-6, (theme, i)


def test_every_row_of_a_deck_prints_in_one_colour():
    """ברוקלין's four rows carried SIX different values, one of them (#4f2d6c) a
    purple in a design whose words are blue — detector noise, printed."""
    for theme in _themes():
        cell, slots, _idx, _svg = _first_card(theme)
        seated = rp.deck_slots(theme, slots, cell)
        colours = {s.get("color") for s in seated if s.get("color")}
        assert len(colours) <= 1, f"{theme}: {colours}"


def test_the_title_is_a_keep_out_for_the_words():
    """The owner's words: "the title is also red area". מרקאנה's ninth front
    carries its title at the FOOT, and a block growing down into the free paper
    printed the last entry straight across the honoree's name.

    Driven on a synthetic card so it runs wherever the suite does — the shipped
    copy of that deck is a v1 sheet in this checkout, and the card the complaint
    is about lives in the owner's own store."""
    font, ref = rp._word_metrics(CAFE)
    cell = [0, 0, 224.0, 312.0]
    slots = [{"x0": 60, "y0": y0, "x1": 170, "y1": y1, "color": "#000"}
             for y0, y1 in ((100, 118), (140, 158), (180, 198), (220, 238))]
    title = (250.0, 300.0)                       # the name, printed at the foot
    words = ["בית קפה", "דודה", "נסיעה לאילת", "שמש"]
    layouts = rp._word_layouts(slots, words, font, ref, cell=cell,
                               safe=rp._CARD_SAFE, room_bottom=296.0,
                               title_box=title)
    last = [l for l in layouts if l][-1]
    pitch = last.lead * last.size
    bottom = (last.center + (len(last.lines) - 1) * pitch / 2
              + rp._ink_reach(font, ref, last.lines[-1])[1] * last.size)
    assert bottom <= title[0] + 1e-6, (
        f"the words reach {bottom:.1f}, into a title that starts at {title[0]}")
    # ...and without the title in play the same card is free to use that paper,
    # so the bound is the TITLE and not some other cap.
    free = rp._word_layouts(slots, words, font, ref, cell=cell,
                            safe=rp._CARD_SAFE, room_bottom=296.0)
    free_last = [l for l in free if l][-1]
    assert free_last.center > last.center - 1e-6
