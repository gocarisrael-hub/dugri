#!/usr/bin/env python3
"""Tests for generator/press.py — the press-ready (shop) copy of a deck.

What a print shop asked for, and what Chrome's print-to-pdf cannot give them:

  1. CMYK, against a named profile — Chrome emits DeviceRGB.
  2. "Flattened" — Chrome emits live text and transparency (measured on a real
     208-page deck: 2 embedded fonts, 529 transparency groups, 317 soft masks).
  3. Somewhere in the file that says WHERE TO CUT — Chrome emits no TrimBox, so
     nothing states where the A7 card sits inside the page.
  4. The agreed 3 mm of bleed, when the artwork only carries ~2.5 mm — so the
     last half-millimetre per side has to be manufactured.

The geometry tests run everywhere. The ones that shell out to Ghostscript skip
when it is not installed rather than fail the suite.
"""
import os
import shutil
import subprocess

import pytest

import press

ART_W, ART_H = 223.92, 312.0        # the real grapefruit card, in points
VB = [0, 0, ART_W, ART_H]
HAS_GS = shutil.which(press.GS) is not None
try:
    import pikepdf
    HAS_PIKEPDF = True
except ImportError:                  # pragma: no cover - env-dependent
    HAS_PIKEPDF = False


def _mm(pt):
    return pt / press.MM


# --- 1. geometry -------------------------------------------------------------

def test_trim_is_a7_whatever_bleed_is_asked_for():
    for bleed in (3.0, 6.0, 10.0):
        g = press.PressGeometry(ART_W, ART_H, bleed_mm=bleed)
        box = g.trim_box
        assert round(_mm(box[2] - box[0]), 2) == 74.0
        assert round(_mm(box[3] - box[1]), 2) == 105.0


def test_bleed_box_is_the_trim_plus_the_requested_bleed():
    g = press.PressGeometry(ART_W, ART_H, bleed_mm=6.0)
    box = g.bleed_box
    assert round(_mm(box[2] - box[0]), 2) == 86.0      # 74 + 2x6
    assert round(_mm(box[3] - box[1]), 2) == 117.0     # 105 + 2x6


def test_native_bleed_is_derived_from_the_artwork_not_assumed():
    """Canva exported grapefruit at 78.99 x 110.07 mm around a 74 x 105 trim.

    Assuming a fixed native bleed would put the trim line in the wrong place on
    any template exported with different settings, so it is measured.
    """
    g = press.PressGeometry(ART_W, ART_H, bleed_mm=6.0)
    assert round(_mm(g.native_x), 2) == 2.5
    assert round(_mm(g.native_y), 2) == 2.53
    # ...so this much has to be manufactured by mirroring.
    assert round(_mm(g.extra_x), 2) == 3.5
    assert round(_mm(g.extra_y), 2) == 3.47


def test_artwork_with_enough_bleed_needs_none_manufactured():
    g = press.PressGeometry(ART_W, ART_H, bleed_mm=2.0)
    assert g.extra_x == 0 and g.extra_y == 0, "never negative: just trim deeper"


def test_default_bleed_is_the_agreed_3mm_and_barely_mirrors():
    """The shop accepted 3 mm, and the artwork already carries ~2.5 mm.

    So the default manufactures only the last half-millimetre per side. Pinning
    this stops the default drifting back to a depth that mirrors most of the
    band when the artwork could have supplied it.
    """
    g = press.PressGeometry(ART_W, ART_H)
    assert round(_mm(g.bleed), 2) == 3.0
    assert round(_mm(g.extra_x), 2) == 0.50
    assert round(_mm(g.extra_y), 2) == 0.47
    assert g.extra_x < g.native_x, "most of the bleed is the artwork's own ink"


def test_page_carries_bleed_and_the_mark_margin():
    g = press.PressGeometry(ART_W, ART_H, bleed_mm=6.0, mark_mm=4.0)
    assert round(_mm(g.page_w), 2) == 94.0       # 74 + 2x6 + 2x4
    assert round(_mm(g.page_h), 2) == 125.0


def test_view_box_grows_around_the_artwork_without_moving_it():
    """Adding bleed must not shift a single calibrated text slot."""
    g = press.PressGeometry(ART_W, ART_H)
    x, y, w, h = g.view_box(VB)
    assert x < 0 and y < 0, "the page grows outwards"
    # The artwork still occupies exactly 0..ART_W / 0..ART_H inside the page, so
    # every slot measured against the card means the same thing as before.
    assert round(-x, 4) == round((w - ART_W) / 2, 4), "artwork stays centred in x"
    assert round(-y, 4) == round((h - ART_H) / 2, 4), "artwork stays centred in y"
    assert x + w > ART_W and y + h > ART_H, "the page extends past the artwork"


# --- 2. the boxes written into the PDF ---------------------------------------

def test_boxes_are_centred_in_the_page_we_actually_got():
    """Chrome rounds @page to device units — asking 94x125mm gave 93.81x124.88.

    Absolute offsets would put the trim line ~0.2 mm off, so the boxes are
    centred in the real MediaBox instead.
    """
    g = press.PressGeometry(ART_W, ART_H)
    media = [0, 0, 265.92, 354.0]                # the size Chrome really emits
    box = press._centred(media, g.trim_w, g.trim_h)
    assert round(_mm(box[2] - box[0]), 2) == 74.0
    assert round(box[0] + box[2], 6) == round(media[0] + media[2], 6), "centred in x"
    assert round(box[1] + box[3], 6) == round(media[1] + media[3], 6), "centred in y"


def test_centred_box_never_escapes_the_page():
    box = press._centred([0, 0, 50, 50], 999, 999)
    assert box == [0, 0, 50, 50]


@pytest.mark.skipif(not HAS_PIKEPDF, reason="pikepdf not installed")
def test_set_boxes_writes_trim_and_bleed_on_every_page(tmp_path):
    import pikepdf
    src = tmp_path / "in.pdf"
    pdf = pikepdf.Pdf.new()
    for _ in range(3):
        pdf.add_blank_page(page_size=(265.92, 354.0))
    pdf.save(src)
    g = press.PressGeometry(ART_W, ART_H)
    press.set_boxes(str(src), g)
    with pikepdf.open(src) as out:
        assert len(out.pages) == 3
        for page in out.pages:
            trim = [float(v) for v in page.obj["/TrimBox"]]
            bleed = [float(v) for v in page.obj["/BleedBox"]]
            assert round(_mm(trim[2] - trim[0]), 2) == 74.0
            assert round(_mm(bleed[2] - bleed[0]), 2) == 80.0   # 74 + 2x3mm


@pytest.mark.skipif(not HAS_PIKEPDF, reason="pikepdf not installed")
def test_output_intent_embeds_the_profile(tmp_path):
    """A shop reads the OutputIntent to know which CMYK the file is separated for."""
    import pikepdf
    icc = tmp_path / "fake.icc"
    icc.write_bytes(b"\0" * 512)                 # contents are opaque to us here
    src = tmp_path / "in.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(265.92, 354.0))
    pdf.save(src)
    press.set_boxes(str(src), press.PressGeometry(ART_W, ART_H), icc=str(icc),
                    condition="TestCondition")
    with pikepdf.open(src) as out:
        intent = out.Root["/OutputIntents"][0]
        assert str(intent["/S"]) == "/GTS_PDFX"
        assert str(intent["/OutputConditionIdentifier"]) == "TestCondition"
        assert int(intent["/DestOutputProfile"]["/N"]) == 4, "CMYK profile"


# --- 3. the Ghostscript pass -------------------------------------------------

def test_a_missing_profile_is_refused_before_ghostscript_runs(tmp_path):
    with pytest.raises(FileNotFoundError):
        press.cmyk_flatten("whatever.pdf", str(tmp_path / "o.pdf"),
                           icc=str(tmp_path / "nope.icc"))


@pytest.mark.skipif(not HAS_GS, reason="ghostscript not installed")
def test_cmyk_flatten_removes_rgb_fonts_and_transparency(tmp_path):
    src = tmp_path / "in.pdf"
    # A PostScript source keeps the fixture independent of Chrome.
    ps = tmp_path / "in.ps"
    ps.write_text("%!PS\n/Helvetica findfont 24 scalefont setfont\n"
                  "1 0 0 setrgbcolor 72 72 moveto (press) show showpage\n")
    subprocess.run([press.GS, "-dBATCH", "-dNOPAUSE", "-dQUIET",
                    "-sDEVICE=pdfwrite", f"-sOutputFile={src}", str(ps)],
                   check=True, capture_output=True)
    out = tmp_path / "out.pdf"
    press.cmyk_flatten(str(src), str(out))
    data = out.read_bytes()
    assert data.startswith(b"%PDF-1.3"), "PDF 1.3 has no transparency model"
    assert b"/DeviceRGB" not in data
    assert b"/FontFile" not in data, "-dNoOutputFonts must outline the text"
    assert b"/Type /Font" not in data


def test_gs_failure_is_fatal_rather_than_silently_wrong(tmp_path, monkeypatch):
    """The trap this guards: Ghostscript 10 sandboxes file reads, and a BLOCKED
    ICC read does not abort the job — it falls back to a built-in profile and
    still writes a plausible CMYK file. Shipping that would mean a wrong-colour
    print run, so any non-zero exit has to raise."""
    class Result:
        returncode = 1
        stderr = "Last OS error: Permission denied"
        stdout = ""

    monkeypatch.setattr(press.subprocess, "run", lambda *a, **k: Result())
    with pytest.raises(RuntimeError, match="ghostscript failed"):
        press.cmyk_flatten("in.pdf", str(tmp_path / "out.pdf"))
