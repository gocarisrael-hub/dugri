#!/usr/bin/env python3
"""Downscale ONE uploaded picture into a small web thumbnail.

The owner's gallery uploads are full-size photos (a few hundred KB to ~1 MB
each). Some surfaces show them at postage-stamp size — the wizard's design
picker, where a dozen of them at full size would be several MB on the page that
Instagram's in-app browser already struggles with. This produces the small
derivative those surfaces load instead.

Usage:  thumb_image.py <src> <dest> [maxpx]

Caps the longest side at `maxpx` (default 400) and re-encodes. WebP is the
preferred output — best size at this scale and universally supported by the
browsers we serve — but Pillow is not guaranteed to be built with WebP support
everywhere, so a WebP failure falls back to JPEG rather than failing the whole
thumbnail. The caller sniffs the written file's magic bytes for its content
type, so either encoding serves correctly.

Never upscales: a picture already smaller than `maxpx` is only re-encoded, which
is still worth it (a 2 MB PNG of a small image becomes a few KB of WebP).

Exit 0 only when `dest` holds a real thumbnail; any failure exits non-zero and
writes nothing, so the caller can fall back to the shipped render.
"""
import sys

from PIL import Image

DEFAULT_MAXPX = 400
# Visually lossless at picker size while staying tens of KB.
WEBP_Q = 80
JPEG_Q = 82


def build(src, dest, maxpx=DEFAULT_MAXPX):
    im = Image.open(src)
    im.load()
    # EXIF-rotated phone photos must land the right way up; a sideways thumbnail
    # would be a bug the owner could not fix from the admin.
    try:
        from PIL import ImageOps

        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    w, h = im.size
    longest = max(w, h)
    if longest > maxpx:
        scale = maxpx / longest
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    try:
        im.convert("RGB").save(dest, format="WEBP", quality=WEBP_Q, method=4)
        return
    except Exception:
        # Pillow without WebP support (or a WebP encoder hiccup) — JPEG still
        # gives us a small file, and the caller types the result by its bytes.
        im.convert("RGB").save(dest, format="JPEG", quality=JPEG_Q, optimize=True, progressive=True)


def main(argv):
    if len(argv) < 3:
        sys.stderr.write("usage: thumb_image.py <src> <dest> [maxpx]\n")
        return 2
    maxpx = DEFAULT_MAXPX
    if len(argv) > 3:
        try:
            maxpx = max(1, int(argv[3]))
        except ValueError:
            return 2
    build(argv[1], argv[2], maxpx)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
