#!/usr/bin/env python3
"""Top up a customer's personal word list to a full deck.

An order's personal words (usually 70+) are combined with the theme's own
event word pool and the shared generic pool so the printed deck is always full
(>= TARGET words). Every personal word is ALWAYS kept — the seed pools only fill
the remainder. If the personal list alone already meets the target, no filler is
added.

  from topup import topup
  words = topup(personal_words, "trip comeback")   # -> list, len >= 412

Priority order (dedup, case/space-insensitive): personal -> theme wordlist ->
generic-350. The theme's wordlist file is named in themes.json (`wordlist`).

WHERE A POOL IS READ FROM (two directories, store-first)
--------------------------------------------------------
1. DATA_DIR/wordlists — the owner's copy on the PERSISTENT Railway volume,
   written by the admin wordlist screen (server/wordlists.js). DATA_DIR comes
   from the environment; this process is spawned by the Node server and inherits
   it. Unset (local dev / tests) simply means "no owner store".
2. <repo>/content/wordlists — the pools that ship inside the Docker image. The
   container filesystem is EPHEMERAL, so this is READ-ONLY baseline content:
   it is rebuilt from the image on every deploy and nothing may be written here.

A file in (1) SHADOWS the shipped file of the same name, so an owner edit to a
shipped list takes effect WITHOUT mutating the image (server/wordlists.js does
the copy-on-write). Both sides implement the identical rule so the generator and
the admin UI never disagree about which bytes are the live pool.
"""
import os
import re

import config

# A full v2 deck is 103 word cards x 4 words (pack.WORD_CARDS x pack.PER_CARD);
# the 104th card is the photo card and carries no words.
TARGET = 412
WORDLISTS_DIR = os.path.join(config.REPO, "content", "wordlists")
# The owner's persistent store; "" when DATA_DIR is unset (local dev / tests).
DATA_DIR = os.environ.get("DATA_DIR") or ""
STORE_DIR = os.path.join(DATA_DIR, "wordlists") if DATA_DIR else ""
GENERIC = "generic-350.txt"


def _norm(word):
    """Dedup key: trimmed, inner whitespace collapsed, lowercased."""
    return re.sub(r"\s+", " ", str(word).strip()).lower()


def _wordlist_path(filename):
    """Absolute path a pool is read from, or None when it exists nowhere.

    The owner's DATA_DIR copy wins over the shipped baseline. basename() is the
    traversal guard: a themes.json `wordlist` can never reach outside the two
    wordlist directories.
    """
    name = os.path.basename(str(filename or "").strip())
    if not name:
        return None
    if STORE_DIR:
        owner = os.path.join(STORE_DIR, name)
        if os.path.isfile(owner):
            return owner
    shipped = os.path.join(WORDLISTS_DIR, name)
    return shipped if os.path.isfile(shipped) else None


def _read_wordlist(filename):
    """Read a wordlist into a list of lines (blank lines ignored).

    A pool that exists in NEITHER directory yields [] rather than raising: a
    missing filler pool must degrade to a shorter deck, never fail a paid order.
    """
    path = _wordlist_path(filename)
    if not path:
        return []
    with open(path, encoding="utf-8-sig") as f:
        return [ln for ln in f.read().splitlines()]


def topup(personal_words, theme_key, target=TARGET, wordlist=None):
    """Return a deduped word list: all personal words + seed fillers to >= target.

    - Every unique personal word is always present, first.
    - If the (deduped) personal words already reach `target`, they are returned
      as-is with no filler.
    - Otherwise fill from `wordlist` if one is given, else the theme's own
      `wordlist` pool, then generic-350, until the list has at least `target`
      words (or the pools run dry).

    ``wordlist`` is a PER-ORDER override, set by the owner on the order itself:
    a 40th birthday run off a kids template wants the grown-up pool, and the
    theme cannot know that. It only replaces the THEME's pool — personal words
    still come first and generic-350 is still the backstop, so an override can
    never drop a buyer's own word or leave a deck short. An unreadable or
    unknown name simply yields no words and falls through to generic, which is
    the same outcome as a theme naming a pool that isn't there.
    """
    cfg = config.theme(theme_key)
    theme_file = (wordlist or "").strip() or cfg.get("wordlist") or GENERIC

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
        sys.exit("usage: topup.py <personal_words.txt> <theme_key> [out.txt] [pool]")
    src, theme_key = sys.argv[1], sys.argv[2]
    # The optional 4th argument is the order's own seed pool (#410) — the same
    # override order_to_pdf takes as --wordlist. The server passes it when it
    # FREEZES a collection's word bank (server/word-bank.js); a freeze that
    # ignored it would store a bank the print does not reproduce, which is the
    # one thing freezing exists to prevent.
    pool = sys.argv[4] if len(sys.argv) > 4 else None
    personal = open(src, encoding="utf-8-sig").read().splitlines()
    result = topup(personal, theme_key, wordlist=pool)
    if len(sys.argv) > 3:
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            f.write("\n".join(result) + "\n")
    print(f"topped up {len(personal)} personal -> {len(result)} words ({theme_key})")
