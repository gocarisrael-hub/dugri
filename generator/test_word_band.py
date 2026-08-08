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


def test_a_broken_english_word_keeps_its_hyphen_on_the_right():
    """The owner, on an English deck: "the hyphen should be on the right".

    A card's lines are set in a right-to-left base, and a hyphen is a NEUTRAL —
    so at the end of "TELEV-" it took the line's base direction and jumped to the
    left edge, printing "-TELEV" above "ISION". The base a line is set in is the
    line's own now, and so is the way its runs are split.
    """
    latin, heb = "TELEV" + rp._BREAK_HYPHEN, "מסיבה"
    assert rp._line_is_latin(latin) and not rp._line_is_latin(heb)
    # 1. the markup states the LINE's own base, not the card's.
    svg = rp.word_lines(200, 100, 12, "#000", 4, [latin], CAFE)
    assert rp._LTR_EMBED in svg and rp._RTL_EMBED not in svg, svg
    assert rp._RTL_EMBED in rp.word_lines(200, 100, 12, "#000", 4, [heb], CAFE)
    # 2. ...and a two-face card splits the same way: the hyphen belongs to the
    #    English word beside it, not to a right-to-left run of its own.
    face = rp._word_face(CAFE, os.path.join(HERE, "word-fonts", "Fredoka-Medium.ttf"))
    runs = face.runs(latin)
    assert [t for _f, t in runs] == [latin], runs


# --- the English words, a little smaller ------------------------------------
# The owner, reading a deck whose word list mixes the two languages: "in סיישל,
# פריז, קליפורניה, ברוקלין, סנטוריני, טוקיו, מרקאנה, אואזיס, טריפה the size of
# the font of the words only the words in english needs to be little bit
# smaller". Nine designs of the ten — every one except דני.
#
# English is set in the SECOND word face, and a Latin face and a Hebrew one at
# one point size do not read as one size: the Latin x-height is the taller. So
# the fix is not a font change, it is a scale on the alt face's own runs — and
# the trap is that a card is MEASURED before it is PAINTED. Reserve the width of
# a full-size English word and print it at nine tenths and the line sits inside
# room nobody uses; reserve nine tenths and print full size and it crosses the
# trim. Both sides read one number, and these tests are what says so.

LATIN = os.path.join(HERE, "word-fonts", "Fredoka-Medium.ttf")
# One entry with both languages on one line — the shape the complaint is about.
_MIXED = "40 מתחת ל-BBQ"


def _runs_of(svg):
    """``[(family, size, text, x)]`` for every ``<text>`` the renderer emitted.

    Read back off the MARKUP rather than off the layout objects, because the
    markup is what Chrome is handed and therefore what actually prints. The bidi
    controls ``_embed`` wraps a run in are stripped: they order glyphs, they do
    not advance the pen.
    """
    import re
    out = []
    for m in re.finditer(r'<text x="([-\d.]+)"[^>]*?font-family="(HebWord|HebWordAlt)"'
                         r' font-size="([\d.]+)"[^>]*>(.*?)</text>', svg):
        x, fam, size, body = m.group(1), m.group(2), m.group(3), m.group(4)
        for ctrl in (rp._RTL_EMBED, rp._LTR_EMBED, rp._RTL_POP):
            body = body.replace(ctrl, "")
        body = (body.replace("&lt;", "<").replace("&gt;", ">")
                    .replace("&amp;", "&"))
        out.append((fam, float(size), body, float(x)))
    return out


def test_only_the_english_words_are_set_a_little_smaller():
    """The complaint itself, on one line that carries both languages.

    "only the words in english" is the whole of it: the Hebrew half of the very
    same entry keeps the size the design was calibrated at, so nothing about a
    Hebrew-only deck moves. If the scale were applied to the line rather than to
    the alt face's runs, this is the assertion that would catch it.
    """
    size = 12.0
    runs = _runs_of(rp.word_lines(200, 100, size, "#000", 1, [_MIXED], CAFE,
                                  alt_font_path=LATIN))
    word_runs = runs[2:]                      # the first two are digit and stop
    latin = [r for r in word_runs if r[0] == "HebWordAlt"]
    hebrew = [r for r in word_runs if r[0] == "HebWord"]
    assert latin and hebrew, ("this line must carry both languages to mean "
                              f"anything: {word_runs}")
    assert all("BBQ" in r[2] for r in latin), latin
    for r in latin:
        assert abs(r[1] - size * rp._WORD_ALT_SCALE) < 0.005, (
            f"the English was set at {r[1]}, not at "
            f"{size * rp._WORD_ALT_SCALE} — the owner asked for it a little "
            "smaller, and this is the run she was looking at")
    for r in hebrew:
        assert abs(r[1] - size) < 0.005, (
            f"the Hebrew beside it moved to {r[1]}; she asked for the English "
            "only, and the design's own size is the Hebrew's")


def test_the_fit_reserves_exactly_the_width_the_english_is_printed_at():
    """The invariant that costs paper or costs the card when it slips.

    The fit reserves ``_line_width_at`` — marker, gap, word — and the renderer
    then walks a pen through the runs. Here the two are compared THROUGH THE
    MARKUP: every emitted run is re-measured in the family and at the font-size
    it was actually emitted with, and the left edge that produces has to be the
    left edge the fit paid for. Nothing in this reads the renderer's own width
    list, so a scale applied on one side and forgotten on the other shows up as
    a real gap in user units rather than as a passing tautology.
    """
    size, x_right, num = 14.0, 200.0, 3
    face = rp._word_face(CAFE, LATIN)
    fonts = {"HebWord": face.primary, "HebWordAlt": face.alt}
    for line in (_MIXED, "BBQ", "Tel Aviv", "מסיבת רווקות"):
        svg = rp.word_lines(x_right, 100, size, "#000", num, [line], CAFE,
                            alt_font_path=LATIN)
        word_runs = _runs_of(svg)[2:]
        assert word_runs, line
        # Each run is anchored by its END, so its own advance — measured at the
        # size it was emitted at — puts its start.
        starts = [x - fonts[fam].getlength(txt) / face.ref * rsize
                  for fam, rsize, txt, x in word_runs]
        painted = x_right - min(starts)
        reserved = rp._line_width_at(face, face.ref, num, line) * size / face.ref
        # A hundredth of a user unit is the MARKUP's own resolution — every
        # coordinate and every font-size is emitted at two decimals — so the two
        # readings can never agree closer than that. On a 63 mm card a hundredth
        # of a unit is about four thousandths of a millimetre; the drift this
        # test exists to catch is a whole English word's worth of it.
        assert abs(painted - reserved) < 0.02, (
            f"{line!r}: the fit reserved {reserved:.4f} and the renderer "
            f"painted {painted:.4f} — a line measured wider than it prints "
            "wastes the card, and one measured narrower crosses the trim")


def test_with_no_second_face_the_measure_is_still_the_font_itself():
    """``Face``'s standing promise, re-asserted beside the scale that could have
    broken it: with no alt face uploaded there is nothing to scale, and
    ``length`` must be the primary's own call and the primary's own float — not
    a sum over a one-element list that could reassociate and move a last digit.

    Every shipped design but the two-face ones takes this branch, so it is the
    branch that must not move by a hundredth of a unit.
    """
    face = rp._word_face(CAFE)
    primary = rp._word_metrics(CAFE)[0]
    for text in ("מסיבה", _MIXED, "BBQ", "Tel Aviv", ""):
        assert face.length(text) == primary.getlength(text), text
        assert face.getbbox(text) == primary.getbbox(text), text
    assert face.scale(False) == 1.0 and face.scale(True) == 1.0
    # ...and the markup of a one-face line is byte for byte what it always was.
    assert (rp.word_lines(200, 100, 12, "#000", 1, [_MIXED], CAFE)
            == rp.word_lines(200, 100, 12, "#000", 1, [_MIXED], CAFE,
                             alt_font_path=None, alt_scale=0.5))


def test_a_design_can_pin_its_english_back_to_the_hebrew_size():
    """דני is the one design the owner did NOT list.

    So the house fraction has to be a default and not a law: a design pins
    itself back to parity with ``word_alt_scale: 1.0`` in themes.json, which is
    config the owner already edits, not a code change and not a deploy.
    """
    import json as _json
    import shutil

    import test_build_deck as tb

    def _store(scale):
        class _S(tb.Store):
            def __enter__(self):
                tmp = super().__enter__()
                root = os.environ["DATA_DIR"]
                shutil.copy(LATIN, os.path.join(root, "templates", "demo",
                                                "fonts", "Fredoka-Medium.ttf"))
                p = os.path.join(root, "templates", "themes.json")
                with open(p, encoding="utf-8") as fh:
                    data = _json.load(fh)
                data["demo"]["word_font_alt"] = "Fredoka-Medium.ttf"
                if scale is not None:
                    data["demo"]["word_alt_scale"] = scale
                with open(p, "w", encoding="utf-8") as fh:
                    _json.dump(data, fh)
                return tmp

        return _S()

    def _english_sizes(scale):
        with _store(scale):
            cfg = config.theme("demo")
            recipe = config.recipe_or_empty(cfg)
            overlay = rp.card_overlay("demo", recipe,
                                      [_MIXED, "BBQ", "מסיבה", "Tel Aviv"],
                                      ["PARTY לשירה"], front_index=2)
            runs = _runs_of(overlay)
            eng = [(r[1], r[2]) for r in runs if r[0] == "HebWordAlt"]
            heb = [r[1] for r in runs if r[0] == "HebWord"]
            assert eng, "this card must set some English to mean anything"
            return eng, heb

    # 1. the design that says nothing gets the house fraction...
    eng, heb = _english_sizes(None)
    card = max(heb)                        # the card's own word size
    for got, txt in eng:
        assert abs(got - card * rp._WORD_ALT_SCALE) < 0.01, (txt, got, card)
    # 2. ...and the design that pins itself back gets its English at the card's
    #    own size, exactly as it printed before any of this.
    eng, heb = _english_sizes(1.0)
    card = max(heb)
    for got, txt in eng:
        assert abs(got - card) < 0.01, (
            f"{txt!r} set at {got} on a design that asked for parity with the "
            f"card's {card}")


def test_the_theme_knob_falls_back_rather_than_failing_an_order():
    """A knob the owner mistypes must not be the reason a paid order does not
    render. Nor may a zero get through and set the English as nothing at all."""
    assert config.word_alt_scale({}, 0.9) == 0.9
    assert config.word_alt_scale({"word_alt_scale": 1.0}, 0.9) == 1.0
    assert config.word_alt_scale({"word_alt_scale": "0.85"}, 0.9) == 0.85
    for bad in ("", "a bit smaller", None, 0, -1, [0.8]):
        assert config.word_alt_scale({"word_alt_scale": bad}, 0.9) == 0.9, bad


def test_the_numbered_marker_is_not_touched_by_the_english_scale():
    """The digit is the card's OWN face and its own size, by design.

    ``_MARKER_SCALE`` happens to be 0.9 as well, so the proof is driven at a
    scale that is deliberately NOT the house one — otherwise the two numbers
    would agree by coincidence and the test would pass while reading the wrong
    one.
    """
    size = 20.0
    svg = rp.word_lines(200, 100, size, "#000", 4, ["BBQ"], CAFE,
                        alt_font_path=LATIN, alt_scale=0.5)
    runs = _runs_of(svg)
    digit, stop = runs[0], runs[1]
    assert (digit[2], stop[2]) == ("4", "."), runs
    for r in (digit, stop):
        assert r[0] == "HebWord", r
        assert abs(r[1] - size * rp._MARKER_SCALE) < 0.005, (
            f"the marker was set at {r[1]}, not at {size * rp._MARKER_SCALE}")
    assert abs(runs[2][1] - size * 0.5) < 0.005, runs[2]
    # ...and the digit COLUMN, which every word on the card starts after, is the
    # card's face too: the scale may not move it by a hundredth of a unit.
    one, scaled = rp._word_face(CAFE), rp._word_face(CAFE, LATIN, alt_scale=0.5)
    assert (rp._marker_advance(rp._primary(scaled), 4)
            == rp._marker_advance(one.primary, 4))


def test_the_house_fraction_can_be_overridden_from_the_environment():
    """The renders the owner is shown are made with the knob turned, so it has to
    be turnable without an edit: ``DUGRI_WORD_ALT_SCALE``, in the style of every
    other constant in this module.

    Checked in a fresh interpreter rather than by reloading the module here — a
    reload would hand the rest of the suite a second ``render_page`` with cold
    caches and a different ``Face`` class."""
    import subprocess
    import sys
    env = dict(os.environ, DUGRI_WORD_ALT_SCALE="0.75")
    out = subprocess.run(
        [sys.executable, "-c",
         "import render_page as rp; print(rp._WORD_ALT_SCALE); "
         "print(rp._word_face('word-fonts/Cafe Regular.ttf',"
         " 'word-fonts/Fredoka-Medium.ttf').alt_scale)"],
        cwd=HERE, env=env, capture_output=True, text=True, check=True)
    assert out.stdout.split() == ["0.75", "0.75"], out.stdout


def test_a_design_that_names_one_file_in_both_slots_keeps_its_hebrew_size():
    """Six of the ten designs fill BOTH word slots with the same file.

    אואזיס, פריז, טוקיו, מרקאנה, ברוקלין and טריפה each set their words in one
    face that draws Hebrew and Latin alike, and the owner filled the second slot
    with it anyway. So on those cards the two faces are literally one object, and
    anything that asked "is this run's font the alt one?" answered YES for every
    run — Hebrew included. Six of the nine designs she asked for smaller English
    would have had their Hebrew shrunk with it.

    The split knows which run is which; ``Face.runs_by_script`` carries the answer,
    and this is what says so.
    """
    size = 12.0
    face = rp._word_face(CAFE, CAFE)
    assert face.alt is face.primary, "this test only means anything if they are"
    runs = _runs_of(rp.word_lines(200, 100, size, "#000", 1, [_MIXED], CAFE,
                                  alt_font_path=CAFE))[2:]
    heb = [r for r in runs if "מתחת" in r[2]]
    eng = [r for r in runs if "BBQ" in r[2]]
    assert heb and eng, runs
    assert all(abs(r[1] - size) < 0.005 for r in heb), heb
    assert all(abs(r[1] - size * rp._WORD_ALT_SCALE) < 0.005 for r in eng), eng
    # ...and a Hebrew-only entry on such a design is the ordinary one-face line
    # again: the card's own family, and the RTL embedding every other design's
    # Hebrew is wrapped in. Without it a line that opens with digits is laid out
    # left-to-right first, which is a real card printing "40 מסיבת" backwards.
    heb_only = rp.word_lines(200, 100, size, "#000", 1, ["40 מסיבת רווקות"],
                             CAFE, alt_font_path=CAFE)
    assert heb_only == rp.word_lines(200, 100, size, "#000", 1,
                                     ["40 מסיבת רווקות"], CAFE)
    assert "HebWordAlt" not in heb_only
    assert rp._RTL_EMBED in heb_only


def test_no_design_scales_a_hebrew_run_however_its_two_slots_are_filled():
    """The guarantee swept over the catalogue rather than over one pair of files.

    "only the words in english": a Hebrew entry has to measure the same width on
    every design whether or not that design fills its second word slot — the
    same claim as "its width does not move when the alt face is taken away", and
    exact, not close, because it is the same font doing the same reading.

    Driven over BOTH wirings the real store uses, because the shipped copies of
    these designs in this checkout carry no second face at all: a design whose
    two slots hold DIFFERENT files (סיישל, קליפורניה, סנטוריני, דני) and one
    whose two slots hold the SAME file (the other six). The second is the one
    that broke: with one object in both slots there is no font to tell the runs
    apart, and every Hebrew word on those cards was about to be shrunk.
    """
    words = ("מסיבה", "אבא", "הופעה של להקת הבלוז", "40 מתחת")
    for theme in _themes():
        primary = config.resolve_word_font(theme)
        one = rp._word_face(primary)
        for alt, how in ((primary, "the same file in both slots"),
                         (LATIN, "a separate Latin face")):
            two = rp._word_face(primary, alt)
            for word in words:
                assert two.length(word) == one.length(word), (
                    f"{theme} with {how}: {word!r} measures {two.length(word)} "
                    f"with a second face and {one.length(word)} without it — "
                    "the scale reached a Hebrew run")
