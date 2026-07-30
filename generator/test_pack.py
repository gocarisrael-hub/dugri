#!/usr/bin/env python3
"""Tests for generator/pack.py — packing a word list into the deck CSV.

Run: python3 generator/test_pack.py   (or via pytest)
"""
import csv
import os
import random
import tempfile

import pack

# A standard deck's worth of words: 103 word cards x 4 (topup.TARGET feeds this).
FULL = pack.WORD_CARDS * pack.PER_CARD


def _csv(name="order.csv"):
    """A throwaway path for one test's CSV (never reuse the real order dir)."""
    return os.path.join(tempfile.mkdtemp(prefix="dugri-pack-"), name)


def _words(n, prefix="מילה"):
    """n distinct words. Distinct matters: pack dedupes, so repeats would shrink
    the deck and make a card-count assertion measure the wrong thing.

    NOTE these are two-token strings ("מילה 7"), i.e. PHRASES by pack.is_multi.
    The deck-shape tests below therefore also exercise the all-phrase supply,
    which must still fill every card. The phrase-mix tests use _mix()."""
    return [f"{prefix} {i}" for i in range(n)]


def _mix(n_single, n_multi):
    """n_single one-token words + n_multi phrases, interleaved.

    Interleaved on purpose: if the two kinds arrived already grouped, a packer
    that ignored the split could still look sorted by accident."""
    singles = [f"מילה{i}" for i in range(n_single)]
    multis = [f"ביטוי ארוך {i}" for i in range(n_multi)]
    out = []
    for i in range(max(n_single, n_multi)):
        if i < n_single:
            out.append(singles[i])
        if i < n_multi:
            out.append(multis[i])
    return out


def _cards(path):
    """The word cards' 4-lists, in deck order (photo card excluded)."""
    return [c["words"] for c in pack.load_cards(path) if c["kind"] == "word"]


def _n_multi(words):
    """How many phrases a card carries (blanks don't count)."""
    return sum(1 for w in words if w and pack.is_multi(w))


def _rows(path):
    """The CSV's data rows as dicts, exactly as written (no load_cards parsing)."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def test_standard_deck_is_103_word_cards_plus_the_photo_card():
    out = _csv()
    n, cards = pack.pack(_words(FULL), out)
    assert n == FULL, f"all {FULL} unique words kept, got {n}"
    # 103 word cards + 1 photo card = 104 printed cards = 208 pages (back+front).
    assert cards == pack.WORD_CARDS + 1 == 104
    assert cards * 2 == 208
    rows = _rows(out)
    assert len(rows) == cards, "one CSV row per printed card"
    assert sum(1 for r in rows if r["kind"] == "word") == pack.WORD_CARDS
    # every word card is full — a standard deck has no blank slot anywhere
    for r in rows[:-1]:
        assert all(r[f"w{k}"] for k in range(1, 5)), f"blank slot in {r}"


def test_front_styles_are_spread_evenly_round_robin():
    # 103 word cards over 8 fronts can't divide evenly; round-robin makes the
    # remainder land as 13/13/13/13/13/13/13/12 rather than clumping. Assert the
    # MULTISET so the test pins the balance, not which style got the short straw.
    out = _csv()
    pack.pack(_words(FULL), out)
    counts = {}
    for r in _rows(out):
        if r["kind"] == "word":
            counts[r["front"]] = counts.get(r["front"], 0) + 1
    assert len(counts) == pack.FRONTS, f"all {pack.FRONTS} fronts used, got {counts}"
    assert sorted(counts.values(), reverse=True) == [13] * 7 + [12]


def test_last_row_is_the_photo_card_and_carries_no_words():
    out = _csv()
    pack.pack(_words(FULL), out)
    last = _rows(out)[-1]
    assert last["kind"] == "photo"
    assert all(not last[f"w{k}"] for k in range(1, 5)), "photo card holds no words"
    # ...and the loader hands the renderer front=None, so it never indexes into
    # the theme's fronts list looking for a style the photo card doesn't have.
    card = pack.load_cards(out)[-1]
    assert card["kind"] == "photo"
    assert card["front"] is None
    assert card["words"] == [""] * pack.PER_CARD


def test_short_list_yields_fewer_cards_not_a_tail_of_blank_ones():
    # The filler pools can run dry (a missing wordlist degrades to []). A short
    # deck must be SHORT, not padded out to 103 mostly-empty printed cards.
    out = _csv()
    n, cards = pack.pack(_words(10), out)
    assert n == 10
    assert cards == 3 + 1, "3 word cards (4+4+2) + the photo card"
    rows = _rows(out)
    word_rows = [r for r in rows if r["kind"] == "word"]
    assert len(word_rows) == 3
    # only the LAST word card is blank-padded; the others are full
    for r in word_rows[:-1]:
        assert all(r[f"w{k}"] for k in range(1, 5))
    filled = [r for r in word_rows[-1:] for k in range(1, 5) if r[f"w{k}"]]
    assert len(filled) == 2, "the final card holds the 2 leftover words"


def test_oversized_list_keeps_every_word_and_grows_the_deck():
    # The product promises no upper word limit, so an oversized personal list
    # must grow the deck past 103 cards rather than silently drop the overflow.
    words = _words(500)
    out = _csv()
    n, cards = pack.pack(words, out)
    assert n == 500
    assert cards == 125 + 1, "ceil(500/4)=125 word cards + the photo card"
    assert cards > pack.WORD_CARDS + 1, "an oversized list must grow the deck"
    rows = _rows(out)
    written = {r[f"w{k}"] for r in rows if r["kind"] == "word" for k in range(1, 5)}
    assert set(words) <= written, "no word may be dropped"
    # round-robin keeps the styles balanced at ANY deck size, not just 103
    counts = {}
    for r in rows:
        if r["kind"] == "word":
            counts[r["front"]] = counts.get(r["front"], 0) + 1
    assert max(counts.values()) - min(counts.values()) <= 1, counts


def test_exact_duplicates_are_deduped():
    out = _csv()
    n, cards = pack.pack(["מים", "מים", "  מים  ", "אש", "", "  "], out)
    assert n == 2, "exact repeats (and surrounding whitespace) collapse to one"
    assert cards == 1 + 1
    words = [w for r in _rows(out) if r["kind"] == "word"
             for w in (r["w1"], r["w2"], r["w3"], r["w4"]) if w]
    assert sorted(words) == sorted(["מים", "אש"])


def test_same_seed_gives_a_byte_identical_csv():
    # The shuffle is what mixes words across cards; it must be reproducible so a
    # re-run of a paid order reprints the SAME deck, not a reshuffled one.
    words = _words(FULL)
    a, b = _csv("a.csv"), _csv("b.csv")
    pack.pack(words, a, seed=7)
    pack.pack(words, b, seed=7)
    assert open(a, "rb").read() == open(b, "rb").read()
    # and a different seed really does reshuffle (else "deterministic" is vacuous)
    c = _csv("c.csv")
    pack.pack(words, c, seed=8)
    assert open(c, "rb").read() != open(a, "rb").read()


def test_load_cards_round_trips_what_pack_wrote():
    out = _csv()
    words = _words(FULL)
    _, cards = pack.pack(words, out)
    loaded = pack.load_cards(out)
    assert len(loaded) == cards
    word_cards = [c for c in loaded if c["kind"] == "word"]
    assert len(word_cards) == pack.WORD_CARDS
    for i, c in enumerate(word_cards):
        assert c["front"] == i % pack.FRONTS, "front survives the round trip as an int"
        assert len(c["words"]) == pack.PER_CARD
    assert {w for c in word_cards for w in c["words"]} == set(words)


def test_load_cards_falls_back_to_the_row_index_for_a_bad_front():
    # A hand-edited CSV (the owner fixing a typo in Excel) can lose or mangle the
    # front column. That must still render an even spread, not blow up mid-order.
    out = _csv()
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(pack.FIELDS)
        wr.writerow(["word", "0", "א", "ב", "ג", "ד"])
        wr.writerow(["word", "", "ה", "ו", "ז", "ח"])       # missing
        wr.writerow(["word", "לא מספר", "ט", "י", "כ", "ל"])  # garbage
        wr.writerow(["photo", "", "", "", "", ""])
    loaded = pack.load_cards(out)
    assert [c["front"] for c in loaded] == [0, 1, 2, None]
    assert loaded[1]["words"] == ["ה", "ו", "ז", "ח"]


def test_a_normal_deck_gives_every_card_three_singles_and_one_phrase():
    # The owner's rule: 3 one-word entries + 1 phrase per card. All four words on
    # a card render at ONE size, so a card of four phrases sets tiny; capping it
    # at one phrase caps how far any card has to shrink.
    # 309 singles + 103 phrases = 412 words = exactly 103 cards x (3+1).
    out = _csv()
    n, cards = pack.pack(_mix(309, 103), out)
    assert n == FULL and cards == pack.WORD_CARDS + 1
    for words in _cards(out):
        assert _n_multi(words) == 1, f"want exactly one phrase, got {words}"


def test_the_phrase_is_the_fourth_word_on_the_card():
    # Slot 4 is the BOTTOM line of the card, where a phrase that wraps to two or
    # three lines has room. A phrase in slot 1 would push the rest down.
    out = _csv()
    pack.pack(_mix(309, 103), out)
    for words in _cards(out):
        assert pack.is_multi(words[3]), f"phrase must be last, got {words}"
        assert not any(pack.is_multi(w) for w in words[:3]), words


def test_the_phrase_sits_last_among_the_words_actually_present():
    # The final card can be short (6 words -> 4+2). Its blanks must stay
    # TRAILING — the card renderer numbers slots 1..4 top-down, so a blank
    # between two words prints an empty numbered line. The phrase therefore
    # takes the last FILLED slot, not literally w4.
    out = _csv()
    n, cards = pack.pack(_mix(5, 1), out)
    assert n == 6 and cards == 2 + 1
    last = _cards(out)[-1]
    assert not pack.is_multi(last[0]) and pack.is_multi(last[1])
    assert last[2] == "" and last[3] == "", f"blanks must trail, got {last}"


def test_no_word_is_lost_or_duplicated_over_a_large_random_list():
    # The deal reorders; it must never be able to drop or repeat a word. Checked
    # as a MULTISET (sorted list, not set) so a duplicate can't hide behind a
    # missing word, over lengths that hit every remainder of the final card.
    rnd = random.Random(20260730)
    for size in (1, 2, 3, 7, 41, 103, 412, 999):
        for frac in (0.0, 0.17, 0.5, 0.83, 1.0):
            n_multi = round(size * frac)
            words = _mix(size - n_multi, n_multi)
            rnd.shuffle(words)
            out = _csv(f"{size}-{n_multi}.csv")
            n, _ = pack.pack(words, out, seed=rnd.randrange(10**6))
            assert n == size
            placed = sorted(w for c in _cards(out) for w in c if w)
            assert placed == sorted(words), f"size={size} multi={n_multi}"


def test_more_phrases_than_cards_spreads_them_instead_of_clustering():
    # 250 singles + 162 phrases over 103 cards: the supply can't hold the deck to
    # one phrase a card, so cards take 1 or 2 — but evenly through the deck, not
    # 59 clean cards followed by 44 doubles.
    out = _csv()
    pack.pack(_mix(250, 162), out)
    per = [_n_multi(c) for c in _cards(out)]
    assert len(per) == pack.WORD_CARDS
    assert sum(per) == 162
    assert min(per) == 1 and max(per) == 2, f"only 1s and 2s, got {set(per)}"
    # every prefix stays within one phrase of the ideal rate -> no clustering
    for k in range(1, len(per) + 1):
        assert abs(sum(per[:k]) - k * 162 / len(per)) < 1, f"clustered by card {k}"


def test_fewer_phrases_than_cards_spreads_the_carriers_through_the_deck():
    # 20 phrases over 103 cards must not all land on cards 1-20; a customer
    # flipping through the deck should meet them at a steady rate.
    out = _csv()
    pack.pack(_mix(392, 20), out)
    per = [_n_multi(c) for c in _cards(out)]
    assert sum(per) == 20 and max(per) == 1
    carriers = [i for i, m in enumerate(per) if m]
    assert carriers[0] < 10 and carriers[-1] > len(per) - 10, carriers
    for k in range(1, len(per) + 1):
        assert abs(sum(per[:k]) - k * 20 / len(per)) < 1, f"clustered by card {k}"


def test_only_phrases_still_fills_a_complete_deck():
    # A word list can be all phrases (an order written as full expressions).
    # There is no single to pair them with, so every card takes four — the deck
    # must still come out full and complete rather than half-empty.
    out = _csv()
    n, cards = pack.pack(_mix(0, FULL), out)
    assert n == FULL and cards == pack.WORD_CARDS + 1
    for words in _cards(out):
        assert _n_multi(words) == pack.PER_CARD


def test_only_phrases_with_a_short_final_card_reroutes_the_overflow():
    # 9 phrases -> cards of 4/4/1. The even spread wants 3 per card, but the
    # final card holds ONE; the two it can't take move up rather than vanish.
    out = _csv()
    words = _mix(0, 9)
    n, cards = pack.pack(words, out)
    assert n == 9 and cards == 3 + 1
    got = _cards(out)
    assert [len([w for w in c if w]) for c in got] == [4, 4, 1]
    assert sorted(w for c in got for w in c if w) == sorted(words)


def test_only_single_words_still_fills_a_complete_deck():
    out = _csv()
    n, cards = pack.pack(_mix(FULL, 0), out)
    assert n == FULL and cards == pack.WORD_CARDS + 1
    for words in _cards(out):
        assert _n_multi(words) == 0
        assert all(words), "a single-token list must still fill every slot"


def test_a_handful_of_words_still_yields_one_real_card():
    # Below 4 words there is nothing to mix; the deck must not collapse to zero
    # cards (the photo card alone is not a game).
    for words in ([], ["מים"], ["ביטוי ארוך"], ["מים", "ביטוי ארוך"]):
        out = _csv()
        n, cards = pack.pack(words, out)
        assert n == len(words)
        assert cards == 1 + 1, f"one word card + the photo card for {words}"
        got = _cards(out)
        assert len(got) == 1
        assert [w for w in got[0] if w] == sorted(words, key=pack.is_multi)


def test_the_mix_is_deterministic_for_a_mixed_list():
    # The all-phrase list in the seed test above never exercises the two-pool
    # deal. A mixed list must be reproducible too: a reprint of a paid order has
    # to come out as the same deck, card for card.
    words = _mix(309, 103)
    a, b, c = _csv("a.csv"), _csv("b.csv"), _csv("c.csv")
    pack.pack(words, a, seed=7)
    pack.pack(words, b, seed=7)
    pack.pack(words, c, seed=8)
    assert open(a, "rb").read() == open(b, "rb").read()
    assert open(c, "rb").read() != open(a, "rb").read()


def test_is_multi_counts_whitespace_tokens_not_length():
    # The cost the mix is managing is WRAPPING. A long unbreakable token wraps as
    # one line whatever we do, so it is not a phrase; two short words are.
    assert pack.is_multi("הצעת נישואין")
    assert pack.is_multi("להקת שבעת הכוכבים")
    assert pack.is_multi("אבא  שלי"), "a double space is still two tokens"
    assert not pack.is_multi("אינסטגרם")
    assert not pack.is_multi("מים")


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
