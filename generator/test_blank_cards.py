#!/usr/bin/env python3
"""Tests for the 'no top-up' order — the deck the buyer asked us NOT to fill.

She sends 90 words, we normally add ~320 of ours, and some buyers do not want
them: they laminate the rest of the deck and write their own at the table. What
that has to produce is not a shorter deck — she is buying 104 cards either way —
but a FULL deck whose tail cards are empty and still numbered.

Three pieces, one per layer:

  * ``pack.pack(min_cards=...)`` pads the deck out with wordless cards;
  * ``render_page`` prints 1. 2. 3. 4. on a card with no words (and, crucially,
    still does NOT on an ordinary deck's short card);
  * ``topup(target=0)`` is the no-fill top-up: her words, deduped, no pool read.

Run: python3 generator/test_blank_cards.py   (or via pytest)
"""
import os
import re

import build
import pack
import topup as topupmod

from test_build_deck import Store, _pages


def _csv(tmp, words, min_cards=None, name="order.csv"):
    path = os.path.join(tmp, name)
    pack.pack(words, path, min_cards=min_cards)
    return path


def _words(n):
    return [f"מילה{i}" for i in range(1, n + 1)]


# The digit runs of a numbered line: the marker is drawn as its own <text>, so
# counting them counts the numbers actually printed on the card.
_DIGITS = re.compile(r'direction="ltr"[^>]*>(\d)</text>')


def _numbers(overlay):
    """The line numbers printed on one card, in document order."""
    return [int(d) for d in _DIGITS.findall(overlay)]


# --- packing ---------------------------------------------------------------

def test_a_short_list_still_packs_a_full_deck():
    with Store() as tmp:
        path = _csv(tmp, _words(90), min_cards=pack.WORD_CARDS)
        cards = pack.load_cards(path)
        word_cards = [c for c in cards if c["kind"] == "word"]
        assert len(word_cards) == pack.WORD_CARDS, len(word_cards)
        assert len(cards) == pack.WORD_CARDS + 1, "the photo card is still last"
        assert cards[-1]["kind"] == "photo"


def test_the_padding_cards_carry_no_words_and_her_words_are_all_there():
    with Store() as tmp:
        mine = _words(90)
        cards = [c for c in pack.load_cards(_csv(tmp, mine, min_cards=pack.WORD_CARDS))
                 if c["kind"] == "word"]
        placed = [w for c in cards for w in c["words"] if w]
        assert sorted(placed) == sorted(mine), "every word of hers, and nothing else"
        empty = [c for c in cards if not any(c["words"])]
        # 90 words fill 23 cards (the 23rd holds two), so 80 cards are blank.
        assert len(empty) == pack.WORD_CARDS - 23, len(empty)


def test_the_blank_cards_keep_the_front_cycling_even():
    with Store() as tmp:
        cards = [c for c in pack.load_cards(_csv(tmp, _words(90),
                                                 min_cards=pack.WORD_CARDS))
                 if c["kind"] == "word"]
        counts = sorted(sum(1 for c in cards if c["front"] % 8 == i) for i in range(8))
        assert counts == [12, 13, 13, 13, 13, 13, 13, 13], counts


def test_padding_is_opt_in_so_an_ordinary_short_deck_is_unchanged():
    with Store() as tmp:
        cards = [c for c in pack.load_cards(_csv(tmp, _words(90)))
                 if c["kind"] == "word"]
        assert len(cards) == 23, "without min_cards a short list still yields a short deck"


def test_a_full_list_is_never_padded_past_its_own_length():
    with Store() as tmp:
        cards = [c for c in pack.load_cards(
            _csv(tmp, _words(pack.WORD_CARDS * pack.PER_CARD + 40),
                 min_cards=pack.WORD_CARDS)) if c["kind"] == "word"]
        assert len(cards) == pack.WORD_CARDS + 10, len(cards)


# --- rendering --------------------------------------------------------------

def _deck(tmp, words, blank_markers):
    csvp = _csv(tmp, words, min_cards=pack.WORD_CARDS)
    doc, _ = build.deck_document("demo", csvp, ["שירה"],
                                 blank_markers=blank_markers)
    fronts = [ov for k, ov in _pages(doc) if k.startswith("front")]
    return csvp, fronts


def test_an_empty_card_prints_its_four_numbers():
    with Store() as tmp:
        _csvp, fronts = _deck(tmp, _words(90), blank_markers=True)
        # The last front is the deck's last WORD card, which is blank padding.
        assert _numbers(fronts[-1]) == [1, 2, 3, 4], fronts[-1][:400]


def test_an_empty_card_prints_no_words_beside_those_numbers():
    with Store() as tmp:
        _csvp, fronts = _deck(tmp, _words(90), blank_markers=True)
        assert "מילה" not in fronts[-1], "a padding card carries none of her words"


def test_the_written_cards_are_untouched_by_the_padding():
    with Store() as tmp:
        _csvp, fronts = _deck(tmp, _words(90), blank_markers=True)
        assert _numbers(fronts[0]) == [1, 2, 3, 4]
        assert "מילה" in fronts[0]


def test_a_part_written_card_numbers_its_empty_lines_too():
    with Store() as tmp:
        # 90 words: card 23 holds the last two, so lines 3 and 4 are hers to fill.
        _csvp, fronts = _deck(tmp, _words(90), blank_markers=True)
        card23 = fronts[22]
        assert _numbers(card23) == [1, 2, 3, 4], _numbers(card23)
        assert card23.count("מילה") == 2, "only her two words are on it"


# The marker as it is actually drawn: right edge, baseline, size.
_MARKERS = re.compile(
    r'<text x="([-\d.]+)" y="([-\d.]+)" font-family="HebWord" font-size="([\d.]+)"'
    r'[^>]*direction="ltr"[^>]*>(\d)</text>'
)


def _marker_geometry(overlay):
    return [(m.group(4), m.group(1), m.group(2), m.group(3))
            for m in _MARKERS.finditer(overlay)]


def test_an_empty_cards_numbers_sit_where_a_written_cards_numbers_sit():
    """The whole point of the feature, in one assertion.

    She is going to shuffle these cards in with the written ones and write on
    them at the table. If the numbers on a blank card sat at another size, or a
    hair off the column, the deck would read as two decks. They do not: same
    digit column, same baselines, same size.
    """
    with Store() as tmp:
        _csvp, fronts = _deck(tmp, _words(90), blank_markers=True)
        written = _marker_geometry(fronts[0])
        assert len(written) == 4, written
        assert _marker_geometry(fronts[22]) == written, "the part-written card"
        assert _marker_geometry(fronts[-1]) == written, "the empty card"


def test_without_the_flag_an_empty_card_prints_nothing_at_all():
    """The guard that keeps every ORDINARY deck byte-for-byte what it was.

    A slot is empty on a normal order too — the short card at a group seam, the
    last card of an oversized list — and those have always printed the lines they
    have and no others.
    """
    with Store() as tmp:
        _csvp, fronts = _deck(tmp, _words(90), blank_markers=False)
        assert _numbers(fronts[-1]) == [], fronts[-1][:400]


# --- the top-up that does not happen ---------------------------------------

def test_target_zero_returns_her_words_and_reads_no_pool():
    with Store():
        mine = ["חתונה", "  חתונה  ", "ירח דבש", ""]
        assert topupmod.topup(mine, "demo", target=0) == ["חתונה", "ירח דבש"]


def test_the_normal_target_still_fills_from_a_pool():
    """The counterpart: target=0 is the only thing that changed."""
    with Store():
        filled = topupmod.topup(["חתונה"], "demo")
        assert len(filled) > 1, "an ordinary order is still topped up"


if __name__ == "__main__":
    import sys

    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as e:
                fails += 1
                print(f"FAIL {name}: {e}")
    sys.exit(1 if fails else 0)
