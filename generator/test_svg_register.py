#!/usr/bin/env python3
"""Tests for generator/svg_register.py — putting a mis-exported plate back in register.

Four of the owner's decks ship a ``clean/9.svg`` Canva exported from a different
layout pass than its ``filled/9.svg`` twin: viewBox 224.25x311.999995 against
223.92x312, with the artwork inside scaled to match. ``filled - clean`` was then
the design ghosted against itself rather than the text, and מרקאנה's front 9 —
the one card in the deck whose title sits at the FOOT — measured nothing and got
handed its siblings' box at the top of the card.

These tests pin the recovery: the similarity between the two plates is derived
from the shapes they share, a pair that already agrees is left alone, and a pair
that shares nothing is refused rather than warped into agreement.

Run: python3 generator/test_svg_register.py   (or via pytest)
"""
import os

import svg_register as S

HERE = os.path.dirname(os.path.abspath(__file__))

# The real artifact, to the digit: the clean plate's viewBox, the filled plate's
# viewBox, and the scale between the artwork inside them.
CLEAN_VB = [0.0, 0.0, 224.25, 311.999995]
FILLED_VB = [0.0, 0.0, 223.92, 312.0]
SCALE = 1.002384
SHIFT = (0.0, -0.4646)

# Four boxes with four DIFFERENT aspect ratios, so each is findable in the other
# plate by point count and shape alone. Sized across the card, because a box a
# quarter of the card wide pins a 0.24% scale far better than a speck does.
ARTWORK = [(6.0, 8.0, 210.0, 300.0), (20.0, 30.0, 120.0, 80.0),
           (140.0, 40.0, 200.0, 190.0), (30.0, 200.0, 90.0, 240.0)]


def _box(x0, y0, x1, y1):
    return (f'<path fill="#2340a0" d="M {x0} {y0} L {x1} {y0} L {x1} {y1} '
            f'L {x0} {y1} Z"/>')


def _plate(vb, shapes, extra=""):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="299" height="416" '
            f'viewBox="{" ".join(str(v) for v in vb)}" '
            'preserveAspectRatio="xMidYMid meet">'
            '<rect width="100%" height="100%" fill="#eef3ff"/>'
            + "".join(_box(*s) for s in shapes) + extra + "</svg>")


def _unscaled(shapes, scale=SCALE, shift=SHIFT):
    """The same artwork as the clean plate draws it: filled = scale*clean + shift."""
    return [tuple((v - shift[i % 2]) / scale for i, v in enumerate(box))
            for box in shapes]


def _write(tmp_path, name, text):
    path = os.path.join(str(tmp_path), name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def test_a_matching_pair_needs_no_registration(tmp_path):
    same = _plate(FILLED_VB, ARTWORK)
    a = _write(tmp_path, "filled.svg", same)
    b = _write(tmp_path, "clean.svg", same)
    assert S.registration((299, 416, FILLED_VB), (299, 416, FILLED_VB), a, b) is None


def test_the_mis_exported_plate_recovers_the_scale_and_shift_canva_used(tmp_path):
    filled = _write(tmp_path, "filled.svg", _plate(FILLED_VB, ARTWORK))
    clean = _write(tmp_path, "clean.svg", _plate(CLEAN_VB, _unscaled(ARTWORK)))
    got = S.similarity(S.shapes(clean), S.shapes(filled))
    assert got, "the two plates draw the same four shapes — this is findable"
    scale, tx, ty = got
    assert abs(scale - SCALE) < 1e-5, scale
    assert abs(tx - SHIFT[0]) < 1e-3 and abs(ty - SHIFT[1]) < 1e-3, (tx, ty)


def test_registration_maps_the_clean_plates_pixels_onto_its_twins(tmp_path):
    filled = _write(tmp_path, "filled.svg", _plate(FILLED_VB, ARTWORK))
    clean = _write(tmp_path, "clean.svg", _plate(CLEAN_VB, _unscaled(ARTWORK)))
    reg = S.registration((299, 416, FILLED_VB), (299, 416, CLEAN_VB), filled, clean)
    assert reg, "a derivable correction must not be refused"
    a, dx, dy = reg
    # Check it where it matters: a corner of the artwork must land, in pixels, on
    # the same corner of the filled plate's artwork.
    fppu, fox, foy = S.viewport(FILLED_VB, 299, 416)
    cppu, cox, coy = S.viewport(CLEAN_VB, 299, 416)
    for box, want in zip(_unscaled(ARTWORK), ARTWORK):
        px = cox + box[0] * cppu
        py = coy + box[1] * cppu
        assert abs(a * px + dx - (fox + want[0] * fppu)) < 0.02
        assert abs(a * py + dy - (foy + want[1] * fppu)) < 0.02


def test_two_plates_that_share_no_artwork_are_refused(tmp_path):
    other = [(1.0, 2.0, 3.0, 9.0), (11.0, 2.0, 33.0, 5.0), (4.0, 4.0, 90.0, 7.0)]
    filled = _write(tmp_path, "filled.svg", _plate(FILLED_VB, ARTWORK))
    clean = _write(tmp_path, "clean.svg", _plate(CLEAN_VB, other))
    assert S.registration((299, 416, FILLED_VB), (299, 416, CLEAN_VB),
                          filled, clean) is None, \
        "no shared shapes means no measurement — and a guess would print the " \
        "honoree's name in the wrong place"


def test_a_wildly_different_scale_is_refused_rather_than_applied(tmp_path):
    # Half-size artwork is not a rounding artifact, it is a different card. The
    # caller must fall through to "re-export this plate".
    filled = _write(tmp_path, "filled.svg", _plate(FILLED_VB, ARTWORK))
    clean = _write(tmp_path, "clean.svg", _plate(CLEAN_VB, _unscaled(ARTWORK, 2.0)))
    assert S.registration((299, 416, FILLED_VB), (299, 416, CLEAN_VB),
                          filled, clean) is None


def test_an_empty_pair_is_refused_not_registered(tmp_path):
    blank = _plate(FILLED_VB, [])
    a = _write(tmp_path, "filled.svg", blank)
    b = _write(tmp_path, "clean.svg", _plate(CLEAN_VB, []))
    assert S.registration((299, 416, FILLED_VB), (299, 416, CLEAN_VB), a, b) is None


def test_clip_paths_are_not_measured(tmp_path):
    """Clip geometry is rounded to the DRAWING's bounds, not the page's.

    On the affected plates the two clip rectangles differ by a unit in a way the
    artwork does not, so pairing them would drag the estimate off. They are not
    ink and must not be read.
    """
    clip = ('<defs><clipPath id="c"><path d="M 0 0 L 90 0 L 90 90 L 0 90 Z"/>'
            "</clipPath></defs>")
    a = _write(tmp_path, "filled.svg", _plate(FILLED_VB, ARTWORK, clip))
    text = _plate(CLEAN_VB, _unscaled(ARTWORK),
                  clip.replace("90 0 L 90 90 L 0 90", "70 0 L 70 70 L 0 70"))
    b = _write(tmp_path, "clean.svg", text)
    got = S.similarity(S.shapes(b), S.shapes(a))
    assert got and abs(got[0] - SCALE) < 1e-5, got


def test_wrap_nests_the_original_document_rather_than_editing_it(tmp_path):
    inner = _plate(CLEAN_VB, _unscaled(ARTWORK))
    out = S.wrap('<?xml version="1.0"?><!DOCTYPE svg PUBLIC "x" "y">' + inner,
                 (1.5, 2.0, -3.0), 299, 416)
    assert inner in out, "the plate itself must be handed to Chrome untouched"
    assert "<?xml" not in out, "a nested document may not carry a declaration"
    assert "<!DOCTYPE" not in out, "nor a doctype — Chrome would serve an error"
    assert 'viewBox="0 0 299 416"' in out, "the wrapper works in pixels"
    assert "matrix(1.500000000,0,0,1.500000000,2.000000,-3.000000)" in out


def test_transform_attributes_compose_in_svg_order():
    m = S.parse_transform("translate(10,20) scale(2)")
    assert m == [2.0, 0.0, 0.0, 2.0, 10.0, 20.0]
    # translate AFTER scale is scaled by it — the order the spec gives.
    m = S.parse_transform("scale(2) translate(10,20)")
    assert m == [2.0, 0.0, 0.0, 2.0, 20.0, 40.0]


def test_the_owners_real_football_boys_export_registers(tmp_path):
    """The actual pair, when this checkout carries it.

    Skipped rather than failed where the template is not on disk: the export
    lives in the owner's store, and the synthetic tests above already pin the
    arithmetic. When it IS here, this is the number that matters — the artwork
    scale Canva's two passes disagree by.
    """
    import config
    root = os.path.join(config.REPO, "resources", "canva", "templates",
                        "football-boys")
    clean = os.path.join(root, "clean", "9.svg")
    filled = os.path.join(root, "filled", "9.svg")
    if not (os.path.exists(clean) and os.path.exists(filled)):
        print("  (skip football-boys: the export is not in this checkout)")
        return
    got = S.similarity(S.shapes(clean), S.shapes(filled))
    assert got, "the two plates share the whole design — it must be findable"
    assert abs(got[0] - 1.002384) < 1e-5, got


if __name__ == "__main__":
    import tempfile
    import shutil
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        d = tempfile.mkdtemp(prefix="dugri-reg-")
        try:
            fn(d) if fn.__code__.co_argcount else fn()
        finally:
            shutil.rmtree(d, ignore_errors=True)
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
