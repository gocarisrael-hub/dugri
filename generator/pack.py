#!/usr/bin/env python3
"""Pack a raw word list into the deck CSV — ONE ROW PER CARD.

v2 (single-card deck): each printed card carries 4 words, so a row is a card,
not an 8-up sheet. Dedupes exact repeats, shuffles so each card gets a mix (not
alphabetical clumps), deals the words so a card carries at most ONE multi-word
phrase (see PHRASE MIX below), and tags every card with the front STYLE it
renders on — round-robin across the theme's 8 fronts so the styles come out even
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
hands each card 3 singles + 1 phrase where the supply allows, with the phrase in
the LAST filled slot — slot 4, the bottom line, where a wrapped entry has the
most room. Measured on the sample order (113 personal words topped up to 412
with the bachelorette pool = 55 phrases over 103 cards):

  phrases/card   0    1    2
  before        59   33   11
  after         48   55    0

The mix is a target, not a guarantee; the supply decides:

- MORE phrases than cards: the surplus is spread evenly across the deck (card i
  takes ``(i+1)*M//n - i*M//n``). An all-personal 412-word list at 38% is 157
  phrases over 103 cards: before = 1 card of 4 phrases, 18 of 3, 32 of 2;
  after = 54 cards of 2 and 49 of 1, and never a run of doubles at the tail.
- FEWER phrases than cards: the same formula spreads the phrase-carrying cards
  through the deck instead of front-loading them; the rest take 4 singles.
- ALL phrases (or all singles): every card is simply filled from the one pool,
  byte-for-byte what the old plain slice produced.
- The short final card (1-3 words) is capacity-clamped, so a phrase that no
  longer fits there moves to an earlier card rather than being dropped.

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
    [3,3,4]). The overflow is handed to the earliest cards with room, because
    the alternative — dropping it — would lose a customer's word.
    """
    n = len(caps)
    quota = [(i + 1) * n_multi // n - i * n_multi // n for i in range(n)]
    spill = 0
    for i, cap in enumerate(caps):
        if quota[i] > cap:
            spill += quota[i] - cap
            quota[i] = cap
    for i, cap in enumerate(caps):
        if not spill:
            break
        take = min(cap - quota[i], spill)
        quota[i] += take
        spill -= take
    return quota


def deal(uniq, n_cards, rnd):
    """Deal ``uniq`` into ``n_cards`` rows of PER_CARD slots (blank-padded).

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
