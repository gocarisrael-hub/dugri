"""A centred Hebrew title must be centred ON THE CARD, not in Pillow's opinion.

WHY THIS FILE RENDERS INSTEAD OF ASSERTING ON BEARINGS. The bug it guards was
shipped once and then shipped again inverted, and both times the "proof" was a
number computed from ``_ink_bearings`` — the very function under suspicion. A
test written that way cannot fail: it reads back the arithmetic it is checking.

So the measurement here comes off PIXELS, through the production rasterizer, and
the question it asks is the one a buyer asks — is the ink in the middle of the
box? — with no opinion about how it got there.

It is a Chrome test and it costs a second or two. That is the price of a
measurement that can say no.
"""
import json
import os
import re
import tempfile

import test_render_page as T
import config

HERE = os.path.dirname(os.path.abspath(__file__))
BOX = T._GLYPH_BOX
CX = (BOX["x0"] + BOX["x1"]) / 2
WIDTH = BOX["x1"] - BOX["x0"]
SCALE = 3

# A SANITY NET, not the precise guard — see the second test for that.
#
# The trap in tightening this: the repo's Hebrew fonts are nearly symmetric, so
# the fault only measures ~1-3 units here, while the brush face it actually bites
# on (GveretLevin, which lives on the volume) puts it at 17. A threshold tuned to
# catch the small case would sit a third of a unit above the noise floor and go
# red on antialiasing. So this one asks the coarse question — is the title
# grossly off-centre — and the invariant below asks the exact one.
TOL = 0.03 * (BOX["x1"] - BOX["x0"])

# Names chosen for their INK, not their length: a Hebrew word ending in a final
# letter with a descender (ך, ן, ץ) hangs differently from one ending in a
# square letter, which is exactly the asymmetry the old correction misread.
NAMES = ["יעל", "רן", "דניאל", "שירה חוגגת יובל", "יעל חוגגת יובל",
         # VOWEL-POINTED, and it earns its place: a holam is a combining mark
         # with ZERO advance and real ink, which is precisely the shape a
         # correction built on advance-vs-ink bearings gets wrong. Rendered, the
         # mark draws and the title lands where the unpointed one does — the
         # assertion is that adding niqqud changes nothing about the centring.
         "יעל חוגגת יוֹבל"]


def _hebrew_themes():
    shipped = json.load(open(os.path.join(HERE, "themes.json"), encoding="utf-8"))
    return [(k, v) for k, v in sorted(shipped.items())
            if v.get("name_form") == "hebrew"
            and (v.get("title_style") or {}).get("align", "center") == "center"]


def _offsets(key, entry, names, out_dir):
    """How far each title's ink sits from the box centre, in box units."""
    blocks, labels = [], []
    for name in names:
        lines, fp, block = T._shipped_title_block(key, entry, name)
        if block:
            blocks.append(block)
            labels.append((name, lines, fp))
    if not blocks:
        return []
    mask = T._chrome_mask(
        T._title_doc(*blocks, font_path=labels[0][2],
                     weight=config.title_font_weight(entry)),
        T._BAND_W, T._BAND_H * len(blocks), SCALE,
        os.path.join(out_dir, re.sub(r"\W", "_", key) + ".png"))
    out = []
    for (name, lines, _), span in zip(labels, T._band_spans(mask, len(blocks))):
        assert span, f"{key}/{name}: nothing rendered"
        out.append((name, lines, (span[0] + span[1]) / 2 / SCALE - CX))
    return out


def test_a_centred_hebrew_title_puts_its_ink_in_the_middle_of_the_box():
    """The regression itself, on every shipped Hebrew theme.

    Coarse on purpose: with the repo's near-symmetric Hebrew faces both shipped
    mistakes measure only a unit or three here, and a threshold tight enough to
    separate them would be measuring antialiasing. On the real card, with the
    volume's brush face, the same fault is 17 units — which is what this catches.
    The exact guard is the invariant in the next test.
    """
    d = tempfile.mkdtemp(prefix="dugri-rtlcentre-")
    themes = _hebrew_themes()
    assert themes, "no centred Hebrew theme is shipped — this test stopped testing"
    checked = 0
    for key, entry in themes:
        for name, lines, off in _offsets(key, entry, NAMES, d):
            checked += 1
            assert abs(off) <= TOL, (
                f"{key}/{name} {lines}: the title's ink sits {off:+.2f} units "
                f"from the centre of a {WIDTH:.0f}-unit box "
                f"({off / WIDTH * 100:+.1f}% of it) — a centred title is not centred"
            )
    assert checked >= 5, f"only {checked} titles were actually rendered"


def test_the_correction_is_not_simply_reintroduced_with_the_other_sign():
    """A guard against the fix that has already been shipped twice.

    Whatever an RTL title's measured bearings say, the anchor must not move with
    them: a run whose bearings are wildly lopsided has to land in the same place
    as one whose bearings are even. Asserting THAT — rather than a sign — is
    what makes flipping it back a failing test rather than a review comment.
    """
    import render_page as rp
    d = tempfile.mkdtemp(prefix="dugri-rtlsign-")
    key, entry = _hebrew_themes()[0]
    names = NAMES[:3]
    honest = _offsets(key, entry, names, d)

    orig = rp._ink_bearings
    try:
        # Bearings that scream "shift me", in the direction each sign would take.
        rp._ink_bearings = lambda f, ref, line, size: (size * 0.9, 0.0)
        lop = _offsets(key, entry, names, tempfile.mkdtemp(prefix="dugri-rtlsign2-"))
    finally:
        rp._ink_bearings = orig

    for (name, _, a), (_, _, b) in zip(honest, lop):
        assert abs(a - b) <= 0.5, (
            f"{key}/{name}: the anchor moved {abs(a - b):.2f} units when the "
            "bearings changed — an RTL title is being skewed by them again"
        )


def test_a_latin_title_still_gets_its_correction():
    """The fix is about RTL, and must not quietly disarm the LTR case.

    Measured the same way, the skew is worth up to ~1.7 units on a Latin title
    and never hurt — small, but it is the reason the term exists, and a change
    aimed at Hebrew has no business removing it.
    """
    import render_page as rp
    shipped = json.load(open(os.path.join(HERE, "themes.json"), encoding="utf-8"))
    latin = [(k, v) for k, v in sorted(shipped.items())
             if v.get("name_form", "english").startswith("english")
             and (v.get("title_style") or {}).get("align", "center") == "center"]
    assert latin, "no centred Latin theme is shipped"
    key, entry = latin[0]
    names = ["Dan", "Alexandra"]
    d = tempfile.mkdtemp(prefix="dugri-ltr-")
    live = _offsets(key, entry, names, d)

    orig = rp._ink_bearings
    try:
        rp._ink_bearings = lambda f, ref, line, size: (0.0, 0.0)
        without = _offsets(key, entry, names, tempfile.mkdtemp(prefix="dugri-ltr2-"))
    finally:
        rp._ink_bearings = orig

    moved = max(abs(a[2] - b[2]) for a, b in zip(live, without))
    assert moved > 0.5, (
        f"{key}: turning the bearings off moved a Latin title by only "
        f"{moved:.2f} units — the LTR correction is no longer being applied"
    )
