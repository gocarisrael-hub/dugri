#!/usr/bin/env python3
"""Tests for THE BUYER'S OWN FRAMING of a pawn photo.

``subject_window`` answers "where is the person?", which is the right question
right up until there are two of them in the shot, or the buyer simply wants a
face bigger than the rule would draw it. She can see the pawn on her collection
page now, so she can move it — a zoom and a pan, applied on top of whichever
square the automatic rules picked.

The numbers come off a slider in her browser (``site/js/pawn-frame.js``), travel
through the collection as ``pawn_view``, and arrive here as ``--photo-frame``.
``tests/unit/pawn-view.test.js`` holds the browser half against this transform;
this file holds the transform itself, and that ``square_photo`` actually applies
it.

Run: python3 -m pytest generator/test_photo_view.py
"""
import os
import tempfile

import pytest
from PIL import Image

import build


# --- parsing ----------------------------------------------------------------

def test_parses_the_three_numbers():
    assert build.parse_photo_view("1.5,0.25,-0.4") == (1.5, 0.25, -0.4)


def test_the_default_view_is_no_view():
    # "1,0,0" is exactly what the automatic framing already does, so it must
    # produce the same answer as passing nothing — the crop code then takes the
    # untouched path and an order nobody framed renders as it always did.
    assert build.parse_photo_view("1,0,0") is None
    assert build.parse_photo_view("") is None
    assert build.parse_photo_view(None) is None


def test_junk_leaves_the_automatic_framing_in_charge():
    for bad in ("", "nope", "1,2", "1,2,3,4", "a,b,c"):
        assert build.parse_photo_view(bad) is None


def test_clamps_to_the_range_the_slider_can_produce():
    # The store clamps too, and so does the page. Three layers because this one
    # is reached by a CLI and the other two are not: a hand-typed --photo-frame
    # must not be able to crop a 4-pixel window out of somebody's order.
    assert build.parse_photo_view("99,9,-9") == (2.5, 1.0, -1.0)
    assert build.parse_photo_view("0.01,0,0") == (0.5, 0.0, 0.0)


# --- the transform ----------------------------------------------------------

CROP = (0, 0, 100, 100)


def test_zooming_in_shrinks_the_window_about_its_centre():
    assert build.apply_photo_view(CROP, (2.0, 0.0, 0.0)) == (25, 25, 75, 75)


def test_zooming_out_grows_it_past_the_photo_on_purpose():
    # Cropping past the edge is intended: Pillow pads with zeros, which on RGBA
    # is transparent, so the sticker simply has empty space there.
    assert build.apply_photo_view(CROP, (0.5, 0.0, 0.0)) == (-50, -50, 150, 150)


def test_panning_slides_the_window_in_units_of_its_own_side():
    assert build.apply_photo_view(CROP, (1.0, 0.25, 0.0)) == (25, 0, 125, 100)
    assert build.apply_photo_view(CROP, (1.0, 0.0, -0.5)) == (0, -50, 100, 50)


def test_the_pan_is_measured_before_the_zoom_so_it_scales_with_it():
    # dx is a fraction of the window she is LOOKING at, which is what makes a
    # drag feel the same at every zoom.
    zoomed = build.apply_photo_view(CROP, (2.0, 0.25, 0.0))
    assert zoomed == (50, 25, 100, 75)


def test_no_view_is_the_identity():
    assert build.apply_photo_view(CROP, None) == CROP


def test_the_window_stays_square_even_when_the_crop_was_not_quite():
    # subject_window rounds each edge independently, so its answer can be a pixel
    # off square. The slot is square; a stretched face is not an acceptable
    # rounding artefact.
    out = build.apply_photo_view((0, 0, 100, 101), (1.0, 0.0, 0.0))
    assert out[2] - out[0] == out[3] - out[1]


# --- square_photo actually applies it ---------------------------------------

def _opaque_photo(path, size=(400, 400)):
    """A plain opaque photo with a distinctive quadrant, so a crop is visible."""
    im = Image.new("RGB", size, (10, 10, 10))
    # a white square in the top-left quarter
    im.paste((255, 255, 255), (0, 0, size[0] // 2, size[1] // 2))
    im.save(path)
    return path


def _white_share(path):
    """How much of the output disc is the white quadrant, ignoring transparency."""
    with Image.open(path) as im:
        im = im.convert("RGBA")
        px = im.load()
        lit = 0
        seen = 0
        for y in range(0, im.height, 4):
            for x in range(0, im.width, 4):
                r, g, b, a = px[x, y]
                if a < 128:
                    continue
                seen += 1
                if r > 200:
                    lit += 1
        return lit / max(1, seen)


def test_square_photo_without_a_view_is_unchanged():
    with tempfile.TemporaryDirectory() as tmp:
        src = _opaque_photo(os.path.join(tmp, "a.png"))
        plain = build.square_photo(src, os.path.join(tmp, "w1"), 0)
        same = build.square_photo(src, os.path.join(tmp, "w2"), 0, view=None)
        assert _white_share(plain) == pytest.approx(_white_share(same), abs=1e-9)


def test_panning_into_the_white_quadrant_fills_the_disc_with_it():
    # The photo is square, so the automatic crop is the whole frame and the disc
    # sees a quarter of it white. Zoom in on the top-left and it should be all
    # white; zoom in on the bottom-right and none of it.
    with tempfile.TemporaryDirectory() as tmp:
        src = _opaque_photo(os.path.join(tmp, "a.png"))
        base = _white_share(build.square_photo(src, os.path.join(tmp, "w0"), 0))
        into = _white_share(
            build.square_photo(src, os.path.join(tmp, "w1"), 0, view=(3.0, -0.3, -0.3)))
        away = _white_share(
            build.square_photo(src, os.path.join(tmp, "w2"), 0, view=(3.0, 0.3, 0.3)))
        assert 0.2 < base < 0.35
        assert into > 0.95
        assert away < 0.05


def test_resolve_photos_pairs_each_view_with_its_own_photo():
    with tempfile.TemporaryDirectory() as tmp:
        a = _opaque_photo(os.path.join(tmp, "a.png"))
        b = _opaque_photo(os.path.join(tmp, "b.png"), size=(401, 401))
        out = build.resolve_photos("bachelorette", [a, b],
                                   workdir=os.path.join(tmp, "w"),
                                   views=[(3.0, -0.3, -0.3), None])
        # The first is framed onto the white quadrant, the second is not — swap
        # the two and this is the assertion that fails.
        assert _white_share(out[0]) > 0.95
        assert 0.2 < _white_share(out[1]) < 0.35


def test_a_photo_that_vanished_takes_its_view_with_it():
    # The lists are positional, so dropping a missing file without dropping its
    # view would put one face's framing on the next one's photo.
    with tempfile.TemporaryDirectory() as tmp:
        b = _opaque_photo(os.path.join(tmp, "b.png"))
        out = build.resolve_photos("bachelorette",
                                   [os.path.join(tmp, "gone.png"), b],
                                   workdir=os.path.join(tmp, "w"),
                                   views=[(3.0, -0.3, -0.3), None])
        assert 0.2 < _white_share(out[0]) < 0.35


def test_a_short_views_list_is_fine():
    with tempfile.TemporaryDirectory() as tmp:
        a = _opaque_photo(os.path.join(tmp, "a.png"))
        out = build.resolve_photos("bachelorette", [a],
                                   workdir=os.path.join(tmp, "w"), views=[])
        assert 0.2 < _white_share(out[0]) < 0.35
