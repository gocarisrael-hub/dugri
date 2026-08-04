"""prepare_photo.py — what a customer photo must look like BEFORE it is cut.

The background-removal API returns a fresh PNG with no EXIF, so anything the EXIF
tag would have fixed has to be fixed on the way OUT, not on the way back.
"""
import io
import os
import subprocess
import sys

import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prepare_photo  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prepare_photo.py")


def _photo(w, h, mode="RGB", exif_orientation=None):
    """A JPEG of a plain gradient, optionally tagged with an EXIF orientation."""
    im = Image.new(mode, (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (x * 255 // max(1, w), y * 255 // max(1, h), 128)[: len(im.getbands())]
    buf = io.BytesIO()
    if exif_orientation is None:
        im.save(buf, format="JPEG")
    else:
        exif = im.getexif()
        exif[0x0112] = exif_orientation
        im.save(buf, format="JPEG", exif=exif)
    return buf.getvalue()


def test_a_big_phone_photo_is_capped_at_the_send_ceiling():
    # A modern phone shoots ~4000px; the card only ever shows 512 of them, and the
    # masking endpoints on the same Adobe host document a 4000x4000 ceiling.
    out = prepare_photo.prepare(_photo(4000, 3000))
    with Image.open(io.BytesIO(out)) as im:
        assert max(im.size) == prepare_photo.MAXPX, im.size
        assert im.size == (2048, 1536), im.size  # aspect ratio preserved


def test_a_small_photo_is_not_upscaled():
    out = prepare_photo.prepare(_photo(300, 400))
    with Image.open(io.BytesIO(out)) as im:
        assert im.size == (300, 400), im.size


def test_exif_rotation_is_APPLIED_not_carried():
    # Orientation 6 = "rotate 90° CW to display". The cutout comes back as a fresh
    # PNG with no EXIF at all, so a photo sent sideways comes back sideways and
    # build.square_photo has nothing left to correct — this is the only place it
    # can be fixed.
    raw = _photo(400, 200, exif_orientation=6)
    with Image.open(io.BytesIO(raw)) as im:
        assert im.size == (400, 200)  # stored landscape...
    out = prepare_photo.prepare(raw)
    with Image.open(io.BytesIO(out)) as im:
        assert im.size == (200, 400), "the rotation must be baked into the pixels"
        assert not im.getexif().get(0x0112), "and the tag must not be carried along"


def test_an_opaque_photo_goes_out_as_jpeg():
    out = prepare_photo.prepare(_photo(800, 600))
    assert out[:3] == b"\xff\xd8\xff", "opaque -> JPEG (far smaller over the wire)"


def test_an_already_transparent_photo_keeps_its_alpha():
    # Re-uploading a cutout must not flatten it into a white box on the way out.
    im = Image.new("RGBA", (600, 800), (0, 0, 0, 0))
    im.putpixel((100, 100), (255, 0, 0, 255))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    out = prepare_photo.prepare(buf.getvalue())
    assert out[:8] == b"\x89PNG\r\n\x1a\n"
    with Image.open(io.BytesIO(out)) as got:
        assert got.mode == "RGBA"
        assert got.getextrema()[3][0] == 0


def test_an_unreadable_file_raises_so_the_caller_sends_the_original():
    with pytest.raises(Exception):
        prepare_photo.prepare(b"this is not an image at all")


def test_the_cli_streams_stdin_to_stdout():
    # This is the shape server/cutout.js actually invokes (same pattern as
    # templates.shrinkSvgImages -> shrink_svg_images.py).
    raw = _photo(3000, 3000)
    r = subprocess.run([sys.executable, SCRIPT], input=raw, capture_output=True)
    assert r.returncode == 0, r.stderr
    with Image.open(io.BytesIO(r.stdout)) as im:
        assert max(im.size) == prepare_photo.MAXPX


def test_the_cli_exits_non_zero_on_junk():
    r = subprocess.run([sys.executable, SCRIPT], input=b"nope", capture_output=True)
    assert r.returncode != 0
    assert r.stdout == b""
