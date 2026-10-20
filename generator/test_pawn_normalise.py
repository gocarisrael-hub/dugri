#!/usr/bin/env python3
"""Tests for pawn_normalise: an uploaded fallback pawn is centred at upload.

The pawn is drawn into its slot by its CANVAS on the site and in print alike, so
where the ink sits on the canvas is where it prints. The owner's green and gold
pawns (2026-10-20) were cropped tight on the top and left with a fifth of the
canvas empty below, and printed low-left, too big, and cut by the disc. The
fixture below is that shape.

Run: python3 -m pytest generator/test_pawn_normalise.py
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw

import pawn_normalise as pn

HERE = os.path.dirname(os.path.abspath(__file__))


def _ink_box(im):
    return im.getchannel("A").point(lambda a: 255 if a > pn.ALPHA_INK else 0).getbbox()


def _sticker(w, h, box, colour=(40, 160, 90, 255)):
    """A transparent canvas with one solid ellipse of ink inside ``box``."""
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(im).ellipse(box, fill=colour)
    return im


def _centre(box, side):
    return ((box[0] + box[2]) / 2 / side, (box[1] + box[3]) / 2 / side)


def test_a_tight_top_left_crop_comes_back_centred_on_a_square():
    # The owner's green pawn: 909x861, ink flush to the top and left edges and
    # a fifth of the canvas empty below.
    src = _sticker(909, 861, (0, 0, 869, 694))
    out, reason = pn.normalise(src)
    assert reason == "centred"
    assert out.width == out.height
    box = _ink_box(out)
    cx, cy = _centre(box, out.width)
    assert abs(cx - 0.5) < 0.002 and abs(cy - 0.5) < 0.002, (cx, cy)
    long_side = max(box[2] - box[0], box[3] - box[1]) / out.width
    assert abs(long_side - pn.FILL) < 0.003, long_side


def test_the_ink_is_copied_not_resampled_at_normal_sizes():
    src = _sticker(909, 861, (0, 0, 869, 694))
    out, _ = pn.normalise(src)
    # Same ink, pixel for pixel: the alpha total is unchanged by a pure move.
    assert sum(out.getchannel("A").getdata()) == sum(src.getchannel("A").getdata())


def test_a_small_upload_is_never_upscaled():
    src = _sticker(300, 300, (10, 10, 110, 90))     # ~100 px of ink
    ink_w = _ink_box(src)[2] - _ink_box(src)[0]
    out, _ = pn.normalise(src)
    box = _ink_box(out)
    assert box[2] - box[0] == ink_w                  # same size, not blown up
    assert out.width == -(-ink_w * 100 // 85)        # ceil(ink / 0.85)


def test_a_huge_upload_is_downscaled_to_the_cap():
    src = _sticker(4000, 4000, (0, 0, 3999, 3000))
    out, _ = pn.normalise(src)
    assert out.size == (pn.MAX_SIDE, pn.MAX_SIDE)
    box = _ink_box(out)
    cx, cy = _centre(box, out.width)
    assert abs(cx - 0.5) < 0.003 and abs(cy - 0.5) < 0.003


def test_an_already_centred_pawn_stays_centred():
    src = _sticker(1000, 1000, (75, 150, 925, 850))
    out, _ = pn.normalise(src)
    cx, cy = _centre(_ink_box(out), out.width)
    assert abs(cx - 0.5) < 0.002 and abs(cy - 0.5) < 0.002


def test_a_photo_without_alpha_is_left_alone():
    photo = Image.new("RGB", (800, 600), (200, 180, 160))
    out, reason = pn.normalise(photo)
    assert out is None and "opaque" in reason


def test_an_rgba_photo_with_an_opaque_border_is_left_alone():
    # A phone photo saved as PNG carries an alpha channel that is opaque
    # everywhere; trimming it would find nothing and padding it would frame a
    # square photo in nothing.
    photo = Image.new("RGBA", (800, 600), (200, 180, 160, 255))
    out, reason = pn.normalise(photo)
    assert out is None and "opaque border" in reason


def test_a_fully_transparent_image_is_left_alone():
    out, reason = pn.normalise(Image.new("RGBA", (200, 200), (0, 0, 0, 0)))
    assert out is None and reason == "no visible ink"


def test_cli_writes_the_png_and_reports_json(tmp_path):
    src = tmp_path / "in.png"
    dst = tmp_path / "out.png"
    _sticker(909, 861, (0, 0, 869, 694)).save(src)
    r = subprocess.run([sys.executable, os.path.join(HERE, "pawn_normalise.py"), str(src), str(dst)],
                       capture_output=True, text=True, check=True)
    info = json.loads(r.stdout.strip().splitlines()[-1])
    assert info["normalised"] is True and info["size"][0] == info["size"][1]
    assert Image.open(dst).mode == "RGBA"


def test_cli_on_an_unreadable_file_says_so_and_writes_nothing(tmp_path):
    src = tmp_path / "in.png"
    src.write_bytes(b"\x89PNG\r\n\x1a\nnot really")
    dst = tmp_path / "out.png"
    r = subprocess.run([sys.executable, os.path.join(HERE, "pawn_normalise.py"), str(src), str(dst)],
                       capture_output=True, text=True, check=True)
    info = json.loads(r.stdout.strip().splitlines()[-1])
    assert info["normalised"] is False and info["reason"].startswith("unreadable")
    assert not dst.exists()
