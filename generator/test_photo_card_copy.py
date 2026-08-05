#!/usr/bin/env python3
"""The pawn card's static copy — the words, and that the outlines still say them.

The copy is OUTLINED PATHS, not ``<text>``: ``docs/photo-card.md`` makes "the
card needs no @font-face injection" a contract that the deck path and the
preview path both lean on. Outlines cost testability — you cannot read a word
out of a bezier — so every copy path carries the sentence it draws in
``data-copy``, and ``scripts/set_photo_card_copy.py`` regenerates the ``d`` from
it. This re-runs that script in ``--check`` mode, which is the only thing that
can catch the copy and its outlines drifting apart.

Run: python3 -m pytest generator/test_photo_card_copy.py
"""
import os
import re
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "scripts"))

CARDS = {
    "generic": os.path.join(REPO, "resources", "canva", "templates", "_shared",
                            "photo-card", "photo.svg"),
    "grapefruit": os.path.join(REPO, "resources", "canva", "templates",
                               "grapefruit", "clean", "photo.svg"),
}

CAPTION = "גזרו אותם לפי הקווים"
# What the caption used to say, and the wordmark that used to sit under the
# pawns. Both were removed on the owner's instruction; naming them here is what
# stops either quietly coming back.
OLD_CAPTION = "בחרו פיון והתחילו לשחק"
WORDMARK = "דוגרי"

# The pawn grid ends at y = 231 (slot 3/4 at y=165, 66 tall). Everything below it
# was the footer: a short rule at y=251 and the wordmark at y≈262-270.
FOOTER_TOP = 240.0

_PAINTED = re.compile(r"<(?:path|rect|circle|ellipse|line|polyline|polygon|text|image)\b[^>]*>")


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _body(markup):
    """The card minus its <defs> and <title> — i.e. what actually prints."""
    markup = re.sub(r"<defs\b.*?</defs>", "", markup, flags=re.S)
    return re.sub(r"<title>.*?</title>", "", markup, flags=re.S)


def _ys(d):
    """Every y coordinate in a path's ``d``, crudely but exhaustively.

    Crude on purpose: this asks "is there ANY ink down there", so over-reading
    coordinates is safe and under-reading is not.
    """
    nums = [float(n) for n in re.findall(r"-?\d+\.?\d*(?:[eE]-?\d+)?", d)]
    return nums[1::2]


@pytest.mark.parametrize("name", sorted(CARDS))
def test_the_caption_says_what_the_owner_asked_for(name):
    svg = _read(CARDS[name])
    copies = re.findall(r'\bdata-copy="([^"]*)"', svg)
    assert CAPTION in copies, f"{name} does not carry the caption"


@pytest.mark.parametrize("name", sorted(CARDS))
def test_the_old_caption_is_gone(name):
    assert OLD_CAPTION not in _read(CARDS[name])


@pytest.mark.parametrize("name", sorted(CARDS))
def test_every_copy_path_actually_draws_something(name):
    """``data-copy`` is documentation of the outlines, not a substitute for them."""
    svg = _read(CARDS[name])
    for el in re.findall(r"<path\b[^>]*\bdata-copy=[^>]*/>", svg):
        d = re.search(r'\bd="([^"]*)"', el)
        assert d and len(d.group(1)) > 200, f"{name}: a copy path draws nothing"


@pytest.mark.parametrize("name", sorted(CARDS))
def test_nothing_prints_below_the_pawn_grid(name):
    """The דוגרי wordmark and the rule above it are gone from the card.

    Asserted as "no ink in that band" rather than "this particular path is
    absent": the wordmark was outlines, so its absence cannot be checked by
    searching for the word, and a redrawn version of it would sit in exactly the
    same place.
    """
    for el in _PAINTED.findall(_body(_read(CARDS[name]))):
        d = re.search(r'\bd="([^"]*)"', el)
        if d:
            below = [y for y in _ys(d.group(1)) if y > FOOTER_TOP]
            assert not below, f"{name}: ink at y={max(below):.1f} — {el[:80]}"
            continue
        y = re.search(r'\by="([\d.]+)"', el)
        h = re.search(r'\bheight="([\d.]+)"', el)
        if y and h:
            # A full-bleed rect legitimately spans the whole card.
            if float(h.group(1)) < 200:
                assert float(y.group(1)) + float(h.group(1)) <= FOOTER_TOP, el[:80]


@pytest.mark.parametrize("name", sorted(CARDS))
def test_the_wordmark_did_not_come_back_as_text(name):
    assert WORDMARK not in _body(_read(CARDS[name]))


def test_the_outlines_still_say_what_the_words_say():
    """Re-set every copy path from its ``data-copy`` and require no change.

    This is the test that makes outlined copy safe to ship: editing ``data-copy``
    without regenerating, or hand-patching a ``d``, both fail here.
    """
    pytest.importorskip("fontTools", reason="fonttools is a dev dependency")
    import set_photo_card_copy as tool
    assert tool.main(["--check"]) == 0


def test_the_script_refuses_a_font_that_cannot_set_the_words():
    """A silent tofu box on a printed card would be far worse than a crash."""
    pytest.importorskip("fontTools", reason="fonttools is a dev dependency")
    import set_photo_card_copy as tool
    latin_only = os.path.join(REPO, "generator", "MrDafoe-Regular.ttf")
    if not os.path.exists(latin_only):
        pytest.skip("no Latin-only font to try")
    with pytest.raises(SystemExit) as e:
        tool.outline("גזרו", latin_only, 7, 111.96, 70)
    assert "no glyph" in str(e.value)
