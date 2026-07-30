#!/usr/bin/env python3
"""Turn a rendered deck into a PRESS-READY PDF for a professional print shop.

Chrome's ``--print-to-pdf`` gives us a good screen PDF and a poor press one.
Measured on a real 208-page grapefruit deck, its output carried:

  * DeviceRGB, with no OutputIntent — presses run CMYK inks;
  * 2 embedded subset fonts and 529 transparency groups with 317 soft masks —
    what a shop means when it asks for a "flattened" file;
  * no TrimBox and no BleedBox — so nothing in the file says where to cut, and
    the shop has to guess where the A7 card sits inside the page.

This module fixes all three in one Ghostscript pass plus a box-writing pass, and
adds the bleed geometry the cutter needs (see ``PressGeometry``).

WHY NOT DO THIS IN CANVA. The obvious alternative is to export a flattened PDF
from Canva instead. That would mean abandoning the generator — every order is
built here from an SVG, not in Canva — so the flattening belongs in this
pipeline. What a shop actually wants has a name, PDF/X-1a: CMYK, no live
transparency, no font dependencies. That is what this produces.
"""
import os
import shutil
import subprocess
import tempfile

MM = 72.0 / 25.4          # points per millimetre

# A7, the finished card. The artwork pages are bigger than this because they
# already carry some bleed; how much is derived, never assumed (see below).
TRIM_MM = (74.0, 105.0)
# None means "whatever bleed the artwork already carries" — the owner's choice,
# and the only setting that manufactures nothing at all: every dot in the file is
# Canva's own ink.
#
# It is also the fast one. Manufacturing the missing millimetres means mirroring
# the outer band outward, which puts eight extra clipped copies of the artwork on
# every page; Ghostscript then has ~9x the work to flatten. Measured on ten
# grapefruit pages: 6.7s without them, 58.1s with — 2.3 minutes versus 20 for a
# 208-page deck.
#
# Set a number (in mm) to ask for a specific depth; anything beyond what the
# artwork holds is mirrored, and pays that cost.
BLEED_MM = None
# Crop marks sit OUTSIDE the bleed — a mark drawn over the bleed would print on
# the part of the sheet that gets cut away and be useless. This is their length;
# they start at the bleed edge and point outwards.
MARK_MM = 4.0
# Hairline, the prepress convention: heavy marks are hard to cut to accurately.
MARK_W_PT = 0.25

# Ghostscript 10 refuses to read files outside its sandbox, and a blocked ICC
# read does NOT abort the job — it falls back to a built-in profile and still
# writes a plausible CMYK file. That silently ships the wrong colour, so every
# run passes --permit-file-read for the profile AND checks the exit code.
GS = os.environ.get("GHOSTSCRIPT", "gs")


class PressGeometry:
    """Where the trim, the bleed and the marks fall on one card page.

    All the awkwardness lives here: the artwork ALREADY has some bleed (Canva
    exported the grapefruit card at 78.99 x 110.07 mm around a 74 x 105 trim, so
    ~2.5 mm on every side), and how much differs per template. Deriving it from
    the artwork rather than assuming it means a template exported with different
    bleed still lands its trim in the right place.

    ``extra_x``/``extra_y`` are what the artwork is SHORT of the requested
    bleed. That ink does not exist in the SVG and has to be manufactured by
    mirroring the outer band outwards — legitimate because the bleed is cut off
    and discarded; its only job is to stop a misaligned cut showing white.
    """

    def __init__(self, art_w, art_h, trim_mm=TRIM_MM, bleed_mm=BLEED_MM,
                 mark_mm=MARK_MM):
        self.art_w, self.art_h = float(art_w), float(art_h)
        self.trim_w, self.trim_h = trim_mm[0] * MM, trim_mm[1] * MM
        self.mark = mark_mm * MM
        self.mark_w = MARK_W_PT
        # Bleed the artwork already carries, per axis.
        self.native_x = max(0.0, (self.art_w - self.trim_w) / 2)
        self.native_y = max(0.0, (self.art_h - self.trim_h) / 2)
        # The SHALLOWER axis is what the artwork can guarantee on all four
        # sides, so that is the depth "use what we have" can honestly declare.
        self.bleed = (min(self.native_x, self.native_y) if bleed_mm is None
                      else bleed_mm * MM)
        # Bleed still to be manufactured, per axis. Never negative: artwork with
        # MORE bleed than asked for is fine, it just gets trimmed deeper.
        self.extra_x = max(0.0, self.bleed - self.native_x)
        self.extra_y = max(0.0, self.bleed - self.native_y)
        self.page_w = self.trim_w + 2 * (self.bleed + self.mark)
        self.page_h = self.trim_h + 2 * (self.bleed + self.mark)

    @property
    def trim_box(self):
        """TrimBox in PDF points, origin at the page's bottom-left."""
        x0 = self.bleed + self.mark
        y0 = self.bleed + self.mark
        return [x0, y0, x0 + self.trim_w, y0 + self.trim_h]

    @property
    def bleed_box(self):
        x0 = self.mark
        y0 = self.mark
        return [x0, y0, x0 + self.trim_w + 2 * self.bleed,
                y0 + self.trim_h + 2 * self.bleed]

    def margins(self, vb):
        """(left, top) growth of the page, in the artwork's user units."""
        ux, uy = vb[2] / self.art_w, vb[3] / self.art_h    # units per point
        return (self.extra_x + self.mark) * ux, (self.extra_y + self.mark) * uy

    def view_box(self, vb):
        """The page's viewBox in the ARTWORK's own user units.

        The artwork keeps its coordinates; the page simply grows around it, so
        every text slot and every calibration measured against the card is
        untouched by adding bleed.
        """
        left, top = self.margins(vb)
        return (vb[0] - left, vb[1] - top, vb[2] + 2 * left, vb[3] + 2 * top)

    @property
    def manufactures_bleed(self):
        """True when some of the bleed has to be mirrored into existence."""
        return self.extra_x > 1e-9 or self.extra_y > 1e-9

    def describe(self):
        made = (f"{self.extra_x / MM:.2f}mm mirrored"
                if self.manufactures_bleed else "nothing manufactured")
        return (f"trim {self.trim_w / MM:.0f}x{self.trim_h / MM:.0f}mm, "
                f"bleed {self.bleed / MM:.2f}mm "
                f"({self.native_x / MM:.2f}mm from artwork, {made}), "
                f"page {self.page_w / MM:.1f}x{self.page_h / MM:.1f}mm")


def cmyk_flatten(src_pdf, out_pdf, icc=None, timeout=900):
    """Ghostscript pass: CMYK, transparency flattened, text converted to paths.

    ``-dCompatibilityLevel=1.3`` is what forces the flattening — PDF 1.3 has no
    transparency model, so the groups and soft masks are composited away.
    ``-dNoOutputFonts`` turns the text into outlines, which removes both the font
    licensing question and any chance of the shop substituting a face.
    """
    cmd = [GS, "-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pdfwrite",
           "-dCompatibilityLevel=1.3", "-dPDFSETTINGS=/prepress",
           "-sColorConversionStrategy=CMYK", "-sProcessColorModel=DeviceCMYK",
           "-dNoOutputFonts", "-dAutoRotatePages=/None",
           "-dDetectDuplicateImages=true"]
    if icc:
        icc = os.path.abspath(icc)
        if not os.path.exists(icc):
            raise FileNotFoundError(f"ICC profile not found: {icc}")
        cmd += [f"-sOutputICCProfile={icc}", f"--permit-file-read={icc}"]
    cmd += [f"-sOutputFile={out_pdf}", src_pdf]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        # A sandbox refusal reads as "Permission denied" here while pdfwrite may
        # still have produced a file. Treat any non-zero exit as fatal so a
        # wrong-profile PDF can never reach a customer.
        raise RuntimeError(
            f"ghostscript failed (exit {proc.returncode}) converting to CMYK. "
            f"stderr: {(proc.stderr or '').strip()[:400]}")
    if not os.path.exists(out_pdf):
        raise RuntimeError("ghostscript reported success but wrote no PDF")
    return out_pdf


def _centred(media_box, w, h):
    """A ``w`` x ``h`` box centred inside ``media_box``, clamped to it."""
    x0, y0, x1, y1 = media_box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return [max(x0, cx - w / 2), max(y0, cy - h / 2),
            min(x1, cx + w / 2), min(y1, cy + h / 2)]


def set_boxes(pdf_path, geom, icc=None, condition="SWOP2006_Coated3v2"):
    """Write TrimBox/BleedBox on every page, and the OutputIntent once.

    The BOXES are the part a shop's imposition software actually reads; drawn
    crop marks are for the human. Without a TrimBox nothing in the file states
    where the A7 card sits inside the larger sheet — which is why the shop had to
    ask in the first place.
    """
    import pikepdf
    with pikepdf.open(pdf_path, allow_overwriting_input=True) as pdf:
        for page in pdf.pages:
            # CENTRE the boxes in the page we actually got, rather than trust the
            # ideal offsets. Chrome rounds @page to whole device units — asking
            # for 94x125mm yielded 93.81x124.88 — so absolute offsets would put
            # the trim line ~0.2mm off. The artwork is centred on the page by
            # construction, so centring the boxes tracks it exactly.
            mb = [float(v) for v in page.obj["/MediaBox"]]
            page.obj["/TrimBox"] = pikepdf.Array(_centred(mb, geom.trim_w, geom.trim_h))
            page.obj["/BleedBox"] = pikepdf.Array(_centred(
                mb, geom.trim_w + 2 * geom.bleed, geom.trim_h + 2 * geom.bleed))
        if icc:
            with open(icc, "rb") as f:
                blob = f.read()
            stream = pdf.make_stream(blob)
            stream["/N"] = 4                      # CMYK
            pdf.Root["/OutputIntents"] = pikepdf.Array([
                pdf.make_indirect(pikepdf.Dictionary({
                    "/Type": pikepdf.Name("/OutputIntent"),
                    "/S": pikepdf.Name("/GTS_PDFX"),
                    "/OutputConditionIdentifier": pikepdf.String(condition),
                    "/Info": pikepdf.String(condition),
                    "/DestOutputProfile": pdf.make_indirect(stream),
                }))
            ])
        pdf.save()
    return pdf_path


def press_pdf(src_pdf, out_pdf, geom, icc=None):
    """The whole press pass: CMYK + flatten, then the boxes and OutputIntent."""
    tmp = tempfile.mkdtemp(prefix="dugri-press-")
    try:
        staged = os.path.join(tmp, "cmyk.pdf")
        cmyk_flatten(src_pdf, staged, icc=icc)
        set_boxes(staged, geom, icc=icc)
        shutil.move(staged, out_pdf)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return out_pdf
