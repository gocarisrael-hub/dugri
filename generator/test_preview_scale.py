#!/usr/bin/env python3
"""Tests for ``preview.py --scale`` / ``--board-scale``.

The homepage art (server/home-art.js) renders each design's sample card, back
and board once per artwork revision and builds its own size ladder from that,
so it needs the SAME render the buyer preview makes, only at a higher device
scale and uncapped. These pin:

  * no scale given is the buyer preview exactly as before: scale 2, capped to
    CARD_MAX_W / BOARD_MAX_W;
  * a scale given reaches Chrome and the PNG is that many times the card's CSS
    size, uncapped (scale 4 is twice the width of scale 2);
  * the board follows ``scale`` unless ``board_scale`` is given.

Run: python3 generator/test_preview_scale.py   (or via pytest)
"""
import os
import shutil
import subprocess
import sys

import config
import preview as pv
import render_page as rp
import test_build_deck as tb

HERE = os.path.dirname(os.path.abspath(__file__))


def _chrome():
    exe = os.environ.get("CHROME", "")
    if exe and os.path.exists(exe):
        return exe
    return (shutil.which("google-chrome") or shutil.which("chromium")
            or shutil.which("chromium-browser"))


# --- pure ------------------------------------------------------------------

def test_no_scale_is_the_buyer_preview_capped_at_two():
    assert pv._scales(None, None) == (2, 2, False)


def test_a_scale_uncaps_and_the_board_follows_it_unless_told():
    assert pv._scales(5, None) == (5, 5, True)
    assert pv._scales(5, 4) == (5, 4, True)
    # A board scale alone still means "the caller picked its resolution".
    assert pv._scales(None, 4) == (2, 4, True)


def test_full_res_leaves_the_png_alone(tmp_path=None):
    from PIL import Image
    d = str(tmp_path) if tmp_path else __import__("tempfile").mkdtemp()
    png = os.path.join(d, "wide.png")
    Image.new("RGB", (1500, 2000), "white").save(png)
    pv._downscale(png, pv.CARD_MAX_W, full_res=True)
    assert Image.open(png).size == (1500, 2000)
    pv._downscale(png, pv.CARD_MAX_W)
    assert Image.open(png).width == pv.CARD_MAX_W


def test_the_cli_refuses_a_scale_that_would_hang_chrome():
    for bad in ("0", "-1", "20"):
        proc = subprocess.run(
            [sys.executable, os.path.join(HERE, "preview.py"), "demo", "x",
             "/tmp/unused", "--scale", bad],
            capture_output=True, text=True)
        assert proc.returncode == 2, (bad, proc.stderr)
        assert "--scale" in proc.stderr


# --- with Chrome -----------------------------------------------------------

def test_scale_four_is_twice_the_width_of_scale_two_and_default_is_capped():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    from PIL import Image
    with tb.Store() as tmp:
        cfg = config.theme("demo")
        css_w, _ = rp.dims(config.card_path("demo", config.fronts(cfg)[0]))

        def run(tag, **kw):
            d = os.path.join(tmp, tag)
            os.makedirs(d, exist_ok=True)
            out = pv.preview("demo", "שירה", workdir=d, **kw)
            return {k: Image.open(out[k]).size for k in ("card", "back", "board")
                    if k in out}

        default = run("default")
        two = run("two", scale=2)
        four = run("four", scale=4)
        split = run("split", scale=4, board_scale=2)

        # The buyer preview is unchanged: scale 2, capped.
        assert default["card"][0] == min(2 * css_w, pv.CARD_MAX_W), default
        if "board" in default:
            assert default["board"][0] <= pv.BOARD_MAX_W, default
        # An explicit scale is honoured and nothing is capped.
        assert two["card"][0] == 2 * css_w, two
        assert abs(four["card"][0] - 2 * two["card"][0]) <= 1, (two, four)
        assert abs(four["back"][0] - 2 * two["back"][0]) <= 1, (two, four)
        if "board" in two:
            assert abs(four["board"][0] - 2 * two["board"][0]) <= 1, (two, four)
            assert split["board"] == two["board"], (split, two)
            assert split["card"] == four["card"], (split, four)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  {fn.__name__}")
    print(f"all {len(fns)} tests passed")
