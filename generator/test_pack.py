#!/usr/bin/env python3
"""Tests for generator/pack.py — packing a word list into the deck CSV.

Run: python3 generator/test_pack.py   (or via pytest)
"""
import csv
import os
import tempfile

import pack

# A standard deck's worth of words: 103 word cards x 4 (topup.TARGET feeds this).
FULL = pack.WORD_CARDS * pack.PER_CARD


def _csv(name="order.csv"):
    """A throwaway path for one test's CSV (never reuse the real order dir)."""
    return os.path.join(tempfile.mkdtemp(prefix="dugri-pack-"), name)


def _words(n, prefix="מילה"):
    """n distinct words. Distinct matters: pack dedupes, so repeats would shrink
    the deck and make a card-count assertion measure the wrong thing."""
    return [f"{prefix} {i}" for i in range(n)]


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


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
