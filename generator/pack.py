#!/usr/bin/env python3
"""Pack a raw word list into the deck CSV — ONE ROW PER CARD.

v2 (single-card deck): each printed card carries 4 words, so a row is a card,
not an 8-up sheet. Dedupes exact repeats, shuffles so each card gets a mix (not
alphabetical clumps), deals the words so multi-word phrases are spread evenly —
every card within one phrase of the deck average (see PHRASE MIX below) — and
tags every card with the front STYLE it renders on — round-robin across the
theme's 8 fronts so the styles come out even
(13/13/13/13/13/13/13/12 over a standard 103-card deck). The last row is the
PHOTO card, which carries no words. Deterministic given a seed.

  python3 generator/pack.py words.txt order.csv

CSV columns: ``kind,front,w1,w2,w3,w4``
  kind   "word" or "photo"
  front  0-based index into the theme's ``fronts`` list; empty on the photo card
  w1..w4 the card's words (blank-padded on the final word card)

DECK SIZE. A standard deck is ``WORD_CARDS`` (103) word cards + 1 photo card =
104 cards = 208 printed pages, which is what ``topup.TARGET`` (412 = 103 x 4)
feeds it. Two deliberate departures:

- FEWER words than that (the filler pools ran dry) yields FEWER cards rather
  than a tail of blank ones — only the last card is blank-padded.
- MORE words than that yields MORE cards. Every personal word is always kept
  (the product promises no upper limit), so an oversized list grows the deck
  past 103 instead of silently dropping the overflow. The front cycling is
  round-robin, so the styles stay even at any size.

PHRASE MIX (why the deal is not a plain slice)
----------------------------------------------
A customer "word" is often a PHRASE — "להקת שבעת הכוכבים", "ארוחת בוקר בנמל".
A real personal list runs ~38% phrases (the sample list ships at 43 of 113).
All four words on a card render at ONE size, so the most demanding entry drags
the whole card down — and a plain shuffle-then-slice let phrases clump.

So the deal partitions the list into SINGLE-token and MULTI-token words and
hands them out phrase-by-phrase across the deck (card i takes
``(i+1)*M//n - i*M//n``), with each card's phrases in its LAST filled slots —
slot 4, the bottom line, where a wrapped entry has the most room.

WHAT IS GUARANTEED, for ANY word list:

  Every card is within ONE phrase of the deck average, never clustered.

That is the whole promise, and it is input-independent. With M phrases over n
cards every card carries either ``M//n`` or ``M//n + 1`` of them — so the
WORST card is only ever one phrase heavier than the best, and no card can carry
a pile of phrases while an equal-capacity card carries none.

"3 singles + 1 phrase" is what that works out to at a TYPICAL phrase rate, NOT
a promise. It holds only while phrases are at most a quarter of the list. A
customer who submits mostly two- and three-word entries will get cards with 2,
3, even 4 phrases — unavoidably, there is nothing else to put on them. What
does not happen at any ratio is the clustering: 2 everywhere beats 4-and-0.

  ratio          phrases/card the deck lands on
  M <= n         some cards 0, the rest 1
  n < M <= 2n    some cards 1, the rest 2
  ...            ...
  M = 4n (all)   every card 4

Measured on the sample order (113 personal words topped up to 412 with the
bachelorette pool = 55 phrases over 103 cards):

  phrases/card   0    1    2
  before        59   33   11
  after         48   55    0

...and on the ratio that breaks the 3+1 shape — an all-personal 412-word list
at the sample list's own 38% rate, 157 phrases over 103 cards — the guarantee
still holds where the shape does not: before = 1 card of 4 phrases, 18 of 3,
32 of 2; after = 54 cards of 2 and 49 of 1. Two on every card, not four on some.

The one exception is CAPACITY, not clustering: the final card may hold only 1-3
words, so it cannot take a full share. Its overflow moves to the emptiest cards
(see ``_phrase_quota``) rather than being dropped.

Every unique word is placed exactly once in every case — the deal only reorders.
"""
import csv
import math
import random
import sys

# Words per printed card.
PER_CARD = 4
# Word cards in a standard deck; + the photo card = 104 cards = 208 pages.
WORD_CARDS = 103
# How many front styles a v2 template ships (2.svg..9.svg).
FRONTS = 8

FIELDS = ["kind", "front", "w1", "w2", "w3", "w4"]


def is_multi(word):
    """True for a phrase — anything that whitespace-splits into 2+ tokens.

    Whitespace is the proxy for "needs to wrap onto 2-3 lines", which is what
    actually costs the card its font size. "בליינד דייט" is a phrase; a single
    long token like "אינסטגרם" is not (it wraps as one unbreakable line either
    way, so splitting it off would buy nothing).
    """
    return len(str(word).split()) > 1


def _phrase_quota(n_multi, caps):
    """How many phrases each card takes, in card order. Sums to ``n_multi``.

    ``caps[i]`` is how many words card i holds (4, except a short final card).
    The even-spread formula ``(i+1)*M//n - i*M//n`` walks the phrase supply
    across the deck: 103 cards / 60 phrases alternates 0s and 1s instead of
    dumping all 60 on cards 1-60; 103 cards / 150 phrases alternates 1s and 2s.

    Then the clamp: the final card may hold only 1-3 words, so its quota can
    exceed its capacity (10 all-phrase words -> caps [4,4,2], raw quota
    [3,3,4]). The overflow has to go somewhere — dropping it would lose a
    customer's word — and WHERE it goes decides whether the even spread
    survives. Handing it to the earliest card with room does not: caps
    [4,4,4,1] with 9 phrases gave [4,2,2,1], i.e. one all-phrase card next to
    two half-phrase ones of the SAME capacity — the exact clustering this
    function exists to prevent. So each spilled phrase goes to the card
    currently holding the FEWEST (ties to the earliest), which fills level and
    keeps equal-capacity cards within one of each other: [3,3,2,1].

    The spill is at most PER_CARD-1 = 3 phrases (only the last card can be
    short), so the argmin scan is bounded and cheap at any deck size.
    """
    n = len(caps)
    quota = [(i + 1) * n_multi // n - i * n_multi // n for i in range(n)]
    spill = 0
    for i, cap in enumerate(caps):
        if quota[i] > cap:
            spill += quota[i] - cap
            quota[i] = cap
    # Total capacity is the word count, which is >= the phrase count, so a card
    # with room always exists while spill remains — this cannot spin.
    for _ in range(spill):
        i = min((j for j in range(n) if quota[j] < caps[j]), key=lambda j: quota[j])
        quota[i] += 1
    return quota


def deal(uniq, n_cards, rnd):
    """Deal ``uniq`` into ``n_cards`` rows of PER_CARD slots (blank-padded).

    The guarantee, for any word list: every card ends up within ONE phrase of
    the deck average, never clustered — with M phrases over n cards each card
    takes ``M//n`` or ``M//n + 1``. This is NOT "at most one phrase per card":
    a list that is mostly phrases has to put 2, 3 or 4 on every card. What it
    rules out is the lopsided deck — one card carrying four phrases while the
    next carries none.

    Singles fill from slot 1, phrases fill from the back, so a 3+1 card reads
    single/single/single/phrase and the wrapped entry sits on the bottom line.
    Only the last card can be short, and its blanks stay TRAILING — the card
    renderer numbers the slots 1..4 top-down, so a blank between two words would
    print an empty numbered line.
    """
    singles = [w for w in uniq if not is_multi(w)]
    multis = [w for w in uniq if is_multi(w)]
    # Shuffled independently, but both from the one seeded RNG. When a list is
    # all-single or all-multi the empty pool's shuffle draws no randomness, so
    # the deck comes out byte-identical to the pre-mix plain shuffle.
    rnd.shuffle(singles)
    rnd.shuffle(multis)

    caps = [PER_CARD] * n_cards
    caps[-1] = len(uniq) - PER_CARD * (n_cards - 1)  # 0..4 on the final card
    quota = _phrase_quota(len(multis), caps)

    rows, si, mi = [], 0, 0
    for cap, n_m in zip(caps, quota):
        n_s = cap - n_m
        row = singles[si:si + n_s] + multis[mi:mi + n_m]
        si, mi = si + n_s, mi + n_m
        rows.append(row + [""] * (PER_CARD - len(row)))
    return rows


def pack(words, out_csv, seed=42, fronts=FRONTS, photo_card=True):
    """Write the deck CSV and return ``(unique_words, card_count)``.

    ``card_count`` INCLUDES the photo card when one is emitted, so it is the
    number of printed cards (and half the page count).
    """
    seen = set()
    uniq = []
    for w in words:
        w = w.strip()
        if w and w not in seen:
            seen.add(w)
            uniq.append(w)
    # Own RNG, not the global one: pack must not perturb (or be perturbed by)
    # anything else seeding random in the same order-rendering process.
    rnd = random.Random(seed)
    # Enough cards to hold every word (never fewer, so no word is dropped), and
    # at least one so an empty list still yields a well-formed deck.
    n_cards = max(1, math.ceil(len(uniq) / PER_CARD))
    rows = deal(uniq, n_cards, rnd)
    with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(FIELDS)
        for i, row in enumerate(rows):
            wr.writerow(["word", i % fronts] + row)
        if photo_card:
            wr.writerow(["photo", ""] + [""] * PER_CARD)
    return len(uniq), n_cards + (1 if photo_card else 0)


def load_cards(path):
    """Read a deck CSV back into ``[{kind, front, words}]``, one dict per card.

    ``front`` is an int for a word card and None for the photo card; ``words``
    is always a 4-list (blank-padded). Tolerates a row whose ``front`` is
    missing/unparseable by falling back to the row's position, so a hand-edited
    CSV still renders an even spread instead of dying.
    """
    out = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for i, r in enumerate(csv.DictReader(f)):
            kind = (r.get("kind") or "word").strip()
            words = [(r.get(f"w{k}") or "") for k in range(1, PER_CARD + 1)]
            if kind == "photo":
                out.append({"kind": "photo", "front": None, "words": words})
                continue
            try:
                front = int(str(r.get("front", "")).strip())
            except (TypeError, ValueError):
                front = i
            out.append({"kind": "word", "front": front, "words": words})
    return out


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    words = open(src, encoding="utf-8-sig").read().splitlines()
    n, cards = pack(words, out)
    print(f"packed {n} unique words -> {cards} card(s) / {cards * 2} pages -> {out}")
