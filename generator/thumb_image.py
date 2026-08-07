#!/usr/bin/env python3
"""Downscale ONE uploaded picture to an exact target WIDTH.

The owner's gallery uploads are full-size photographs — up to 4032 px wide and
3.4 MB — and every surface that shows them (the shop grid, the home rail, the
product page, the wizard picker) paints them into a box between 100 and 400 CSS
px. This script produces the derivative those surfaces load instead.

Usage:  thumb_image.py <src> <dest> <maxw>

GEOMETRY — the one rule, and the reason it is WIDTH and not "longest side":

    out_width  = min(source_width, maxw)
    out_height = round(source_height * out_width / source_width)

`srcset` descriptors are WIDTHS. The server advertises `min(source_width, rung)`
for each rung, and this function produces exactly that number of pixels, so the
descriptor and the file can never disagree — for a portrait, a landscape or a
square alike. Capping the LONGEST side instead (or adding a separate height cap)
makes a portrait come out narrower than the width it was advertised as: a
585x1266 source capped at 400 is 185 px wide while the srcset still claims 400w.
The browser then picks it for a box it cannot fill and renders it soft. That bug
was introduced, "fixed", and re-created in two earlier attempts; capping width
only is what makes it unrepresentable.

Never upscales — a source narrower than `maxw` is re-encoded at its own width
(still worth it: a 1.7 MB PNG becomes tens of KB of WebP).

ALPHA — a transparent PNG stays transparent. The previous version ran
convert("RGB") on everything, which drops the alpha channel and leaves whatever
RGB sat under it (usually black) as solid pixels, so a logo with a transparent
background came back as a black block. WebP carries alpha, so transparency is
preserved there; only the JPEG fallback (a Pillow build without WebP) has to
flatten, and it flattens onto WHITE — the page background — not black.

Exit 0 only when `dest` holds a real derivative; any failure exits non-zero and
writes nothing, so the caller can fall back.
"""

import sys

from PIL import Image

DEFAULT_MAXW = 400
# Visually lossless at these sizes while staying tens of KB.
WEBP_Q = 80
JPEG_Q = 82
# What a flattened JPEG composites transparency onto. WHITE, because every page
# that shows these pictures is white; black would draw the exact dark block this
# script used to produce.
FLATTEN_BG = (255, 255, 255)


def fit(src_w, src_h, maxw):
    """THE geometry rule. Returns (out_w, out_h) for a source and a width cap.

    Sole authority on output dimensions — the server derives its srcset `w`
    descriptors from `min(src_w, rung)`, which is precisely `fit(...)[0]`.
    """
    if src_w <= 0 or src_h <= 0:
        raise ValueError("source has no pixels")
    out_w = min(src_w, max(1, int(maxw)))
    out_h = max(1, round(src_h * out_w / src_w))
    return out_w, out_h


def has_alpha(im):
    """Whether this image carries real transparency worth preserving."""
    return im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info


def build(src, dest, maxw=DEFAULT_MAXW):
    im = Image.open(src)
    im.load()
    # EXIF-rotated phone photos must land the right way up; a sideways derivative
    # would be a bug the owner could not fix from the admin. Done BEFORE fit(),
    # so the width the server advertises is the width of the upright picture.
    try:
        from PIL import ImageOps

        im = ImageOps.exif_transpose(im)
    except Exception:
        pass

    keep_alpha = has_alpha(im)
    im = im.convert("RGBA" if keep_alpha else "RGB")

    out_w, out_h = fit(im.size[0], im.size[1], maxw)
    if (out_w, out_h) != im.size:
        im = im.resize((out_w, out_h), Image.LANCZOS)

    try:
        # WebP carries alpha, so a transparent PNG stays transparent.
        im.save(dest, format="WEBP", quality=WEBP_Q, method=4)
        return
    except Exception:
        # Pillow built without WebP (or an encoder hiccup) — JPEG still gives a
        # small file, and the caller types the result by its magic bytes. JPEG has
        # no alpha, so flatten onto the page colour rather than the default black.
        if keep_alpha:
            flat = Image.new("RGB", im.size, FLATTEN_BG)
            flat.paste(im, mask=im.split()[-1])
            im = flat
        im.convert("RGB").save(dest, format="JPEG", quality=JPEG_Q, optimize=True, progressive=True)


def main(argv):
    if len(argv) < 3:
        sys.stderr.write("usage: thumb_image.py <src> <dest> <maxw>\n")
        return 2
    maxw = DEFAULT_MAXW
    if len(argv) > 3:
        try:
            maxw = max(1, int(argv[3]))
        except ValueError:
            return 2
    build(argv[1], argv[2], maxw)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
