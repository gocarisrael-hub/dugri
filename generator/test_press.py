#!/usr/bin/env python3
"""Tests for generator/press.py — the press-ready (shop) copy of a deck.

What a print shop asked for, and what Chrome's print-to-pdf cannot give them:

  1. CMYK, against a named profile — Chrome emits DeviceRGB.
  2. "Flattened" — Chrome emits live text and transparency (measured on a real
     208-page deck: 2 embedded fonts, 529 transparency groups, 317 soft masks).
  3. Somewhere in the file that says WHERE TO CUT — Chrome emits no TrimBox, so
     nothing states where the A7 card sits inside the page.
  4. Bleed and crop marks, on a sheet grown to carry them. By default the bleed
     is whatever the artwork already holds, so nothing is manufactured.

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


def test_default_bleed_is_whatever_the_artwork_carries():
    """The owner's choice: manufacture nothing, ship only Canva's own ink.

    It is also the fast path. Mirroring puts eight extra clipped copies of the
    artwork on every page and Ghostscript then has ~9x the flattening work —
    measured at 6.7s vs 58.1s over ten pages, i.e. 2.3 minutes against 20 for a
    full deck. So "no manufactured bleed" and "fast" are the same setting.
    """
    g = press.PressGeometry(ART_W, ART_H)
    assert g.extra_x == 0 and g.extra_y == 0
    assert g.manufactures_bleed is False
    # The shallower axis is what the artwork can guarantee on all four sides.
    assert round(_mm(g.bleed), 2) == round(_mm(min(g.native_x, g.native_y)), 2)
    assert round(_mm(g.bleed), 2) == 2.50


def test_asking_for_more_than_the_artwork_holds_turns_mirroring_on():
    g = press.PressGeometry(ART_W, ART_H, bleed_mm=6.0)
    assert g.manufactures_bleed is True
    assert round(_mm(g.extra_x), 2) == 3.5


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
            assert round(_mm(bleed[2] - bleed[0]), 2) == 78.99  # the artwork itself


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


def test_press_pdf_runs_ghostscript_in_the_default_mode(tmp_path, monkeypatch):
    """Nothing about the default changed: cmyk_flatten still runs, with the ICC."""
    calls = []
    monkeypatch.setattr(press, "cmyk_flatten",
                        lambda src, out, **kw: (calls.append((src, out, kw)),
                                                open(out, "wb").write(b"%PDF-"))[0])
    monkeypatch.setattr(press, "set_boxes",
                        lambda p, g, **kw: calls.append(("boxes", kw)) or p)
    src = tmp_path / "in.pdf"
    src.write_bytes(b"%PDF-")
    press.press_pdf(str(src), str(tmp_path / "out.pdf"),
                    press.PressGeometry(ART_W, ART_H), icc="/some/profile.icc")
    assert calls[0][2]["icc"] == "/some/profile.icc"
    assert calls[1] == ("boxes", {"icc": "/some/profile.icc",
                                  "mode": press.MODE_CMYK})


# --- 4. pass-through: the colour pass switched off ---------------------------
# The owner's switch (settings press.cmyk_pass). The shop separates the colour
# itself, so the two minutes of Ghostscript buy nothing; the geometry is a
# different question and is NOT part of what was dropped.

def test_passthrough_never_shells_out_to_ghostscript(tmp_path, monkeypatch):
    """The whole point of the mode. Any Ghostscript here and the speedup is gone."""
    def boom(*a, **k):                       # pragma: no cover - must not run
        raise AssertionError("pass-through must not run Ghostscript")

    monkeypatch.setattr(press, "cmyk_flatten", boom)
    monkeypatch.setattr(press.subprocess, "run", boom)
    boxed = []
    monkeypatch.setattr(press, "set_boxes",
                        lambda p, g, **kw: boxed.append(kw) or p)
    src = tmp_path / "in.pdf"
    src.write_bytes(b"%PDF-1.4 rgb deck")
    out = tmp_path / "out.pdf"
    press.press_pdf(str(src), str(out), press.PressGeometry(ART_W, ART_H),
                    icc="/some/profile.icc", cmyk=False)
    assert out.read_bytes() == b"%PDF-1.4 rgb deck", "the rendered deck, untouched"
    # The ICC is dropped at this level, not merely unused: an OutputIntent names
    # the condition a file was SEPARATED against, and nothing separated this one.
    assert boxed == [{"mode": press.MODE_PASSTHROUGH}]


def test_passthrough_leaves_the_output_alone_when_it_fails(tmp_path, monkeypatch):
    """src and out are the SAME file in a real build (build.py press_pdf(out, out)).

    An in-place edit that died halfway would destroy the only rendered copy, so
    the work is staged and moved — in this mode as in the other.
    """
    monkeypatch.setattr(press, "set_boxes",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("nope")))
    deck = tmp_path / "deck.pdf"
    deck.write_bytes(b"%PDF-1.4 the whole rendered deck")
    with pytest.raises(RuntimeError):
        press.press_pdf(str(deck), str(deck), press.PressGeometry(ART_W, ART_H),
                        cmyk=False)
    assert deck.read_bytes() == b"%PDF-1.4 the whole rendered deck"


@pytest.mark.skipif(not HAS_PIKEPDF, reason="pikepdf not installed")
def test_passthrough_writes_the_boxes_but_declares_no_cmyk(tmp_path):
    """The geometry is kept; the colour claim is not made.

    press.py:177 is the reason: without a TrimBox nothing in the file says where
    the card ends. A CMYK OutputIntent on an unconverted file, by contrast, would
    be the file's own metadata lying to the one reader that believes it.
    """
    import pikepdf
    src = tmp_path / "deck.pdf"
    pdf = pikepdf.Pdf.new()
    for _ in range(3):
        pdf.add_blank_page(page_size=(265.92, 354.0))
    pdf.save(src)
    out = tmp_path / "press.pdf"
    press.press_pdf(str(src), str(out), press.PressGeometry(ART_W, ART_H),
                    icc=str(tmp_path / "unused.icc"), cmyk=False)
    with pikepdf.open(out) as got:
        assert len(got.pages) == 3, "every page survives"
        for page in got.pages:
            trim = [float(v) for v in page.obj["/TrimBox"]]
            assert round(_mm(trim[2] - trim[0]), 2) == 74.0
            assert "/BleedBox" in page.obj
        assert "/OutputIntents" not in got.Root
        assert str(got.docinfo[press.MODE_KEY]) == press.MODE_PASSTHROUGH


@pytest.mark.skipif(not HAS_PIKEPDF, reason="pikepdf not installed")
def test_the_two_modes_stamp_different_document_info(tmp_path):
    """A press file has to stay identifiable long after the build that made it.

    The owner will have both kinds in one orders folder and they look identical
    in any viewer — the same failure mode as the RGB intermediate the release
    gate exists to catch.
    """
    import pikepdf
    src = tmp_path / "in.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(265.92, 354.0))
    pdf.save(src)
    icc = tmp_path / "fake.icc"
    icc.write_bytes(b"\0" * 512)
    press.set_boxes(str(src), press.PressGeometry(ART_W, ART_H), icc=str(icc),
                    mode=press.MODE_CMYK)
    with pikepdf.open(src) as got:
        assert str(got.docinfo[press.MODE_KEY]) == press.MODE_CMYK
        assert "/OutputIntents" in got.Root
    assert press.MODE_CMYK != press.MODE_PASSTHROUGH


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
