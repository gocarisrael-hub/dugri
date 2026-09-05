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
