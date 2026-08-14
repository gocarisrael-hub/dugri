#!/usr/bin/env python3
"""The owner's icon rule, proved on the printed pixels.

    "the words are covering the icon … the best is to take the words that are
    covering the icon to a new line (of course not if it's a 1 word word), or
    make the font smaller (and keep all the rules like same font for all words
    in a card)"

Her rule is about ink on artwork, so the load-bearing test here asserts ink on
artwork: every template, every card, worst-case entries, rendered through the
production rasterizer, and NOT ONE PIXEL of word ink touching a drawn icon.

BOTH INKS ARE MEASURED, and the second one is the point. The obvious test — no
word ink inside an obstacle RECTANGLE — is the wrong test, and it fails on
artwork that is perfectly fine: כדורסל's player is drawn mid-jump, so the
top-left corner of his box is blank paper, and a word set beside him puts four
pixels in that corner while the nearest thing actually printed is a centimetre
away. The rectangles are what the FITTER uses, because layout runs 104 times an
order and may not open a browser; they are a conservative stand-in for the
drawing, and asserting against the stand-in tests the approximation rather than
the requirement. So the assertion reads the artwork itself: inside each obstacle
box, whatever the clean plate paints that is not the card's own background IS the
icon, and no word may touch it.

The word ink is isolated the way ``recipe_diff`` isolates the origin's: the
generated card minus the clean plate. The icons are drawn identically on both and
cancel exactly — the property that makes detection blind to them (see THE ICONS
in render_page) is what makes this a clean extraction of the words and nothing
else. Titles are left off the page so the mask is the WORDS' ink alone.

Run: python3 -m pytest generator/test_icon_keepout.py
"""
import collections
import json
import os
import re
import tempfile

import pytest
from PIL import Image, ImageChops, ImageFilter

import config
import recipe_diff
import render_page as rp

HERE = os.path.dirname(os.path.abspath(__file__))
THEMES = json.load(open(os.path.join(HERE, "themes.json"), encoding="utf-8"))


def _sheet_themes():
    """The v1 sheet themes: eight cards on one page, no declared words column."""
    return [t for t, e in sorted(THEMES.items())
            if not (e.get("card_slots") or {}).get("words")]


def _clean(theme):
    return os.path.join(config.theme_dir(theme), "clean", "fronts.svg")


# WORST CASE, not typical. A short word clears an icon by accident; these do not.
# Four kinds, because they fail differently: a long phrase that CAN wrap, a long
# phrase that must wrap twice, a single word with nowhere to break (the owner's
# "not if it's a 1 word word" — it can only shrink), and a Latin one, since half
# the shipped decks are English.
_WORST = ["ההופעה של הכלה במסיבת הרווקות",
          "אלכסנדרה מרגריטה בת חמישים ואחת",
          "אינטרנציונליזציה",
          "ALEXANDRINA POPPYLDE THE THIRD"]


def _page_ink(theme, workdir):
    """``(word mask, clean plate, ppu, ox, oy)`` for a sheet set with ``_WORST``."""
    clean = _clean(theme)
    recipe = config.recipe_or_empty(config.theme(theme))
    words = [list(_WORST) for _ in recipe["cards"]]
    svg = rp.build_page(theme, clean, words, [])          # no title: words only
    gen = os.path.join(workdir, f"{theme}-gen.svg")
    open(gen, "w", encoding="utf-8").write(svg)
    w, h, vb = recipe_diff.dims(clean)
    gp = os.path.join(workdir, f"{theme}-gen.png")
    cp = os.path.join(workdir, f"{theme}-clean.png")
    recipe_diff.render(gen, gp, w, h)
    recipe_diff.render(clean, cp, w, h)
    a = Image.open(gp).convert("RGB")
    b = Image.open(cp).convert("RGB")
    if a.size != b.size:
        b = b.resize(a.size)
    ppu, ox, oy = recipe_diff.viewport(vb, w, h)
    return recipe_diff.diff_mask(a, b), b, ppu, ox, oy


def _px(box, ppu, ox, oy, bounds):
    """A box in card units as a pixel rectangle, clipped to the image."""
    r = (int(box[0] * ppu + ox), int(box[1] * ppu + oy),
         int(box[2] * ppu + ox) + 1, int(box[3] * ppu + oy) + 1)
    return (max(r[0], 0), max(r[1], 0),
            min(r[2], bounds[0]), min(r[3], bounds[1]))


# How much of the printed card a word's ink must stay clear of an icon's, in
# PIXELS of the proof render (2.67 to the unit, so one pixel is 0.13 mm). Two
# inks that share an edge or a corner are printed on top of each other as far as
# anyone looking at the card is concerned, so touching is a failure; this asks
# for one pixel more than that, which is as tight as a rasterized comparison can
# honestly be read. The fit leaves ``_ICON_CLEAR_MM`` — four pixels here — so a
# deck that has to spend this margin has already gone wrong somewhere.
_TOUCH_PX = 1


def _icon_ink(clean_img, box, cell, ppu, ox, oy, thr=24):
    """The icon's OWN ink inside ``box``, as a mask over the whole page.

    An icon is what the clean plate paints that the card's paper does not: the
    background is the card's most common colour (these cards are flat behind
    their art — a field, a wash, a sheet of paper), and anything inside the
    obstacle box far enough from it is the drawing. ``thr`` is set well above
    the rasterizer's own dithering of a flat fill and well below any of the
    shipped inks, all of which are strong colours on a pale card.
    """
    r = _px(box, ppu, ox, oy, clean_img.size)
    out = Image.new("L", clean_img.size, 0)
    if r[2] <= r[0] or r[3] <= r[1]:
        return out
    cr = _px(cell, ppu, ox, oy, clean_img.size)
    paper = collections.Counter(clean_img.crop(cr).getdata()).most_common(1)[0][0]
    crop = clean_img.crop(r)
    flat = Image.new("RGB", crop.size, paper)
    ink = ImageChops.difference(crop, flat).convert("L").point(
        lambda v: 255 if v > thr else 0)
    out.paste(ink, (r[0], r[1]))
    return out


@pytest.mark.parametrize("theme", _sheet_themes())
def test_no_word_ink_lands_on_an_icon(theme):
    """THE requirement. Not a number about the fit — the two inks themselves."""
    recipe = config.recipe_or_empty(config.theme(theme))
    svg_text = open(_clean(theme), encoding="utf-8").read()
    checked = 0
    with tempfile.TemporaryDirectory(prefix="dugri-keepout-") as d:
        words, clean_img, ppu, ox, oy = _page_ink(theme, d)
        assert words.getbbox(), f"{theme}: the page rendered no words at all"
        for ci, card in enumerate(recipe["cards"]):
            if not card or not card.get("cell") or not card.get("words"):
                continue
            for box in rp.card_obstacles(svg_text, card["cell"]).rects:
                icon = _icon_ink(clean_img, box, card["cell"], ppu, ox, oy)
                if not icon.getbbox():
                    continue          # a box round nothing: no drawing to cover
                near = icon.filter(ImageFilter.MaxFilter(2 * _TOUCH_PX + 1))
                hit = ImageChops.multiply(words, near)
                bad = hit.getbbox()
                assert not bad, (
                    f"{theme} card {ci + 1}: word ink is printed on the icon at "
                    f"{[round(v, 1) for v in box]} — "
                    f"{sum(1 for v in hit.getdata() if v)} pixels, around "
                    f"{[round((bad[0] - ox) / ppu, 1), round((bad[1] - oy) / ppu, 1)]}")
                checked += 1
    # סנטוריני is the one deck with nothing to check, by the owner's own ruling,
    # and test_santorini_has_no_icons_at_all is what holds it to that.
    assert checked or theme == "anniversary", (
        f"{theme}: no icons were checked, so nothing was proved")


def test_no_icon_sits_under_a_word_column():
    """The one case the fitter cannot answer must not exist in the shipped decks.

    An icon reaching past an entry's right anchor cannot be dodged by narrowing
    the entry — the marker digit is pinned at that anchor. It CAN be dodged the
    other way, by clipping the entry's row to the icon's near edge, and כדורסל
    needs exactly that on all eight cards: its player stands in the bottom corner
    and reaches 24 units past the anchor, with only his top four units inside the
    last entry's row. What has no remedy at all is an icon straddling the entry's
    own centre, and this is the check that no shipped template has one.
    """
    for theme in _sheet_themes():
        text = open(_clean(theme), encoding="utf-8").read()
        for ci, card in enumerate(config.recipe_or_empty(
                config.theme(theme))["cards"]):
            if not card or not card.get("cell") or not card.get("words"):
                continue
            cell, slots = card["cell"], card["words"]
            icons = rp.card_obstacles(text, cell).rects
            for wi, slot in enumerate(slots):
                half = rp._slot_pitch(slots, wi) / 2
                mid = (slot["y0"] + slot["y1"]) / 2
                right = rp._line_right_edge(slot["x1"], cell)
                for depth, box in rp.unclearable_icons(
                        icons, (mid - half, mid + half), mid, right,
                        cell[2] - cell[0]):
                    raise AssertionError(
                        f"{theme} card {ci + 1} entry {wi + 1}: the icon at "
                        f"{[round(v, 1) for v in box]} reaches {depth:.1f} units "
                        f"left of the anchor at {right:.1f} AND straddles the "
                        f"entry's centre {mid:.1f} — no wrap, no shrink and no "
                        f"row clip can clear it")


def test_the_anchor_slop_still_sits_in_a_gap():
    """``_ANCHOR_SLOP`` divides two populations; they must stay far apart.

    Every icon box that crosses a words' anchor on the shipped artwork is either
    a corner of the box with nothing drawn in it (כדורסל card 1, 0.96% of the
    card) or the figure genuinely standing under the column (the same player on
    cards 2 and 7, 12.5% and 17.1%). The threshold is set at 5%, in the middle of
    a 13x gap. A re-export that lands one in the gap is a judgement this can no
    longer make for itself, and it should say so rather than guess.
    """
    slop, band = rp._ANCHOR_SLOP, (0.6, 1.8)   # how far either side must stay
    seen = []
    for theme in _sheet_themes():
        text = open(_clean(theme), encoding="utf-8").read()
        for ci, card in enumerate(config.recipe_or_empty(
                config.theme(theme))["cards"]):
            if not card or not card.get("cell") or not card.get("words"):
                continue
            cell, slots = card["cell"], card["words"]
            width = cell[2] - cell[0]
            for box in rp.card_obstacles(text, cell).rects:
                for wi, slot in enumerate(slots):
                    half = rp._slot_pitch(slots, wi) / 2
                    mid = (slot["y0"] + slot["y1"]) / 2
                    right = rp._line_right_edge(slot["x1"], cell)
                    if not (box[1] < mid + half and mid - half < box[3]
                            and box[2] >= right and box[0] < right):
                        continue
                    depth = (right - box[0]) / width
                    seen.append((depth, theme, ci + 1, wi + 1))
                    assert not band[0] * slop < depth < band[1] * slop, (
                        f"{theme} card {ci + 1} entry {wi + 1}: an icon crosses "
                        f"the anchor by {depth:.2%} of the card, too close to "
                        f"_ANCHOR_SLOP ({slop:.0%}) to call it either a box "
                        f"artefact or artwork under the words")
    assert seen, "no icon crosses an anchor at all — the threshold is untested"


def _card_size(theme, ci, card, svg_text, with_icons):
    """The one size a card sets with ``_WORST`` in it, icons honoured or not."""
    cfg = config.theme(theme)
    font, ref = rp._word_metrics(config.resolve_word_font(theme, None))
    cell = card["cell"]
    icons = room = None
    if with_icons:
        icons = rp.card_obstacles(svg_text, cell).rects
        if icons:
            safe = cell[3] - (cell[3] - cell[1]) * rp._CARD_SAFE
            room = rp.room_bottom(theme, ci + 1, svg_text, cell, safe)
    laid = rp._word_layouts(card["words"], _WORST, font, ref, cell=cell,
                            word_size=cfg.get("word_size"),
                            bold_w=config.word_bold_w(cfg, rp._WORD_BOLD_W),
                            obstacles=icons, room_bottom=room)
    return next((lay.size for lay in laid if lay), None)


# How much type a card may lose to its icons before the cure is worse than the
# disease, as a fraction of what the same card sets with the icons ignored.
#
# THIS IS THE GUARD THE FIRST VERSION NEEDED AND DID NOT HAVE. Reserving a
# bounding box whose corner grazed the words' anchor left כדורסל's card 1 with
# two tenths of a unit of row to set four entries in, and it obediently set them
# at 0.49 against the 11.72 it sets unobstructed — an unreadable grey smear. The
# ink test PASSED on it, and could only have passed: type that small cannot land
# on anything. A keep-out rule can always satisfy itself by destroying the words,
# so the words need a floor of their own.
#
# 0.28 sits between the two populations with room on both sides: the collapse it
# exists to catch was 0.04, and the largest legitimate loss on the shipped decks
# is טיול's card 4 at 0.2996, where a palm island really does sit beside the last
# entry — overlapping that row's centre, 33 units short of the numbered column —
# and a 25-character phrase really does have to wrap three ways and shrink to
# clear it. That card wants a calibration fix (move the row or trim the island),
# not a fitter that gives up on the icon.
#
# IT WAS 0.40 UNTIL THE CARD-WIDE GRID, and what moved was the DENOMINATOR, not
# that card. Its icon-honoured size is 4.35 both before and after — the same
# arithmetic against the same 33 units of clear paper beside the palm — while
# the same card with its icons ignored went 8.83 -> 14.53, because a card is now
# allowed to wrap instead of shrinking onto one line. So the ratio fell while
# every card either improved or stayed exactly where it was, which is why the
# floor moves rather than the layout. ``test_the_palm_card_is_no_worse_than_it_was``
# pins the absolute number so a future change cannot quietly make it worse.
_CRUSH_FLOOR = 0.28


@pytest.mark.parametrize("theme", _sheet_themes())
def test_no_card_is_crushed_by_its_icons(theme):
    """Dodging an icon may cost a card type; it may not cost it legibility."""
    svg_text = open(_clean(theme), encoding="utf-8").read()
    for ci, card in enumerate(config.recipe_or_empty(
            config.theme(theme))["cards"]):
        if not card or not card.get("cell") or not card.get("words"):
            continue
        free = _card_size(theme, ci, card, svg_text, with_icons=False)
        held = _card_size(theme, ci, card, svg_text, with_icons=True)
        if not free or not held:
            continue
        assert held >= _CRUSH_FLOOR * free, (
            f"{theme} card {ci + 1}: dodging its icons drops the card from "
            f"{free:.2f} to {held:.2f} ({held / free:.0%}) — the words are being "
            f"destroyed to keep them off the artwork")


# The worst card on the shipped decks, pinned in ABSOLUTE type size rather than
# as a ratio: טיול's card 4 sets its last entry in the 33 units of paper between
# a palm island and the numbered column. That is a genuinely hard card — the size
# is the same one it has set since the icons were first honoured — and this is
# here so a later change to the band, the grid or the icon scan cannot make it
# worse without saying so out loud.
_PALM_CARD_SIZE = 4.35


def test_the_palm_card_is_no_worse_than_it_was():
    theme = "trip comeback"
    svg_text = open(_clean(theme), encoding="utf-8").read()
    card = config.recipe_or_empty(config.theme(theme))["cards"][3]
    held = _card_size(theme, 3, card, svg_text, with_icons=True)
    assert held >= _PALM_CARD_SIZE - 0.01, (
        f"the palm card now sets at {held:.2f}, below the {_PALM_CARD_SIZE} it "
        f"has always set")


def test_every_shipped_template_is_scanned_without_a_blind_spot():
    """An unreadable element is a hole in the guarantee, so there must be none.

    ``card_obstacles`` reports rather than swallows them (a skipped obstacle
    silently becomes empty paper), and this is what keeps the report honest for
    the artwork we actually ship.
    """
    for theme in _sheet_themes():
        text = open(_clean(theme), encoding="utf-8").read()
        for ci, card in enumerate(config.recipe_or_empty(
                config.theme(theme))["cards"]):
            if not card or not card.get("cell"):
                continue
            found = rp.card_obstacles(text, card["cell"])
            assert not found.unreadable, (
                f"{theme} card {ci + 1}: {found.unreadable} element(s) could "
                f"not be placed — words are not guaranteed clear of them")


@pytest.mark.parametrize("theme", _sheet_themes())
def test_a_card_with_no_icons_renders_exactly_as_it_did(theme, monkeypatch):
    """No icons, no change — asserted on the MARKUP, byte for byte.

    The icon rule was scoped to the artwork that has icons: a card nothing
    reaches must keep ``max_lines`` of 1, no vertical bound and the size it
    always set, or eight shipped decks quietly rewrap. Comparing the page against
    the same page with the scan forced to find nothing is the tightest way to say
    that, because it holds every card of every deck to it at once — including all
    eight of סנטוריני's, which the owner ruled have no icons and which therefore
    must come out identical here.
    """
    clean = _clean(theme)
    recipe = config.recipe_or_empty(config.theme(theme))
    words = [list(_WORST) for _ in recipe["cards"]]
    with_icons = rp.build_page(theme, clean, words, [])
    monkeypatch.setattr(rp, "card_obstacle_rects", lambda *a, **k: [])
    without = rp.build_page(theme, clean, words, [])
    if theme == "anniversary":
        assert with_icons == without, "סנטוריני has no icons and must not move"
        return
    # Elsewhere only the cards the icons actually reach may differ, so the page
    # as a whole does — but every card the scan found nothing on is in both.
    svg_text = open(clean, encoding="utf-8").read()
    untouched = [ci for ci, c in enumerate(recipe["cards"])
                 if c and c.get("cell") and c.get("words")
                 and not rp.card_obstacles(svg_text, c["cell"]).rects]
    for ci in untouched:
        for entry in _card_entries(without, recipe["cards"][ci]["cell"]):
            assert entry in with_icons, (
                f"{theme} card {ci + 1} has no icons but its markup moved: "
                f"{entry[:120]}")


def _card_entries(page_svg, cell):
    """The ``<text>`` elements of ``page_svg`` whose x falls inside ``cell``."""
    out = []
    for el in re.findall(r"<text\b[^>]*>.*?</text>", page_svg, re.S):
        x = re.search(r'\sx="(-?[\d.]+)"', el)
        if x and cell[0] <= float(x.group(1)) <= cell[2]:
            out.append(el)
    return out


def test_the_frame_scan_did_not_inherit_the_obstacle_scan_s_appetite():
    """``frame_box`` and ``card_obstacles`` share a walk, not a question.

    The walk was widened for the obstacle scan — ``<image>`` joined the tags it
    reads, because a raster decoration is still a decoration — and ``frame_box``
    is calibrated against the artwork it already saw. A frame is an outline: no
    fill, a stroke. An ``<image>`` is neither, so it must stay invisible to the
    frame scan no matter what the walk hands it, and this pins that rather than
    trusting the predicate to keep saying so.

    (The full proof that the refactor moved nothing is a rendering one: 357
    readings of ``frame_box`` and ``room_bottom`` across every template and both
    plates, identical before and after. This is the part of it that fits in a
    test.)
    """
    card = [0, 0, 100, 100]
    raster = ('<svg><image x="10" y="10" width="30" height="30" '
              'xlink:href="data:image/png;base64,AAAA"/></svg>')
    assert rp.frame_box(raster, card) is None, (
        "a placed raster is not a printed border")
    # And it IS an obstacle — the same element, the other question. It carries
    # no fill and no stroke, so this also pins that a raster is not read as
    # invisible (see ``_paints``).
    # Compared by VALUE: an obstacle is a tuple that also remembers the pieces it
    # was merged from (rp.Obstacle), so a list/tuple identity check would be
    # testing the container rather than the geometry.
    assert [list(b) for b in rp.card_obstacles(raster, card).rects] == [[10, 10, 40, 40]], (
        "a placed raster is artwork the words must stay off")


def test_santorini_has_no_icons_at_all():
    """The owner's ruling: סנטוריני's art is background, so nothing is off limits.

    Asserted card by card because a template-level count would pass with seven
    empty cards and one wrong one.
    """
    text = open(_clean("anniversary"), encoding="utf-8").read()
    cards = config.recipe_or_empty(config.theme("anniversary"))["cards"]
    for ci, card in enumerate(cards):
        if not card or not card.get("cell"):
            continue
        found = rp.card_obstacles(text, card["cell"]).rects
        assert found == [], (
            f"anniversary card {ci + 1} reported {len(found)} icons on artwork "
            f"the owner ruled has none: {[[round(v, 1) for v in b] for b in found]}")


def test_maracana_keeps_its_panel_and_loses_only_its_badges():
    """The other ruling: the light-blue panel is text area, the badges are not.

    The panel covers the whole card, so "the panel is not an obstacle" is the
    same statement as "no obstacle covers the card" — and every icon found must
    be small enough to be an object rather than a field.
    """
    text = open(_clean("football-boys"), encoding="utf-8").read()
    cards = config.recipe_or_empty(config.theme("football-boys"))["cards"]
    total = 0
    for ci, card in enumerate(cards):
        if not card or not card.get("cell"):
            continue
        x0, y0, x1, y1 = card["cell"]
        w, h = x1 - x0, y1 - y0
        found = rp.card_obstacles(text, card["cell"]).rects
        assert found, f"football-boys card {ci + 1}: its badges were not found"
        for b in found:
            # Wide OR tall is fine — the bunting of hanging footballs on card 7
            # runs 0.94 of the card across and 0.18 down, and is still an object.
            # Wide AND tall is the panel, and the panel is text area.
            assert not ((b[2] - b[0]) >= 0.5 * w and (b[3] - b[1]) >= 0.5 * h), (
                f"football-boys card {ci + 1}: {[round(v, 1) for v in b]} spans "
                f"most of the card — the panel is text area, not an obstacle")
        total += len(found)
    assert total >= 8, f"only {total} badges found across eight cards"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))


# --- AN ICON IS NOT AS WIDE AT THE TOP AS AT THE BOTTOM -----------------------
#
# The owner, looking at her palm card with the keep-out drawn on it: "you can do
# better in the red areas, because the upper part of the icon is smaller than the
# lower part."
#
# She is right, and it was costing real paper. The palm is 145 separate shapes,
# merged into ONE rectangle so the icon counts as one thing — and that rectangle
# then claims the empty sky above the fronds. Measured on her card: 29% of the
# rectangle is painted, and the line beside it was pushed off 31 units of blank
# paper, which (one size per card) shrank all four entries from 18.7 to 11.6.

def test_a_merged_icon_remembers_the_pieces_it_was_merged_from():
    # Two boxes near enough to merge: the union is one obstacle, and it still
    # knows it is two — that is what makes a per-height answer possible.
    merged = rp._merge_boxes([[0, 0, 10, 10], [2, 12, 30, 20]], 4, keep_parts=True)
    assert len(merged) == 1
    assert list(merged[0]) == [0, 0, 30, 20]
    assert len(merged[0].parts) == 2


def test_the_reach_is_asked_at_the_height_of_the_line():
    # A narrow piece on top, a wide one below — a palm in miniature. A line up in
    # the fronds is stopped by the fronds; a line down in the sand is stopped by
    # the sand.
    icon = rp._merge_boxes([[0, 0, 10, 10], [0, 12, 30, 20]], 4, keep_parts=True)
    assert rp._obstacle_left(icon, (2, 8), right=100) == 10      # the narrow top
    assert rp._obstacle_left(icon, (14, 18), right=100) == 30    # the wide bottom
    # …and the merged rectangle would have said 30 for both.
    assert max(o[2] for o in icon) == 30


def test_an_icon_of_one_piece_behaves_exactly_as_before():
    # A real rectangle has one piece, and it IS the box — so nothing about a
    # plain icon changes.
    icon = rp._merge_boxes([[0, 0, 30, 20]], 4, keep_parts=True)
    assert rp._obstacle_left(icon, (2, 8), right=100) == 30
    assert rp._obstacle_left(icon, (14, 18), right=100) == 30


def test_the_clear_air_is_added_to_the_pieces_too():
    # Clear air the outer box has and the pieces do not is clear air the words
    # would never actually get.
    icon = rp._merge_boxes([[0, 0, 10, 10], [0, 12, 30, 20]], 4, keep_parts=True)
    grown = rp._grown(icon, 2)
    assert rp._obstacle_left(grown, (2, 8), right=100) == 12     # 10 + the air
    assert rp._obstacle_left(grown, (14, 18), right=100) == 32   # 30 + the air
