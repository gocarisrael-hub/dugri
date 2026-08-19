#!/usr/bin/env python3
"""Tests for measuring how demanding an entry is, and for dealing by it.

THE OWNER'S QUESTION: "maybe it's better to divide the words in a card in a way
that maximizes the biggest font size?" — and the measurement is what settles it,
in a direction that is not the intuitive one. See pack.deal_measured.
"""
import random
import statistics

import pack
import word_demand as wd

THEME = "grapefruit"          # the one shipped template with calibrated slots

# Entries chosen for what they prove, not for looking realistic:
HARD = "קונסטרוקטיביזם"        # one token, nowhere to break — the worst case
EASY = "ים"


def _sizes(words):
    return wd.measure(words, THEME)


def test_a_long_unbreakable_word_measures_harder_than_a_long_phrase():
    # THE WHOLE POINT. The old rule called an entry demanding when it contained a
    # space, which gets this exactly backwards: a phrase wraps onto two lines and
    # keeps its size, while a single long token has nowhere to break and drags
    # its whole card down.
    sizes = _sizes([HARD, "בר רווקות", EASY])
    assert sizes[HARD] < sizes["בר רווקות"] < sizes[EASY]
    # …and the old rule would have said the opposite:
    assert pack.is_multi("בר רווקות") and not pack.is_multi(HARD)


def test_a_short_word_measures_easiest():
    sizes = _sizes(["אמא", "פסטיבל", "אינטרנציונליזם"])
    assert sizes["אמא"] > sizes["פסטיבל"] > sizes["אינטרנציונליזם"]


def test_measuring_never_raises_on_a_theme_it_cannot_read():
    # An order must not fail because a measurement could not be made; the caller
    # reads {} as "no measurement" and deals the old way.
    assert wd.measure(["מילה"], "no-such-theme-at-all") == {}
    assert wd.measure([], THEME) == {}


def test_hard_entries_are_spread_one_per_card():
    # THE RULE, and it is the SECOND answer this has had. While every card solved
    # its own line spacing, clustering the hard entries was better: one card
    # absorbed them by tightening its rhythm. The deck-wide rhythm removed that
    # escape (render_page.design_pitch), so several hard entries on one card have
    # nowhere to go but down in size — and they compound.
    hard = ["קונסטרוקטיביזם", "אינטרנציונליזם", "אינטרוספקציה", "אימפרסיוניזם"]
    easy = ["ים", "אמא", "דוד", "שוק", "חוף", "כלב", "עץ", "אור", "גן", "רון", "נר", "תה"]
    words = hard + easy
    sizes = _sizes(words)
    rows = pack.deal(words, 4, random.Random(3), sizes=sizes)
    per_card = [sum(1 for w in row if w in set(hard)) for row in rows]
    assert max(per_card) == 1, rows


def test_the_worst_card_of_the_deck_is_no_worse_than_the_shuffle():
    # The owner's question — "doesn't it make some few cards font super small?" —
    # asked of the measurement rather than of intuition. Spreading may not beat
    # the plain shuffle on every list, but it must never be WORSE: the whole
    # point is that no card carries two demanding entries.
    words = (["קונסטרוקטיביזם", "אינטרנציונליזם", "אינטרוספקציה", "אימפרסיוניזם"]
             + [f"מילה{i}" for i in range(40)])
    sizes = _sizes(words)
    n = 11

    def worst(rows):
        return min(min(sizes.get(w, 99) for w in r if w) for r in rows if any(r))

    old = pack.deal(words, n, random.Random(5))
    new = pack.deal(words, n, random.Random(5), sizes=sizes)
    assert worst(new) >= worst(old)


def test_no_word_is_lost_or_duplicated_by_the_measured_deal():
    words = ["קונסטרוקטיביזם"] + [f"מילה{i}" for i in range(30)]
    sizes = _sizes(words)
    rows = pack.deal(words, 8, random.Random(9), sizes=sizes)
    placed = sorted(w for r in rows for w in r if w)
    assert placed == sorted(words)
    # …and blanks stay at the END of their card, or the renderer prints an empty
    # numbered line in the middle of one.
    for row in rows:
        present = [bool(w) for w in row]
        assert present == sorted(present, reverse=True), row


def test_an_unmeasured_entry_is_treated_as_ordinary():
    # Not as hard: clustering it onto the small card on no evidence would be the
    # measurement inventing a problem.
    words = ["קונסטרוקטיביזם", "לא-נמדד"] + [f"מילה{i}" for i in range(10)]
    sizes = _sizes(words)
    sizes.pop("לא-נמדד", None)
    rows = pack.deal(words, 3, random.Random(2), sizes=sizes)
    hard_card = next(r for r in rows if "קונסטרוקטיביזם" in r)
    assert "לא-נמדד" not in hard_card


def test_small_cards_names_the_entry_that_did_it():
    words = ["קונסטרוקטיביזםאימפרסיוניזם"] + [f"מילה{i}" for i in range(20)]
    sizes = _sizes(words)
    rows = pack.deal(words, 6, random.Random(4), sizes=sizes)
    found = wd.small_cards([r for r in rows if any(r)], sizes)
    assert found, "the deliberately awful entry should surface"
    assert found[0]["word"] == "קונסטרוקטיביזםאימפרסיוניזם"
    assert found[0]["ratio"] < 0.55
    assert found[0]["index"] >= 1        # 1-based, the way a person counts cards


def test_a_card_merely_smaller_than_its_deck_is_not_reported():
    """The owner's correction, as a test: 0.65 of the deck is not "small".

    Three cards of a 70-word order carried אנציקלופדיה, אוניברסיטה and
    מתמטיקאי — ordinary long Hebrew words — and printed at 13-15 against a deck
    median of 20.2. The report named all three; she looked at the deck and said
    they had nothing small about them. Only a card that is genuinely hard to
    read is worth interrupting her for.
    """
    rows = [["a"], ["b"], ["c"], ["d"], ["e"], ["f"], ["g"]]
    ordinary = {"a": 13.11, "b": 13.65, "c": 15.13,
                "d": 20.2, "e": 20.2, "f": 20.2, "g": 20.2}
    assert wd.small_cards(rows, ordinary) == []
    # ...while the card that started all this — 6.24 against the same deck —
    # is still named.
    tiny = {**ordinary, "a": 6.24}
    named = wd.small_cards(rows, tiny)
    assert [d["index"] for d in named] == [1]


def test_a_uniformly_tiny_deck_is_still_reported():
    """The floor fires on its own. A deck where EVERY card is unreadable has no
    card standing out in it, and averaging itself out of trouble is exactly the
    failure the report exists to catch."""
    rows = [["a"], ["b"], ["c"], ["d"]]
    sizes = {"a": 7.0, "b": 7.4, "c": 7.2, "d": 7.1}
    assert len(wd.small_cards(rows, sizes)) == 4


def test_an_even_deck_reports_nothing():
    # No card stands out when every entry is ordinary — the report must stay
    # quiet rather than cry wolf on a deck nobody would look at twice.
    words = [f"מילה{i}" for i in range(40)]
    sizes = _sizes(words)
    rows = pack.deal(words, 10, random.Random(6), sizes=sizes)
    assert wd.small_cards([r for r in rows if any(r)], sizes) == []


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))


# --- WHICH ROW an entry takes (render_page.order_by_room) --------------------
#
# The packer decides which entries share a card; only the renderer knows which
# FRONT the card is printed on, and therefore which of its four rows an icon has
# taken a bite out of. So the row is chosen here, against this card's artwork.

import config
import render_page as rp


def _card():
    cfg = config.theme(THEME)
    rec = config.recipe_or_empty(cfg)
    cell = (rec.get("card") or {}).get("cell") or rp._recipe_cell(rec, None)
    slots = rp.deck_slots(THEME, config.card_word_boxes(cfg, rec, cell), cell)
    face = rp._word_face(
        config.resolve_word_font(THEME, None),
        rp.word_font_alt(THEME, None),
        alt_scale=config.word_alt_scale(cfg, rp._WORD_ALT_SCALE),
    )
    return slots, cell, face


def _icon_over(slot, width=40):
    """An icon biting into one row, from the left where the artwork's are."""
    return [(slot["x0"] - 2, slot["y0"] - 1, slot["x0"] + width, slot["y1"] + 1)]


def test_a_hard_entry_moves_off_the_row_an_icon_eats():
    slots, cell, face = _card()
    words = [HARD, "ים", "אמא", "חוף"]
    # With an icon over the FIRST row, the demanding entry must not stay there.
    got = rp.order_by_room(slots, words, face, cell=cell, obstacles=_icon_over(slots[0]))
    assert got[0] != HARD, got
    assert HARD in got


def test_the_icon_decides_it_not_a_fixed_rule():
    # The same four entries, the same card, two different fronts: the demanding
    # entry lands somewhere else. That is the whole reason this moved out of the
    # packer — a fixed "hardest goes last" cannot see the artwork.
    slots, cell, face = _card()
    words = [HARD, "ים", "אמא", "חוף"]
    first = rp.order_by_room(slots, words, face, cell=cell, obstacles=_icon_over(slots[0]))
    last = rp.order_by_room(slots, words, face, cell=cell, obstacles=_icon_over(slots[3]))
    assert first.index(HARD) != last.index(HARD), (first, last)


def test_it_keeps_every_entry_and_leaves_blanks_at_the_end():
    slots, cell, face = _card()
    words = [HARD, "ים", "", ""]
    got = rp.order_by_room(slots, words, face, cell=cell, obstacles=_icon_over(slots[0]))
    assert sorted(w for w in got if w) == sorted([HARD, "ים"])
    # A blank between two entries would print an empty numbered line.
    present = [bool(w) for w in got]
    assert present == sorted(present, reverse=True), got


def test_a_card_with_nothing_to_choose_is_left_alone():
    slots, cell, face = _card()
    for words in ([HARD, "", "", ""], ["", "", "", ""]):
        assert rp.order_by_room(slots, words, face, cell=cell, obstacles=None) == list(words)


def test_equal_rows_keep_the_order_they_arrived_in():
    # Stability matters: on a card whose rows are equally roomy the deck should
    # look exactly as it did, not be reshuffled for no gain.
    slots, cell, face = _card()
    words = ["אמא", "חוף", "ים", "דוד"]
    flat = [dict(s) for s in slots]
    for i, s in enumerate(flat):          # four identical rows, evenly spaced
        h = slots[0]["y1"] - slots[0]["y0"]
        s["y0"], s["y1"] = 20 + i * 40.0, 20 + i * 40.0 + h
        s["x0"], s["x1"] = slots[0]["x0"], slots[0]["x1"]
    assert rp.order_by_room(flat, words, face, cell=cell, obstacles=None) == words
