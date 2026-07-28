#!/usr/bin/env python3
"""Pack a raw word list into the deck CSV — ONE ROW PER CARD.

v2 (single-card deck): each printed card carries 4 words, so a row is a card,
not an 8-up sheet. Dedupes exact repeats, shuffles so each card gets a mix (not
alphabetical clumps), and tags every card with the front STYLE it renders on —
round-robin across the theme's 8 fronts so the styles come out even (13/13/13/
13/13/13/13/12 over a standard 103-card deck). The last row is the PHOTO card,
which carries no words. Deterministic given a seed.

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
    random.seed(seed)
    random.shuffle(uniq)
    # Enough cards to hold every word (never fewer, so no word is dropped), and
    # at least one so an empty list still yields a well-formed deck.
    n_cards = max(1, math.ceil(len(uniq) / PER_CARD))
    padded = uniq + [""] * (n_cards * PER_CARD - len(uniq))
    with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(FIELDS)
        for i in range(n_cards):
            row = padded[i * PER_CARD:(i + 1) * PER_CARD]
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
