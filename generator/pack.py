#!/usr/bin/env python3
"""Pack a raw word list into the Canva bulk CSV (c1w1..c8w4, one row per page).

Dedupes exact repeats, shuffles so each card gets a mix (not alphabetical
clumps), 4 words/card, 8 cards/page = 32 words/page, pads the last page with
blanks. Deterministic given a seed.

  python3 generator/pack.py words.txt order.csv
"""
import csv
import math
import random
import sys

PER_PAGE = 32


def pack(words, out_csv, seed=42):
    seen = set()
    uniq = []
    for w in words:
        w = w.strip()
        if w and w not in seen:
            seen.add(w)
            uniq.append(w)
    random.seed(seed)
    random.shuffle(uniq)
    pages = max(1, math.ceil(len(uniq) / PER_PAGE))
    padded = uniq + [""] * (pages * PER_PAGE - len(uniq))
    headers = [f"c{c}w{w}" for c in range(1, 9) for w in range(1, 5)]
    with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(headers)
        for p in range(pages):
            wr.writerow(padded[p * PER_PAGE:(p + 1) * PER_PAGE])
    return len(uniq), pages


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    words = open(src, encoding="utf-8-sig").read().splitlines()
    n, pages = pack(words, out)
    print(f"packed {n} unique words -> {pages} page(s) -> {out}")
