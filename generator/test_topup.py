#!/usr/bin/env python3
"""Tests for generator/topup.py — the word-list top-up to a full deck.

Run: python3 generator/test_topup.py   (or via pytest)
"""
import os
import shutil
import tempfile

import topup


class _store:
    """Point topup at a throwaway DATA_DIR/wordlists for one test.

    STORE_DIR is read from the environment at import time, so a test that needs an
    owner store sets it directly (and always restores it).
    """

    def __init__(self, files):
        self.files = files

    def __enter__(self):
        self.dir = tempfile.mkdtemp(prefix="dugri-wordlists-")
        for name, words in self.files.items():
            with open(os.path.join(self.dir, name), "w", encoding="utf-8") as f:
                f.write("\n".join(words) + "\n")
        self.prev = topup.STORE_DIR
        topup.STORE_DIR = self.dir
        return self.dir

    def __exit__(self, *exc):
        topup.STORE_DIR = self.prev
        shutil.rmtree(self.dir, ignore_errors=True)
        return False


def test_personal_all_present_and_length_and_no_dupes():
    personal = ["בדיחה פנימית", "חבר טוב", "ריקוד"]
    result = topup.topup(personal, "trip comeback")
    # every personal word survives
    for w in personal:
        assert w in result, f"missing personal word {w!r}"
    # filled to at least the target deck size
    assert len(result) >= 416, f"expected >=416, got {len(result)}"
    # no duplicates (case/space-insensitive)
    keys = [topup._norm(w) for w in result]
    assert len(keys) == len(set(keys)), "duplicate words in result"


def test_personal_words_come_first():
    personal = ["ראשון", "שני"]
    result = topup.topup(personal, "trip comeback")
    assert result[: len(personal)] == personal


def test_dedupes_personal_but_keeps_all_unique():
    # exact + case/space variants collapse to one; all distinct personal survive.
    personal = ["מים", "מים", " מים ", "אש"]
    result = topup.topup(personal, "trip comeback")
    assert result[0] == "מים"
    assert "אש" in result
    assert sum(1 for w in result if topup._norm(w) == "מים") == 1


def test_personal_alone_over_target_uses_all_personal_only():
    personal = [f"w{i}" for i in range(420)]
    result = topup.topup(personal, "trip comeback")
    assert len(result) == 420
    assert result == personal


def test_empty_personal_still_fills():
    result = topup.topup([], "trip comeback")
    assert len(result) >= 416


# ---- DATA_DIR store resolution ---------------------------------------------
# content/wordlists ships inside the Docker image and is rebuilt on every deploy,
# so the owner's edits live on the DATA_DIR volume and must SHADOW the shipped
# pool of the same name. server/wordlists.js implements the same rule on the
# admin side; these tests pin the generator half of the contract.


def test_no_data_dir_reads_the_shipped_pool():
    prev, topup.STORE_DIR = topup.STORE_DIR, ""
    try:
        assert len(topup._read_wordlist("generic-350.txt")) == 350
        assert topup._wordlist_path("generic-350.txt").startswith(topup.WORDLISTS_DIR)
    finally:
        topup.STORE_DIR = prev


def test_owner_store_shadows_the_shipped_pool_of_the_same_name():
    with _store({"generic-350.txt": ["מילה של הבעלים"]}) as d:
        assert topup._wordlist_path("generic-350.txt") == os.path.join(
            d, "generic-350.txt"
        )
        assert topup._read_wordlist("generic-350.txt") == ["מילה של הבעלים"]
    # and the shipped file is untouched once the store is gone
    assert len(topup._read_wordlist("generic-350.txt")) == 350


def test_owner_edit_of_a_theme_pool_reaches_the_deck():
    with _store({"friends-350.txt": ["מילת בעלים " + str(i) for i in range(400)]}):
        result = topup.topup(["אישית"], "trip comeback")
        assert result[0] == "אישית"
        assert "מילת בעלים 0" in result
        assert len(result) >= 416


def test_owner_created_pool_is_readable_by_name():
    with _store({"retirement-350.txt": ["פנסיה", "מסיבה"]}):
        assert topup._read_wordlist("retirement-350.txt") == ["פנסיה", "מסיבה"]


def test_a_pool_that_exists_nowhere_degrades_to_empty_not_a_crash():
    # A missing filler pool must shorten the deck, never fail a paid order.
    assert topup._read_wordlist("no-such-pool.txt") == []
    assert topup._wordlist_path("no-such-pool.txt") is None


def test_a_traversal_wordlist_name_cannot_escape_the_pool_dirs():
    for bad in ["../../etc/passwd", "../themes.json", "sub/dir.txt"]:
        p = topup._wordlist_path(bad)
        assert p is None or os.path.dirname(p) in (topup.WORDLISTS_DIR, topup.STORE_DIR)
    # themes.json sits one level above content/wordlists — basename() strips the
    # traversal, so the lookup can only ever miss.
    assert topup._read_wordlist("../themes.json") == []


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
