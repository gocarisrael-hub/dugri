#!/usr/bin/env python3
"""Top up a customer's personal word list to a full deck.

An order's personal words (usually 70+) are combined with the theme's own
event word pool and the shared generic pool so the printed deck is always full
(>= TARGET words). Every personal word is ALWAYS kept — the seed pools only fill
the remainder. If the personal list alone already meets the target, no filler is
added.

  from topup import topup
  words = topup(personal_words, "trip comeback")   # -> list, len >= 416

Priority order (dedup, case/space-insensitive): personal -> theme wordlist ->
generic-350. The theme's wordlist file is named in themes.json (`wordlist`).
"""
import os
import re

import config

TARGET = 416
WORDLISTS_DIR = os.path.join(config.REPO, "content", "wordlists")
GENERIC = "generic-350.txt"


def _norm(word):
    """Dedup key: trimmed, inner whitespace collapsed, lowercased."""
    return re.sub(r"\s+", " ", str(word).strip()).lower()


def _read_wordlist(filename):
    """Read a wordlist file into a list of non-empty lines (blank lines ignored)."""
    path = os.path.join(WORDLISTS_DIR, filename)
    with open(path, encoding="utf-8-sig") as f:
        return [ln for ln in f.read().splitlines()]


def topup(personal_words, theme_key, target=TARGET):
    """Return a deduped word list: all personal words + seed fillers to >= target.

    - Every unique personal word is always present, first.
    - If the (deduped) personal words already reach `target`, they are returned
      as-is with no filler.
    - Otherwise fill from the theme's `wordlist` pool, then generic-350, until
      the list has at least `target` words (or the pools run dry).
    """
    cfg = config.theme(theme_key)
    theme_file = cfg.get("wordlist") or GENERIC

    seen = set()
    out = []

    def add(words, cap):
        """Add unique words. With cap=True, stop the moment the deck reaches
        `target` (so fillers never overshoot the deck size); with cap=False,
        add every word (used for personal words, which are always all kept)."""
        for w in words:
            if cap and len(out) >= target:
                return
            w = re.sub(r"\s+", " ", str(w).strip())
            if not w:
                continue
            k = _norm(w)
            if k in seen:
                continue
            seen.add(k)
            out.append(w)

    # 1) All personal words first — never dropped (beyond exact dedup), even if
    #    they alone exceed the target.
    add(personal_words or [], cap=False)
    if len(out) >= target:
        return out

    # 2) The theme's own event pool, only up to the target.
    add(_read_wordlist(theme_file), cap=True)
    if len(out) >= target:
        return out

    # 3) The shared generic pool (disjoint from themed pools) as the backstop.
    if theme_file != GENERIC:
        add(_read_wordlist(GENERIC), cap=True)
    return out


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        sys.exit("usage: topup.py <personal_words.txt> <theme_key> [out.txt]")
    src, theme_key = sys.argv[1], sys.argv[2]
    personal = open(src, encoding="utf-8-sig").read().splitlines()
    result = topup(personal, theme_key)
    if len(sys.argv) > 3:
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            f.write("\n".join(result) + "\n")
    print(f"topped up {len(personal)} personal -> {len(result)} words ({theme_key})")
