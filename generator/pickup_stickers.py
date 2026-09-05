#!/usr/bin/env python3
"""The self-collection stickers: one label per order waiting at the printer.

    python3 generator/pickup_stickers.py <orders.json> <out.pdf>

Every printed game that the customer collects herself gets a sticker on its box,
and until now the owner built the sheet by hand every night: open a document,
type eleven names, print. This is that document, from the orders.

ONE STICKER, four lines of it:

    איסוף עצמי          ← the same on every label; it is what the shelf is for
    <the game's title>   ← what she looks for when the customer walks in
    שם מלא:  <buyer>     ← who is collecting
    עיצוב:   <design>    ← which game, when two boxes look alike
    טלפון:   <phone>     ← the one thing needed to chase a no-show

ONE TO A PAGE, AND THE PAGE IS THE LABEL — 105x74 mm, the size of the label
itself, so the PDF prints straight onto the label stock at 100% with nothing to
cut and no cut guides to line up. It used to be eight to an A4 sheet in a 2x4
grid, guillotined apart; the page carries exactly one label now, at the same
size that grid gave it, so nothing about the label's own layout moved.

NOT EVERY BOX IN THE PILE IS COLLECTED, though, and the ones going out by courier
carry HFD's own sticker — a barcode the driver scans, which we cannot draw. So an
entry in the input may instead be ``{"pdf": "<path>"}``: a label PDF already
fetched from HFD, which is carried into the output AS IS, in its place in the
batch. The owner asked for one download for the whole pile rather than ours here
and HFD's from their website, and the pile is mixed, so the file has to be.

That is what the ghostscript pass at the bottom is for: Chrome renders OUR labels
in one go (one browser start, not one per label), ghostscript cuts that into
single pages, and a second ghostscript pass interleaves them with HFD's in the
order the batch came in. Page sizes survive the merge — ours stay 105x74 and
HFD's stay whatever HFD prints.

The fonts are INLINED from site/assets/fonts rather than named and hoped for:
this renders in a container whose font situation is not ours to assume, and a
missing Hebrew face does not fail loudly — it prints a page of boxes.
"""
import base64
import html
import json
import os
import subprocess
import sys

import chrome

# The same override name press.py, proof_sheet.py and press_marks.py use, so one
# container-level GHOSTSCRIPT setting moves every pass that needs it.
GS = os.environ.get("GHOSTSCRIPT", "gs")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
FONT_DIR = os.path.join(REPO, "site", "assets", "fonts")

# The two halves of one face: Heebo covers Hebrew and Latin in separate files,
# and a sticker sheet carries both ("סבא חוגג 80" and "Bride To Be" were on the
# same page of the sheet this replaces).
FONT_FILES = [
    ("heebo-300-hebrew.f1f7cfae.woff2",
     "U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F"),
    ("heebo-300-latin.50dae2e1.woff2",
     "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, "
     "U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, "
     "U+2212, U+2215, U+FEFF, U+FFFD"),
]

PER_PAGE = 1

# The label, and therefore the page. 105x74 mm is the label the sheets are cut
# to — the same rectangle one cell of the old 2x4 A4 grid measured, which is why
# the type sizes below did not have to move.
LABEL_W = "105mm"
LABEL_H = "74mm"

# The heading size, and the sizes a long title steps down to. A title is the
# customer's own words and can be one syllable ("אחיה") or five
# ("Reut's Bachelorette Bash"); one fixed size either wastes the label or runs
# off it, so the size is chosen from the length. Measured against the sheet the
# owner has been making by hand.
TITLE_STEPS = [(14, "19pt"), (24, "16pt"), (34, "13pt"), (999, "11pt")]


def title_size(text):
    """The font size for a title of this length."""
    n = len(str(text or ""))
    for limit, size in TITLE_STEPS:
        if n <= limit:
            return size
    return TITLE_STEPS[-1][1]


def font_faces():
    """@font-face rules with the woff2 payloads inlined as data URIs."""
    out = []
    for name, unicode_range in FONT_FILES:
        path = os.path.join(FONT_DIR, name)
        try:
            with open(path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
        except OSError:
            # Best-effort: a missing font file leaves the sheet to the container's
            # own fonts rather than failing the night's stickers outright.
            continue
        out.append(
            "@font-face{font-family:'Heebo';font-style:normal;font-weight:300;"
            f"src:url(data:font/woff2;base64,{b64}) format('woff2');"
            f"unicode-range:{unicode_range};}}"
        )
    return "".join(out)


def pages(stickers, per_page=PER_PAGE):
    """``stickers`` split into pages, the last one padded with blanks.

    At one to a page the padding only ever does one thing, and it is the thing
    that matters: a night with nothing to collect still yields ONE page. A
    zero-page PDF is a file most readers refuse to open at all.
    """
    out = []
    for i in range(0, max(len(stickers), 1), per_page):
        page = list(stickers[i:i + per_page])
        page += [None] * (per_page - len(page))
        out.append(page)
    return out


def _row(label, value):
    if not value:
        return ""
    return (f'<div class="row"><span class="lab">{html.escape(str(label))}</span>'
            f'<span class="val">{html.escape(str(value))}</span></div>')


def cell_html(sticker):
    """One label. ``None`` is an empty cell — the page keeps its shape."""
    if not sticker:
        return '<div class="cell"></div>'
    title = str(sticker.get("title") or "").strip()
    return (
        '<div class="cell">'
        '<div class="head">איסוף עצמי</div>'
        f'<div class="title" style="font-size:{title_size(title)}">'
        f'{html.escape(title)}</div>'
        '<div class="rows">'
        + _row("שם מלא:", sticker.get("buyer_name"))
        + _row("עיצוב:", sticker.get("design"))
        + _row("טלפון:", sticker.get("phone"))
        + "</div></div>"
    )


def sheet_html(stickers):
    """The whole run of labels as one printable HTML document."""
    body = "".join(
        '<div class="page">' + "".join(cell_html(s) for s in page) + "</div>"
        for page in pages(stickers)
    )
    return (
        "<!doctype html><html lang='he' dir='rtl'><head><meta charset='utf-8'>"
        "<style>"
        + font_faces() +
        # The page IS the label, edge to edge. No printer margin: one would shrink
        # the artwork to fit inside it and leave the text off-centre on the stock.
        f"@page{{size:{LABEL_W} {LABEL_H};margin:0}}"
        "html,body{margin:0;padding:0}"
        "body{font-family:'Heebo',Arial,sans-serif;color:#000;"
        "-webkit-print-color-adjust:exact;print-color-adjust:exact}"
        f".page{{width:{LABEL_W};height:{LABEL_H};display:flex;"
        "box-sizing:border-box;break-after:page;overflow:hidden}"
        ".page:last-child{break-after:auto}"
        # No cut guides: there is nothing to cut. The label's edge is the page's
        # edge, and a dashed line there would print along the die-cut.
        ".cell{flex:1;box-sizing:border-box;padding:5mm 7mm 4mm;display:flex;"
        "flex-direction:column;overflow:hidden}"
        # Heebo ships here at weight 300 only, so a requested 700 is SYNTHESISED
        # and comes out lighter than the hand-made sheet's bold. The hairline
        # stroke puts that weight back: on a 300-DPI label it reads as a bold
        # face, and it costs no second font file to carry into the container.
        ".head{text-align:center;font-weight:700;font-size:19pt;line-height:1.15;"
        "-webkit-text-stroke:0.4px currentColor}"
        ".title{text-align:center;font-weight:700;line-height:1.15;"
        "margin-top:1.5mm;overflow-wrap:anywhere;"
        "-webkit-text-stroke:0.4px currentColor}"
        # The three facts sit at the FOOT of the label, right-aligned: the title
        # is what she reads across the room and these are what she reads with the
        # box in her hand. Label and value on ONE line, next to each other —
        # pushed to opposite edges they stop reading as a pair.
        ".rows{margin-top:auto;display:flex;flex-direction:column;gap:0.8mm}"
        ".row{display:flex;justify-content:flex-start;align-items:baseline;"
        "gap:2mm;font-size:11pt;line-height:1.3}"
        ".lab{font-weight:700;white-space:nowrap;"
        "-webkit-text-stroke:0.25px currentColor}"
        ".val{overflow-wrap:anywhere;min-width:0;"
        # A phone number is Latin digits in an RTL line; pinning its direction
        # keeps "0521234567" from being reordered around a leading zero.
        "unicode-bidi:plaintext}"
        "</style></head><body>" + body + "</body></html>"
    )


def is_courier_label(entry):
    """True for an entry that is already a PDF — HFD's sticker, not ours.

    The courier's label carries a barcode the driver scans; it comes down from
    HFD and is carried into the batch untouched.
    """
    return bool(isinstance(entry, dict) and entry.get("pdf"))


def _gs(args, what):
    """One ghostscript run, or a RuntimeError carrying its complaint."""
    proc = subprocess.run(
        [GS, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite"] + args,
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[-400:]
        raise RuntimeError(f"ghostscript failed ({what}, exit {proc.returncode}): {detail}")


def _readable_pdf(path):
    """True when ``path`` is a file that actually begins %PDF.

    A label that did not come down cleanly is skipped rather than merged: one
    unreadable sticker must not cost the owner the other twenty.
    """
    try:
        with open(path, "rb") as f:
            return f.read(5).startswith(b"%PDF")
    except OSError:
        return False


def build(stickers, out_pdf, workdir=None):
    """Render the batch to ``out_pdf`` and return the path.

    ``stickers`` is the pile in the order it should print: our own labels as
    dicts, HFD's as ``{"pdf": path}``. Entries whose PDF cannot be read are
    dropped — see ``_readable_pdf``.
    """
    workdir = workdir or os.path.dirname(os.path.abspath(out_pdf))
    os.makedirs(workdir, exist_ok=True)

    entries = list(stickers or [])
    courier = [e for e in entries if is_courier_label(e)]
    ours = [e for e in entries if not is_courier_label(e)]

    # The plain case, and the only one an all-self-collection night takes: one
    # Chrome print and no ghostscript at all.
    if not courier:
        html_path = os.path.join(workdir, "pickup-stickers.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(sheet_html(ours))
        chrome.print_pdf(html_path, out_pdf, what="pickup stickers")
        return out_pdf

    parts_dir = os.path.join(workdir, "parts")
    os.makedirs(parts_dir, exist_ok=True)

    # OUR labels, all of them in ONE browser run, then cut into single pages by
    # ONE ghostscript run (`%d` writes a file per page). Rendering them
    # separately would start Chrome once per sticker, and Chrome runs are capped
    # to four at a time across the whole container for good reasons.
    mine = []
    if ours:
        html_path = os.path.join(workdir, "pickup-stickers.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(sheet_html(ours))
        sheet_pdf = os.path.join(workdir, "ours.pdf")
        chrome.print_pdf(html_path, sheet_pdf, what="pickup stickers")
        _gs(["-sOutputFile=" + os.path.join(parts_dir, "ours-%d.pdf"), sheet_pdf],
            "splitting our labels")
        mine = [os.path.join(parts_dir, f"ours-{i}.pdf") for i in range(1, len(ours) + 1)]

    # Back into the order the batch came in: ours and HFD's interleaved, so the
    # PDF reads down the owner's list rather than sorting itself by who printed
    # what.
    ordered = []
    take = iter(mine)
    for entry in entries:
        if is_courier_label(entry):
            path = str(entry.get("pdf"))
            if _readable_pdf(path):
                ordered.append(path)
            continue
        nxt = next(take, None)
        if nxt and _readable_pdf(nxt):
            ordered.append(nxt)

    if not ordered:
        # Everything fell away. One blank label beats a zero-page PDF, which most
        # readers refuse to open at all — the same rule ``pages`` keeps.
        html_path = os.path.join(workdir, "pickup-stickers.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(sheet_html([]))
        chrome.print_pdf(html_path, out_pdf, what="pickup stickers")
        return out_pdf

    _gs(["-sOutputFile=" + out_pdf] + ordered, "merging the batch")
    return out_pdf


def main():
    if len(sys.argv) < 3:
        print("usage: pickup_stickers.py <orders.json> <out.pdf>", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as f:
        stickers = json.load(f)
    out = build(stickers, sys.argv[2])
    courier = sum(1 for s in stickers if is_courier_label(s))
    print(json.dumps({"pdf": out, "ours": len(stickers) - courier, "courier": courier}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
