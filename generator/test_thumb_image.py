"""thumb_image.py — the downscaler behind the small gallery derivatives.

The owner's gallery uploads are full-size photographs; the wizard's design picker
shows one at ~150px wide. This is the script that bridges that gap, and what it
must guarantee is size: a picker full of originals would be several MB on the
first screen of the funnel.
"""
import os
import subprocess
import sys

import pytest
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "thumb_image.py")


def run(src, dest, maxpx=None):
    argv = [sys.executable, SCRIPT, src, dest] + ([str(maxpx)] if maxpx else [])
    return subprocess.run(argv, capture_output=True)


def photo(path, size=(2400, 1600)):
    """A photo-like image: smooth gradients with some shape detail. A flat colour
    would compress to nothing and make the size assertions meaningless; pure
    per-pixel noise is the opposite trap (it compresses far WORSE than any real
    photograph, so it would understate the saving)."""
    w, h = size
    im = Image.new("RGB", size)
    im.putdata(
        [
            (int(255 * x / max(1, w - 1)), int(255 * y / max(1, h - 1)), (x * y // 97) % 256)
            for y in range(h)
            for x in range(w)
        ]
    )
    d = ImageDraw.Draw(im)
    for i in range(6):
        d.ellipse(
            [w * i / 12, h * i / 14, w * (i + 4) / 12, h * (i + 5) / 14],
            outline=(20, 20 + i * 30, 200 - i * 20),
            width=max(1, w // 200),
        )
    im.save(path)
    return path


def test_caps_the_longest_side_and_keeps_the_aspect(tmp_path):
    src = photo(str(tmp_path / "src.png"), (2400, 1600))
    dest = str(tmp_path / "out")
    assert run(src, dest, 400).returncode == 0
    with Image.open(dest) as im:
        assert max(im.size) == 400
        # 3:2 in, 3:2 out — a squashed thumbnail is a visible bug.
        assert abs(im.size[0] / im.size[1] - 2400 / 1600) < 0.02


def test_the_derivative_lands_in_tens_of_KB_however_big_the_upload(tmp_path):
    """The whole point. The owner's real uploads are 180KB–1MB; measured against
    the live gallery, this turns them into 11–31KB. The output has to track the
    px CAP, not the size of what came in — so a bigger upload must not produce a
    bigger thumbnail."""
    dest_big = str(tmp_path / "big")
    dest_small = str(tmp_path / "small")
    assert run(photo(str(tmp_path / "big.png"), (3000, 2000)), dest_big, 400).returncode == 0
    assert run(photo(str(tmp_path / "small.png"), (1200, 800)), dest_small, 400).returncode == 0
    # 60KB is already generous against the 11–31KB the real uploads produce; it
    # is here to catch "the resize silently stopped happening", not to police
    # codec drift.
    assert os.path.getsize(dest_big) < 60 * 1024
    assert os.path.getsize(dest_small) < 60 * 1024


def test_never_upscales_a_picture_that_is_already_small(tmp_path):
    src = photo(str(tmp_path / "src.png"), (120, 90))
    dest = str(tmp_path / "out")
    assert run(src, dest, 400).returncode == 0
    with Image.open(dest) as im:
        assert im.size == (120, 90)


def test_output_is_a_raster_the_browser_can_type_by_its_magic_bytes(tmp_path):
    """The server sniffs the written bytes for the content type it serves, so the
    file must be recognizably WebP or JPEG — whichever this Pillow can encode."""
    src = photo(str(tmp_path / "src.png"), (800, 600))
    dest = str(tmp_path / "out")
    assert run(src, dest, 400).returncode == 0
    head = open(dest, "rb").read(12)
    assert head[:3] == b"\xff\xd8\xff" or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")


@pytest.mark.parametrize("ext", ["png", "jpg", "webp"])
def test_reads_every_format_an_upload_can_be(tmp_path, ext):
    src = str(tmp_path / f"src.{ext}")
    photo(src, (900, 600))
    dest = str(tmp_path / "out")
    assert run(src, dest, 400).returncode == 0
    assert os.path.getsize(dest) > 0


def test_a_file_that_is_not_an_image_fails_and_writes_nothing(tmp_path):
    """The caller reads a non-zero exit as 'no thumbnail' and falls back to the
    shipped render — so failing loudly here is the safe behaviour, and a
    half-written dest would be served forever."""
    src = str(tmp_path / "src.png")
    open(src, "wb").write(b"definitely not a picture")
    dest = str(tmp_path / "out")
    assert run(src, dest, 400).returncode != 0
    assert not os.path.exists(dest)


def test_a_missing_source_fails(tmp_path):
    dest = str(tmp_path / "out")
    assert run(str(tmp_path / "nope.png"), dest, 400).returncode != 0
    assert not os.path.exists(dest)


def test_bad_usage_fails(tmp_path):
    assert subprocess.run([sys.executable, SCRIPT], capture_output=True).returncode != 0
