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


def test_hard_entries_are_put_together_not_spread_apart():
    # Four awful entries and plenty of ordinary ones: they should end up sharing
    # ONE card, so one card is small instead of four.
    hard = ["קונסטרוקטיביזם", "אינטרנציונליזם", "אינטרוספקציה", "אימפרסיוניזם"]
    easy = ["ים", "אמא", "דוד", "שוק", "חוף", "כלב", "עץ", "אור", "גן", "רון", "נר", "תה"]
    words = hard + easy
    sizes = _sizes(words)
    rows = pack.deal(words, 4, random.Random(3), sizes=sizes)
    on_one_card = max(sum(1 for w in row if w in set(hard)) for row in rows)
    assert on_one_card == 4, rows


def test_it_costs_the_deck_fewer_small_cards_than_the_old_rule():
    # The claim in deal_measured's docstring, measured here so it cannot rot:
    # clustering yields FEWER noticeably-small cards than the shuffle it replaced.
    words = (["קונסטרוקטיביזם", "אינטרנציונליזם", "אינטרוספקציה", "אימפרסיוניזם"]
             + [f"מילה{i}" for i in range(40)])
    sizes = _sizes(words)
    n = 11

    def small(rows):
        per = [min(sizes.get(w, 99) for w in r if w) for r in rows if any(r)]
        med = statistics.median(per)
        return sum(1 for p in per if p < med * 0.75)

    old = pack.deal(words, n, random.Random(5))
    new = pack.deal(words, n, random.Random(5), sizes=sizes)
    assert small(new) <= small(old)


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
    words = ["קונסטרוקטיביזם"] + [f"מילה{i}" for i in range(20)]
    sizes = _sizes(words)
    rows = pack.deal(words, 6, random.Random(4), sizes=sizes)
    found = wd.small_cards([r for r in rows if any(r)], sizes)
    assert found, "the deliberately awful entry should surface"
    assert found[0]["word"] == "קונסטרוקטיביזם"
    assert found[0]["ratio"] < 0.75
    assert found[0]["index"] >= 1        # 1-based, the way a person counts cards


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
