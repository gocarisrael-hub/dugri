#!/usr/bin/env python3
"""How demanding each word is to print — measured, not guessed.

THE OWNER'S POINT, which is the whole reason this file exists: "maybe it's
better to divide the words in a card in a way that maximizes the biggest font
size". The packer used to decide which words share a card by asking one
question — does this entry contain a space? — and spreading the ones that do.

That proxy is wrong in both directions. "בר רווקות" has a space and is easy: two
short tokens that wrap comfortably. "אינטרנציונליזם" has none and is the worst
thing that can land on a card, because there is nowhere to break it. So the old
rule would happily seat two genuinely hard entries together and let the card
shrink for both, while carefully separating two easy ones.

WHAT IS MEASURED. For each entry, the largest font size at which it can be set
in a standard word slot — the same measurement the renderer makes when it lays
the card out (``render_page._candidates``), asked one entry at a time. Bigger is
easier. A card's size is the MINIMUM over its four entries, which is what makes
this the right number to balance across cards.

WHY ONE REPRESENTATIVE SLOT is enough here. The four word slots of a card are
the same size as each other (they differ only in where they sit and which icon
intrudes), and they are shared across all eight fronts. So a single width
measures every entry on the same footing, which is all a comparison needs. What
the icons do to a particular row is a per-front question, and it belongs to the
renderer, which already answers it.

THE COST is font metrics for ~412 short strings — milliseconds, no Chrome, no
artwork. It runs once per order, before the deck is packed.
"""
import statistics

import config
import render_page as rp

# The word list is dealt into cards before anything is drawn, so the measurement
# needs a band width to measure against. This is the standard slot, and every
# entry is measured against the same one.
_FALLBACK_SLOT_W = 89.6      # the v2 card's word slot, in card units


def slot_width(theme):
    """The width one word gets on a card, in the card's own units.

    The four slots are equal, so their median is that width. A theme whose
    geometry cannot be read (an uncalibrated or v1 sheet template) falls back to
    the shipped card's slot — the measurement is a COMPARISON between entries, so
    a slightly wrong absolute width still ranks them correctly.
    """
    try:
        cfg = config.theme(theme)
        recipe = config.recipe_or_empty(cfg)
        cell = (recipe.get("card") or {}).get("cell") or rp._recipe_cell(recipe, None)
        boxes = config.card_word_boxes(cfg, recipe, cell)
        widths = [b["x1"] - b["x0"] for b in boxes if b.get("x1") is not None]
        if widths:
            return statistics.median(widths)
    except Exception:
        # Measuring is an optimisation. A theme we cannot read must fall back to
        # a usable number rather than fail an order over it.
        pass
    return _FALLBACK_SLOT_W


def measure(words, theme, word_font=None):
    """``{word: size}`` — the largest size each entry can be set at. Higher is easier.

    Returns an empty dict when the fonts cannot be loaded, which the caller reads
    as "no measurement available" and falls back to the old space-counting rule.
    Never raises: an order must not fail because a measurement could not be made.
    """
    words = [w for w in dict.fromkeys(w for w in words if w and str(w).strip())]
    if not words:
        return {}
    try:
        cfg = config.theme(theme)
        avail = slot_width(theme)
        face = rp._word_face(
            config.resolve_word_font(theme, word_font),
            rp.word_font_alt(theme, word_font),
            alt_scale=config.word_alt_scale(cfg, rp._WORD_ALT_SCALE),
        )
    except Exception:
        return {}

    out = {}
    for w in words:
        try:
            # Every wrapping this entry allows; the largest size among them is
            # what the entry can achieve when the card gives it room to wrap.
            # ``num`` is the slot number the marker is drawn for — the marker
            # width barely differs between 1 and 4, and using one keeps every
            # entry measured identically.
            cands = rp._candidates(face, face.ref, 1, str(w), avail)
            sizes = [c[2] for c in cands.values() if c and c[2] is not None]
            if sizes:
                out[w] = float(max(sizes))
        except Exception:
            # One unmeasurable entry is not a reason to abandon the rest: it
            # simply carries no measurement and is treated as average.
            continue
    return out


def hardest(words, sizes):
    """The entry that will decide a card's size, and that size.

    ``(word, size)`` for the smallest measured entry, or ``(None, None)`` when
    none of them were measured.
    """
    scored = [(sizes[w], w) for w in words if w and w in sizes]
    if not scored:
        return None, None
    size, word = min(scored)
    return word, size


# HOW SMALL IS SMALL, in print. A card unit is the artwork's own: 223.92 of them
# span a 63mm card, so a unit is about 0.28mm and this floor is roughly 2.5mm of
# type — small enough that an entry stops reading across a room, which is the
# only reason this report exists. It fires on its own, so a deck that is
# uniformly tiny is still reported even though no card stands out in it.
_SMALL_FLOOR = 9.0


def small_cards(rows, sizes, ratio=0.55, floor=_SMALL_FLOOR):
    """Cards that will print noticeably smaller than the rest of the deck.

    The owner's complaint, in her words: "sometimes there is 1 card that the font
    size of the words is super tiny because of 1 fucked up word". This is what
    finds those cards AFTER the deal — the ones the balancing could not save,
    which are exactly the ones where a single entry is too demanding for any card
    to carry comfortably.

    Compared against the deck's own MEDIAN rather than a fixed size, because the
    comfortable size differs per template and per font: a card at 12 units is
    fine in a deck that sits at 13 and alarming in a deck that sits at 20.

    Returns ``[{index, size, word, ratio}]``, worst first. ``index`` is 1-based,
    the way a person counts cards.
    """
    per_card = []
    for i, row in enumerate(rows):
        word, size = hardest(row, sizes)
        if size is not None:
            per_card.append((i + 1, size, word))
    if len(per_card) < 3:
        return []
    med = statistics.median([s for _, s, _ in per_card])
    if med <= 0:
        return []
    # WHERE THE LINE IS. It was three quarters of the deck's median, and that
    # called ordinary cards small: a deck sitting at 20.2 had three cards
    # carrying אנציקלופדיה / אוניברסיטה / מתמטיקאי come out at 13-15, reported at
    # 0.65-0.75 and perfectly good in the hand — "this cards have nothing small".
    # A report the owner has to overrule is a report she stops reading. The card
    # that started this one measured 0.38 of its deck.
    #
    # The floor is the second, independent alarm: below it the type is too small
    # to read whatever the rest of the deck is doing, so a deck that is uniformly
    # tiny still gets named instead of averaging itself out of trouble.
    out = [
        {"index": i, "size": round(s, 2), "word": w, "ratio": round(s / med, 3)}
        for i, s, w in per_card
        if s < med * ratio or s < floor
    ]
    out.sort(key=lambda d: d["ratio"])
    return out
