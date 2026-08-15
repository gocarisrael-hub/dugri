#!/usr/bin/env python3
"""Add bleed + crop marks (and TrimBox/BleedBox) to an existing card PDF.

Standalone version of the generator's press step (generator/press.py +
generator/deck_html.py), for running by hand on any PDF — a Canva export, a
finished deck, a single card. Every page is treated as ONE card: the page grows
outward to carry bleed and crop marks, the artwork itself is never scaled or
moved relative to its own trim.

    pip install pikepdf          # the only dependency (Ghostscript optional)

    # normal use: keep the bleed the artwork already has, draw marks, write boxes
    python3 press_marks.py in.pdf out.pdf

    # a whole folder: every PDF in it, written to cards/with-marks/
    python3 press_marks.py cards/
    python3 press_marks.py cards/ ready/ --recursive

    # ask for 3mm of bleed; whatever the artwork is short of is MIRRORED outward
    python3 press_marks.py in.pdf out.pdf --bleed 3

    # different card size, longer marks
    python3 press_marks.py in.pdf out.pdf --trim 74x105 --mark 5

    # also separate to CMYK + flatten + outline text (needs Ghostscript)
    python3 press_marks.py in.pdf out.pdf --cmyk --icc /path/to/profile.icc

WHAT IT DOES, and why

  TRIM/BLEED BOXES are the part a shop's imposition software actually reads:
  without a TrimBox nothing in the file states where the card ends inside the
  larger sheet. Drawn CROP MARKS are for the human at the cutter. This writes
  both, and both are cheap.

  BLEED is ink beyond the cut line, so a misaligned cut shows artwork instead of
  a white sliver. Most Canva exports already carry some (a 74x105mm card
  exported at 79x110 has ~2.5mm on every side) — that is `--bleed auto`, the
  default, and it manufactures nothing: every dot in the output is the original
  file's own ink. Asking for MORE than the artwork holds mirrors the outer band
  outward across the artwork edge, which is legitimate precisely because the
  bleed is cut off and thrown away — mirroring keeps colour and texture
  continuous at the cut line, which scaling the art up cannot do without
  shifting the printed frame. It is also much slower to flatten (eight extra
  clipped copies of the artwork per page), so only ask when the shop asks.

  --cmyk is optional and OFF by default: a shop that knows its own press
  separates better than we can guess from here. The OutputIntent (which declares
  the CMYK the file was separated against) is written only when the conversion
  actually ran — declaring it on a pass-through file would be a lie told to the
  one reader that trusts metadata over its eyes.
"""
import argparse
import os
import subprocess
import sys

MM = 72.0 / 25.4                    # points per millimetre
TRIM_MM = (74.0, 105.0)             # A7 — the finished dugri card
MARK_MM = 4.0                       # crop-mark length, outside the bleed
MARK_W_PT = 0.25                    # hairline: heavy marks are hard to cut to
GS = os.environ.get("GHOSTSCRIPT", "gs")


class Geometry:
    """Where the trim, the bleed and the marks fall on one card page.

    ``native_*`` is the bleed the artwork ALREADY carries (half the difference
    between the page it was exported at and the finished card). ``extra_*`` is
    what it is short of the requested bleed — the millimetres that have to be
    manufactured by mirroring.
    """

    def __init__(self, art_w, art_h, trim_mm=TRIM_MM, bleed_mm=None,
                 mark_mm=MARK_MM):
        self.art_w, self.art_h = float(art_w), float(art_h)
        self.trim_w, self.trim_h = trim_mm[0] * MM, trim_mm[1] * MM
        self.mark = mark_mm * MM
        self.native_x = max(0.0, (self.art_w - self.trim_w) / 2)
        self.native_y = max(0.0, (self.art_h - self.trim_h) / 2)
        # The SHALLOWER axis is what the artwork can guarantee on all four
        # sides, so that is the depth "use what we have" can honestly declare.
        self.bleed = (min(self.native_x, self.native_y) if bleed_mm is None
                      else bleed_mm * MM)
        self.extra_x = max(0.0, self.bleed - self.native_x)
        self.extra_y = max(0.0, self.bleed - self.native_y)
        # The page is the card plus the bleed asked for plus the mark margin —
        # measured from the TRIM, not from the artwork. Artwork carrying MORE
        # bleed than was asked for therefore overhangs the page and is clipped
        # away, which is the point: it keeps the marks on clean white paper
        # instead of drawing them over ink that is about to be cut off.
        self.page_w = self.trim_w + 2 * (self.bleed + self.mark)
        self.page_h = self.trim_h + 2 * (self.bleed + self.mark)

    @property
    def art_origin(self):
        """Bottom-left of the artwork on the grown page.

        Negative on an axis where the artwork carries more bleed than was
        asked for: it hangs off the page and the clip discards the surplus.
        """
        return (self.page_w - self.art_w) / 2, (self.page_h - self.art_h) / 2

    @property
    def trim_box(self):
        x0 = (self.page_w - self.trim_w) / 2
        y0 = (self.page_h - self.trim_h) / 2
        return [x0, y0, x0 + self.trim_w, y0 + self.trim_h]

    @property
    def bleed_box(self):
        w, h = self.trim_w + 2 * self.bleed, self.trim_h + 2 * self.bleed
        x0, y0 = (self.page_w - w) / 2, (self.page_h - h) / 2
        return [x0, y0, x0 + w, y0 + h]

    @property
    def manufactures_bleed(self):
        return self.extra_x > 1e-9 or self.extra_y > 1e-9

    def describe(self):
        surplus = max(self.native_x - self.bleed, self.native_y - self.bleed)
        made = (f"{max(self.extra_x, self.extra_y) / MM:.2f}mm mirrored"
                if self.manufactures_bleed
                else (f"{surplus / MM:.2f}mm of surplus artwork cropped"
                      # 0.01pt: below a quarter of a hundredth of a millimetre
                      # is float noise from the size conversion, not a crop.
                      if surplus > 0.01 else "nothing manufactured"))
        return (f"art {self.art_w / MM:.2f}x{self.art_h / MM:.2f}mm, "
                f"trim {self.trim_w / MM:.0f}x{self.trim_h / MM:.0f}mm, "
                f"bleed {self.bleed / MM:.2f}mm "
                f"({self.native_x / MM:.2f}mm from artwork, {made}), "
                f"page {self.page_w / MM:.1f}x{self.page_h / MM:.1f}mm")


def _bands(g):
    """The eight bleed-ring rectangles and their mirror matrices.

    Coordinates are relative to the artwork's own bottom-left corner. Each band
    is the artwork reflected across the artwork edge it borders, clipped to the
    strip outside that edge.
    """
    w, h, ex, ey = g.art_w, g.art_h, g.extra_x, g.extra_y
    mx0 = (-1, 0, 0, 1, 0, 0)               # mirror across x = 0
    mx1 = (-1, 0, 0, 1, 2 * w, 0)           # mirror across x = w
    my0 = (1, 0, 0, -1, 0, 0)               # mirror across y = 0
    my1 = (1, 0, 0, -1, 0, 2 * h)           # mirror across y = h
    def both(a, b):                          # corner: reflect across both edges
        return (-a[0], 0, 0, -b[3], a[4], b[5])
    return [
        ((-ex, 0, ex, h), mx0),                       # left
        ((w, 0, ex, h), mx1),                         # right
        ((0, -ey, w, ey), my0),                       # bottom
        ((0, h, w, ey), my1),                         # top
        ((-ex, -ey, ex, ey), both(mx0, my0)),         # bottom-left
        ((w, -ey, ex, ey), both(mx1, my0)),           # bottom-right
        ((-ex, h, ex, ey), both(mx0, my1)),           # top-left
        ((w, h, ex, ey), both(mx1, my1)),             # top-right
    ]


def _marks_ops(g):
    """Eight crop marks, aligned to the TRIM edges and outside the bleed.

    A mark drawn over the bleed would be cut away with it, so each starts at the
    bleed edge and points outwards.
    """
    tx0, ty0, tx1, ty1 = g.trim_box
    b, m = g.bleed, g.mark
    seg = []
    for x in (tx0, tx1):                                  # vertical marks
        seg.append((x, ty0 - b - m, x, ty0 - b))
        seg.append((x, ty1 + b, x, ty1 + b + m))
    for y in (ty0, ty1):                                  # horizontal marks
        seg.append((tx0 - b - m, y, tx0 - b, y))
        seg.append((tx1 + b, y, tx1 + b + m, y))
    ops = ["q", "0 G", f"{MARK_W_PT:g} w", "[] 0 d"]
    for x1, y1, x2, y2 in seg:
        ops.append(f"{x1:.4f} {y1:.4f} m {x2:.4f} {y2:.4f} l S")
    ops.append("Q")
    return "\n".join(ops)


def _content(g, name):
    """The whole page: mirrored bleed first, the artwork over it, marks last."""
    ox, oy = g.art_origin
    bx0, by0, bx1, by1 = g.bleed_box
    ops = ["q",
           # Clip to the bleed box: surplus artwork must not paint into the mark
           # margin, or the marks would sit on ink instead of on white paper.
           f"{bx0:.4f} {by0:.4f} {bx1 - bx0:.4f} {by1 - by0:.4f} re W n",
           f"1 0 0 1 {ox:.4f} {oy:.4f} cm"]
    if g.manufactures_bleed:
        for (x, y, w, h), mtx in _bands(g):
            if w <= 1e-9 or h <= 1e-9:
                continue
            ops.append("q")
            ops.append(f"{x:.4f} {y:.4f} {w:.4f} {h:.4f} re W n")
            ops.append(" ".join(f"{v:.4f}" for v in mtx) + " cm")
            ops.append(f"/{name} Do")
            ops.append("Q")
    ops.append(f"/{name} Do")                 # the card paints over its bleed
    ops.append("Q")
    ops.append(_marks_ops(g))                 # nothing paints over the marks
    return "\n".join(ops).encode("ascii")


def add_marks(src_pdf, out_pdf, trim_mm=TRIM_MM, bleed_mm=None, mark_mm=MARK_MM,
              verbose=True):
    """Grow every page of ``src_pdf`` into a press sheet."""
    import pikepdf
    src = pikepdf.open(src_pdf)
    dst = pikepdf.new()
    first = None
    for i, spage in enumerate(src.pages):
        mb = [float(v) for v in spage.mediabox]
        g = Geometry(mb[2] - mb[0], mb[3] - mb[1], trim_mm, bleed_mm, mark_mm)
        if first is None:
            first = g
        form = dst.copy_foreign(pikepdf.Page(spage).as_form_xobject())
        page = dst.add_blank_page(page_size=(g.page_w, g.page_h))
        page.contents_add(dst.make_stream(_content(g, "Art")))
        page.Resources = dst.make_indirect(pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Art=form)))
        page.obj["/TrimBox"] = pikepdf.Array(g.trim_box)
        page.obj["/BleedBox"] = pikepdf.Array(g.bleed_box)
    if verbose and first is not None:
        print(f"{len(src.pages)} page(s): {first.describe()}")
    dst.save(out_pdf)
    src.close()
    return out_pdf


def cmyk_flatten(src_pdf, out_pdf, icc=None, timeout=1800):
    """Ghostscript pass: CMYK, transparency flattened, text converted to paths.

    ``-dCompatibilityLevel=1.3`` is what forces the flattening — PDF 1.3 has no
    transparency model, so groups and soft masks are composited away.
    ``-dNoOutputFonts`` turns text into outlines, which removes both the font
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
    # A sandbox refusal reads as "Permission denied" while pdfwrite may still
    # have written a file, so any non-zero exit is fatal: a wrong-profile PDF
    # must never reach a print shop.
    if proc.returncode != 0:
        raise RuntimeError(f"ghostscript failed (exit {proc.returncode}): "
                           f"{(proc.stderr or '').strip()[:400]}")
    return out_pdf


def set_output_intent(pdf_path, icc, condition="SWOP2006_Coated3v2"):
    """Declare which CMYK the file was separated against. CMYK mode only."""
    import pikepdf
    with open(icc, "rb") as f:
        blob = f.read()
    with pikepdf.open(pdf_path, allow_overwriting_input=True) as pdf:
        stream = pdf.make_stream(blob)
        stream["/N"] = 4
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


def _trim(text):
    try:
        w, h = text.lower().replace(",", "x").split("x")
        return (float(w), float(h))
    except ValueError:
        raise argparse.ArgumentTypeError("--trim wants WIDTHxHEIGHT in mm, "
                                         "e.g. 74x105")


OUT_DIR_NAME = "with-marks"         # default sibling folder for a folder run


def _pdfs_in(folder, recursive=False, skip_dir=None):
    """Every PDF under ``folder``, sorted, with ``skip_dir``'s subtree left out.

    ``skip_dir`` is the output folder: a recursive run whose output lives inside
    the input would otherwise re-process its own results on the next pass.
    """
    found = []
    skip = os.path.abspath(skip_dir) + os.sep if skip_dir else None
    for root, dirs, files in os.walk(folder):
        if skip and (os.path.abspath(root) + os.sep).startswith(skip):
            dirs[:] = []
            continue
        for f in files:
            if f.lower().endswith(".pdf") and not f.startswith("."):
                found.append(os.path.join(root, f))
        if not recursive:
            break
        dirs.sort()
    return sorted(found)


def _process_one(src, out, trim_mm, bleed_mm, mark_mm, cmyk=False, icc=None):
    """One file through the whole press step: marks, then the optional CMYK."""
    if os.path.abspath(src) == os.path.abspath(out):
        raise ValueError("output would overwrite the input; pick another path")
    out_dir = os.path.dirname(os.path.abspath(out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    add_marks(src, out, trim_mm=trim_mm, bleed_mm=bleed_mm, mark_mm=mark_mm)
    if cmyk:
        tmp = out + ".cmyk.tmp"
        cmyk_flatten(out, tmp, icc=icc)
        os.replace(tmp, out)
        # Ghostscript drops TrimBox/BleedBox, so write them again on the way out.
        add_boxes_only(out, trim_mm, bleed_mm, mark_mm)
        if icc:
            set_output_intent(out, icc)
    return out


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Add bleed, crop marks and TrimBox/BleedBox to card PDFs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Each PAGE of the input is treated as one card. SRC may be a "
               "folder, in which case every PDF in it is processed.")
    p.add_argument("src", help="a PDF, or a folder of PDFs")
    p.add_argument("out", nargs="?",
                   help="output PDF, or output folder when SRC is a folder "
                        f"(default: SRC/{OUT_DIR_NAME} for a folder, "
                        "NAME_marks.pdf for a file)")
    p.add_argument("-r", "--recursive", action="store_true",
                   help="with a folder SRC, also descend into subfolders "
                        "(their layout is reproduced under the output folder)")
    p.add_argument("--trim", type=_trim, default=TRIM_MM,
                   help="finished card size in mm (default 74x105)")
    p.add_argument("--bleed", default="auto",
                   help="bleed in mm, or 'auto' (default) to keep exactly what "
                        "the artwork already carries and mirror nothing")
    p.add_argument("--mark", type=float, default=MARK_MM,
                   help="crop-mark length in mm (default 4)")
    p.add_argument("--cmyk", action="store_true",
                   help="also separate to CMYK, flatten and outline text "
                        "(Ghostscript; slow — most shops prefer to convert)")
    p.add_argument("--icc", help="CMYK ICC profile for --cmyk; also writes the "
                                 "OutputIntent")
    a = p.parse_args(argv)

    bleed = None if str(a.bleed).lower() == "auto" else float(a.bleed)
    if a.icc and not a.cmyk:
        p.error("--icc only means something with --cmyk (see the module note "
                "on declaring an OutputIntent on an unconverted file)")
    if a.recursive and not os.path.isdir(a.src):
        p.error("--recursive only means something when SRC is a folder")

    if not os.path.isdir(a.src):
        stem, ext = os.path.splitext(a.src)
        out = a.out or f"{stem}_marks{ext or '.pdf'}"
        _process_one(out=out, src=a.src, trim_mm=a.trim, bleed_mm=bleed,
                     mark_mm=a.mark, cmyk=a.cmyk, icc=a.icc)
        print(f"wrote {out}")
        return 0

    out_dir = a.out or os.path.join(a.src, OUT_DIR_NAME)
    if os.path.abspath(out_dir) == os.path.abspath(a.src):
        p.error("the output folder must differ from the input folder — "
                "writing into it would overwrite the originals")
    srcs = _pdfs_in(a.src, a.recursive, skip_dir=out_dir)
    if not srcs:
        print(f"no PDFs in {a.src}", file=sys.stderr)
        return 1

    failed = []
    for i, src in enumerate(srcs, 1):
        # Mirror the input's own layout under the output folder, so a recursive
        # run cannot collide two same-named files from different subfolders.
        out = os.path.join(out_dir, os.path.relpath(src, a.src))
        print(f"[{i}/{len(srcs)}] {os.path.relpath(src, a.src)}: ", end="",
              flush=True)
        try:
            _process_one(src, out, a.trim, bleed, a.mark, a.cmyk, a.icc)
        except Exception as e:                # one bad file must not stop the run
            failed.append((src, e))
            print(f"FAILED — {e}")        # finishes the line started above
    print(f"wrote {len(srcs) - len(failed)}/{len(srcs)} to {out_dir}")
    if failed:
        # stdout, like the per-file lines: two streams interleave unpredictably
        # when the run is piped, and the exit code is what signals the failure.
        print(f"{len(failed)} failed:")
        for src, e in failed:
            print(f"  {src}: {e}")
        return 1
    return 0


def add_boxes_only(pdf_path, trim_mm, bleed_mm, mark_mm):
    """Re-assert TrimBox/BleedBox on a file whose pages are already press-sized.

    Centred in the page we actually got rather than at the ideal offsets: the
    artwork is centred by construction, so centring the boxes tracks it exactly
    even when a producer rounded the page size.
    """
    import pikepdf
    with pikepdf.open(pdf_path, allow_overwriting_input=True) as pdf:
        for page in pdf.pages:
            mb = [float(v) for v in page.obj["/MediaBox"]]
            pw, ph = mb[2] - mb[0], mb[3] - mb[1]
            tw, th = trim_mm[0] * MM, trim_mm[1] * MM
            bleed = ((pw - tw) / 2 - mark_mm * MM if bleed_mm is None
                     else bleed_mm * MM)
            bleed = max(0.0, bleed)
            for name, (w, h) in (("/TrimBox", (tw, th)),
                                 ("/BleedBox", (tw + 2 * bleed, th + 2 * bleed))):
                cx, cy = (mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2
                page.obj[name] = pikepdf.Array([
                    max(mb[0], cx - w / 2), max(mb[1], cy - h / 2),
                    min(mb[2], cx + w / 2), min(mb[3], cy + h / 2)])
        pdf.save()


if __name__ == "__main__":
    sys.exit(main())
