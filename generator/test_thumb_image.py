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


def test_caps_the_size_and_keeps_the_aspect(tmp_path):
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


# The storefront serves a LADDER of widths through srcset (400/800/1200), so the
# same script has to produce every rung — a 163px grid tile and a full-bleed
# product photo cannot share one size without one of them being wrong.
@pytest.mark.parametrize("maxpx", [400, 800, 1200])
def test_produces_every_rung_of_the_storefront_ladder(tmp_path, maxpx):
    src = photo(str(tmp_path / "src.png"), (3000, 2400))
    dest = str(tmp_path / f"out{maxpx}")
    assert run(src, dest, maxpx).returncode == 0
    with Image.open(dest) as im:
        assert max(im.size) == maxpx
        assert abs(im.size[0] / im.size[1] - 3000 / 2400) < 0.02


def test_a_bigger_rung_really_is_a_bigger_picture(tmp_path):
    """srcset picks a rung by its `w` descriptor and trusts it to carry more
    detail. If the cap were ignored every rung would weigh the same and the
    browser's choice would be meaningless."""
    src = photo(str(tmp_path / "src.png"), (3000, 2400))
    sizes = {}
    for maxpx in (400, 800, 1200):
        dest = str(tmp_path / f"out{maxpx}")
        assert run(src, dest, maxpx).returncode == 0
        sizes[maxpx] = os.path.getsize(dest)
    assert sizes[400] < sizes[800] < sizes[1200]


def test_a_transparent_png_does_not_turn_black(tmp_path):
    """The resizer used to convert("RGB") unconditionally, which composites alpha
    onto BLACK. Any cut-out or logo PNG the owner uploaded became a black slab on
    every storefront surface, and nothing in the admin could fix it."""
    src = str(tmp_path / "src.png")
    im = Image.new("RGBA", (900, 600), (0, 0, 0, 0))  # fully transparent
    d = ImageDraw.Draw(im)
    d.ellipse([300, 200, 600, 400], fill=(255, 0, 0, 255))  # one opaque blob
    im.save(src)

    dest = str(tmp_path / "out")
    assert run(src, dest, 400).returncode == 0
    with Image.open(dest) as out:
        out = out.convert("RGBA")
        # A corner that was transparent must not have become opaque black.
        r, g, b, a = out.getpixel((2, 2))
        assert a == 0 or (r, g, b) != (0, 0, 0), f"corner became {(r, g, b, a)}"
        # …and the opaque blob still reads red, so nothing was flattened away.
        assert out.getpixel((out.size[0] // 2, out.size[1] // 2))[0] > 150


def test_caps_the_WIDTH_so_srcset_descriptors_are_honest(tmp_path):
    """These derivatives are advertised through srcset `w` descriptors, which
    state a WIDTH. Capping the longest side instead made every portrait picture
    narrower than its descriptor claimed, so the browser — believing it had
    enough pixels — picked a rung too small and drew it soft."""
    portrait = photo(str(tmp_path / "p.png"), (2000, 3000))
    landscape = photo(str(tmp_path / "l.png"), (3000, 2000))
    for name, src in (("p", portrait), ("l", landscape)):
        dest = str(tmp_path / f"out{name}")
        assert run(src, dest, 800).returncode == 0
        with Image.open(dest) as im:
            assert im.size[0] == 800, f"{name}: width {im.size[0]} != descriptor 800"


def test_even_the_top_rung_is_a_fraction_of_the_camera_original(tmp_path):
    """1200px is the ceiling because a 390px phone at DPR 3 resolves 1170 device
    px. The owner's uploads are ~3000px/~1MB; the point of the top rung is that
    it is still far smaller than what her camera produced, at no visible cost."""
    src = str(tmp_path / "src.png")
    photo(src, (3780, 3024))
    dest = str(tmp_path / "out")
    assert run(src, dest, 1200).returncode == 0
    assert os.path.getsize(dest) < os.path.getsize(src) / 4
