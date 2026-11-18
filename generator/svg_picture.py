#!/usr/bin/env python3
"""Rasterize a template's storefront PICTURE SVGs (its filled front/back/board) to PNGs.

The shop shows an uploaded design through the template's own filled SVGs. Those are
Canva exports that embed full-resolution rasters (3 MB for one card is normal), so a
phone downloading the shop grid downloads megabytes of artwork to paint a 160 px tile.
server/template-pics.js turns them into a WebP width ladder; this script is its first
step: ONE Chrome screenshot per picture, drawn exactly as a browser draws the SVG in an
<img> (its own width/height, the viewBox scaled into it), at a pixel width the ladder's
top rung can be cut from.

This is a PICTURE of the artwork for the shop. Nothing here is read by the deck, the
proof or the press export: those keep rendering the original SVGs.

Usage:  svg_picture.py <out_dir> <role>=<svg>:<width> [<role>=<svg>:<width> ...]

Prints ONE JSON line: {"card": <front png>, "back": <png>, "board": <png>} with the
roles that rendered (the shape server/home-art.js expects from a render). Exit non-zero
when the front does not render; a back or board that fails is left out.
"""

import json
import math
import os
import re
import sys

import chrome

ROLES = ("front", "back", "board")
# The key server/home-art.js reads a render's front from.
OUT_KEY = {"front": "card", "back": "back", "board": "board"}
# CSS px per unit, for the few units an SVG root's width can carry.
UNIT_PX = {"": 1.0, "px": 1.0, "pt": 4.0 / 3.0, "pc": 16.0, "in": 96.0,
           "cm": 96.0 / 2.54, "mm": 96.0 / 25.4}
MAX_SCALE = 12.0


def _length(attrs, name):
    m = re.search(r'\s' + name + r'\s*=\s*["\']\s*([\d.]+)\s*(px|pt|pc|in|cm|mm)?\s*["\']', attrs)
    if not m:
        return None
    v = float(m.group(1)) * UNIT_PX[m.group(2) or ""]
    return v if v > 0 else None


def css_size(svg_text):
    """The SVG's drawn size in CSS px: its width/height, else its viewBox. None if unreadable.

    Taken from the root's width/height when it has both, because that is what an <img>
    draws (Canva cards say 299x416 over a 223.92x312 viewBox; using the viewBox crops,
    see generator memory "canva-svg-render-size").
    """
    m = re.search(r"<svg\b([^>]*)>", svg_text[:20000], re.S)
    if not m:
        return None
    attrs = " " + m.group(1)
    w, h = _length(attrs, "width"), _length(attrs, "height")
    vb = re.search(r'\sviewBox\s*=\s*["\']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)', attrs)
    vw, vh = (float(vb.group(1)), float(vb.group(2))) if vb else (None, None)
    if w and h:
        return w, h
    if vw and vh:
        if w:
            return w, w * vh / vw
        if h:
            return h * vw / vh, h
        return vw, vh
    return None


def render(svg_path, out_png, width):
    """Screenshot ONE picture SVG to a PNG about ``width`` px wide. Returns the path."""
    with open(svg_path, encoding="utf-8", errors="replace") as f:
        size = css_size(f.read())
    if not size:
        raise ValueError(f"{svg_path}: no readable width/height or viewBox")
    css_w, css_h = size
    # The window is the SVG's own box, so the drawing fills it exactly; the device scale
    # makes the pixels. A fractional box is rounded: at most half a CSS px of edge.
    win_w, win_h = max(1, round(css_w)), max(1, round(css_h))
    scale = min(MAX_SCALE, max(1.0, width / win_w))
    scale = math.floor(scale * 1000) / 1000
    return chrome.screenshot(svg_path, out_png, win_w, win_h, scale=scale,
                             what=os.path.basename(svg_path))


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    out_dir = argv[1]
    os.makedirs(out_dir, exist_ok=True)
    out = {}
    for spec in argv[2:]:
        m = re.match(r"^(front|back|board)=(.+):(\d{2,5})$", spec)
        if not m:
            print(f"bad spec {spec!r}", file=sys.stderr)
            return 2
        role, svg, width = m.group(1), m.group(2), int(m.group(3))
        try:
            out[OUT_KEY[role]] = render(svg, os.path.join(out_dir, role + ".png"), width)
        except Exception as e:  # one picture failing must not cost the others
            print(f"{role}: {e}", file=sys.stderr)
    if "card" not in out:
        print("the front did not render", file=sys.stderr)
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
