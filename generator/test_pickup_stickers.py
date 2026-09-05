#!/usr/bin/env python3
"""Tests for the self-collection stickers.

Every printed game the customer collects herself gets a label on its box, and the
owner has been typing that sheet by hand every night. What follows is the shape
those labels have to keep: ONE to a page, and the page is the label — 105x74 mm,
printed straight onto the label stock with nothing to cut. (It was eight to an A4
sheet in a 2x4 grid, guillotined apart; the label's own layout is unchanged, only
what surrounds it.)

Run: python3 -m pytest generator/test_pickup_stickers.py
"""
import os
import re
import shutil
import subprocess
import tempfile

import pytest

import pickup_stickers as ps

ONE = {
    "title": "יובל חוגגת 23",
    "buyer_name": "אופק אוחיון",
    "design": "דני",
    "phone": "0527275047",
}


def _has_chrome():
    exe = os.environ.get("CHROME", "")
    return bool(
        shutil.which(exe)
        or shutil.which("google-chrome")
        or shutil.which("chromium")
        or shutil.which("chromium-browser")
        or os.path.exists("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    )


needs_chrome = pytest.mark.skipif(not _has_chrome(), reason="no Chrome")
needs_gs = pytest.mark.skipif(
    shutil.which(os.environ.get("GHOSTSCRIPT", "gs")) is None,
    reason="ghostscript is in the image; skip where it is not installed",
)

PT_PER_MM = 72 / 25.4


def _page_sizes(pdf):
    """Every page's width x height in mm, in order, read off the PDF itself."""
    data = open(pdf, "rb").read()
    out = []
    for box in re.findall(rb"/MediaBox\s*\[([^\]]*)\]", data):
        x0, y0, x1, y1 = (float(v) for v in box.split())
        out.append((round((x1 - x0) / PT_PER_MM), round((y1 - y0) / PT_PER_MM)))
    return out


def _a4_pdf(path):
    """A stand-in for a courier label: someone else's PDF, a different size.

    Written by ghostscript rather than by our own renderer — the point of the
    fixture is that it did NOT come from us, and it keeps a browser out of a
    test that is about the merge.
    """
    subprocess.run(
        [os.environ.get("GHOSTSCRIPT", "gs"), "-q", "-dNOPAUSE", "-dBATCH",
         "-sDEVICE=pdfwrite", "-sOutputFile=" + path,
         "-c", "<</PageSize [595 842]>> setpagedevice /Helvetica findfont 40 scalefont"
               " setfont 60 700 moveto (HFD 95314644) show showpage"],
        capture_output=True, text=True, check=True)
    return path


# --- one to a page -----------------------------------------------------------

def test_one_label_to_a_page():
    assert [len(p) for p in ps.pages(list(range(1)))] == [1]
    assert [len(p) for p in ps.pages(list(range(8)))] == [1] * 8
    assert [len(p) for p in ps.pages(list(range(11)))] == [1] * 11


def test_no_orders_still_makes_one_empty_page():
    # A night with nothing to collect is a normal night. One blank label beats a
    # zero-page PDF, which most readers refuse to open at all.
    assert [len(p) for p in ps.pages([])] == [1]
    assert ps.pages([]) == [[None]]


def test_the_order_of_the_labels_is_preserved():
    # The labels come out oldest first so a box can be found in the stack; the
    # split into pages must not reorder them.
    pgs = ps.pages([{"title": str(i)} for i in range(8)])
    assert [p[0]["title"] for p in pgs] == [str(i) for i in range(8)]


# --- one label ---------------------------------------------------------------

def test_a_label_carries_all_four_lines():
    cell = ps.cell_html(ONE)
    assert "איסוף עצמי" in cell
    assert "יובל חוגגת 23" in cell
    for label, value in [("שם מלא:", "אופק אוחיון"), ("עיצוב:", "דני"),
                         ("טלפון:", "0527275047")]:
        assert label in cell
        assert value in cell


def test_a_missing_fact_leaves_no_empty_row():
    # An order with no buyer name recorded prints a label without that line,
    # rather than a bold "שם מלא:" with nothing after it.
    cell = ps.cell_html({**ONE, "buyer_name": ""})
    assert "שם מלא:" not in cell
    assert "טלפון:" in cell


def test_an_empty_slot_is_an_empty_cell_and_not_a_missing_one():
    assert ps.cell_html(None) == '<div class="cell"></div>'


def test_the_title_is_escaped_not_interpreted():
    # Titles are the customer's own words and reach this through the order form.
    cell = ps.cell_html({**ONE, "title": '<script>x</script> & "co"'})
    assert "<script>" not in cell
    assert "&lt;script&gt;" in cell


def test_a_long_title_steps_down_rather_than_running_off_the_label():
    # A title is one syllable ("אחיה") or five ("Reut's Bachelorette Bash"); one
    # fixed size either wastes the label or overflows it.
    small = ps.title_size("Reut's Bachelorette Bash")
    big = ps.title_size("אחיה")
    assert float(big.rstrip("pt")) > float(small.rstrip("pt"))
    assert ps.title_size("") == ps.title_size("אחיה")
    # …and something absurd still lands on a real size rather than None.
    assert ps.title_size("x" * 400).endswith("pt")


# --- the document ------------------------------------------------------------

def test_the_page_is_rtl_and_the_size_of_the_label():
    # Not A4: the sheet is printed onto label stock at 100%, so the PDF's page
    # has to BE the label. An A4 page would scale the artwork to fit the label
    # and leave the text off-centre on it.
    html = ps.sheet_html([ONE])
    assert "dir='rtl'" in html
    assert "size:105mm 74mm" in html
    assert "margin:0" in html
    assert "size:A4" not in html


def test_the_fonts_are_carried_in_the_document():
    # This renders in a container whose font situation is not ours to assume, and
    # a missing Hebrew face does not fail loudly — it prints a page of boxes.
    html = ps.sheet_html([ONE])
    assert html.count("@font-face") == 2
    assert "data:font/woff2;base64," in html
    assert "http" not in html.split("<body>")[0].replace("http-equiv", "")


def test_every_page_holds_exactly_one_label():
    html = ps.sheet_html([ONE] * 9)
    assert html.count('class="page"') == 9
    assert html.count('class="cell"') == 9


def test_there_are_no_cut_guides_to_line_up():
    # The label's edge is the page's edge. A dashed guide there would print
    # along the die-cut instead of showing where to cut.
    html = ps.sheet_html([ONE])
    assert "dashed" not in html


# --- the real thing ----------------------------------------------------------

@needs_chrome
def test_it_prints_a_label_sized_page_per_order():
    with tempfile.TemporaryDirectory() as tmp:
        out = ps.build([ONE] * 9, os.path.join(tmp, "s.pdf"), workdir=tmp)
        data = open(out, "rb").read()
        assert data[:5] == b"%PDF-"
        # Nine pages for nine labels, counted off the PDF itself rather than off
        # the code that asked for them.
        assert len(re.findall(rb"/Type\s*/Page[^s]", data)) == 9
        # …and each of them is the label, not a sheet of them. 105x74 mm is
        # 297.6x209.8 pt; Chrome rounds, so this allows a point either way.
        boxes = re.findall(rb"/MediaBox\s*\[([^\]]*)\]", data)
        assert boxes
        for box in boxes:
            x0, y0, x1, y1 = (float(v) for v in box.split())
            assert (x0, y0) == (0, 0)
            assert abs(x1 - 105 / 25.4 * 72) < 1
            assert abs(y1 - 74 / 25.4 * 72) < 1


# --- the courier's labels, in with ours ---------------------------------------
# Not every box in the pile is collected: the ones going out by courier carry
# HFD's own sticker, a barcode we cannot draw. The owner asked for ONE download
# for the whole pile instead of ours here and HFD's from their website, so a
# batch entry may be a PDF that already exists and is carried in whole.

def test_a_pdf_entry_is_the_couriers_label_and_a_dict_is_ours():
    assert ps.is_courier_label({"pdf": "/tmp/hfd-95314644.pdf"}) is True
    assert ps.is_courier_label(ONE) is False
    assert ps.is_courier_label(None) is False
    assert ps.is_courier_label({"pdf": ""}) is False


@needs_chrome
@needs_gs
def test_the_batch_keeps_its_order_ours_and_hfds_interleaved():
    # The PDF has to read down the owner's list. Sorting it by who printed what
    # would mean counting boxes in one order and stickers in another.
    with tempfile.TemporaryDirectory() as tmp:
        hfd = _a4_pdf(os.path.join(tmp, "hfd.pdf"))
        out = ps.build([ONE, {"pdf": hfd}, ONE], os.path.join(tmp, "s.pdf"), workdir=tmp)
        assert _page_sizes(out) == [(105, 74), (210, 297), (105, 74)]


@needs_gs
def test_a_pile_of_courier_labels_only_carries_no_blank_page_of_ours():
    # The blank page exists so an empty night still opens; a night that is ALL
    # deliveries is not an empty night, and a blank first label would be printed
    # and thrown away.
    with tempfile.TemporaryDirectory() as tmp:
        hfd = _a4_pdf(os.path.join(tmp, "hfd.pdf"))
        out = ps.build([{"pdf": hfd}], os.path.join(tmp, "s.pdf"), workdir=tmp)
        assert _page_sizes(out) == [(210, 297)]


@needs_chrome
@needs_gs
def test_a_label_that_did_not_come_down_is_dropped_not_fatal():
    # One unreadable sticker must not cost the owner the other twenty. A path
    # that is missing, and one that is a file but not a PDF, are both skipped.
    with tempfile.TemporaryDirectory() as tmp:
        broken = os.path.join(tmp, "broken.pdf")
        with open(broken, "w", encoding="utf-8") as f:
            f.write("<html>HFD is down</html>")
        hfd = _a4_pdf(os.path.join(tmp, "hfd.pdf"))
        out = ps.build(
            [ONE, {"pdf": broken}, {"pdf": os.path.join(tmp, "gone.pdf")}, {"pdf": hfd}],
            os.path.join(tmp, "s.pdf"), workdir=tmp)
        assert _page_sizes(out) == [(105, 74), (210, 297)]


@needs_chrome
@needs_gs
def test_our_labels_are_rendered_in_ONE_browser_run_however_many_there_are():
    # Chrome runs are capped to four at a time across the whole container, and a
    # browser start is most of a label's cost. Ten labels is one print, then
    # ghostscript cuts it up — not ten prints.
    calls = []
    real = ps.chrome.print_pdf

    def counting(source, out_pdf, **kw):
        calls.append(source)
        return real(source, out_pdf, **kw)

    with tempfile.TemporaryDirectory() as tmp:
        hfd = _a4_pdf(os.path.join(tmp, "hfd.pdf"))
        ps.chrome.print_pdf = counting
        try:
            out = ps.build([ONE] * 10 + [{"pdf": hfd}],
                           os.path.join(tmp, "s.pdf"), workdir=tmp)
        finally:
            ps.chrome.print_pdf = real
        assert len(calls) == 1
        assert len(_page_sizes(out)) == 11


@needs_chrome
def test_an_all_self_collection_night_never_shells_out_to_ghostscript():
    # The common night is every box collected. It stays one Chrome print with no
    # second process behind it.
    ran = []
    real = subprocess.run
    subprocess.run = lambda *a, **k: ran.append(a) or real(*a, **k)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ps.build([ONE, ONE], os.path.join(tmp, "s.pdf"), workdir=tmp)
    finally:
        subprocess.run = real
    assert not any(str(a[0][0]).endswith("gs") for a in ran if a and a[0])
