"""Turn a finished deck PDF into the pages a buyer can actually look at.

THE PROOF IS THE ARTEFACT, NOT A PICTURE OF IT. The deck has already been
produced by the time anyone wants to check it, and rendering it a second way —
in a browser, from the same words — would recreate the drift this project has
spent real money on: a screen that says one thing and a press that prints
another. So the pages come out of the PDF itself, through ghostscript, which is
already in the image for the press export.

ONE ghostscript pass for the whole deck, not one per page. A deck is ~104 pages;
104 processes would cost more in start-up than in drawing, and the owner's
scaling audit already found preview dying at two concurrent renders.

    python3 proof_sheet.py deck.pdf out/ --width 320

Answers `{"pages": n, "files": [...]}` on stdout so the caller never has to guess
what landed on disk.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

# Wide enough to read four words on a card at a glance, small enough that a
# hundred of them are not a download. The buyer opens one large when she wants
# to READ it; the grid only has to be recognisable.
DEFAULT_WIDTH = 320
# 2x the grid width, so the page still looks sharp when one is opened large.
RENDER_SCALE = 2
GS = os.environ.get("GHOSTSCRIPT", "gs")
# A deck is ~104 pages. The cap is a guard against a runaway file, not a limit
# anyone should reach — a real order is nowhere near it.
MAX_PAGES = 400


def _page_width_pt(pdf):
    """The first page's width in points, so the render dpi can be chosen.

    Rendering at a FIXED dpi is the trap: a card page is 224pt and an A4 board
    page is 595pt, so one dpi either blurs the cards or writes 8MB PNGs for the
    boards — and a deck is ~104 pages, all of them on the same volume the orders
    live on. Reading the box first keeps every temp file near the size we want.
    """
    try:
        import pikepdf
        with pikepdf.open(pdf) as doc:
            box = doc.pages[0].mediabox
            return abs(float(box[2]) - float(box[0])) or None
    except Exception:
        return None


def _gs_render(pdf, out_dir, width):
    """Every page to PNG in ONE pass. Returns the files, in page order.

    One ghostscript process for the whole deck, not one per page: at ~104 pages
    the start-up cost would dwarf the drawing, and the scaling audit already
    found this box unhappy at two concurrent renders.
    """
    pt = _page_width_pt(pdf) or 224.0          # a card, if the box can't be read
    dpi = max(36, min(600, round(width * RENDER_SCALE * 72.0 / pt)))
    pattern = os.path.join(out_dir, "p%04d.png")
    cmd = [GS, "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
           "-sDEVICE=png16m", "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
           f"-r{dpi}", f"-dLastPage={MAX_PAGES}",
           f"-sOutputFile={pattern}", pdf]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError("ghostscript failed: " + (proc.stderr or proc.stdout)[-400:])
    return sorted(glob.glob(os.path.join(out_dir, "p*.png")))


def _to_webp(png, dest, width):
    """One page, at the grid's width. No cropping — the page IS the card.

    Trimming whitespace here would be a lie on the one card that matters: a
    front whose art runs pale to the trim would come back a different shape from
    its neighbours, and the buyer would be reading OUR crop, not her deck.
    """
    from PIL import Image
    im = Image.open(png).convert("RGB")
    if im.width != width:
        im = im.resize((width, max(1, round(im.height * width / im.width))), Image.LANCZOS)
    im.save(dest, "WEBP", quality=78, method=4)


def build(pdf, out_dir, width=DEFAULT_WIDTH):
    """Render `pdf` into `out_dir` as page-numbered webp. Returns the manifest."""
    if not os.path.exists(pdf):
        raise FileNotFoundError(pdf)
    os.makedirs(out_dir, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="proof-", dir=out_dir)
    try:
        pngs = _gs_render(pdf, tmp, width)
        files = []
        for i, png in enumerate(pngs, 1):
            name = "%04d.webp" % i
            _to_webp(png, os.path.join(out_dir, name), width)
            files.append(name)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    manifest = {"pages": len(files), "files": files, "width": width}
    with open(os.path.join(out_dir, "proof.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f)
    return manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pdf")
    ap.add_argument("out")
    ap.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    a = ap.parse_args()
    try:
        print(json.dumps(build(a.pdf, a.out, a.width)))
    except Exception as exc:            # answered, not raised — the route reads this
        print(json.dumps({"error": str(exc)[:400]}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
