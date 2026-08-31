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


# ---- the deal's weight: letters, not the measurement -------------------------
# The measurement above still answers "how large will this print", which the
# small-card report needs. What it must NOT decide any more is the ORDER the deal
# hands entries out in: it reads every entry at its best wrapping, and a card
# with four entries has no room to wrap. See word_demand.letter_weights.


def test_letters_are_counted_with_the_spaces():
    w = wd.letter_weights(["יתוש בחדר", "מחברת"])
    assert w["יתוש בחדר"] == -9
    assert w["מחברת"] == -5


def test_a_longer_entry_weighs_heavier():
    # Bigger means easier — the direction the deal has always read.
    w = wd.letter_weights(["עוגת יום הולדת", "מחברת", "קן"])
    assert w["עוגת יום הולדת"] < w["מחברת"] < w["קן"]


def test_blank_entries_carry_no_weight():
    assert wd.letter_weights(["", "   ", None, "קן"]) == {"קן": -2}


def test_the_weight_needs_no_font_or_template():
    # measure() comes back empty when the fonts cannot be read, and the deal used
    # to fall back to counting spaces. Letters have no such path, so every order
    # is dealt by the same rule and the deck cannot change shape on a bad font.
    assert wd.letter_weights(["מסיבה"]) == {"מסיבה": -5}


def test_the_phrase_the_measurement_called_easy_is_dealt_first():
    # THE BUG THIS FIXES, as one assertion. עוגת יום הולדת caps its card at 15.61
    # on אשכולית — the worst entry of the order that exposed this — while the
    # measurement scores it ABOVE מחברת, one of the easiest words in the deck.
    # Under letters it is the heaviest thing in the list, and the deal, which
    # hands out heaviest first, gives it to card 1.
    words = ["עוגת יום הולדת", "מחברת", "קן", "ים",
             "פאב", "שוק", "חוף", "גן"]
    measured = wd.measure(words, THEME)
    assert measured["עוגת יום הולדת"] > measured["מחברת"]
    rows = pack.deal(words, 2, random.Random(0), sizes=wd.letter_weights(words))
    assert "עוגת יום הולדת" in rows[0], rows


def test_hard_entries_are_still_spread_one_per_card_under_letter_weights():
    # THE RULE ITSELF, re-asserted against the score the deal actually uses. The
    # older test above proves it for wd.measure, which no order takes any more,
    # so it would not catch a weight that let two demanding entries share a card.
    # The demanding entries here are what a real order's worst ones look like:
    # long phrases, not the invented unbreakable tokens.
    hard = ["עוגת יום הולדת", "מסיבת הפתעה גדולה", "ארוחת בוקר בנמל", "להקת שבעת הכוכבים"]
    easy = ["ים", "אמא", "דוד", "שוק", "חוף", "כלב", "עץ", "אור", "גן", "רון", "נר", "תה"]
    words = hard + easy
    rows = pack.deal(words, 4, random.Random(3), sizes=wd.letter_weights(words))
    per_card = [sum(1 for w in row if w in set(hard)) for row in rows]
    assert max(per_card) == 1, rows


def test_a_long_token_and_a_long_phrase_are_weighed_alike():
    # The correction that looks obvious and measures worse — see letter_weights.
    # These two cap a card at the same 17.40 on אשכולית, and the weight keeps
    # them together rather than promoting the token for being unbreakable.
    w = wd.letter_weights(["קונסטרוקטיביזם", "בר רווקות ענקית"])
    assert abs(w["קונסטרוקטיביזם"] - w["בר רווקות ענקית"]) <= 1


def test_the_snake_still_pairs_the_heaviest_with_the_lightest():
    # The deal itself is untouched: heaviest first, dealt left to right and then
    # right to left. Eight entries over two cards is two laps each way, so card 1
    # takes the 1st, 4th, 5th and 8th heaviest — the extremes — and card 2 the
    # middle four.
    words = ["א" * n for n in range(9, 1, -1)]        # lengths 9,8,7,6,5,4,3,2
    rows = pack.deal(words, 2, random.Random(0), sizes=wd.letter_weights(words))
    assert sorted(len(w) for w in rows[0]) == [2, 5, 6, 9], rows
    assert sorted(len(w) for w in rows[1]) == [3, 4, 7, 8], rows


# --- WHERE an entry sits ON its card (pack.deal_measured's shuffle) ----------
#
# The weight decides which entries SHARE a card. It used to decide their order on
# the card too — sorted longest last — and because render_page.order_by_room
# breaks a tie by keeping the order it was handed, on every card whose rows are
# equally roomy that sort WAS the printed order: the longest entry on the bottom
# line of all of them. The owner asked for that fixed position to go. These tests
# hold both halves of the answer: the position moves, and the grouping does not.


def _snake_groups(words, n_cards):
    """The snake's grouping, recomputed independently of pack.

    Longest first, dealt left to right then right to left. Given entries of
    DISTINCT lengths the sort has no ties, so this is exact and owes nothing to
    the RNG — which is what lets it stand as the "did the grouping move?" oracle.
    """
    order = sorted(words, key=len, reverse=True)
    rows = [[] for _ in range(n_cards)]
    i = lap = 0
    while i < len(order):
        seq = range(n_cards) if lap % 2 == 0 else reversed(range(n_cards))
        for c in seq:
            if i >= len(order):
                break
            rows[c].append(order[i])
            i += 1
        lap += 1
    return [set(r) for r in rows]


def test_the_shuffle_never_moves_a_word_to_another_card():
    # THE GUARANTEE. Which four words meet on a card is exactly what it was, seed
    # by seed — the shuffle only reorders inside the card it was already given.
    words = ["א" * n for n in range(4, 28)]           # 24 entries, all lengths distinct
    expected = _snake_groups(words, 6)
    for seed in range(6):
        rows = pack.deal(words, 6, random.Random(seed), sizes=wd.letter_weights(words))
        assert [set(w for w in r if w) for r in rows] == expected, (seed, rows)


def test_the_longest_entry_no_longer_always_sits_in_the_same_slot():
    # Over a deck, the longest entry of a card lands in every slot rather than
    # always the last one. Asserted as "more than one slot" rather than an even
    # spread: this is a shuffle, not a rotation, and a deck is not a big enough
    # sample to promise 25% each.
    words = ["א" * (4 + (i % 19)) + str(i) for i in range(412)]
    rows = pack.deal(words, 103, random.Random(11), sizes=wd.letter_weights(words))
    slots = set()
    for row in rows:
        live = [w for w in row if w]
        slots.add(live.index(max(live, key=len)))
    assert len(slots) > 1, slots
    # …and specifically NOT the old behaviour, which put it in the last filled
    # slot of every single card.
    assert slots != {3}, slots


def test_the_card_is_still_blank_padded_at_the_END():
    # The renderer numbers the rows 1..4 downwards, so a blank between two entries
    # prints an empty numbered line. A short final card must keep its blanks
    # trailing after the shuffle, exactly as the sort left them.
    words = ["א" * n for n in range(4, 10)]           # 6 entries -> 4 + 2
    rows = pack.deal(words, 2, random.Random(1), sizes=wd.letter_weights(words))
    last = rows[-1]
    assert last[0] and last[1] and last[2] == "" and last[3] == "", last


def test_a_deck_is_still_reproducible_from_its_seed():
    # The shuffle draws from the deal's own seeded RNG, so the same seed still
    # gives the same deck down to the slot — and a different seed gives a
    # different one, which is what makes the position vary between orders.
    words = ["א" * (4 + (i % 13)) + str(i) for i in range(80)]
    sizes = wd.letter_weights(words)
    a = pack.deal(words, 20, random.Random(7), sizes=sizes)
    b = pack.deal(words, 20, random.Random(7), sizes=sizes)
    c = pack.deal(words, 20, random.Random(8), sizes=sizes)
    assert a == b
    assert a != c
