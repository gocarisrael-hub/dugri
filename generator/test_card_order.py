#!/usr/bin/env python3
"""Tests for the per-order CARD ORDER — pack.ORDERS.

The owner picks one per order, next to the seed pool: 'random' is the deck as it
always was, 'personal-first' opens with the buyer's own words, 'by-script' keeps
Hebrew cards and Latin cards apart.

Two things have to hold no matter which is picked, and most of this file is
about them:

  * no word is lost, gained, or duplicated — grouping decides WHERE a word goes,
    never WHETHER it goes;
  * the phrase balance still holds INSIDE each group. It is not one of the
    options, it sits underneath all of them: four words on a card render at one
    size, so a card of four phrases prints tiny.

Run: python3 generator/test_card_order.py   (or via pytest)
"""
import math
import os
import random
import tempfile

import pack

HE = "מילה"
EN = "word"


def _csv(name="order.csv"):
    return os.path.join(tempfile.mkdtemp(prefix="dugri-order-"), name)


def _cards(path):
    return [c["words"] for c in pack.load_cards(path) if c["kind"] == "word"]


def _placed(cards):
    return [w for c in cards for w in c if w]


def _n_multi(words):
    return sum(1 for w in words if w and pack.is_multi(w))


def _he(n, phrases=0):
    """n Hebrew entries, `phrases` of which are multi-word."""
    return [f"{HE} ארוכה {i}" if i < phrases else f"{HE}{i}" for i in range(n)]


def _en(n, phrases=0):
    return [f"{EN} long {i}" if i < phrases else f"{EN}{i}" for i in range(n)]


# --- grouping: what a card may draw from ------------------------------------


def test_personal_first_opens_the_deck_with_her_own_words():
    personal = _he(30)
    filler = _en(70)
    out = _csv()
    pack.pack(personal + filler, out, order=pack.ORDER_PERSONAL_FIRST,
              personal_count=len(personal), photo_card=False)
    cards = _cards(out)
    # 30 personal words = 7 full cards + one card of 2, then the filler starts.
    n_personal_cards = math.ceil(len(personal) / pack.PER_CARD)
    opening = _placed(cards[:n_personal_cards])
    assert sorted(opening) == sorted(personal)
    assert sorted(_placed(cards[n_personal_cards:])) == sorted(filler)


def test_no_card_mixes_her_words_with_the_filler():
    # The whole point of the option: a card is hers or it is not. A card that
    # holds three of her words and one from the pool is exactly what she asked
    # to stop seeing.
    personal, filler = _he(53), _en(140)
    out = _csv()
    pack.pack(personal + filler, out, order=pack.ORDER_PERSONAL_FIRST,
              personal_count=len(personal), photo_card=False)
    mine = set(personal)
    for words in _cards(out):
        present = [w for w in words if w]
        assert all(w in mine for w in present) or not any(w in mine for w in present)


def test_by_script_never_puts_hebrew_and_latin_on_one_card():
    out = _csv()
    pack.pack(_he(60) + _en(45), out, order=pack.ORDER_BY_SCRIPT, photo_card=False)
    for words in _cards(out):
        present = [w for w in words if w]
        kinds = {pack.is_hebrew(w) for w in present}
        assert len(kinds) <= 1, present


def test_by_script_prints_the_hebrew_cards_first():
    # Hebrew is the deck's primary face; the Latin cards are the tail.
    out = _csv()
    pack.pack(_he(40) + _en(20), out, order=pack.ORDER_BY_SCRIPT, photo_card=False)
    cards = _cards(out)
    first = _placed(cards[:1])
    assert all(pack.is_hebrew(w) for w in first)
    assert all(not pack.is_hebrew(w) for w in _placed(cards[-1:]))


def test_a_mixed_entry_counts_as_hebrew_rather_than_being_split():
    # "ערב ב Tel Aviv" has to live on one side; the Hebrew side is the deck's.
    assert pack.is_hebrew("ערב ב Tel Aviv")
    assert pack.is_hebrew("שלום")
    assert not pack.is_hebrew("Tel Aviv")
    # Digits and punctuation have no script — a Hebrew product puts them on the
    # Hebrew cards rather than opening a Latin card for them.
    assert pack.is_hebrew("40")
    assert pack.is_hebrew("!!!")


def test_random_is_the_deck_exactly_as_it_was():
    # The default must not have moved: the same words and seed give the same
    # cards whether the caller passes the order or not.
    words = _he(200, phrases=40) + _en(100, phrases=20)
    a, b = _csv("a.csv"), _csv("b.csv")
    pack.pack(words, a, seed=7)
    pack.pack(words, b, seed=7, order=pack.ORDER_RANDOM)
    assert _cards(a) == _cards(b)


# --- the promises that hold under every order --------------------------------


def test_no_word_is_lost_or_duplicated_under_any_order():
    words = _he(211, phrases=57) + _en(96, phrases=25)
    for order in pack.ORDERS:
        out = _csv()
        n, cards = pack.pack(words, out, order=order, personal_count=211,
                             photo_card=False)
        placed = _placed(_cards(out))
        assert sorted(placed) == sorted(words), order
        assert n == len(words), order
        assert cards == len(_cards(out)), order


def test_the_phrase_balance_holds_inside_every_group():
    # THE SECONDARY RULE, and the reason grouping deals each group through the
    # same deal() instead of slicing a finished deck: within one group, every
    # full card takes M//n or M//n + 1 phrases. Sliced, a group could inherit a
    # run of phrase-heavy cards and print tiny.
    rnd = random.Random(99)
    for order in (pack.ORDER_PERSONAL_FIRST, pack.ORDER_BY_SCRIPT):
        for n_he, he_phrases, n_en, en_phrases in (
            (103, 40, 60, 10),
            (200, 100, 40, 40),
            (48, 12, 48, 24),
            (412, 103, 0, 0),
        ):
            words = _he(n_he, he_phrases) + _en(n_en, en_phrases)
            out = _csv()
            pack.pack(words, out, order=order, personal_count=n_he,
                      photo_card=False, seed=rnd.randrange(10**6))
            groups = pack.card_groups(
                [w for w in dict.fromkeys(words)], order, personal_count=n_he
            )
            cards = _cards(out)
            at = 0
            for g in groups:
                n_cards = max(1, math.ceil(len(g) / pack.PER_CARD))
                mine = cards[at:at + n_cards]
                at += n_cards
                total = sum(1 for w in g if pack.is_multi(w))
                full = [c for c in mine if all(c)]
                if not full:
                    continue
                lo = total // len(mine)
                for c in full:
                    assert lo <= _n_multi(c) <= lo + 1, (order, len(g), c)


def test_a_group_that_is_not_a_multiple_of_four_leaves_ONE_short_card():
    # The seam, asserted rather than tolerated: filling that card from the next
    # group would put filler on a personal card, which is the thing the option
    # exists to prevent. At most one short card per group.
    out = _csv()
    pack.pack(_he(30) + _en(22), out, order=pack.ORDER_BY_SCRIPT, photo_card=False)
    cards = _cards(out)
    short = [c for c in cards if not all(c)]
    assert len(short) == 2, cards
    assert [len([w for w in c if w]) for c in short] == [2, 2]


def test_an_all_hebrew_list_under_by_script_is_just_a_deck():
    # No Latin words means no second group — and no gratuitous short card in
    # the middle of the deck.
    out = _csv()
    pack.pack(_he(30), out, order=pack.ORDER_BY_SCRIPT, photo_card=False)
    cards = _cards(out)
    assert len(cards) == math.ceil(30 / pack.PER_CARD)
    assert len([c for c in cards if not all(c)]) == 1


def test_personal_first_without_a_boundary_does_not_split():
    # An order that predates the frozen word bank, or a list that is entirely
    # hers: nothing to separate, so it packs as one deck.
    words = _he(30)
    for boundary in (None, 0, len(words), 999):
        out = _csv()
        pack.pack(words, out, order=pack.ORDER_PERSONAL_FIRST,
                  personal_count=boundary, photo_card=False)
        assert len(_cards(out)) == math.ceil(len(words) / pack.PER_CARD), boundary


def test_a_grouped_full_deck_costs_at_most_one_extra_card():
    # 412 words is the shipped size — 103 word cards + the photo card. A group
    # boundary that falls mid-card (103 of her words is 25 cards and a card of 3)
    # rounds up, so a grouped deck can run ONE card longer. That is the whole
    # price of the option, and it is bounded: two groups, at most one extra.
    words = _he(103) + _en(309)
    plain = pack.pack(words, _csv(), order=pack.ORDER_RANDOM)[1]
    assert plain == pack.WORD_CARDS + 1 == 104
    for order in (pack.ORDER_PERSONAL_FIRST, pack.ORDER_BY_SCRIPT):
        out = _csv()
        _, cards = pack.pack(words, out, order=order, personal_count=103)
        assert plain <= cards <= plain + 1, order


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))


# --- the choice reaching the packer -----------------------------------------


class _Stop(Exception):
    """Nothing past the CSV matters here — rendering a real deck takes minutes."""


def test_order_to_pdf_hands_the_packer_the_choice_and_the_boundary(monkeypatch):
    # The fragile link: 'personal-first' needs to know where her words end, and
    # that boundary is a COUNT computed here, not something the word list carries.
    # If it silently stopped being passed, every deck would still build — just
    # blended, which is exactly the failure nobody would see.
    import order_to_pdf

    seen = {}

    def spy(words, out_csv, **kw):
        seen.update(kw)
        seen["n_words"] = len(words)
        raise _Stop()

    monkeypatch.setattr(pack, "pack", spy)
    personal = ["שלום", "ריקוד", "Tel Aviv"]
    for order in pack.ORDERS:
        seen.clear()
        try:
            order_to_pdf.order_to_pdf(
                "bachelorette", "שירה", {}, personal, out_pdf="/tmp/unused.pdf",
                order=order,
            )
        except _Stop:
            pass
        assert seen.get("order") == order
        assert seen.get("personal_count") == len(personal)
        # …and the deck it packs is the topped-up one, not just her three words.
        assert seen.get("n_words", 0) > len(personal)


def test_order_to_pdf_defaults_to_the_blend():
    import order_to_pdf
    import inspect

    sig = inspect.signature(order_to_pdf.order_to_pdf)
    assert sig.parameters["order"].default == pack.ORDER_RANDOM
