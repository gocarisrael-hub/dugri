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


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
