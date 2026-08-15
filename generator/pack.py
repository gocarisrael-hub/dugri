#!/usr/bin/env python3
"""Pack a raw word list into the deck CSV — ONE ROW PER CARD.

v2 (single-card deck): each printed card carries 4 words, so a row is a card,
not an 8-up sheet. Dedupes exact repeats, shuffles so each card gets a mix (not
alphabetical clumps), and deals the words so multi-word phrases land evenly:
every card within one phrase of the deck average (see PHRASE MIX below). Each
card is tagged with the front STYLE it renders on, round-robin across the
theme's 8 fronts so the styles come out even (13/13/13/13/13/13/13/12 over a
standard 103-card deck). The last row is the PHOTO card, which carries no
words. Deterministic given a seed.

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
import re
import random
import sys

# Words per printed card.
PER_CARD = 4
# Word cards in a standard deck; + the photo card = 104 cards = 208 pages.
WORD_CARDS = 103

# An entry below this fraction of the deck's median is HARD — see _hard_cut.
_HARD_CUT = 0.75
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


# ---- CARD ORDER (per order) -------------------------------------------------
# How the deck's words are laid onto cards. The owner picks this per order, next
# to the seed pool, because a 63-word order and a 400-word one want different
# answers.
#
#   random          the historical behaviour: one shuffled blend, nobody can tell
#                   her words from the filler.
#   personal-first  HER words fill the opening cards, in her own list's order,
#                   and the pool fills the rest.
#   by-script       Hebrew cards and Latin cards are kept apart, so no card mixes
#                   the two scripts.
#
# THE PHRASE RULE IS NOT ONE OF THE OPTIONS — it applies underneath all of them.
# `deal` guarantees every card lands within ONE multi-word entry of the average,
# because all four words on a card render at one size and a card of four phrases
# prints tiny. Grouping only decides WHICH words a card may draw from; the deal
# inside each group is the same balanced deal it always was.
#
# THE SEAM. A group whose size is not a multiple of four leaves its last card
# short (2 or 3 words, blanks trailing), so a grouped deck can run ONE card
# longer than the same words blended. That is deliberate and it is the only
# honest option: filling that card from the next group would put filler on a
# personal card, or Hebrew on a Latin one, which is the whole thing the option
# was chosen to prevent. A short card is also not a new look — the last card of
# every deck has always been one — and with two groups there is at most one
# extra of them.
ORDER_RANDOM = "random"
ORDER_PERSONAL_FIRST = "personal-first"
ORDER_BY_SCRIPT = "by-script"
ORDERS = (ORDER_RANDOM, ORDER_PERSONAL_FIRST, ORDER_BY_SCRIPT)

_HEBREW_RE = re.compile(r"[\u0590-\u05FF]")
_LATIN_RE = re.compile(r"[A-Za-z]")


def is_hebrew(word):
    """Whether an entry belongs on a HEBREW card.

    Any Hebrew letter makes it Hebrew — a mixed entry ("Tel Aviv בתל אביב",
    "C14 של ערוץ") has to live on one side or the other, and the Hebrew face is
    the deck's primary one, so it goes there. An entry with neither script
    (digits, punctuation) is Hebrew too: the cards are a Hebrew product and that
    is where a bare number reads naturally.
    """
    w = str(word or "")
    if _HEBREW_RE.search(w):
        return True
    return not _LATIN_RE.search(w)


def card_groups(uniq, order, personal_count=None):
    """Partition the deck's words into the groups a card may be drawn from.

    Returns a list of lists, in the order their cards are printed. One group
    means "no grouping" — which is what `random` is, and what any option falls
    back to when the split would be empty on one side (an all-Hebrew list under
    by-script is just a deck, not two).
    """
    words = list(uniq)
    if order == ORDER_PERSONAL_FIRST:
        # topup puts the customer's own words first and fills behind them, so the
        # boundary is a COUNT rather than a mark on each word. Without one (an
        # order that predates the frozen bank, or a list that is all hers) there
        # is nothing to separate.
        n = int(personal_count or 0)
        if 0 < n < len(words):
            return [words[:n], words[n:]]
        return [words]
    if order == ORDER_BY_SCRIPT:
        heb = [w for w in words if is_hebrew(w)]
        lat = [w for w in words if not is_hebrew(w)]
        if heb and lat:
            return [heb, lat]
        return [words]
    return [words]


def _hard_cut(sizes, cut=_HARD_CUT):
    """The size below which an entry counts as HARD, for this deck.

    Relative to the deck's own median entry, never an absolute number: what
    counts as small depends on the template and the font, and a deck of long
    Hebrew phrases has a different comfortable size from a deck of one-word
    English names.
    """
    vals = sorted(sizes.values())
    if not vals:
        return 0.0
    med = vals[len(vals) // 2]
    return med * cut


def deal_measured(uniq, n_cards, rnd, sizes):
    """Deal by MEASURED difficulty — see generator/word_demand.py.

    THE RULE: hard entries are SPREAD, one per card, not put together.

    That is the second answer this function has had, and the first one was right
    at the time. While every card solved its own line spacing, a card could
    absorb several hard entries by tightening its rhythm, so putting four of them
    on one card cost one card instead of four — measured then as 5 noticeably
    small cards down to 2.

    The deck-wide rhythm removed that escape. A card cannot tighten its spacing
    any more (render_page.design_pitch), so several hard entries on one card have
    nowhere to go but down in size, and they compound. Measured on the same deck,
    with the rhythm in place:

        put together      worst card 15.4, one card noticeably small
        as it was         worst card 18.3-20.2, none
        spread apart      worst card 18.3-20.6, none

    So the owner's question — "doesn't it make some few cards font super small?" —
    was exactly right, and this is the answer to it: one hard entry per card, and
    the card only ever pays for that one.

    The deal is a SNAKE: sorted hardest first, dealt left to right, then right to
    left, so card i gets one entry from the hardest quarter and one from the
    easiest. A plain round robin would hand card 1 the hardest entry of every
    round.

    An entry nobody could measure is treated as AVERAGE — it lands where the deal
    puts it, which is what it did before any of this existed.
    """
    words = list(uniq)
    # Shuffle first so equal-difficulty entries fall in a different order per
    # seed, then sort — Python's sort is stable, so the shuffle survives as the
    # tie-break and two orders of the same words still differ.
    rnd.shuffle(words)
    known = sorted(sizes[w] for w in words if w in sizes)
    mid = known[len(known) // 2] if known else 0.0
    words.sort(key=lambda w: sizes.get(w, mid))          # hardest (smallest) first

    caps = [PER_CARD] * n_cards
    caps[-1] = len(uniq) - PER_CARD * (n_cards - 1)
    rows = [[] for _ in range(n_cards)]
    order = list(range(n_cards))
    i = rnd_round = 0
    while i < len(words):
        seq = order if rnd_round % 2 == 0 else order[::-1]
        placed = False
        for c in seq:
            if i >= len(words):
                break
            if len(rows[c]) < caps[c]:
                rows[c].append(words[i])
                i += 1
                placed = True
        if not placed:
            break            # every card full — cannot happen while sum(caps) == len
        rnd_round += 1

    out = []
    for row in rows:
        # Hardest LAST within the card. Which ROW it actually prints on is chosen
        # later against that card's own artwork (render_page.order_by_room); this
        # only keeps the CSV readable and the blanks trailing.
        row = sorted((w for w in row if w), key=lambda w: -sizes.get(w, mid))
        out.append(row + [""] * (PER_CARD - len(row)))
    return out


def deal(uniq, n_cards, rnd, sizes=None):
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

    ``sizes`` is the MEASURED difficulty of each entry (word_demand.measure). When
    it is given the deal is made from it instead — see ``deal_measured``, which is
    the better rule and the default for any order the fonts could be read for.
    The space-counting deal below is what runs when no measurement was possible
    (an unreadable font, a template we cannot load), and it is unchanged.
    """
    if sizes:
        return deal_measured(uniq, n_cards, rnd, sizes)
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


def pack(words, out_csv, seed=42, fronts=FRONTS, photo_card=True,
         order=ORDER_RANDOM, personal_count=None, sizes=None):
    """Write the deck CSV and return ``(unique_words, card_count)``.

    ``card_count`` INCLUDES the photo card when one is emitted, so it is the
    number of printed cards (and half the page count).

    ``order`` is the per-order card order (see ORDERS): the words are partitioned
    into groups and each group is dealt into its OWN cards, so a card only ever
    draws from one group. The phrase balance is unchanged and applies inside every
    group. ``personal_count`` is how many of the leading words are the customer's
    own — the boundary `personal-first` splits on, and ignored by the others.
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
    # at least one so an empty list still yields a well-formed deck. Each GROUP
    # gets whole cards of its own, so a group whose size is not a multiple of four
    # leaves its last card short — see the seam note above ORDERS.
    groups = card_groups(uniq, order, personal_count)
    rows = []
    for g in groups:
        rows.extend(deal(g, max(1, math.ceil(len(g) / PER_CARD)), rnd, sizes=sizes))
    with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(FIELDS)
        for i, row in enumerate(rows):
            wr.writerow(["word", i % fronts] + row)
        if photo_card:
            wr.writerow(["photo", ""] + [""] * PER_CARD)
    return len(uniq), len(rows) + (1 if photo_card else 0)


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
