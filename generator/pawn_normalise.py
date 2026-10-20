#!/usr/bin/env python3
"""Centre an uploaded fallback pawn on a square transparent canvas.

THE PROBLEM THIS SOLVES. A fallback pawn is drawn into its photo-card slot
"xMidYMid meet" by its CANVAS — on the site (site/js/pawn-print.js
fallbackMarkup) and in print (render_page.fill_photo_slots) alike. So an upload
cropped tight on two sides and loose on the other two prints off-centre and too
big, and in print the disc's clip cuts off whatever crosses the circle. That is
what the owner's green and gold pawns did on 2026-10-20.

THE RULE, applied ONCE at upload (server/index.js POST /api/admin/photo-fallback)
so the stored file is the one both surfaces read and parity holds by
construction:

  1. trim to the visible ink — alpha above ``ALPHA_INK``;
  2. pad, centred, onto a transparent SQUARE canvas whose side is the ink's long
     side / ``FILL`` — the margin the shipped logo pawns already carry;
  3. only ever DOWNSCALE (to ``MAX_SIDE``), never upscale: a small upload stays
     small rather than going soft.

A picture with no real transparency is a PHOTO, not sticker art: trimming it
finds nothing and padding it would put a square photo in a frame of nothing.
It is returned untouched, as is anything Pillow cannot open.

CLI (what the server spawns):  python3 pawn_normalise.py <in> <out.png>
prints one JSON line: {"normalised": bool, "reason": str, "size": [w, h]}.
"""
import json
import math
import sys

from PIL import Image

ALPHA_INK = 8          # alpha above this is ink; below is antialias haze / dust
FILL = 0.85            # the ink's long side as a fraction of the canvas side
MAX_SIDE = 2048        # the canvas is never larger than this
# Share of BORDER pixels that must be see-through for the image to count as
# sticker art. A photo's border is opaque all the way round.
CLEAR_BORDER = 0.5


def _border_clear_share(alpha):
    w, h = alpha.size
    px = alpha.load()
    edge = [(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)]
    edge += [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)]
    clear = sum(1 for p in edge if px[p] <= ALPHA_INK)
    return clear / max(1, len(edge))


def normalise(im):
    """``(image, reason)`` — the centred RGBA image, or None when left alone."""
    if im.mode not in ("RGBA", "LA") and "transparency" not in im.info:
        return None, "opaque (no alpha channel)"
    rgba = im.convert("RGBA")
    alpha = rgba.getchannel("A")
    if _border_clear_share(alpha) < CLEAR_BORDER:
        return None, "opaque border (a photo, not sticker art)"
    box = alpha.point(lambda a: 255 if a > ALPHA_INK else 0).getbbox()
    if not box:
        return None, "no visible ink"
    ink = rgba.crop(box)
    side = math.ceil(max(ink.size) / FILL)
    if side > MAX_SIDE:
        k = MAX_SIDE / side
        ink = ink.resize((max(1, round(ink.width * k)), max(1, round(ink.height * k))),
                         Image.LANCZOS)
        side = MAX_SIDE
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(ink, ((side - ink.width) // 2, (side - ink.height) // 2))
    return canvas, "centred"


def main(src, dst):
    try:
        im = Image.open(src)
        im.load()
    except Exception as exc:                      # noqa: BLE001 - reported, not fatal
        print(json.dumps({"normalised": False, "reason": f"unreadable: {exc}"}))
        return 0
    out, reason = normalise(im)
    if out is None:
        print(json.dumps({"normalised": False, "reason": reason, "size": list(im.size)}))
        return 0
    out.save(dst, "PNG", optimize=True)
    print(json.dumps({"normalised": True, "reason": reason, "size": list(out.size)}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
