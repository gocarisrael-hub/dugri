"""The title's base direction is read off the TITLE, not off the design.

A title that mixes digits with Hebrew — "30 שנות נישואין", "{NAME} בן {AGE}" —
must be laid out right-to-left, or the number prints on the wrong side of the
words. That direction used to be taken from the theme's ``language`` field,
which was right while the honoree's name was composed into a designed title and
wrong the moment buyers began typing the WHOLE title themselves: seven of the
ten shipped designs are ``language: english`` and every one of them takes Hebrew
titles daily.

``title_font_for`` already reads the FACE off the same text via
``title_script``. These tests hold the direction to that same rule, so the two
can never again disagree about what language a title is in.
"""
import re

import config
import render_page as R

HEB_NUM = ["30 שנות נישואין"]
HEB = ["מזל טוב"]
ENG = ["MAZAL TOV"]

# A Latin-scripted design, and a Hebrew one, both real and both shipped.
ENGLISH_THEME = "bachelorette"
HEBREW_THEME = "anniversary"


def _cfg(name):
    return config.theme(name)


# ------------------------------------------------------------ the rule itself
def test_a_hebrew_title_is_rtl_on_a_latin_design():
    """The bug: the number in "30 שנות נישואין" printed on the left."""
    cfg = _cfg(ENGLISH_THEME)
    assert cfg.get("language") == "english", "fixture must be a Latin design"
    assert R.title_is_rtl(cfg, HEB_NUM) is True


def test_an_english_title_is_ltr_on_a_hebrew_design():
    cfg = _cfg(HEBREW_THEME)
    assert cfg.get("language") == "hebrew", "fixture must be a Hebrew design"
    assert R.title_is_rtl(cfg, ENG) is False


def test_a_hebrew_title_stays_rtl_on_a_hebrew_design():
    """The case that already worked must keep working."""
    assert R.title_is_rtl(_cfg(HEBREW_THEME), HEB) is True


def test_an_english_title_stays_ltr_on_a_latin_design():
    assert R.title_is_rtl(_cfg(ENGLISH_THEME), ENG) is False


# ------------------------------------------------------- what decides nothing
def test_digits_alone_decide_nothing_and_the_design_answers():
    """No strong character anywhere, so there is nothing to read the title by —
    the theme's own language is the only answer available, and is what the
    caller got before this rule existed."""
    assert R.title_is_rtl(_cfg(HEBREW_THEME), ["30"]) is True
    assert R.title_is_rtl(_cfg(ENGLISH_THEME), ["30"]) is False


def test_no_lines_at_all_keeps_the_designs_language():
    # Back-compat: `title_is_rtl(cfg)` is still a valid call and still answers
    # exactly as it did (test_config.test_title_is_rtl_by_language relies on it).
    assert R.title_is_rtl(_cfg(HEBREW_THEME)) is True
    assert R.title_is_rtl(_cfg(ENGLISH_THEME)) is False
    assert R.title_is_rtl(_cfg(ENGLISH_THEME), []) is False


def test_the_first_strong_character_wins_wherever_it_sits():
    # Same rule title_script states: neutrals decide nothing, so a title opening
    # with a number reads by the words that follow it.
    assert R.title_is_rtl(_cfg(ENGLISH_THEME), ["40", "שנה טובה"]) is True
    assert R.title_is_rtl(_cfg(HEBREW_THEME), ["40", "YEARS ON"]) is False


def test_it_agrees_with_the_face_the_same_title_gets():
    """The direction and the FONT are both read off the title; if they ever
    disagree a title prints in a Hebrew face laid out left-to-right."""
    for theme in (ENGLISH_THEME, HEBREW_THEME):
        cfg = _cfg(theme)
        for lines in (HEB_NUM, HEB, ENG):
            script = R.title_script(lines)
            assert R.title_is_rtl(cfg, lines) is (script == "hebrew")


# ------------------------------------------------------------- what it renders
# A plain box on a plain card. The shipped themes keep their per-front title
# slots on the owner's volume, not in the repo, so the geometry here is stated
# outright — what these two tests read is the base direction, which no box moves.
CARD = [0, 0, 223.92, 312]
BOX = [{"x0": 50.0, "y0": 34.0, "x1": 190.0, "y1": 93.0}]


def _overlay(theme, lines):
    return "".join(R._title_overlay(BOX, lines, _cfg(theme),
                                    config.resolve_title_font(theme), CARD))


def test_the_rendered_latin_design_carries_rtl_for_a_hebrew_title():
    svg = _overlay(ENGLISH_THEME, HEB_NUM)
    assert 'direction="rtl"' in svg, (
        'a Hebrew numbered title on a Latin design must render with an RTL base '
        'direction, or the number lays out on the wrong side'
    )


def test_the_rendered_latin_design_stays_ltr_for_an_english_title():
    assert 'direction="rtl"' not in _overlay(ENGLISH_THEME, ENG)


def test_the_title_text_reaches_the_svg_unreversed():
    """The direction attribute does the ordering; the generator must not also
    reorder the characters itself, or the two cancel out."""
    svg = _overlay(ENGLISH_THEME, HEB_NUM)
    body = re.sub(r"<[^>]+>", "", svg)
    assert HEB_NUM[0] in body


# --------------------------------------------------- every surface, not just one
def test_no_caller_asks_without_the_title():
    """The card, the card BACK and the BOARD each set their own title, and the
    bug was invisible on any surface whose call still passed only ``cfg``. A
    ``title_is_rtl(cfg)`` with no lines beside it in rendering code is that bug
    coming back, so it is caught here rather than by eye on a printed board.
    """
    import os
    import re

    here = os.path.dirname(__file__)
    offenders = []
    for name in ("render_page.py", "build.py", "preview.py", "deck_html.py"):
        path = os.path.join(here, name)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                if re.search(r"title_is_rtl\(\s*cfg\s*\)", line):
                    offenders.append(f"{name}:{i}")
    assert not offenders, (
        "these render the title without telling title_is_rtl what the title says, "
        "so a Hebrew title on a Latin design lays out backwards: " + ", ".join(offenders)
    )
