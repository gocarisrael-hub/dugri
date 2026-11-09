#!/usr/bin/env python3
"""Two per-design knobs the owner sets from the admin: ``word_color`` and ``pawn_halo``.

``word_color`` pins the ink a design's card words print in. The ink is normally
DETECTED per word slot, and detection can be wrong without anything noticing:
יולי גלזר הפקות sets cream words on navy, the detector read the navy page as the
ink, and DG-1786 printed 412 words in the paper's own colour. The pin must win
over every detected slot, and the pawn card's own copy (which follows the deck's
word ink on dark paper, ``card_paper.reink``) must follow it too.

``pawn_halo: false`` prints a design's pawns without the white sticker outline —
"remove the white background from the pawns". It must turn the outline off in
the ONE place both the print and the site read it (the card's own
``#sticker-halo`` filter), leave every bit of geometry where it was, and leave
every design that never mentions it exactly as before.

Run: python3 -m pytest generator/test_word_color_pawn_halo.py
"""
import re

import pytest

import card_paper
import config
import render_page as rp

THEME = "grapefruit"          # a shipped single-card theme with a detected recipe
PINK_PAPER = "#f6c9cf"
NAVY = "#06203f"
CREAM = "#faf09d"


def _with(monkeypatch, **extra):
    """config.theme(THEME) answering with ``extra`` merged into its entry."""
    real = config.theme

    def theme(name):
        cfg = real(name)
        return {**cfg, **extra} if name == THEME else cfg

    monkeypatch.setattr(config, "theme", theme)


def _slots():
    cfg = config.theme(THEME)
    recipe = config.recipe_or_empty(cfg)
    cell = recipe["card"]["cell"]
    return rp.deck_slots(THEME, config.card_word_boxes(cfg, recipe, cell), cell), cell


# --- word_color -------------------------------------------------------------

def test_word_color_reads_only_a_hex_colour():
    assert config.word_color({"word_color": "#FAF09D"}) == CREAM
    assert config.word_color({"word_color": " #abc "}) == "#abc"
    for bad in (None, "", "gold", "#12345", 7, ["#ffffff"]):
        assert config.word_color({"word_color": bad}) is None
    assert config.word_color({}) is None


def test_without_a_pin_the_detected_ink_prints():
    slots, _ = _slots()
    detected = rp._deck_rows(THEME)[1]
    assert detected and detected.lower() != CREAM
    assert {s["color"] for s in slots} == {detected}


def test_a_pinned_ink_beats_every_detected_slot(monkeypatch):
    before, _ = _slots()
    _with(monkeypatch, word_color=CREAM)
    after, _ = _slots()
    assert {s["color"] for s in after} == {CREAM}
    # Only the colour moves: geometry is the detected/calibrated geometry still.
    strip = lambda ss: [{k: v for k, v in s.items() if k != "color"} for s in ss]
    assert strip(after) == strip(before)


def test_a_pinned_ink_applies_with_no_recipe_too(monkeypatch):
    """A template calibrated by hand, never detected, has no rows to pool."""
    _with(monkeypatch, word_color=CREAM)
    monkeypatch.setattr(rp, "_deck_rows", lambda theme: (None, None))
    slots = [{"x0": 0, "y0": 0, "x1": 10, "y1": 5, "color": NAVY}]
    assert rp.deck_slots(THEME, slots, [0, 0, 100, 100])[0]["color"] == CREAM
    # …and nothing changes when nothing is pinned.
    monkeypatch.setattr(config, "theme", lambda name: {})
    assert rp.deck_slots(THEME, slots, [0, 0, 100, 100])[0]["color"] == NAVY


def test_the_pawn_card_copy_follows_the_pinned_ink_on_dark_paper(monkeypatch):
    _with(monkeypatch, word_color=CREAM)
    assert rp.deck_ink(THEME) == CREAM
    svg = rp.photo_card_svg(THEME, [], paper=NAVY, frame=None)
    copy = re.search(r"<path\b[^>]*\bdata-copy=[^>]*>", svg).group(0)
    assert f'fill="{CREAM}"' in copy


# --- pawn_halo --------------------------------------------------------------

def _halo(svg):
    return re.search(r'<filter\b[^>]*\bid="sticker-halo".*?</filter>', svg, re.S).group(0)


def test_pawn_halo_defaults_on():
    assert config.pawn_halo({}) is True
    assert config.pawn_halo({"pawn_halo": True}) is True
    assert config.pawn_halo({"pawn_halo": "false"}) is True   # only a real false
    assert config.pawn_halo({"pawn_halo": False}) is False


def test_drop_halo_empties_the_filter_and_nothing_else():
    svg = rp.photo_card_svg(THEME, [], paper=PINK_PAPER, frame=None)
    bare = card_paper.drop_halo(svg)
    halo = _halo(bare)
    # Still there under the same id (the site paints through it by that id) …
    assert 'id="sticker-halo"' in halo
    # … but it paints nothing: no white, no dilation, no shadow.
    assert 'flood-opacity="0"' in halo
    assert "feMorphology" not in halo and "feDropShadow" not in halo
    # Everything outside the filter is byte-identical: slots, cut lines, uses.
    assert bare.replace(halo, "") == svg.replace(_halo(svg), "")
    assert bare.count("<use ") == svg.count("<use ")
    assert len(re.findall(r'class="cut-line"', bare)) == 4


def test_a_design_that_turns_it_off_prints_bare_pawns(monkeypatch):
    shipped = rp.photo_card_svg(THEME, [], paper=PINK_PAPER, frame=None)
    assert "feMorphology" in _halo(shipped)          # the house look, untouched
    _with(monkeypatch, pawn_halo=False)
    bare = rp.photo_card_svg(THEME, [], paper=PINK_PAPER, frame=None)
    assert "feMorphology" not in _halo(bare)
    assert bare == card_paper.drop_halo(shipped)


def test_the_site_is_handed_the_same_bare_filter(monkeypatch, tmp_path):
    """preview.sticker_spec reads the filter out of the rendered card's SVG — the
    page paints her pawns through it — so the page loses the halo with the print."""
    import preview
    _with(monkeypatch, pawn_halo=False)
    svg = rp.photo_card_svg(THEME, [], paper=PINK_PAPER, frame=None)
    png = tmp_path / "card.png"
    (tmp_path / "card.svg").write_text(svg, encoding="utf-8")
    spec = preview.sticker_spec(THEME, str(png))
    assert spec["filter"] and 'flood-opacity="0"' in spec["filter"]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
