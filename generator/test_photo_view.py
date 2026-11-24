#!/usr/bin/env python3
"""Tests for THE BUYER'S OWN FRAMING of a pawn photo.

``subject_window`` answers "where is the person?", which is the right question
right up until there are two of them in the shot, or the buyer simply wants a
face bigger than the rule would draw it. She can see the pawn on her collection
page now, so she can move it — a zoom and a pan, applied on top of whichever
square the automatic rules picked.

The numbers come off a slider in her browser (``site/js/pawn-frame.js``), travel
through the collection as ``pawn_view``, and arrive here as ``--photo-frame``.
``tests/unit/pawn-print.test.js`` holds the browser half against this transform;
this file holds the transform itself, and that ``square_photo`` actually applies
it.

Run: python3 -m pytest generator/test_photo_view.py
"""
import math
import os
import tempfile

import pytest
from PIL import Image

import build


# --- parsing ----------------------------------------------------------------

def test_parses_the_three_numbers():
    assert build.parse_photo_view("1.5,0.25,-0.1") == (1.5, 0.25, -0.1)


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
    zoom, dx, dy = build.parse_photo_view("99,9,-9")
    assert zoom == 2.5
    # The pan is a radius, 0.45 / zoom, and keeps its direction.
    assert math.sqrt(dx * dx + dy * dy) == pytest.approx(0.45 / 2.5)
    assert dx == pytest.approx(-dy) and dx > 0
    assert build.parse_photo_view("0.01,0,0") == (0.5, 0.0, 0.0)
    assert build.parse_photo_view("1,nan,0") is None


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
    assert build.apply_photo_view(CROP, (1.0, 0.0, -0.4)) == (0, -40, 100, 60)


def test_the_pan_is_measured_before_the_zoom_so_it_scales_with_it():
    # dx is a fraction of the window she is LOOKING at, which is what makes a
    # drag feel the same at every zoom.
    zoomed = build.apply_photo_view(CROP, (2.0, 0.2, 0.0))
    assert zoomed == (45, 25, 95, 75)


def test_no_view_is_the_identity():
    assert build.apply_photo_view(CROP, None) == CROP


def test_the_window_stays_square_even_when_the_crop_was_not_quite():
    # subject_window rounds each edge independently, so its answer can be a pixel
    # off square. The slot is square; a stretched face is not an acceptable
    # rounding artefact.
    out = build.apply_photo_view((0, 0, 100, 101), (1.0, 0.0, 0.0))
    assert out[2] - out[0] == out[3] - out[1]


# --- the pan can crop the subject, never lose it -----------------------------
#
# A real order printed five of eight pawns as EMPTY circles: page-scroll swipes
# that started on a photo were saved as pans of dy=-1 (one also dx=+0.99) and
# dx=-1/dy=+1, and at ±1 the window no longer overlaps the subject at all. The
# bound is now a radius of 0.45 / zoom — the subject's centre stays inside the
# printed disc — and it is applied HERE too, so the views already stored print.

def test_the_pan_is_a_radius_that_shrinks_with_the_zoom():
    for zoom in (0.5, 1.0, 1.7, 2.5):
        dx, dy = build.clamp_photo_pan(-1.0, 1.0, zoom)
        assert math.sqrt(dx * dx + dy * dy) == pytest.approx(0.45 / zoom)
        assert dx == pytest.approx(-dy)
    # Inside the circle nothing moves, and a clamped pan clamps to itself.
    assert build.clamp_photo_pan(0.2, -0.1, 1.0) == (0.2, -0.1)
    once = build.clamp_photo_pan(0.0, -1.0, 1.0)
    assert build.clamp_photo_pan(*once, 1.0) == once


def test_apply_photo_view_clamps_a_view_stored_before_the_bound():
    # 100px window, zoom 1: dy=-1 used to slide it a whole side up, off the
    # subject. Now its centre stops 45px up — on the rim of the printed disc.
    assert build.apply_photo_view(CROP, (1.0, 0.0, -1.0)) == (0, -45, 100, 55)


def _cutout_subject(path, size=400):
    """A transparent photo with one opaque figure (head + shoulders) in it, the
    way the wizard hands the generator a background-removed pawn."""
    from PIL import ImageDraw
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((150, 60, 250, 170), fill=(220, 170, 130, 255))   # head
    d.ellipse((110, 170, 290, 330), fill=(40, 60, 160, 255))    # shoulders
    im.save(path)
    return path


def _subject_in_disc(path):
    """How many opaque subject pixels the printed disc carries."""
    with Image.open(path) as im:
        a = im.convert("RGBA").getchannel("A")
        return sum(1 for v in a.getdata() if v > 128)


@pytest.mark.parametrize("view", [
    (1.0, -1.0, 1.0),      # the order's dx=-1, dy=+1
    (1.0, 0.0, -1.0),      # dy=-1
    (1.0, 0.99, -1.0),     # dx=+0.99, dy=-1
    (2.5, -1.0, 1.0),      # the same swipe, zoomed all the way in
    (0.5, 1.0, -1.0),      # …and all the way out
])
def test_a_stored_runaway_pan_still_prints_the_subject(view):
    with tempfile.TemporaryDirectory() as tmp:
        src = _cutout_subject(os.path.join(tmp, "p.png"))
        base = _subject_in_disc(build.square_photo(src, os.path.join(tmp, "w0"), 0))
        out = build.square_photo(src, os.path.join(tmp, "w1"), 0, view=view)
        # A real share of the face, not a stray pixel at the rim.
        assert _subject_in_disc(out) > 0.1 * base

        # …and the test can fail: at zoom 1 the same window WITHOUT the clamp
        # carries none of the subject, which is the card the order printed.
        if view[0] == 1.0:
            assert _unclamped_subject_in_disc(src, view) == 0


def _unclamped_subject_in_disc(src, view):
    """apply_photo_view's old, unclamped transform, through square_photo's disc."""
    from PIL import ImageChops
    zoom, dx, dy = view
    with Image.open(src) as im:
        im = im.convert("RGBA")
        box, alpha = build.subject_box(im)
        x0, y0, x1, y1 = build.subject_window(box, alpha=alpha)
        side = float(x1 - x0)
        new = side / zoom
        cx = (x0 + x1) / 2.0 + dx * side
        cy = (y0 + y1) / 2.0 + dy * side
        sq = im.crop((int(round(cx - new / 2)), int(round(cy - new / 2)),
                      int(round(cx + new / 2)), int(round(cy + new / 2)))).resize((200, 200))
        a = ImageChops.multiply(sq.getchannel("A"), build._disc_mask(200))
        return sum(1 for v in a.getdata() if v > 128)


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
    # sees a quarter of it white. Zoom in on the top-left and it should be mostly
    # white; zoom in on the bottom-right and none of it. "Mostly", not "all": the
    # pan is clamped so the frame's centre stays inside the disc, so a corner can
    # never fill it completely (see clamp_photo_pan).
    with tempfile.TemporaryDirectory() as tmp:
        src = _opaque_photo(os.path.join(tmp, "a.png"))
        base = _white_share(build.square_photo(src, os.path.join(tmp, "w0"), 0))
        into = _white_share(
            build.square_photo(src, os.path.join(tmp, "w1"), 0, view=(3.0, -0.3, -0.3)))
        away = _white_share(
            build.square_photo(src, os.path.join(tmp, "w2"), 0, view=(3.0, 0.3, 0.3)))
        assert 0.2 < base < 0.35
        assert into > 0.75
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
        assert _white_share(out[0]) > 0.75
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


# --- the CLI seam -----------------------------------------------------------
#
# Every test above hands `views` to `resolve_photos` already paired. Getting them
# paired is a different job, done by argparse, and it is where this feature was
# broken on live orders: both CLIs declared `--photo` and `--photo-frame` as
# independent `append` lists, the server emits a frame only for a photo the buyer
# actually moved, and argparse handed back a COMPACTED frame list. The frames
# then slid left onto the wrong faces and the tail printed with the automatic
# framing the buyer had overridden. Both halves were tested and neither test
# could see it: `tests/unit/pawn-view-routes.test.js` asserts the argv the server
# writes, this file asserted the transform, and nobody parsed the one with the
# other.


def _parse(argv):
    """``argv`` through the very declaration both CLIs use."""
    import argparse
    ap = argparse.ArgumentParser()
    build.add_photo_args(ap, "a pawn photo")
    return ap.parse_args(argv)


def _server_argv(pairs):
    """The argv `orderArgs` builds for ``[(photo, frame_or_None), ...]``.

    Mirrors server/index.js: every photo gets a `--photo`, and only a photo the
    buyer MOVED gets a `--photo-frame` after it.
    """
    argv = []
    for photo, frame in pairs:
        argv += ["--photo", photo]
        if frame:
            argv.append("--photo-frame=" + frame)
    return argv


def test_a_frame_belongs_to_the_photo_in_front_of_it():
    args = _parse(_server_argv([("p1", None), ("p2", "1.5,0,0"),
                                ("p3", None), ("p4", None)]))
    assert build.photos(args) == ["p1", "p2", "p3", "p4"]
    # THE BUG, in one assertion: this used to come back [(1.5, 0, 0)] — one entry
    # long — so p1 printed wearing p2's framing and p2 printed automatically.
    assert build.photo_views(args) == [None, (1.5, 0.0, 0.0), None, None]


def test_every_photo_gets_an_entry_even_when_nobody_framed_anything():
    args = _parse(_server_argv([("p1", None), ("p2", None)]))
    assert build.photo_views(args) == [None, None]


def test_frames_on_every_slot_stay_on_their_own_slot():
    args = _parse(_server_argv([("p1", "0.8,0,0"), ("p2", "1.2,0.1,0"),
                                ("p3", "2,0,-0.2"), ("p4", "1.5,0,0")]))
    assert build.photo_views(args) == [(0.8, 0.0, 0.0), (1.2, 0.1, 0.0),
                                       (2.0, 0.0, -0.2), (1.5, 0.0, 0.0)]


def test_a_frame_that_asks_for_the_default_still_holds_its_slot():
    # "1,0,0" parses to None (it IS the automatic framing), but it must not
    # collapse the list and shift everything after it.
    args = _parse(_server_argv([("p1", "1,0,0"), ("p2", "1.5,0,0")]))
    assert build.photo_views(args) == [None, (1.5, 0.0, 0.0)]


def test_a_frame_with_no_photo_in_front_of_it_is_refused():
    # Hand-typed argv only — the server never writes this. Refusing beats
    # silently framing somebody else's photo with it.
    with pytest.raises(SystemExit):
        _parse(["--photo-frame=1.5,0,0"])
    with pytest.raises(SystemExit):
        _parse(["--photo", "p1", "--photo-frame=1.5,0,0", "--photo-frame=2,0,0"])


def test_nothing_at_all_is_two_empty_lists():
    args = _parse([])
    assert build.photos(args) == []
    assert build.photo_views(args) == []


def test_one_parser_can_parse_twice():
    # The actions append, and argparse hands an action its default OBJECT: a
    # mutable default would make the second order in a process inherit the
    # first one's photos.
    import argparse
    ap = argparse.ArgumentParser()
    build.add_photo_args(ap, "a pawn photo")
    first = ap.parse_args(["--photo", "p1", "--photo-frame=1.5,0,0"])
    second = ap.parse_args(["--photo", "q1"])
    assert build.photos(first) == ["p1"]
    assert build.photos(second) == ["q1"]
    assert build.photo_views(second) == [None]


def test_both_clis_share_the_one_declaration():
    # The two used to declare these flags themselves, in words that agreed and
    # code that did not. A copy re-appearing here is the drift this whole
    # section exists to stop.
    here = os.path.dirname(os.path.abspath(build.__file__))
    for name in ("order_to_pdf.py", "preview.py"):
        src = open(os.path.join(here, name), encoding="utf-8").read()
        assert "add_photo_args" in src, name + " no longer shares the declaration"
        assert 'add_argument("--photo' not in src, name + " declares its own --photo"
