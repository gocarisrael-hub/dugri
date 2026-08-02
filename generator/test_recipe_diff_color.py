"""The ink-colour sampler behind every recipe's ``color`` field.

Regression for pale words on a printed deck. ``color_of`` used to average the
darkest EIGHTH of a detected text box, which assumes the glyphs fill at least
12.5% of their own bounding box. A long entry in a thin script does not: the
same ink spreads over a wider box, the bucket fills up with page background, and
the recorded colour comes out washed toward the page. Every card then prints
that entry pale — bachelorette card 2 recorded #a37b87 and #bf96a2 for words
whose real ink is #6b4d56.

So the tests below sweep INK COVERAGE, which is the variable that used to break
it, and demand the same answer at every level.
"""
from PIL import Image, ImageDraw

import recipe_diff as R

INK = (0x6B, 0x4D, 0x56)      # the real bachelorette word colour
BG = (0xF0, 0xEF, 0xE9)       # its cream page
INK_HEX = "#6b4d56"
BG_HEX = "#f0efe9"

FULL_BOX = dict(x0=0, y0=0, x1=400, y1=40)


def _box(coverage, w=400, h=40, ink=INK, bg=BG):
    """A text box whose ink covers ``coverage`` of its area, rest background.

    Vertical strokes stand in for glyph stems: what matters to the sampler is
    the RATIO of ink to background inside the box, not the glyph shapes.
    """
    im = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(im)
    n = max(1, int(w * coverage))
    for x in range(0, w, max(1, w // n)):
        d.line([(x, 0), (x, h)], fill=ink)
    return im


def test_colour_is_the_ink_at_every_coverage():
    # 12.5% is the old fixed cut. Below it the old code failed; the point of the
    # fix is that nothing special happens as we cross it.
    for coverage in (0.5, 0.3, 0.18, 0.125, 0.09, 0.05, 0.02, 0.01):
        got = R.color_of(_box(coverage), (0, 0), FULL_BOX)
        assert got == INK_HEX, f"{coverage:.0%} coverage sampled {got}, want {INK_HEX}"


def test_sparse_ink_is_not_washed_toward_the_page():
    # The specific defect: a sparse box must not drift toward the background.
    # Guard the DIRECTION of the old bug, not just the exact value.
    got = R.color_of(_box(0.05), (0, 0), FULL_BOX)
    assert R._lum(tuple(int(got[i:i + 2], 16) for i in (1, 3, 5))) < R._lum(BG) * 0.6


def test_a_flat_box_of_one_colour_returns_that_colour():
    # No ink/background split exists here. Averaging the whole box is the right
    # answer, and the empty-ink guard must not turn it into black.
    f = dict(x0=0, y0=0, x1=50, y1=20)
    assert R.color_of(Image.new("RGB", (50, 20), INK), (0, 0), f) == INK_HEX
    assert R.color_of(Image.new("RGB", (50, 20), BG), (0, 0), f) == BG_HEX


def test_antialiased_edges_do_not_lighten_the_answer():
    # Real renders surround every stem with blend pixels. They belong to the
    # LIGHT group and must stay out of the average.
    im = Image.new("RGB", (400, 40), BG)
    d = ImageDraw.Draw(im)
    blend = tuple((INK[i] + BG[i]) // 2 for i in range(3))
    for x in range(0, 400, 20):
        d.line([(x - 1, 0), (x - 1, 40)], fill=blend)   # AA edge
        d.line([(x, 0), (x, 40)], fill=INK)             # stem
        d.line([(x + 1, 0), (x + 1, 40)], fill=blend)   # AA edge
    assert R.color_of(im, (0, 0), FULL_BOX) == INK_HEX


def test_a_light_word_on_a_dark_page_still_reads_as_the_word():
    # The sampler takes the DARK side of the split, so an inverted design (light
    # ink on dark artwork) is a known limit, not a silent wrong answer: assert
    # what it actually does so a future change to that behaviour is deliberate.
    im = _box(0.05, ink=(0xF0, 0xEF, 0xE9), bg=(0x11, 0x11, 0x11))
    assert R.color_of(im, (0, 0), FULL_BOX) == "#111111"


def test_the_box_offset_is_honoured():
    # color_of crops at cell + box; a wrong origin would sample the neighbouring
    # card's artwork, which is how a slot picks up a colour that is not its own.
    im = Image.new("RGB", (200, 100), BG)
    ImageDraw.Draw(im).rectangle([100, 50, 199, 99], fill=INK)
    f = dict(x0=0, y0=0, x1=100, y1=50)
    assert R.color_of(im, (100, 50), f) == INK_HEX
    assert R.color_of(im, (0, 0), f) == BG_HEX
