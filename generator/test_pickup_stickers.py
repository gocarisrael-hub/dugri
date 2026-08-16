#!/usr/bin/env python3
"""Tests for the self-collection sticker sheet.

Every printed game the customer collects herself gets a label on its box, and the
owner has been typing that sheet by hand every night. What follows is the shape
that sheet has to keep, because it is cut with a guillotine: eight to a page, a
2x4 grid, filled RIGHT to LEFT, and the last page padded so its cut lines land
where the blade is set.

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


# --- the grid ----------------------------------------------------------------

def test_eight_to_a_page():
    assert [len(p) for p in ps.pages(list(range(8)))] == [8]
    assert [len(p) for p in ps.pages(list(range(9)))] == [8, 8]
    assert [len(p) for p in ps.pages(list(range(17)))] == [8, 8, 8]


def test_the_last_page_is_padded_not_short():
    # The padding is not cosmetic: a short last page would let the grid reflow
    # and put its cut lines somewhere other than where the guillotine is set.
    last = ps.pages(list(range(11)))[-1]
    assert len(last) == 8
    assert last[3:] == [None] * 5


def test_no_orders_still_makes_one_empty_sheet():
    # A night with nothing to collect is a normal night. One blank grid beats a
    # zero-page PDF, which most readers refuse to open at all.
    assert [len(p) for p in ps.pages([])] == [8]


def test_the_order_is_preserved_within_a_page():
    page = ps.pages([{"title": str(i)} for i in range(8)])[0]
    assert [c["title"] for c in page] == [str(i) for i in range(8)]


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


# --- the sheet ---------------------------------------------------------------

def test_the_sheet_is_rtl_and_a4():
    html = ps.sheet_html([ONE])
    assert "dir='rtl'" in html
    assert "size:A4" in html
    assert "margin:0" in html


def test_the_fonts_are_carried_in_the_document():
    # This renders in a container whose font situation is not ours to assume, and
    # a missing Hebrew face does not fail loudly — it prints a page of boxes.
    html = ps.sheet_html([ONE])
    assert html.count("@font-face") == 2
    assert "data:font/woff2;base64," in html
    assert "http" not in html.split("<body>")[0].replace("http-equiv", "")


def test_every_page_is_a_full_grid_of_cells():
    html = ps.sheet_html([ONE] * 9)
    assert html.count('class="page"') == 2
    assert html.count('class="cell"') == 16


def test_the_cut_guides_are_drawn_between_cells_and_not_around_the_page():
    # The sheet is full-bleed A4: the outer edge is where the paper ends, so a
    # border there would be a line to cut off rather than along.
    html = ps.sheet_html([ONE])
    assert ".cell:nth-child(odd){border-inline-start:0}" in html
    assert ".cell:nth-child(7),.cell:nth-child(8){border-bottom:0}" in html


# --- the real thing ----------------------------------------------------------

@needs_chrome
def test_it_prints_a_pdf_with_one_page_per_eight():
    with tempfile.TemporaryDirectory() as tmp:
        out = ps.build([ONE] * 9, os.path.join(tmp, "s.pdf"), workdir=tmp)
        data = open(out, "rb").read()
        assert data[:5] == b"%PDF-"
        # Two pages for nine labels, counted off the PDF itself rather than off
        # the code that asked for them.
        assert len(re.findall(rb"/Type\s*/Page[^s]", data)) == 2
