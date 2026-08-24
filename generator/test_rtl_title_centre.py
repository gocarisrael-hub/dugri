"""A centred Hebrew title sat off-centre, by half its own ink asymmetry twice.

SVG anchors a run by its ADVANCE, and ink and advance are not the same span — a
script face's glyphs overhang it. title_block already corrects for that: it
shifts the anchor by half the difference so the INK straddles the box centre.

The correction was measured the wrong way round for Hebrew. _ink_bearings reads
the string with Pillow, which lays every script out LEFT-TO-RIGHT; the SVG paints
a Hebrew title RIGHT-TO-LEFT. So the overhang Pillow reports on the right is the
one that shows on the LEFT, and applying the unmirrored skew moved the line the
wrong way — doubling the error instead of removing it. Measured on סנטוריני's
"יעל חוגגת יובל": 1.84 units left of centre before, centred after.

It hid because it only bites a line whose bearings are ASYMMETRIC. Most shipped
titles measure the same on both sides — including every string in this repo's own
fonts, which is why the asymmetry here is injected rather than found: the rule is
what is under test, not one face's metrics.
"""
import re

import render_page as R

CAFE = "Cafe-Regular.ttf"
BOX = {"x0": 20.0, "y0": 20.0, "x1": 200.0, "y1": 90.0}
CENTRE = (BOX["x0"] + BOX["x1"]) / 2
SIZE = 18.0


def _anchor(svg):
    """Where the centred run is anchored: the midpoint of its hosting path.

    The path is `M x0 y Q cx cy x1 y`, and a centred run sits at startOffset 50%
    — the arc-length midpoint, which for the symmetric extension title_block
    emits is (x0 + x1) / 2.
    """
    m = re.search(r'<path[^>]*\bd="M ([-\d.]+) [-\d.]+ Q [-\d.]+ [-\d.]+ ([-\d.]+)', "".join(svg))
    assert m, "no hosting path in the title"
    return (float(m.group(1)) + float(m.group(2))) / 2


def _draw(lines, rtl):
    return R.title_block(BOX, lines, "#000", "#000", CAFE, 0.0, 0.0, False,
                         rtl=rtl, fixed_size=SIZE, align="center")


def _with_bearings(monkeypatch, lsb, rsb):
    monkeypatch.setattr(R, "_ink_bearings", lambda f, ref, line, size: (lsb, rsb))


# ------------------------------------------------------------- the correction
def test_an_rtl_run_is_corrected_the_opposite_way_from_an_ltr_one(monkeypatch):
    """The whole fix. The same asymmetry, drawn RTL and LTR, must anchor on
    OPPOSITE sides of the centre — because the ink being corrected for is."""
    _with_bearings(monkeypatch, 0.0, -1.6)
    ltr = _anchor(_draw(["מזל טוב"], False))
    rtl = _anchor(_draw(["מזל טוב"], True))
    assert abs((ltr - CENTRE) + (rtl - CENTRE)) < 1e-6, (ltr, rtl)
    assert ltr != rtl


def test_the_rtl_shift_is_half_the_asymmetry_and_no_more(monkeypatch):
    """It is a correction, not a nudge: exactly half the difference, so the ink
    lands on the centre rather than somewhere near it."""
    _with_bearings(monkeypatch, 0.0, -1.6)
    got = _anchor(_draw(["מזל טוב"], True))
    assert abs(got - (CENTRE - (-1.6 - 0.0) / 2)) < 1e-6, got


def test_a_symmetric_line_is_centred_either_way(monkeypatch):
    """Which is why this hid: nothing to correct, nothing to get wrong."""
    _with_bearings(monkeypatch, 0.4, 0.4)
    assert abs(_anchor(_draw(["מזל טוב"], True)) - CENTRE) < 1e-6
    assert abs(_anchor(_draw(["MAZAL TOV"], False)) - CENTRE) < 1e-6


def test_a_left_to_right_title_keeps_exactly_the_answer_it_had(monkeypatch):
    """English titles were never wrong, and this must not move them."""
    _with_bearings(monkeypatch, 0.9, -0.3)
    got = _anchor(_draw(["MAZAL TOV"], False))
    assert abs(got - (CENTRE - (0.9 - (-0.3)) / 2)) < 1e-6, got


def test_only_centred_titles_are_touched(monkeypatch):
    """Left and right alignment stay on the ADVANCE deliberately — they exist to
    give a stack a shared edge, and a per-line bearing would ragged it."""
    _with_bearings(monkeypatch, 0.0, -1.6)
    for align in ("left", "right"):
        a = R.title_block(BOX, ["מזל טוב"], "#000", "#000", CAFE, 0.0, 0.0, False,
                          rtl=True, fixed_size=SIZE, align=align)
        b = R.title_block(BOX, ["מזל טוב"], "#000", "#000", CAFE, 0.0, 0.0, False,
                          rtl=False, fixed_size=SIZE, align=align)
        # compare the GEOMETRY: the markup also carries direction="rtl", which
        # is exactly the difference these two are allowed to have
        paths = lambda svg: re.findall(r'<path[^>]*\bd="([^"]+)"', "".join(svg))
        assert paths(a) == paths(b), align


def test_the_correction_cannot_push_a_title_out_of_its_box(monkeypatch):
    """A shift is half an overhang, and an overhang is small. The run stays
    inside the box it was fitted to — the damage a bad centring change does."""
    _with_bearings(monkeypatch, 0.0, -1.6)
    svg = "".join(_draw(["מזל טוב"], True))
    xs = [float(x) for x in re.findall(r'[ML] ([-\d.]+) [-\d.]+', svg)]
    xs += [float(x) for x in re.findall(r'Q [-\d.]+ [-\d.]+ ([-\d.]+)', svg)]
    assert min(xs) > BOX["x0"] - SIZE, min(xs)
    assert max(xs) < BOX["x1"] + SIZE, max(xs)
