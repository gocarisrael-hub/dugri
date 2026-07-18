#!/usr/bin/env python3
"""Downsample raster images embedded in a Canva-exported SVG.

Canva bakes every photo/background into the SVG as a base64 `data:` URI at full
(often retina) resolution, so an image-heavy template can be tens of MB per page
and blow past the upload limit. This rewrites each embedded PNG/JPEG: it caps the
longest side at TEMPLATE_IMAGE_MAXPX and re-encodes (JPEG for opaque images, PNG
when the image has real transparency). Vector paths + text are left untouched, so
card render fidelity is unchanged at print size.

Reads the SVG from stdin, writes the shrunk SVG to stdout. Best-effort per image:
anything that fails to decode is passed through verbatim. Deterministic — the same
input image always yields identical bytes, so a clean/filled pair that shares a
background still diffs to zero there (recipe_diff stays reliable).
"""
import base64
import io
import os
import re
import sys

from PIL import Image

MAXPX = int(os.environ.get("TEMPLATE_IMAGE_MAXPX", "1800"))
JPEG_Q = int(os.environ.get("TEMPLATE_IMAGE_JPEG_Q", "85"))

DATA_RE = re.compile(r"data:image/(png|jpe?g);base64,([A-Za-z0-9+/=]+)")


def _has_real_alpha(im):
    if im.mode not in ("RGBA", "LA", "P"):
        return False
    a = im.convert("RGBA").getchannel("A")
    return a.getextrema()[0] < 255


def _shrink(match):
    b64 = match.group(2)
    try:
        raw = base64.b64decode(b64)
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception:
        return match.group(0)  # undecodable -> leave exactly as-is
    w, h = im.size
    scale = min(1.0, MAXPX / max(w, h)) if max(w, h) else 1.0
    if scale < 1.0:
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    out = io.BytesIO()
    if _has_real_alpha(im):
        im.convert("RGBA").save(out, format="PNG", optimize=True)
        mime = "png"
    else:
        im.convert("RGB").save(out, format="JPEG", quality=JPEG_Q, optimize=True, progressive=True)
        mime = "jpeg"
    new = "data:image/%s;base64,%s" % (mime, base64.b64encode(out.getvalue()).decode("ascii"))
    # Never grow a blob: if re-encoding didn't help, keep the original.
    return new if len(new) < len(match.group(0)) else match.group(0)


def main():
    data = sys.stdin.buffer.read().decode("utf-8", "replace")
    data = DATA_RE.sub(_shrink, data)
    sys.stdout.buffer.write(data.encode("utf-8"))


if __name__ == "__main__":
    main()
