"""typefit: the generator answering what the press will actually set.

The calibration screen fits in JavaScript so it can answer mid-drag, and a second
implementation of a fit drifts — this one did, three separate ways, each invisible
until the two answers were compared. These tests hold the ANSWERING end: that it
reports the same number the renderer uses, that unsaved knobs really do change the
answer (otherwise the screen is asking about the saved template, not the one on
screen), and that it fails loudly rather than guessing.
"""
import json
import subprocess
import sys
import os

import config
import render_page as R
import typefit

HERE = os.path.dirname(__file__)
WORDS = ["מסיבה", "ריקודים", "צחוקים", "חברים"]
THEME = "grapefruit"


def test_it_reports_the_size_the_renderer_actually_sets():
    """The whole point: this must not be a second opinion, it must be THE one."""
    got = typefit.typefit(THEME, WORDS)
    cfg = config.theme(THEME)
    vb = cfg.get("card_viewbox") or {"w": 223.92, "h": 312}
    cell = [0, 0, vb["w"], vb["h"]]
    slots = typefit._slots(cfg, cell)
    from PIL import ImageFont
    font = ImageFont.truetype(config.resolve_word_font(THEME), 200)
    lay = R._word_layouts(slots, WORDS, font, 200, cell=cell,
                          word_size=cfg.get("word_size"),
                          max_size=config.type_ceiling(cfg, "word_max_he"))
    assert abs(got["word_size"] - max(l.size for l in lay if l)) < 1e-6


def test_a_pinned_size_is_the_answer():
    """`uniform = word_size if word_size else ...` — the box does not reduce a
    pin. The screen read 15.82 here where the press sets 21.30."""
    got = typefit.typefit(THEME, WORDS)
    assert abs(got["word_size"] - config.theme(THEME)["word_size"]) < 1e-6


def test_unsaved_knobs_change_the_answer():
    """She is asking about numbers she has NOT committed to; an answer computed
    from the saved template would be answering a different question."""
    free = typefit.typefit(THEME, WORDS)
    held = typefit.typefit(THEME, WORDS, {"word_max_he": 9.0, "word_size": None})
    assert held["word_size"] < free["word_size"]
    assert abs(held["word_size"] - 9.0) < 0.01


def test_overrides_do_not_touch_the_saved_template():
    before = dict(config.theme(THEME))
    typefit.typefit(THEME, WORDS, {"word_size": 4.0})
    assert config.theme(THEME) == before


def test_it_reports_the_wrapping_too():
    """A card that wraps is a different card; the count comes back so the screen
    can say so rather than only showing a size."""
    got = typefit.typefit(THEME, ["מסיבה גדולה מאוד בבית של סבתא", "ים", "כלב", "גן"])
    assert got["lines"][0] >= 1


def test_an_unknown_theme_says_so_rather_than_guessing():
    out = subprocess.run([sys.executable, os.path.join(HERE, "typefit.py")],
                         input=json.dumps({"theme": "no-such-template", "words": WORDS}),
                         capture_output=True, text=True, cwd=HERE)
    assert json.loads(out.stdout)["error"]


def test_the_cli_answers_json_on_stdout():
    out = subprocess.run([sys.executable, os.path.join(HERE, "typefit.py")],
                         input=json.dumps({"theme": THEME, "words": WORDS}),
                         capture_output=True, text=True, cwd=HERE)
    assert out.returncode == 0, out.stderr
    got = json.loads(out.stdout)
    assert got["word_size"] > 0 and got["theme"] == THEME
