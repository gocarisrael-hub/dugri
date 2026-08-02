"""Fitting a title's size when the sample and the artwork have different shapes.

Regression for titles printing about half size. The size is fitted by rendering
the theme's OWN sample title and asking what size makes its ink match the
artwork's. The two are not the same shape: anniversary's ``title_lines``
template is two lines, and the artwork it is measured against prints one. The
fit then answered "what size makes TWO lines as tall as ONE" — roughly half the
real size. Measured on that template's card back: 17.07 against a true ~30.5,
and the preview drew a title half the height of the design's.

The width axis never had the problem (a painted block's width is already its
widest single line), which is why it stayed near the truth and disagreed with
height by 60%+ — reported as a font mismatch when it was a line-count mismatch.

So both sides are reduced to ONE line before they are compared. The invariant
these tests pin: the fitted size must not depend on how many lines the sample
template happens to have.
"""
import os

from PIL import Image, ImageDraw
import pytest

import calibrate as C

FONT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resources",
                    "canva", "templates", "anniversary", "fonts",
                    "Dana Yad AlefAlefAlef Normal.ttf")

pytestmark = pytest.mark.skipif(not os.path.exists(FONT), reason="theme font not present")

INK = (0x00, 0x4A, 0xAD)
BG = (0xF4, 0xF1, 0xEB)
PPU = 2.6667


def _surface(bands, w=598, h=832):
    """A (mask, image) pair carrying ink only in ``bands`` — each (y0, y1, x0, x1)."""
    mask = Image.new("L", (w, h), 0)
    image = Image.new("RGB", (w, h), BG)
    md, idr = ImageDraw.Draw(mask), ImageDraw.Draw(image)
    for y0, y1, x0, x1 in bands:
        md.rectangle([x0, y0, x1, y1], fill=255)
        idr.rectangle([x0, y0, x1, y1], fill=INK)
    return mask, image


def _box(y0f, y1f, x0f=0.2, x1f=0.8, vw=223.92, vh=312.0):
    return {"x0": x0f * vw, "y0": y0f * vh, "x1": x1f * vw, "y1": y1f * vh}


def test_ink_lines_splits_a_block_into_its_rows():
    mask, _ = _surface([(100, 140, 60, 300), (170, 214, 60, 240)])
    bands = C._ink_lines(mask, (0, 0, 598, 832))
    assert len(bands) == 2
    assert bands[0][0] == 41 and bands[1][0] == 45          # heights
    assert bands[0][1] == 241 and bands[1][1] == 181        # widths


def test_ink_lines_reports_nothing_for_a_blank_region():
    mask, _ = _surface([])
    assert C._ink_lines(mask, (0, 0, 598, 832)) == []


def test_one_line_extent_divides_out_the_line_count():
    # Two ink rows of equal height: the ONE-LINE height is a row, not the block.
    # Both rows sit inside the box's own x-range, so nothing is clipped away.
    mask, _ = _surface([(300, 340, 130, 370), (360, 400, 130, 310)])
    box = _box(0.33, 0.50)
    one = C._one_line_extent(mask, box, PPU, 0.0, 0.0)
    assert one is not None
    line_h, line_w, _region = one
    assert line_h == 41                    # one row, not 101 (the whole block)
    assert line_w == 241                   # the WIDEST row


def _fit(bands, samples, box):
    mask, image = _surface(bands)
    return C.fit_title_size(mask, image, box, PPU, 0.0, 0.0, FONT, samples, "#004aad")


def test_the_fit_does_not_depend_on_the_samples_line_count():
    # THE regression. One row of artwork ink; the same title offered first as a
    # one-line template and then as a two-line one. Same artwork, same answer.
    bands = [(300, 381, 100, 480)]
    box = _box(0.33, 0.50)
    one_line = [["מזל טוב 60"], ["מזל טוב 70"]]
    two_line = [["מזל טוב 60", "נעמה ודני"], ["מזל טוב 70", "לירן ודני"]]
    size_a = _fit(bands, one_line, box)[0]
    size_b = _fit(bands, two_line, box)[0]
    assert size_a and size_b
    assert abs(size_a - size_b) / size_a < 0.02


def test_the_two_axes_now_agree_and_the_fit_grades_high():
    # Height and width are independent measurements of the same ink. Once the
    # line counts match they converge, and the "font is a lookalike" warning —
    # which a line-count mismatch used to trigger on every multi-line theme —
    # stays quiet.
    size, grade, note, _ctx = _fit([(300, 381, 100, 480)], [["מזל טוב 60"]], _box(0.33, 0.50))
    assert size
    assert grade == "high"
    assert note is None


def test_a_multi_line_original_is_measured_per_line_too():
    # Artwork that really does print two lines must fit the same size as the
    # one-line artwork of the same per-line ink height.
    box = _box(0.33, 0.62)
    single = _fit([(300, 381, 100, 480)], [["מזל טוב 60"]], box)[0]
    double = _fit([(300, 381, 100, 480), (400, 481, 100, 480)], [["מזל טוב 60"]], box)[0]
    assert single and double
    assert abs(single - double) / single < 0.05
