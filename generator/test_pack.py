#!/usr/bin/env python3
"""Tests for generator/pack.py — packing a word list into the deck CSV.

Run: python3 generator/test_pack.py   (or via pytest)
"""
import csv
import os
import random
import re
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
    # every word card is full — a standard deck has no blank slot anywhere.
    # Selected by KIND, not by position: the photo card has moved to the front
    # of the deck and carries four blanks wherever it sits.
    for r in (x for x in rows if x["kind"] == "word"):
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


def test_first_row_is_the_photo_card_and_carries_no_words():
    out = _csv()
    pack.pack(_words(FULL), out)
    rows = _rows(out)
    first = rows[0]
    assert first["kind"] == "photo"
    assert all(not first[f"w{k}"] for k in range(1, 5)), "photo card holds no words"
    assert all(r["kind"] == "word" for r in rows[1:]), "and nothing else is one"
    # ...and the loader hands the renderer front=None, so it never indexes into
    # the theme's fronts list looking for a style the photo card doesn't have.
    card = pack.load_cards(out)[0]
    assert card["kind"] == "photo"
    assert card["front"] is None
    assert card["words"] == [""] * pack.PER_CARD


def test_the_word_cards_keep_their_even_front_spread_behind_it():
    # The photo card sits in front of the deal now. It carries no front of its
    # own, and it must not push the word cards' cycling along by one.
    out = _csv()
    pack.pack(_words(FULL), out)
    fronts = [int(r["front"]) for r in _rows(out) if r["kind"] == "word"]
    assert fronts[:9] == [0, 1, 2, 3, 4, 5, 6, 7, 0], fronts[:9]
    counts = sorted((fronts.count(i) for i in range(pack.FRONTS)), reverse=True)
    assert counts == [13] * 7 + [12], counts


def test_a_csv_with_no_front_column_still_spreads_evenly():
    # The degraded path: a hand-edited CSV whose `front` cannot be parsed falls
    # back to the card's position. Counted over WORD cards, not over ROWS: the
    # photo card in front would start the spread at 1 and rotate every card off
    # the style `pack` deals it — still all eight styles, still evenly, but one
    # step out of phase with the deck this fallback stands in for.
    out = _csv()
    pack.pack(_words(FULL), out)
    text = open(out, encoding="utf-8-sig").read()
    rewritten = out + ".nofront"
    with open(rewritten, "w", encoding="utf-8-sig") as f:
        f.write(re.sub(r"^word,\d+,", "word,,", text, flags=re.M))
    cards = pack.load_cards(rewritten)
    assert cards[0]["kind"] == "photo"
    assert [c["front"] for c in cards[1:9]] == [0, 1, 2, 3, 4, 5, 6, 7]
    # The whole point, stated as the equality it is: reduced the way `build` reduces
    # it (`fronts[front % len(fronts)]`), the fallback reproduces the spread `pack`
    # wrote, card for card — not a rotation of it.
    dealt = [int(r["front"]) for r in _rows(out) if r["kind"] == "word"]
    fell_back = [c["front"] % pack.FRONTS for c in cards if c["kind"] == "word"]
    assert fell_back == dealt


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
    # The owner's rule at a TYPICAL phrase rate: 3 one-word entries + 1 phrase.
    # All four words on a card render at ONE size, so a card of four phrases sets
    # tiny. This shape is only reachable while phrases are <= a quarter of the
    # list; the promise that survives every ratio is the invariant test below.
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


def test_every_card_is_within_one_phrase_of_the_deck_average():
    # THE INVARIANT — the only input-independent promise the packer makes.
    # "3 singles + 1 phrase" is what a typical list works out to, not a rule: a
    # customer who sends mostly two- and three-word entries MUST get cards with
    # 2, 3 or 4 phrases, because there is nothing else to put on them. What has
    # to hold at EVERY ratio is that the load is level — with M phrases over n
    # cards every card takes M//n or M//n + 1. This is what stops a future
    # change from quietly reintroducing clustering.
    #
    # Full-capacity cards only: the final card can hold 1-3 words and so cannot
    # take a full share. That is a capacity limit, not clustering, and it gets
    # its own (weaker) assertion below.
    rnd = random.Random(4242)
    for size in (8, 41, 103, 202, 412, 700):
        # 0% to 100%, deliberately including ratios past 25% (where 3+1 stops
        # being reachable) and past 100% of the card count (M > n).
        for pct in (0, 5, 25, 38, 50, 60, 75, 90, 100):
            n_multi = size * pct // 100
            words = _mix(size - n_multi, n_multi)
            rnd.shuffle(words)
            out = _csv(f"inv-{size}-{pct}.csv")
            pack.pack(words, out, seed=rnd.randrange(10**6))
            cards = _cards(out)
            per = [_n_multi(c) for c in cards if all(c)]
            where = f"size={size} phrases={n_multi} ({pct}%) cards={len(cards)}"
            assert max(per) - min(per) <= 1, f"{where}: uneven, saw {sorted(set(per))}"
            # ...and level at the RIGHT level, so "even" can't mean "even at 0"
            base = n_multi // len(cards)
            assert set(per) <= {base, base + 1}, \
                f"{where}: want {base} or {base + 1} a card, saw {sorted(set(per))}"
            # the short final card is capped by how many words it holds, no worse
            for c in (c for c in cards if not all(c)):
                assert _n_multi(c) <= len([w for w in c if w]), where


def test_no_card_hoards_the_phrases_while_an_equal_card_gets_none():
    # The specific regression, spelled out so the failure message says WHAT
    # broke rather than just "uneven". A phrase-heavy list must never print one
    # card of four phrases beside a card of four single words.
    # 300 phrases + 112 singles over 103 cards: level is 2-3 phrases a card.
    out = _csv()
    pack.pack(_mix(112, 300), out)
    per = [_n_multi(c) for c in _cards(out)]
    worst, best = max(per), min(per)
    assert worst <= 3, f"worst card carries {worst} phrases; level for this list is 2-3"
    assert best >= 2, f"a card carries only {best} phrases while another carries {worst}"
    assert per.count(pack.PER_CARD) == 0, \
        f"{per.count(pack.PER_CARD)} all-phrase cards — the deck is clustered"
    assert per.count(0) == 0, \
        f"{per.count(0)} phrase-free cards while other cards carry {worst}"


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


# --- the deck's split between pawn cards and word cards ---------------------
#
# The deck is ALWAYS 104 cards. Four players fill one pawn card and each pawn
# card costs one word card, so the buyer trades four words per four players —
# about 1% of the deck, which is why it is offered rather than sold.

def test_the_deck_is_always_104_cards_however_it_is_split():
    # A FULL list for that split — which is the point: the list she is allowed to
    # collect shrinks with the deck (topup.target_for, db.deckWordsFor), so a deck
    # filled to its own capacity is 104 cards at every split.
    for pawn_cards in range(pack.PAWN_CARDS_MIN, pack.PAWN_CARDS_MAX + 1):
        out = _csv()
        n, cards = pack.pack(_words(pack.deck_words(pawn_cards)), out,
                             pawn_cards=pawn_cards)
        rows = _rows(out)
        assert cards == pack.DECK_CARDS, (pawn_cards, cards)
        assert len(rows) == pack.DECK_CARDS
        assert sum(1 for r in rows if r["kind"] == "photo") == pawn_cards
        assert sum(1 for r in rows if r["kind"] == "word") == pack.word_cards(pawn_cards)


def test_every_pawn_card_costs_exactly_four_words():
    assert pack.deck_words(1) == 412
    assert pack.deck_words(2) == 408
    assert pack.deck_words(3) == 404
    assert pack.deck_words(4) == 400
    # …and the standard deck is still what it always was.
    assert pack.WORD_CARDS == 103
    assert pack.deck_words() == 412


def test_the_pawn_cards_lead_and_the_word_cards_follow():
    out = _csv()
    pack.pack(_words(pack.deck_words(3)), out, pawn_cards=3)
    kinds = [r["kind"] for r in _rows(out)]
    assert kinds[:3] == ["photo", "photo", "photo"]
    assert set(kinds[3:]) == {"word"}


def test_the_word_cards_keep_their_even_spread_behind_three_pawn_cards():
    # The photo rows sit in front of the deal and must not push its cycling along.
    out = _csv()
    pack.pack(_words(pack.deck_words(3)), out, pawn_cards=3)
    fronts = [int(r["front"]) for r in _rows(out) if r["kind"] == "word"]
    assert fronts[:9] == [0, 1, 2, 3, 4, 5, 6, 7, 0], fronts[:9]
    counts = sorted((fronts.count(i) for i in range(pack.FRONTS)), reverse=True)
    # 101 word cards over 8 fronts: five get 13, three get 12.
    assert sum(counts) == pack.word_cards(3)
    assert max(counts) - min(counts) == 1


def test_a_hand_typed_count_cannot_deform_the_deck():
    # Reached by a CLI (--pawn-cards), so the bounds are enforced here too: a
    # typo must not produce a deck of 64 word cards.
    assert pack.clamp_pawn_cards(0) == pack.PAWN_CARDS_MIN
    assert pack.clamp_pawn_cards(-3) == pack.PAWN_CARDS_MIN
    assert pack.clamp_pawn_cards(40) == pack.PAWN_CARDS_MAX
    assert pack.clamp_pawn_cards("nope") == pack.PAWN_CARDS_MIN
    assert pack.clamp_pawn_cards(None) == pack.PAWN_CARDS_MIN
    out = _csv()
    pack.pack(_words(pack.deck_words(pack.PAWN_CARDS_MAX)), out, pawn_cards=99)
    rows = _rows(out)
    assert len(rows) == pack.DECK_CARDS
    assert sum(1 for r in rows if r["kind"] == "photo") == pack.PAWN_CARDS_MAX


def test_the_default_deck_is_byte_for_byte_what_it_was():
    a = _csv()
    b = _csv()
    pack.pack(_words(FULL), a)
    pack.pack(_words(FULL), b, pawn_cards=1)
    assert open(a, encoding="utf-8-sig").read() == open(b, encoding="utf-8-sig").read()


def test_an_oversized_list_still_grows_the_deck_at_any_split():
    # The product promises no upper limit on her own words, and that outranks the
    # 104: a list longer than this split holds prints MORE cards rather than
    # losing words. The buyer never gets here through the site — the cap she
    # collects under is this split's (db.deckWordsFor) — but the generator is
    # also a CLI, and dropping a customer's word is never the right failure.
    out = _csv()
    _, cards = pack.pack(_words(pack.deck_words(3) + 40), out, pawn_cards=3)
    assert cards > pack.DECK_CARDS
    assert sum(1 for r in _rows(out) if r["kind"] == "photo") == 3
