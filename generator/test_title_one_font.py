"""A title is set in ONE font.

The owner's rule, in her words: "title is always the first font, unless the
language changed and then the font also changes."

What she reported was the opposite: "titles in english change font with no
reason to the second font". The cause was that titles shared ``Face.runs`` with
the card's WORDS, and that split routes every Latin run to the second face by
script. Correct for words — English words take the design's Latin face — and
wrong for a title, which is one thing set in one face.
"""
import json
import os
import shutil

import pytest

import config
import render_page as rp

HEB = "מזל טוב שירה"
ENG = ["SHIRA'S", "40S"]


@pytest.fixture()
def deck_with_two_title_fonts(tmp_path, monkeypatch):
    """An ENGLISH design carrying a second title font, like the owner's."""
    themes = json.load(open(config.THEMES_JSON, encoding="utf-8"))
    themes["japanese"]["title_font_alt"] = "Assistant-Bold.ttf"
    path = tmp_path / "themes.json"
    path.write_text(json.dumps(themes, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(config, "THEMES_JSON", str(path))
    config.theme.cache_clear() if hasattr(config.theme, "cache_clear") else None
    src = config.font_path("birthday-boys-basketball", "Assistant-Bold.ttf")
    dst = config.font_path("japanese", "Assistant-Bold.ttf")
    shutil.copy(src, dst)
    yield "japanese"
    os.remove(dst)


def test_an_english_title_stays_in_the_designs_own_font(deck_with_two_title_fonts):
    # THE REPORTED BUG. An ordinary English title on an English design must not
    # touch the second font just because it has Latin runs in it.
    theme = deck_with_two_title_fonts
    chosen = rp.title_font_for(theme, ENG)
    assert os.path.basename(chosen) == "Quick.ttf", chosen


def test_the_second_font_is_used_when_the_language_changed(deck_with_two_title_fonts):
    # ...and it IS reached for the one case it exists for: the buyer wrote the
    # title in the other language.
    theme = deck_with_two_title_fonts
    chosen = rp.title_font_for(theme, [HEB])
    assert os.path.basename(chosen) == "Assistant-Bold.ttf", chosen


def test_the_whole_title_is_one_face_never_split_per_run(deck_with_two_title_fonts):
    # The structural guarantee behind both cases: the markup carries no second
    # face, so a per-run swap is impossible rather than merely unlikely.
    theme = deck_with_two_title_fonts
    cfg = config.theme(theme)
    ts = cfg["title_style"]
    box = {"x0": 0.0, "y0": 0.0, "x1": 400.0, "y1": 160.0}
    svg = rp.title_block(box, ["SHIRA'S 40"], ts["fill"], ts["outline"],
                         rp.title_font_for(theme, ["SHIRA'S 40"], cfg),
                         ts["outline_w"], ts["arch"], ts["shadow"],
                         rtl=rp.title_is_rtl(cfg))
    assert "TitleFontAlt" not in svg


def test_a_design_with_no_second_font_is_unchanged():
    # The ordinary case: nothing to choose between.
    assert rp.title_font_for("bachelorette", ["Dana's", "Bachelorette"]) == \
        config.resolve_title_font("bachelorette")


@pytest.mark.parametrize("lines,expected", [
    (["SHIRA'S", "40S"], "english"),
    (["מזל טוב שירה"], "hebrew"),
    (["40", "2026"], None),          # neutrals decide nothing
    (["SHIRA 40", "מזל טוב"], "english"),  # the FIRST strong character wins
])
def test_title_script_reads_the_title_as_a_whole(lines, expected):
    assert rp.title_script(lines) == expected
