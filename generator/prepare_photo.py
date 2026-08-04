#!/usr/bin/env python3
"""Normalise a customer photo before it is sent to the background-removal API.

Reads the raw image from stdin, writes a normalised one to stdout. Two jobs, both
of which have to happen BEFORE the cut rather than after it:

* **EXIF orientation is applied.** A phone photo carries its rotation as metadata.
  The cutout comes back as a fresh PNG with no EXIF at all, so a photo sent
  sideways comes back sideways *and* loses the tag that would have fixed it —
  ``build.square_photo`` would then have nothing left to correct. Rotating here
  is the only place it can be done.
* **The longest side is capped** (``PHOTO_SEND_MAXPX``, default 2048). A modern
  phone photo is ~4000 px; the card only ever shows 512 px of it, so full
  resolution is pure latency and cost, and the masking endpoints on the same
  Adobe host document a 4000 x 4000 ceiling.

JPEG for an opaque image, PNG when the photo already has real transparency (an
already-cut photo re-uploaded). Exits non-zero on anything it cannot read, and the
caller then sends the ORIGINAL bytes — this step is an optimisation, never a gate.

Mirrors generator/shrink_svg_images.py (same stdin/stdout + Pillow shape).
"""
import io
import os
import sys

from PIL import Image, ImageOps

MAXPX = int(os.environ.get("PHOTO_SEND_MAXPX", "2048"))
JPEG_Q = int(os.environ.get("PHOTO_SEND_JPEG_Q", "88"))


def has_real_alpha(im):
    """True only when the image actually USES its alpha channel."""
    if im.mode not in ("RGBA", "LA", "P"):
        return False
    return im.convert("RGBA").getchannel("A").getextrema()[0] < 255


def prepare(raw, maxpx=None, quality=None):
    """Normalised image bytes for `raw`. Raises on an image Pillow cannot read."""
    maxpx = MAXPX if maxpx is None else maxpx
    quality = JPEG_Q if quality is None else quality
    with Image.open(io.BytesIO(raw)) as im:
        im.load()
        im = ImageOps.exif_transpose(im)
        w, h = im.size
        longest = max(w, h)
        if longest > maxpx > 0:
            scale = maxpx / longest
            im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        out = io.BytesIO()
        if has_real_alpha(im):
            im.convert("RGBA").save(out, format="PNG", optimize=True)
        else:
            im.convert("RGB").save(out, format="JPEG", quality=quality, optimize=True)
        return out.getvalue()


def main():
    raw = sys.stdin.buffer.read()
    if not raw:
        return 1
    try:
        out = prepare(raw)
    except Exception:
        return 1  # unreadable — the caller sends the original bytes instead
    sys.stdout.buffer.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
