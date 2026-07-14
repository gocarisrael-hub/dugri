#!/usr/bin/env python3
"""Tests for generator/svg_rings.py — the board tile "ghosting" fix.

The birthday-boys-basketball board (a Canva export) drew each game tile's red
outline offset and doubled off the white tile, so every numbered square rendered
with a red crescent / doubled ring that looked like bad print registration. These
tests pin that the fix (a) snaps ring tiles concentric to their white disc, (b)
collapses doubled solid tiles to one clean disc, (c) is a byte-for-byte no-op on
boards without the pattern, and (d) actually produces a symmetric ring when
rendered.

Run: python3 generator/test_svg_rings.py   (or via pytest)
"""
import math
import os
import re
import subprocess

import config
import svg_rings

HERE = os.path.dirname(os.path.abspath(__file__))
BASKETBALL = "birthday-boys-basketball"


def _ring_group(idc, cx, cy, r, fill=svg_rings.RED):
    """A red disc in the exact export shape svg_rings matches: a clip-path group
    wrapping one circle-ish path. Approximate the circle by its bounding box
    corners (enough for the bbox-centre geometry the module uses)."""
    d = f"M {cx-r} {cy} C {cx-r} {cy-r} {cx+r} {cy-r} {cx+r} {cy} C {cx+r} {cy+r} {cx-r} {cy+r} {cx-r} {cy} Z"
    return f'<g clip-path="url(#{idc})"><path fill="{fill}" d="{d}"/></g>'


def _white_disc(cx, cy, r):
    d = f"M {cx-r} {cy} C {cx-r} {cy-r} {cx+r} {cy-r} {cx+r} {cy} C {cx+r} {cy+r} {cx-r} {cy+r} {cx-r} {cy} Z"
    return f'<path fill="{svg_rings.WHITE}" d="{d}"/>'


def test_ring_tile_snaps_concentric_to_white_disc():
    # White tile at (100,100) r=30; its red outline exported offset by (+2,-2).
    svg = (
        "<svg>"
        + _ring_group("a1", 102, 98, 32)
        + _white_disc(100, 100, 30)
        + "</svg>"
    )
    plan = svg_rings.plan_circles(svg)
    assert len(plan) == 1 and plan[0] is not None
    cx, cy, r, kind = plan[0]
    assert kind == "ring"
    # centre moved onto the WHITE disc, not left at the offset red bbox centre
    assert abs(cx - 100) < 1e-6 and abs(cy - 100) < 1e-6
    # ring sits just outside the 30-unit white disc (a thin border, not huge)
    assert 30 < r < 30 * 1.2
    out = svg_rings.align_ring_discs(svg)
    # emitted as a hollow stroked ring so the tile + number show through
    assert 'fill="none"' in out and f'stroke="{svg_rings.RED}"' in out
    assert "<g clip-path" not in out  # the messy group is gone


def test_solid_doubled_tile_collapses_to_one_disc():
    # A start/end tile: two red copies, offset from each other, no white disc.
    svg = (
        "<svg>"
        + _ring_group("aa1", 200, 200, 44)
        + _ring_group("bb2", 201, 202, 46)
        + "</svg>"
    )
    plan = svg_rings.plan_circles(svg)
    assert all(p is not None and p[3] == "fill" for p in plan)
    # both redrawn concentric on the LARGER copy's centre (201,202)
    for cx, cy, r, kind in plan:
        assert abs(cx - 201) < 1e-6 and abs(cy - 202) < 1e-6
    out = svg_rings.align_ring_discs(svg)
    assert out.count("<circle") == 2 and 'fill="none"' not in out


def test_no_pattern_is_byte_for_byte_noop():
    # A lone red disc-shaped shape with no white tile and no duplicate: untouched.
    svg = "<svg>" + _ring_group("cc3", 50, 50, 20) + "</svg>"
    assert svg_rings.align_ring_discs(svg) == svg
    # A non-square red shape (e.g. a bar) is never converted either.
    d = "M 0 0 C 0 0 100 0 100 0 C 100 5 0 5 0 5 Z"
    bar = f'<g clip-path="url(#dd4)"><path fill="{svg_rings.RED}" d="{d}"/></g>'
    assert svg_rings.align_ring_discs(f"<svg>{bar}</svg>") == f"<svg>{bar}</svg>"


def test_real_basketball_board_all_tiles_cleaned():
    svg = open(config.clean_path(BASKETBALL, "board"), encoding="utf-8").read()
    plan = svg_rings.plan_circles(svg)
    kinds = [p[3] for p in plan if p]
    # 47 numbered white tiles get a ring; 8 solid tiles (start/end/6 logos) are
    # each doubled -> 16 red paths -> fills.
    assert kinds.count("ring") == 47, kinds.count("ring")
    assert kinds.count("fill") == 16, kinds.count("fill")
    assert None not in plan, "every red disc on this board should be cleaned"

    # BEFORE: the exported red bbox centres are measurably off the white tiles
    # (that offset is the visible ghost). AFTER: the plan centres each ring exactly
    # on its white disc.
    reds = [svg_rings._disc(m.group(2)) for m in svg_rings._red_group_re(svg_rings.RED).finditer(svg)]
    whites = svg_rings._white_discs(svg, svg_rings.WHITE)
    worst_before = 0.0
    for r, p in zip(reds, plan):
        if p is None or p[3] != "ring":
            continue
        w = min(whites, key=lambda w: math.hypot(r[0] - w[0], r[1] - w[1]))
        worst_before = max(worst_before, math.hypot(r[0] - w[0], r[1] - w[1]))
        assert abs(p[0] - w[0]) < 1e-6 and abs(p[1] - w[1]) < 1e-6
    assert worst_before > 0.5, "expected a real pre-fix offset to correct"


def test_transform_is_idempotent():
    svg = open(config.clean_path(BASKETBALL, "board"), encoding="utf-8").read()
    once = svg_rings.align_ring_discs(svg)
    assert once != svg
    assert svg_rings.align_ring_discs(once) == once  # nothing left to match


def test_other_theme_boards_unchanged():
    import json

    themes = json.load(open(os.path.join(HERE, "themes.json"), encoding="utf-8"))
    checked = 0
    for name, cfg in themes.items():
        if not isinstance(cfg, dict) or "slug" not in cfg or name == BASKETBALL:
            continue
        bc = config.clean_path(name, "board")
        if not os.path.exists(bc):
            continue
        svg = open(bc, encoding="utf-8").read()
        assert svg_rings.align_ring_discs(svg) == svg, f"{name} board must be untouched"
        checked += 1
    assert checked > 0, "no other theme boards were exercised"


def _chrome():
    import render_page as rp

    return rp.CHROME if os.path.exists(rp.CHROME) else None


def test_rendered_ring_is_symmetric():
    """Rasterize-and-eyeball: render the aligned board and check that a sampled
    numbered tile's red ring is symmetric (red pixels balanced left/right and
    top/bottom around the tile centre) — i.e. the crescent ghost is gone."""
    chrome = _chrome()
    if not chrome:
        print("  (skip render check: Chrome not found)")
        return
    from PIL import Image

    svg = svg_rings.align_ring_discs(
        open(config.clean_path(BASKETBALL, "board"), encoding="utf-8").read()
    )
    workdir = "/tmp/gen/test_svg_rings"
    os.makedirs(workdir, exist_ok=True)
    p = os.path.join(workdir, "board.svg")
    png = os.path.join(workdir, "board.png")
    open(p, "w", encoding="utf-8").write(svg)
    subprocess.run(
        [chrome, "--headless", "--disable-gpu", "--force-device-scale-factor=2",
         f"--screenshot={png}", "--window-size=1123,794", p],
        check=True, stderr=subprocess.DEVNULL,
    )
    img = Image.open(png).convert("RGB")
    W, H = img.size
    px = img.load()
    # Tile "2" sits at viewBox (~156, ~58) in an 842x595 board. Map to pixels and
    # scan a window around it.
    cx = int(156.2 / 842.25 * W)
    cy = int(58.0 / 595.5 * H)
    rad = int(40 / 842.25 * W)

    def is_red(r, g, b):
        return r > 150 and g < 90 and b < 90

    left = right = top = bot = 0
    for y in range(cy - rad, cy + rad):
        for x in range(cx - rad, cx + rad):
            if 0 <= x < W and 0 <= y < H and is_red(*px[x, y]):
                if x < cx:
                    left += 1
                else:
                    right += 1
                if y < cy:
                    top += 1
                else:
                    bot += 1
    assert left + right > 100, "expected to find the red ring around tile 2"
    # A concentric ring is left/right and top/bottom balanced. The pre-fix crescent
    # was heavily lopsided; require close balance now.
    assert abs(left - right) / (left + right) < 0.15, (left, right)
    assert abs(top - bot) / (top + bot) < 0.15, (top, bot)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
