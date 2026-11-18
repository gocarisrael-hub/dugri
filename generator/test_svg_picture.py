"""svg_picture.py: the shop's raster of a template picture is the WHOLE picture, drawn as an <img> draws it.

The trap it must not fall into (memory "canva-svg-render-size"): a Canva card says width="299" height="416" over a
viewBox of 223.92x312. Sizing the window by the viewBox CROPS the card to its top-left instead of scaling it.
"""

import json
import os
import shutil
import subprocess
import sys

import pytest
from PIL import Image

import chrome
import svg_picture

HERE = os.path.dirname(os.path.abspath(__file__))

CANVA_CARD = ('<svg xmlns="http://www.w3.org/2000/svg" width="299" height="416" viewBox="0 0 223.92 312" '
              'preserveAspectRatio="xMidYMid meet" version="1.0">'
              '<rect width="223.92" height="312" fill="#ff0000"/>'
              # a marker in the far corner: present only if the picture was scaled, not cropped
              '<rect x="190" y="280" width="33.92" height="32" fill="#0000ff"/></svg>')


def test_size_is_the_drawn_size_not_the_viewbox():
    assert svg_picture.css_size(CANVA_CARD) == (299.0, 416.0)


def test_size_falls_back_to_the_viewbox_and_its_aspect():
    vb = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 842.25 595.5">'
    assert svg_picture.css_size(vb) == (842.25, 595.5)
    w_only = '<svg width="400" viewBox="0 0 200 100">'
    assert svg_picture.css_size(w_only) == (400.0, 200.0)


def test_size_reads_units():
    w, h = svg_picture.css_size('<svg width="72pt" height="1in">')
    assert (round(w), round(h)) == (96, 96)


def test_size_is_none_when_unreadable():
    assert svg_picture.css_size("<svg>") is None
    assert svg_picture.css_size("not svg") is None


def _has_chrome():
    exe = chrome.binary()
    return os.path.exists(exe) or shutil.which(os.path.basename(exe))


@pytest.mark.skipif(not _has_chrome(), reason="no Chrome")
def test_renders_the_whole_card_at_the_asked_width(tmp_path):
    svg = tmp_path / "card.svg"
    svg.write_text(CANVA_CARD)
    out = tmp_path / "out"
    proc = subprocess.run([sys.executable, os.path.join(HERE, "svg_picture.py"), str(out),
                           f"front={svg}:600"], capture_output=True, text=True, cwd=HERE, timeout=120)
    assert proc.returncode == 0, proc.stderr
    res = json.loads(proc.stdout.strip().splitlines()[-1])
    im = Image.open(res["card"]).convert("RGB")
    # ~600 px wide (the ladder is cut from it), the card's own aspect
    assert 590 <= im.width <= 600
    assert abs(im.height / im.width - 416 / 299) < 0.01
    # scaled, not cropped: the far-corner marker is in the far corner, the middle is the card's red
    px = im.getpixel((int(im.width * 0.95), int(im.height * 0.97)))
    assert px[2] > 200 and px[0] < 60, px
    mid = im.getpixel((im.width // 2, im.height // 2))
    assert mid[0] > 200 and mid[2] < 60, mid


def test_a_front_that_cannot_render_is_a_failure(tmp_path):
    # no Chrome needed: it fails before a render (no readable size)
    bad = tmp_path / "nosize.svg"
    bad.write_text("<svg>")
    proc = subprocess.run([sys.executable, os.path.join(HERE, "svg_picture.py"), str(tmp_path / "o"),
                           f"front={bad}:600"], capture_output=True, text=True, cwd=HERE, timeout=60)
    assert proc.returncode == 1
    assert "front" in proc.stderr
