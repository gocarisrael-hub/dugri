#!/usr/bin/env python3
"""THE PRINT FRAMES A PHOTO THE WAY THE PAGE FRAMED IT.

A pawn photo is framed twice: by site/js/pawn-frame.js on the buyer's collection
page, and by build.square_photo for the press. The arithmetic is mirrored
(tests/unit/pawn-view.test.js holds the two together). What was NOT mirrored was
the choice of which rule to apply:

  * the PAGE asks "am I showing the cutout or the original?" — it measures the
    silhouette for a cutout and takes the plain square for an original
    (site/collect.html, ``measureFrame(printSrc, printSrc !== src)``);
  * the PRINT used to ask the FILE — ``subject_box`` sniffed its alpha.

The two answer differently for one file in particular: an ORIGINAL that carries
alpha, which is what a buyer uploading an already-transparent PNG and then
ticking "keep my background" produces. The owner watched it print. Her dog, a
1280x1280 transparent PNG kept as the original: the page drew the whole square
and the printer framed it on the dog's silhouette — 24.6% of the circle
different, and her zoom of 1.5 multiplied it.

The deck is a promise about a picture she has already approved, so the print now
asks the page's question. The server is what knows the answer (it is the one
choosing which file to hand over) and says so with ``--photo-original``.

Run: python3 -m pytest generator/test_photo_original.py
"""
import os
import tempfile

import pytest
from PIL import Image

import build


# A transparent PNG whose subject is SMALL and off-centre — the shape that makes
# the two rules disagree. A subject that fills its canvas frames the same either
# way, which is why oasis printed fine on the same order the dog did not.
def _cutout(path, size=(400, 400), box=(150, 80, 250, 300)):
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            im.putpixel((x, y), (200, 160, 90, 255))
    im.save(path)
    return path


def _opaque(path, size=(400, 400)):
    Image.new("RGB", size, (30, 30, 30)).save(path)
    return path


def _side(path):
    """The window a squared photo was cut from, as a share of the source's."""
    with Image.open(path) as im:
        return im.size


# --- the framing fork -------------------------------------------------------

def test_an_original_is_framed_on_the_plain_square_even_when_it_has_alpha():
    # THE DOG. The page never measured this file's silhouette, so neither does
    # the print: the whole square, exactly as she approved it.
    with tempfile.TemporaryDirectory() as tmp:
        src = _cutout(os.path.join(tmp, "dog.png"))
        with Image.open(src) as im:
            assert build.subject_box(im.convert("RGBA")), "the fixture must HAVE a silhouette"
        as_original = build.square_photo(src, os.path.join(tmp, "o"), 0, cutout=False)
        as_cutout = build.square_photo(src, os.path.join(tmp, "c"), 0, cutout=True)
        # Both come back at the slot's own size, so the difference is not in the
        # file's dimensions — it is in WHICH part of the photo they carry.
        assert _side(as_original) == _side(as_cutout)
        a = Image.open(as_original).convert("RGBA")
        b = Image.open(as_cutout).convert("RGBA")
        differing = sum(
            1
            for y in range(0, a.height, 4)
            for x in range(0, a.width, 4)
            if (a.getpixel((x, y))[3] > 127) != (b.getpixel((x, y))[3] > 127)
        )
        assert differing > 0, "framing an original on its silhouette is the bug"


def test_a_cutout_is_still_framed_on_its_subject():
    # The normal path is untouched: cutout=True is the default, and it is what
    # every order that predates this passes.
    with tempfile.TemporaryDirectory() as tmp:
        src = _cutout(os.path.join(tmp, "a.png"))
        default = build.square_photo(src, os.path.join(tmp, "d"), 0)
        explicit = build.square_photo(src, os.path.join(tmp, "e"), 0, cutout=True)
        assert (
            Image.open(default).convert("RGBA").tobytes()
            == Image.open(explicit).convert("RGBA").tobytes()
        )


def test_an_opaque_original_is_unaffected_either_way():
    # With no alpha there was never a silhouette to sniff, so the two rules
    # always agreed here — which is why the JPEGs on that order printed right.
    with tempfile.TemporaryDirectory() as tmp:
        src = _opaque(os.path.join(tmp, "a.jpg"))
        as_original = build.square_photo(src, os.path.join(tmp, "o"), 0, cutout=False)
        as_cutout = build.square_photo(src, os.path.join(tmp, "c"), 0, cutout=True)
        assert (
            Image.open(as_original).convert("RGBA").tobytes()
            == Image.open(as_cutout).convert("RGBA").tobytes()
        )


def test_the_buyers_zoom_still_applies_to_an_original():
    # The view is applied ON TOP of whichever square the rule above picked — so
    # her 1.5 means the same thing on the page and on the card.
    with tempfile.TemporaryDirectory() as tmp:
        src = _cutout(os.path.join(tmp, "a.png"))
        plain = build.square_photo(src, os.path.join(tmp, "p"), 0, cutout=False)
        zoomed = build.square_photo(src, os.path.join(tmp, "z"), 0, cutout=False,
                                    view=(2.0, 0.0, 0.0))
        a = Image.open(plain).convert("RGBA")
        b = Image.open(zoomed).convert("RGBA")
        ink = lambda im: sum(  # noqa: E731
            1
            for y in range(0, im.height, 4)
            for x in range(0, im.width, 4)
            if im.getpixel((x, y))[3] > 127
        )
        assert ink(b) > ink(a), "zooming in must show MORE of the subject"


# --- resolve_photos pairs the flags with their photos -----------------------

def test_resolve_photos_gives_each_photo_its_own_flag():
    with tempfile.TemporaryDirectory() as tmp:
        a = _cutout(os.path.join(tmp, "a.png"))
        b = _cutout(os.path.join(tmp, "b.png"))
        out = build.resolve_photos("bachelorette", [a, b],
                                   workdir=os.path.join(tmp, "w"),
                                   cutouts=[False, True])
        first = Image.open(out[0]).convert("RGBA")
        second = Image.open(out[1]).convert("RGBA")
        assert first.tobytes() != second.tobytes(), "the same photo, framed two ways"


def test_a_missing_flag_means_a_cutout():
    # A short list, and an absent list, both mean what every deck meant before
    # an original could reach a slot.
    with tempfile.TemporaryDirectory() as tmp:
        a = _cutout(os.path.join(tmp, "a.png"))
        short = build.resolve_photos("bachelorette", [a],
                                     workdir=os.path.join(tmp, "s"), cutouts=[])
        none = build.resolve_photos("bachelorette", [a], workdir=os.path.join(tmp, "n"))
        assert (
            Image.open(short[0]).convert("RGBA").tobytes()
            == Image.open(none[0]).convert("RGBA").tobytes()
        )


def test_a_photo_that_vanished_takes_its_flag_with_it():
    # The same hazard the views have (#595): three positional lists that can
    # slide against each other put one face's framing on another's.
    with tempfile.TemporaryDirectory() as tmp:
        b = _cutout(os.path.join(tmp, "b.png"))
        out = build.resolve_photos("bachelorette",
                                   [os.path.join(tmp, "gone.png"), b],
                                   workdir=os.path.join(tmp, "w"),
                                   cutouts=[False, True])
        alone = build.resolve_photos("bachelorette", [b],
                                     workdir=os.path.join(tmp, "x"), cutouts=[True])
        assert (
            Image.open(out[0]).convert("RGBA").tobytes()
            == Image.open(alone[0]).convert("RGBA").tobytes()
        )


# --- the CLI seam -----------------------------------------------------------

def _parse(argv):
    import argparse
    ap = argparse.ArgumentParser()
    build.add_photo_args(ap, "a pawn photo")
    return ap.parse_args(argv)


def test_the_flag_belongs_to_the_photo_in_front_of_it():
    args = _parse(["--photo", "p1",
                   "--photo", "p2", "--photo-original",
                   "--photo", "p3"])
    assert build.photos(args) == ["p1", "p2", "p3"]
    assert build.photo_cutouts(args) == [True, False, True]


def test_the_flag_and_the_frame_sit_on_the_same_photo_without_fighting():
    args = _parse(["--photo", "p1",
                   "--photo", "p2", "--photo-original", "--photo-frame=1.5,0,0",
                   "--photo", "p3", "--photo-frame=2,0,0"])
    assert build.photo_cutouts(args) == [True, False, True]
    assert build.photo_views(args) == [None, (1.5, 0.0, 0.0), (2.0, 0.0, 0.0)]


def test_every_photo_gets_an_entry():
    args = _parse(["--photo", "p1", "--photo", "p2"])
    assert build.photo_cutouts(args) == [True, True]
    assert build.photo_cutouts(_parse([])) == []


def test_a_flag_with_no_photo_in_front_of_it_is_refused():
    with pytest.raises(SystemExit):
        _parse(["--photo-original"])
    with pytest.raises(SystemExit):
        _parse(["--photo", "p1", "--photo-original", "--photo-original"])


def test_one_parser_can_parse_twice():
    import argparse
    ap = argparse.ArgumentParser()
    build.add_photo_args(ap, "a pawn photo")
    first = ap.parse_args(["--photo", "p1", "--photo-original"])
    second = ap.parse_args(["--photo", "q1"])
    assert build.photo_cutouts(first) == [False]
    assert build.photo_cutouts(second) == [True]
