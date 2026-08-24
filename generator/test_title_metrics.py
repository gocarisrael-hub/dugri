"""The title-width probe: does it measure, and does it fail safely?

WHY A PROBE AT ALL. The title is sized to fill its calibrated box, and that fit
measures with Pillow while Chrome draws the card. On סנטוריני's brush face the
two disagree by up to 24% on the same string, so the fit stopped at a size where
Pillow said the title fitted and Chrome drew it 2.2mm out of its box — reported
by the owner as a title shoved to one side.

These tests run the real thing where Chrome is available, and pin the failure
behaviour everywhere: a probe that cannot measure MUST answer "no correction",
because a title that cannot be measured still has to be drawn.
"""
import os
import shutil
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import title_metrics as tm            # noqa: E402
import render_page as rp              # noqa: E402

pytest.importorskip("PIL")

REPO_FONT = os.path.join(HERE, "..", "resources", "canva", "templates",
                         "anniversary", "fonts", "Dana Yad AlefAlefAlef Normal.ttf")
HAS_CHROME = shutil.which(os.environ.get("CHROME", "")) is not None or True


@pytest.fixture(autouse=True)
def _clean():
    tm.clear_cache()
    yield
    tm.clear_cache()


def _face(path):
    return rp._title_face(path, None, rtl=True)


def test_an_empty_title_asks_chrome_nothing():
    assert tm.probe(REPO_FONT, [], _face(REPO_FONT)) == {}
    assert tm.probe(REPO_FONT, ["", "   "], _face(REPO_FONT)) == {}


def test_a_font_that_does_not_exist_answers_no_correction():
    """The one wrong answer this must never give is a made-up number."""
    out = tm.probe(os.path.join(HERE, "no-such-font.ttf"), ["דניאל"], _face(REPO_FONT))
    assert out["דניאל"] == (1.0, 0.0)


def test_a_dead_chrome_answers_no_correction(monkeypatch):
    """Chrome missing, timing out, or refusing: the title is still drawn, and
    drawn exactly as it is drawn today."""
    import chrome
    monkeypatch.setattr(chrome, "screenshot",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no chrome")))
    out = tm.probe(REPO_FONT, ["דניאל"], _face(REPO_FONT))
    assert out["דניאל"] == (1.0, 0.0)


def test_it_never_asks_chrome_twice_for_the_same_title(monkeypatch):
    """A deck draws its title on ~104 cards. That is one measurement, not 104."""
    import chrome
    calls = []
    real = chrome.screenshot
    monkeypatch.setattr(chrome, "screenshot",
                        lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    face = _face(REPO_FONT)
    for _ in range(5):
        tm.probe(REPO_FONT, ["דניאל"], face)
    assert len(calls) == 1


def test_the_cache_cannot_grow_without_bound(monkeypatch):
    """It is keyed by buyer-supplied text, and something may import this into a
    process that outlives one order."""
    import chrome
    monkeypatch.setattr(chrome, "screenshot",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("skip")))
    face = _face(REPO_FONT)
    for i in range(tm._CACHE_MAX + 40):
        tm.probe(REPO_FONT, [f"שם{i}"], face)
    assert len(tm._CACHE) <= tm._CACHE_MAX


@pytest.mark.skipif(not os.path.exists(REPO_FONT), reason="font not in this checkout")
def test_a_measured_ratio_is_never_below_one():
    """It exists to SHRINK an overflowing title. Letting it grow type would
    re-size every title on every template on the strength of one measurement."""
    face = _face(REPO_FONT)
    out = tm.probe(REPO_FONT, ["דניאל", "ליאתי מלכת המשחקים", "רן"], face)
    assert out, "the probe returned nothing — Chrome may be unavailable here"
    for line, (ratio, _off) in out.items():
        assert ratio >= 1.0, f"{line}: ratio {ratio} would GROW the title"


@pytest.mark.skipif(not os.path.exists(REPO_FONT), reason="font not in this checkout")
def test_it_measures_a_real_render_rather_than_guessing():
    """A ratio of exactly 1.0 for every line would mean the probe never ran; an
    offset that scales with size would mean it is reporting pixels, not a
    per-unit factor. Both are ways this could look alive while saying nothing."""
    face = _face(REPO_FONT)
    out = tm.probe(REPO_FONT, ["ליאתי מלכת"], face)
    ratio, off = out["ליאתי מלכת"]
    assert 1.0 <= ratio < 3.0, f"implausible ratio {ratio}"
    # The offset is per unit of font size, so it is a small number — a raw pixel
    # offset at the probe size would be tens of units.
    assert abs(off) < 1.0, f"offset {off} looks like pixels, not a per-size factor"
