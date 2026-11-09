"""An all-English deck reads left to right: "1. word", number on the LEFT.

Every card used to be laid out the Hebrew way whatever its words were — the
number on the right and the word right-aligned against it — so an English
order (guidde, DG-1785) printed ".1 LinkedIn" flush right. The direction is now
read off the WORDS: no Hebrew anywhere in the deck, and the list is set the way
an English list is. One Hebrew word keeps the whole deck right to left, so every
existing Hebrew and mixed deck prints exactly as before.
"""

import re

import card_assets
import config
import deck_html
import render_page as rp


def _card(theme="grapefruit"):
    cfg = config.theme(theme)
    recipe = config.recipe_or_empty(cfg)
    front = config.fronts(cfg)[0]
    svg = card_assets.read_svg(config.card_path(theme, front))
    return recipe, front, svg, deck_html.view_box(svg)


def _runs(markup):
    """``[(x, anchor, text)]`` for every <text> run, bidi controls stripped."""
    out = []
    for x, attrs, body in re.findall(r'<text x="([\d.-]+)"([^>]*)>(.*?)</text>', markup):
        anchor = re.search(r'text-anchor="(\w+)"', attrs).group(1)
        out.append((float(x), anchor, re.sub("[‪-‮]", "", body)))
    return out


def test_an_english_list_reads_left_to_right():
    assert rp.words_read_ltr(["LinkedIn", "Red Flag", "7-Eleven", ""])


def test_one_hebrew_word_keeps_the_deck_right_to_left():
    assert not rp.words_read_ltr(["LinkedIn", "Red Flag", "מסיבה"])
    assert not rp.words_read_ltr(["celebration של מדונה"])


def test_no_words_say_nothing():
    assert not rp.words_read_ltr([])
    assert not rp.words_read_ltr(["", "  "])
    assert not rp.words_read_ltr(["40", "2026"])


def test_an_english_card_puts_the_number_on_the_left_of_its_word():
    recipe, front, svg, vb = _card()
    out = rp.card_overlay("grapefruit", recipe, ["Nova", "ARR", "Moti", "Hello"], [],
                          front_index=front, card_vb=vb, card_svg=svg)
    runs = _runs(out)
    assert runs and all(a == "start" for _x, a, _t in runs), runs
    by_text = {t: x for x, _a, t in runs}
    for n, word in enumerate(["Nova", "ARR", "Moti", "Hello"], 1):
        assert by_text[str(n)] < by_text[word], (n, word, runs)
    # One left edge for the four words, and one for the four digits.
    words_x = {round(x, 2) for x, _a, t in runs if t in ("Nova", "ARR", "Moti", "Hello")}
    assert len(words_x) == 1, words_x


def test_the_ltr_column_is_the_mirror_of_the_rtl_one():
    # The same geometry, read the other way round: the English number's ink
    # starts where the Hebrew number's ink ends, mirrored about the card.
    recipe, front, svg, vb = _card()
    he = rp.card_overlay("grapefruit", recipe, ["אחת", "שתיים", "שלוש", "ארבע"], [],
                         front_index=front, card_vb=vb, card_svg=svg)
    en = rp.card_overlay("grapefruit", recipe, ["One", "Two", "Three", "Four"], [],
                         front_index=front, card_vb=vb, card_svg=svg)
    he_words = [x for x, a, t in _runs(he) if t in ("אחת", "שתיים", "שלוש", "ארבע")]
    en_words = [x for x, a, t in _runs(en) if t in ("One", "Two", "Three", "Four")]
    assert all(a == "end" for _x, a, _t in _runs(he)), "a Hebrew card must not move"
    cell = (recipe.get("card") or {}).get("cell") or rp._recipe_cell(recipe, vb)
    axis = cell[0] + cell[2]
    # Hebrew words END at x; English words START at axis - x.
    assert abs((axis - he_words[0]) - en_words[0]) < 0.5, (he_words, en_words, axis)


def test_a_long_english_phrase_wraps_under_its_own_first_line():
    recipe, front, svg, vb = _card()
    words = ["Nova", "ARR", "Moti", "Qualcomm Ventures Product Manager"]
    out = rp.card_overlay("grapefruit", recipe, words, [], front_index=front,
                          card_vb=vb, card_svg=svg)
    runs = [(x, t) for x, a, t in _runs(out) if not t.strip(".").isdigit() and t != "."]
    lines = [t for _x, t in runs]
    assert "Qualcomm Ventures Product Manager" not in lines, lines
    assert len({round(x, 2) for x, _t in runs}) == 1, runs


def test_the_deck_decides_so_a_card_of_english_in_a_hebrew_deck_does_not_flip():
    recipe, front, svg, vb = _card()
    out = rp.card_overlay("grapefruit", recipe, ["Netflix", "Zara", "Tinder", "iPhone"], [],
                          front_index=front, card_vb=vb, card_svg=svg, ltr=False)
    assert all(a == "end" for _x, a, _t in _runs(out))


def test_the_pitch_need_is_asked_of_the_card_as_drawn():
    recipe, front, svg, vb = _card()
    words = ["Nova", "ARR", "Moti", "Qualcomm Ventures Product Manager Theory"]
    need = rp.card_pitch_need("grapefruit", recipe, words, front_index=front,
                              card_vb=vb, card_svg=svg)
    assert need is None or need > 0
