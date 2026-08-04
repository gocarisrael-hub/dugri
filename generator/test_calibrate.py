#!/usr/bin/env python3
"""Tests for generator/calibrate.py — the auto-calibration measurements.

These exercise the ANALYSIS on synthetic images, so they need neither Chrome nor
any template art and run in well under a second. What they cannot cover is the
detection end to end (that needs a real filled/clean pair rendered by Chrome);
that side is validated by running the module against the shipped themes and
comparing to their hand-tuned themes.json values.

Run: python3 generator/test_calibrate.py   (or via pytest)
"""
from PIL import Image

import calibrate as C


def _ringed(size=100, ring=6, fill=(150, 220, 230), outline=(10, 60, 65), pad=20):
    """A filled square inside a ring — a title glyph in miniature.

    The shape is padded with un-inked background, because that is what real ink
    looks like: a mask with no background around it cannot be eroded at all (the
    filter replicates edge pixels), so a fixture without padding would test
    something that never occurs.
    """
    dim = size + 2 * pad
    img = Image.new("RGB", (dim, dim), (255, 255, 255))
    mask = Image.new("L", (dim, dim), 0)
    for y in range(size):
        for x in range(size):
            edge = x < ring or y < ring or x >= size - ring or y >= size - ring
            img.putpixel((x + pad, y + pad), outline if edge else fill)
            mask.putpixel((x + pad, y + pad), 255)
    return img, mask


# The ink's bounding box inside a default _ringed() image.
_RINGED_BOX = (20, 20, 120, 120)


def test_dominant_color_is_the_mode_not_the_mean():
    # Two flat paints: the mode returns one of them exactly, where a mean would
    # return a blend that appears nowhere in the artwork.
    img, mask = _ringed()
    got = C._dominant_color(img, mask, _RINGED_BOX)
    assert got == "#96dce6", f"expected the majority paint, got {got}"


def test_fill_and_outline_separates_a_ringed_title():
    img, mask = _ringed()
    fill, outline, ow = C._fill_and_outline(img, mask, _RINGED_BOX)
    assert fill == "#96dce6", f"fill should be the enclosed paint, got {fill}"
    assert outline == "#0a3c41", f"outline should be the bordering paint, got {outline}"
    assert ow and 0 < ow < 0.5, f"ring thickness should be a small fraction, got {ow}"


def test_fill_and_outline_reports_a_single_paint_title():
    # An un-ringed title is a real answer, not a failure: fill == outline, no ring.
    img, mask = _ringed(ring=0)
    fill, outline, ow = C._fill_and_outline(img, mask, _RINGED_BOX)
    assert fill == outline == "#96dce6"
    assert ow == 0.0, "a title with no ring has zero outline width"


def test_fill_and_outline_declines_on_ink_too_small_to_read():
    img, mask = _ringed(size=3, pad=1)
    assert C._fill_and_outline(img, mask, (1, 1, 4, 4)) == (None, None, None)


def test_plausible_rejects_a_box_that_swallowed_the_sheet():
    # The failure this guards: a filled/clean pair that differs across the WHOLE
    # sheet diffs to a "title" the size of the page. Better to report nothing
    # than to write a confident, wrong slot into themes.json.
    region = (0, 0, 1000, 1000)
    assert C._plausible((100, 100, 300, 300), region), "a real title box is plausible"
    assert not C._plausible((0, 0, 1000, 1000), region), "a page-sized box is not a title"
    assert not C._plausible((0, 0, 700, 700), region), "half the sheet is not a title"


def test_shrink_to_clean_border_leaves_a_clean_region_alone():
    # Nothing on the rim -> no shrink, so a title that genuinely runs close to the
    # card edge keeps its true extent.
    mask = Image.new("L", (200, 200), 0)
    for y in range(90, 110):
        for x in range(90, 110):
            mask.putpixel((x, y), 255)
    assert C._shrink_to_clean_border(mask, (0, 0, 200, 200)) == (0, 0, 200, 200)


def test_shrink_to_clean_border_pulls_in_off_a_dirty_rim():
    # Ink along the border (a page margin one export carries and the other does
    # not) must be shed before the bounding box is taken.
    mask = Image.new("L", (200, 200), 0)
    for i in range(200):
        for k in range(3):
            mask.putpixel((i, k), 255)
            mask.putpixel((i, 199 - k), 255)
            mask.putpixel((k, i), 255)
            mask.putpixel((199 - k, i), 255)
    for y in range(90, 110):
        for x in range(90, 110):
            mask.putpixel((x, y), 255)
    x0, y0, x1, y1 = C._shrink_to_clean_border(mask, (0, 0, 200, 200))
    assert x0 > 0 and y0 > 0 and x1 < 200 and y1 < 200, "the dirty rim must be shed"
    assert C._bbox(mask, (x0, y0, x1, y1)) == (90, 90, 110, 110), (
        "and what survives is the real title, not the margin")


def _lines(spans, w=300, h=90):
    """A mask of three horizontal bars at the given (x0, x1) spans."""
    mask = Image.new("L", (w, h), 0)
    for i, (a, b) in enumerate(spans):
        for y in range(i * 30 + 5, i * 30 + 25):
            for x in range(a, b):
                mask.putpixel((x, y), 255)
    return mask


def test_alignment_reads_a_shared_edge():
    left = _lines([(10, 200), (10, 260), (10, 150)])
    assert C._alignment(left, (0, 0, 300, 90)) == "left"
    right = _lines([(100, 290), (40, 290), (150, 290)])
    assert C._alignment(right, (0, 0, 300, 90)) == "right"
    centre = _lines([(100, 200), (70, 230), (120, 180)])
    assert C._alignment(centre, (0, 0, 300, 90)) == "center"


def test_alignment_declines_on_a_single_line():
    # One line carries no alignment signal at all — guessing from it would be
    # inventing an answer.
    one = _lines([(10, 200)])
    assert C._alignment(one, (0, 0, 300, 30)) is None


# ---- Reading the paints from the VECTOR source ----------------------------
# The render alone is not enough: on a small, heavily-ringed title the fill can
# be completely covered and never reach the pixels. The SVG still names it.

def _svg(tmpdir, name, fills):
    """Write a throwaway SVG whose paths carry the given fill attributes."""
    import os
    body = "".join('<path fill="%s" d="M0 0h1v1z"/>' % f for f in fills)
    path = os.path.join(tmpdir, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg">' + body + "</svg>")
    return path


def test_candidate_paints_finds_what_the_text_added():
    import tempfile
    d = tempfile.mkdtemp()
    # The clean sheet already uses #000000 for background art, so a plain set
    # difference would miss the title's black ring. The COUNT is what rises.
    clean = _svg(d, "clean.svg", ["#000000"] * 5 + ["#ff7aa9"] * 2)
    filled = _svg(d, "filled.svg", ["#000000"] * 12 + ["#a4e9ff"] * 7 + ["#ff7aa9"] * 2)
    got = dict(C.candidate_paints(filled, clean))
    assert got.get("#a4e9ff") == 7, "a colour only the text uses is fully counted"
    assert got.get("#000000") == 7, "a shared colour counts only what the text ADDED"
    assert "#ff7aa9" not in got, "a colour used equally in both sheets is not the text"


def test_candidate_paints_excludes_the_word_colours():
    import tempfile
    d = tempfile.mkdtemp()
    # The fronts sheet adds the words too; the recipe already knows their colour,
    # so excluding it leaves the title's own paints.
    clean = _svg(d, "c.svg", [])
    filled = _svg(d, "f.svg", ["#ff7aa9"] * 30 + ["#000000"] * 8 + ["#a4e9ff"] * 8)
    got = dict(C.candidate_paints(filled, clean, exclude={"#ff7aa9"}))
    assert "#ff7aa9" not in got, "the known word colour must be dropped"
    assert set(got) == {"#000000", "#a4e9ff"}


def test_candidate_paints_is_empty_when_colour_is_encoded_elsewhere():
    # Some exports use a style block or inherited group fills; then there is
    # nothing to read and the caller must fall back to the render.
    import os
    import tempfile
    d = tempfile.mkdtemp()
    p = os.path.join(d, "s.svg")
    with open(p, "w", encoding="utf-8") as f:
        f.write('<svg><style>.a{fill:#a4e9ff}</style><path class="a"/></svg>')
    assert C.candidate_paints(p, p) == []


def test_assign_paints_calls_the_enclosing_ring_the_outline():
    # Two KNOWN colours; the only question is which encloses which. The ring owns
    # the ink's outer boundary.
    img, mask = _ringed(fill=(164, 233, 255), outline=(0, 0, 0))
    fill, outline = C.assign_paints(
        [("#a4e9ff", 8), ("#000000", 8)], img, mask, _RINGED_BOX)
    assert fill == "#a4e9ff", f"the enclosed paint is the fill, got {fill}"
    assert outline == "#000000", f"the bordering paint is the outline, got {outline}"


def test_assign_paints_is_not_swayed_by_which_paint_is_commoner():
    # Regression: an early version compared per-paint edge RATIOS, so a mostly
    # covered fill (few pixels, noisy ratio) could outscore the ring that
    # encloses it — which is how 'birthday-girls' came out backwards. A very thin
    # fill must still be identified as the fill.
    img, mask = _ringed(ring=22, fill=(164, 233, 255), outline=(0, 0, 0))
    fill, outline = C.assign_paints(
        [("#a4e9ff", 8), ("#000000", 8)], img, mask, _RINGED_BOX)
    assert (fill, outline) == ("#a4e9ff", "#000000"), (
        "a barely-visible fill is still the fill, however few pixels it has")


def test_assign_paints_passes_a_single_paint_through():
    img, mask = _ringed(ring=0)
    assert C.assign_paints([("#96dce6", 8)], img, mask, _RINGED_BOX) == (
        "#96dce6", "#96dce6")
    assert C.assign_paints([], img, mask, _RINGED_BOX) == (None, None)


# --- the outline ring, measured by depth -------------------------------------
# outline_w was the one style knob nothing measured: it fell out of whichever
# colour path happened to run, and on a small front-card title that path finds a
# single colour cluster and reports "no ring". Three shipped decks then printed a
# pale fill with no ring against pale artwork — an unreadable title. The ring is
# a DEPTH question: it is the band within its own thickness of the ink's outer
# edge, so it is one threshold on distance-to-background.

_WHITE = (255, 255, 255)


def test_the_ring_is_measured_at_the_thickness_it_was_drawn():
    for ring in (4, 8, 14):
        img, mask = _ringed(ring=ring, fill=(164, 233, 255), outline=(0, 0, 0))
        fill, outline, width = C.ring_by_depth(
            img, mask, _RINGED_BOX, ["#a4e9ff", "#000000"], _WHITE, 100.0)
        assert (fill, outline) == ("#a4e9ff", "#000000"), (fill, outline)
        # em is 100 px here, so the fraction IS the ring in pixels over 100.
        assert abs(width - ring / 100.0) <= 0.02, (ring, width)


def test_the_depth_pass_decides_which_paint_is_the_ring_whatever_the_order():
    img, mask = _ringed(ring=9, fill=(164, 233, 255), outline=(0, 0, 0))
    a = C.ring_by_depth(img, mask, _RINGED_BOX, ["#a4e9ff", "#000000"], _WHITE, 100.0)
    b = C.ring_by_depth(img, mask, _RINGED_BOX, ["#000000", "#a4e9ff"], _WHITE, 100.0)
    assert a == b, (a, b)
    assert a[0] == "#a4e9ff" and a[1] == "#000000"


def test_a_paint_that_does_not_survive_into_the_artwork_is_not_asserted():
    """THE unreadable-title bug. The vector names two paints and the front only
    ever draws the dark one; the old reading nominated the light one as the FILL,
    the ring measured zero, and the renderer painted the fill alone — on
    bachelorette in #ffc6d7, which is that card's own background to the byte.

    The honest answer when one paint is absent is the single visible colour with
    no ring: nothing can be said about what is underneath it."""
    img, mask = _ringed(ring=0, fill=(13, 62, 67), outline=(13, 62, 67))
    fill, outline, width = C.ring_by_depth(
        img, mask, _RINGED_BOX, ["#97d8e6", "#0d3e43"], _WHITE, 100.0)
    assert fill == "#0d3e43", f"the paint that is actually there must win: {fill}"
    assert outline == "#0d3e43"
    assert width == 0.0


def test_an_unringed_title_measures_as_having_no_ring():
    img, mask = _ringed(ring=0)
    assert C.ring_by_depth(img, mask, _RINGED_BOX, ["#96dce6"], _WHITE, 100.0) == (
        "#96dce6", "#96dce6", 0.0)


def test_the_ring_is_a_fraction_of_the_TYPE_SIZE_not_of_the_ink():
    """``outline_w`` is a fraction of the em in render_page.title_block, and a
    Hebrew face's ink runs anywhere from 0.46 to 1.13 of its em across the ten
    shipped faces — so expressing the ring against the ink would be wrong by up
    to a factor of two. Halving the em must double the fraction."""
    img, mask = _ringed(ring=8, fill=(164, 233, 255), outline=(0, 0, 0))
    wide = C.ring_by_depth(img, mask, _RINGED_BOX,
                           ["#a4e9ff", "#000000"], _WHITE, 100.0)[2]
    half = C.ring_by_depth(img, mask, _RINGED_BOX,
                           ["#a4e9ff", "#000000"], _WHITE, 50.0)[2]
    assert abs(half - 2 * wide) < 1e-9, (wide, half)


def _hollow(size=100, ring=8, pad=20):
    """A ringed glyph whose FILL never reached the ink mask.

    What a light fill inside a dark ring actually produces: the ring clears the
    diff threshold, the pale fill over pale artwork does not, and the mask comes
    back hollow. The image still carries the fill colour — it is only the mask
    that lost it.
    """
    dim = size + 2 * pad
    img = Image.new("RGB", (dim, dim), (255, 241, 222))
    mask = Image.new("L", (dim, dim), 0)
    for y in range(size):
        for x in range(size):
            edge = x < ring or y < ring or x >= size - ring or y >= size - ring
            img.putpixel((x + pad, y + pad), (0, 0, 0) if edge else (164, 233, 255))
            if edge:
                mask.putpixel((x + pad, y + pad), 255)
    return img, mask


def test_a_hole_inside_the_ink_is_ink():
    img, mask = _hollow()
    before = sum(1 for v in mask.crop(_RINGED_BOX).getdata() if v)
    after = sum(1 for v in C.solid_ink(mask.crop(_RINGED_BOX)).getdata() if v)
    assert after == 100 * 100, f"the enclosed fill was not recovered: {after}"
    assert before < after


def test_background_that_reaches_the_edge_is_not_filled_in():
    """Only an ENCLOSED pocket is ink. Background that the flood can reach from
    the border is background, however much of the crop it is."""
    mask = Image.new("L", (40, 40), 0)
    for y in range(10, 30):
        for x in range(10, 30):
            mask.putpixel((x, y), 255)
    got = C.solid_ink(mask)
    assert sum(1 for v in got.getdata() if v) == 400


def test_a_light_fill_inside_a_dark_ring_is_read_as_fill_and_ring():
    """The whole point: without hole-filling this measures as a solid dark title
    with no ring, which is how two shipped decks came to print one."""
    img, mask = _hollow(ring=8)
    fill, outline, width = C.ring_by_depth(
        img, mask, _RINGED_BOX, ["#a4e9ff", "#000000"], (255, 241, 222), 100.0)
    assert fill == "#a4e9ff", f"the enclosed paint is the fill, got {fill}"
    assert outline == "#000000"
    assert abs(width - 0.08) <= 0.02, width


# --- the drop shadow ---------------------------------------------------------
# The old test was "a thin low-density tail in the bottom 12% of the ink", which
# is not a shadow — it is a DESCENDER, and almost every title has one. Turned on
# for a design that has none it prints an offset second copy of the whole title.

def _shadowed(size=100, ring=8, pad=30, drop=0):
    """A ringed glyph, optionally with its own silhouette repeated below-right."""
    dim = size + 2 * pad
    img = Image.new("RGB", (dim, dim), (255, 255, 255))
    mask = Image.new("L", (dim, dim), 0)
    if drop:
        for y in range(size):
            for x in range(size):
                img.putpixel((x + pad + drop, y + pad + drop), (0, 0, 0))
                mask.putpixel((x + pad + drop, y + pad + drop), 255)
    for y in range(size):
        for x in range(size):
            edge = x < ring or y < ring or x >= size - ring or y >= size - ring
            img.putpixel((x + pad, y + pad), (0, 0, 0) if edge else (164, 233, 255))
            mask.putpixel((x + pad, y + pad), 255)
    return img, mask


def test_a_plain_ring_is_not_reported_as_a_shadow():
    img, mask = _shadowed(drop=0)
    got = C.detect_shadow(img, mask, (0, 0, 160, 160),
                          "#a4e9ff", "#000000", (255, 255, 255), 100.0)
    assert got is False, "a concentric ring is not a shadow"


def test_a_real_offset_copy_is_reported_as_a_shadow():
    img, mask = _shadowed(drop=10)
    got = C.detect_shadow(img, mask, (0, 0, 160, 160),
                          "#a4e9ff", "#000000", (255, 255, 255), 100.0)
    assert got is True


def test_a_single_paint_title_cannot_be_asked_about_its_shadow():
    """No ring means nothing to compare the fill against, so the answer is
    "unknown" — which must not be written down as "no shadow"."""
    img, mask = _ringed(ring=0)
    assert C.detect_shadow(img, mask, _RINGED_BOX, "#96dce6", "#96dce6",
                           (255, 255, 255), 100.0) is None


def test_too_little_ink_is_refused_rather_than_measured():
    img = Image.new("RGB", (12, 12), (255, 255, 255))
    mask = Image.new("L", (12, 12), 0)
    mask.putpixel((6, 6), 255)
    assert C.ring_by_depth(img, mask, (0, 0, 12, 12),
                           ["#a4e9ff", "#000000"], _WHITE, 40.0) == (None, None, None)


# --- the body band: measuring a row of type without knowing what it says ------

def test_the_body_band_is_the_bulk_of_the_ink_not_its_extremes():
    """A single tall spike — one letter's ascender — must not become the band."""
    mask = Image.new("L", (60, 40), 0)
    for y in range(20, 36):                    # the body every letter occupies
        for x in range(4, 56):
            mask.putpixel((x, y), 255)
    for y in range(4, 20):                     # one lamed, two pixels wide
        for x in range(10, 12):
            mask.putpixel((x, y), 255)
    band = C._band_height(mask)
    assert 15 <= band <= 18, f"the band followed the ascender: {band}"
    assert mask.getbbox()[3] - mask.getbbox()[1] == 32, "the bbox would say 32"


def test_the_body_band_is_sub_pixel():
    """A whole-row answer is a staircase with ~6% steps at the sizes these decks
    print, and a bisection against a staircase lands on the step EDGE — always
    under. Two shapes a pixel apart must not report the same band."""
    def band(depth):
        mask = Image.new("L", (60, 60), 0)
        for y in range(10, 10 + depth):
            for x in range(4, 56):
                mask.putpixel((x, y), 255)
        return C._band_height(mask)
    assert band(21) > band(20) > band(19)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
