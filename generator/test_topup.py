#!/usr/bin/env python3
"""Tests for generator/topup.py — the word-list top-up to a full deck.

Run: python3 generator/test_topup.py   (or via pytest)
"""
import os
import re
import shutil
import tempfile

import pack
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


def test_target_is_a_full_deck_of_word_cards():
    # TARGET is not a free-standing number: it is exactly the deck pack.py builds,
    # 103 word cards x 4 words (the 104th card is the photo card and holds none).
    # Pinned against pack's own constants so moving either one without the other
    # fails here instead of quietly shipping a deck with a half-empty last card.
    assert topup.TARGET == 412
    assert topup.TARGET == pack.WORD_CARDS * pack.PER_CARD


def test_personal_all_present_and_length_and_no_dupes():
    personal = ["בדיחה פנימית", "חבר טוב", "ריקוד"]
    result = topup.topup(personal, "trip comeback")
    # every personal word survives
    for w in personal:
        assert w in result, f"missing personal word {w!r}"
    # filled to at least the target deck size
    assert len(result) >= 412, f"expected >=412, got {len(result)}"
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
    assert len(result) >= 412


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
        assert len(result) >= 412


def test_owner_created_pool_is_readable_by_name():
    with _store({"retirement-350.txt": ["פנסיה", "מסיבה"]}):
        assert topup._read_wordlist("retirement-350.txt") == ["פנסיה", "מסיבה"]


def test_a_pool_that_exists_nowhere_degrades_to_empty_not_a_crash():
    # A missing filler pool must shorten the deck, never fail a paid order.
    assert topup._read_wordlist("no-such-pool.txt") == []
    assert topup._wordlist_path("no-such-pool.txt") is None


# ---- deletion ---------------------------------------------------------------
# The admin can delete ANY pool, including one that ships inside the image. That
# file cannot be unlinked, so the deletion is an empty `<name>.deleted` marker on
# the volume (server/wordlists.js). If the generator ignored it, a deck would go
# on being filled from a pool the owner has already thrown away — and she would
# find out on printed cards.


def test_a_deleted_shipped_pool_reads_as_gone():
    with _store({"generic-350.txt.deleted": []}):
        assert topup._wordlist_path("generic-350.txt") is None
        assert topup._read_wordlist("generic-350.txt") == []
    # …and the shipped file is untouched: the marker masks, it does not erase.
    assert len(topup._read_wordlist("generic-350.txt")) == 350


def test_a_deleted_pool_leaves_the_deck_short_rather_than_crashing():
    # The same degradation as a pool that never existed — a paid order still
    # renders, with fewer filler words.
    with _store({"friends-350.txt.deleted": [], "generic-350.txt.deleted": []}):
        result = topup.topup(["אישית"], "trip comeback")
        assert result == ["אישית"]


def test_a_marker_does_not_hide_a_pool_that_was_recreated():
    # Deleting and then creating the same name again is a normal thing to do; the
    # admin clears the marker on write, and the new pool must be visible.
    with _store({"friends-350.txt": ["חדש"]}):
        assert topup._read_wordlist("friends-350.txt") == ["חדש"]


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


# --- per-order seed-pool override -------------------------------------------
# The owner picks, on the order itself, which pool tops this deck up. It replaces
# the THEME's pool only: personal words still come first and generic-350 is still
# the backstop, so an override can neither drop a buyer's word nor leave a deck
# short of a full print run.

def test_override_replaces_the_theme_pool():
    with _store({"owner-pool.txt": ["אלפא", "ביתא", "גמא", "דלתא"]}):
        themed = topup.topup(["אישית"], "bachelorette", target=5)
        overridden = topup.topup(
            ["אישית"], "bachelorette", target=5, wordlist="owner-pool.txt")
    assert themed[0] == "אישית" and overridden[0] == "אישית"
    # The filler came from the owner's pool, not the theme's.
    assert "אלפא" in overridden
    assert "אלפא" not in themed


def test_override_never_drops_a_personal_word():
    with _store({"tiny.txt": ["מילה"]}):
        out = topup.topup(["אבא", "אמא", "סבתא"], "bachelorette",
                          target=4, wordlist="tiny.txt")
    for w in ("אבא", "אמא", "סבתא"):
        assert w in out
    assert out[:3] == ["אבא", "אמא", "סבתא"]


def test_override_still_reaches_target_via_generic_when_the_pool_is_small():
    # A pool of two cannot fill a deck; generic-350 remains the backstop, so the
    # deck is never short just because the owner chose a small pool.
    with _store({"two.txt": ["אחת", "שתיים"]}):
        out = topup.topup(["אישית"], "bachelorette", target=40,
                          wordlist="two.txt")
    assert len(out) >= 40
    assert "אחת" in out and "שתיים" in out


def test_unknown_override_falls_back_rather_than_failing():
    # The server validates the name, but a pool deleted between choosing and
    # producing must still yield a full deck rather than an exception.
    out = topup.topup(["אישית"], "bachelorette", target=30,
                      wordlist="does-not-exist.txt")
    assert len(out) >= 30
    assert out[0] == "אישית"


def test_blank_override_means_the_theme_pool():
    for blank in (None, "", "   "):
        assert topup.topup(["אישית"], "bachelorette", target=6, wordlist=blank) \
            == topup.topup(["אישית"], "bachelorette", target=6)


def test_override_cannot_escape_the_wordlist_directories():
    # topup._wordlist_path is the guard; an override is just a filename to it.
    out = topup.topup(["אישית"], "bachelorette", target=20,
                      wordlist="../../../etc/passwd")
    assert len(out) >= 20
    assert all("root:" not in w for w in out)


def test_cli_takes_the_orders_own_seed_pool(tmp_path):
    """The 4th CLI argument is the per-order pool override (#410).

    server/word-bank.js freezes a collection's word bank by running this CLI. If
    the CLI ignored the override, a frozen bank would be filled from the THEME's
    pool while the print used the ORDER's — the freeze would store a deck the
    printer does not reproduce, which is the one thing freezing exists to stop.

    Asserted by difference rather than by counting: the same personal words run
    with and without the override must not produce the same deck, and the words
    the override contributed must come from the pool it named. (Counting is the
    wrong instrument here — naming the generic backstop AS the override leaves
    the deck legitimately short of TARGET, since there is no third pool behind
    it.)
    """
    import subprocess
    import sys

    src = tmp_path / "personal.txt"
    src.write_text("מסיבה\nחברים\n", encoding="utf-8")
    here = os.path.dirname(os.path.abspath(__file__))

    def run(*extra):
        out = tmp_path / ("out" + str(len(extra)) + ".txt")
        r = subprocess.run(
            [sys.executable, os.path.join(here, "topup.py"), str(src),
             "bachelorette", str(out), *extra],
            capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        return [w for w in out.read_text(encoding="utf-8").splitlines() if w.strip()]

    default = run()
    overridden = run("generic-350.txt")

    # Both keep her own words, in her order, at the front.
    assert default[:2] == ["מסיבה", "חברים"]
    assert overridden[:2] == ["מסיבה", "חברים"]
    # …and the override actually changed which pool completed the deck.
    assert default != overridden
    generic = set(topup._read_wordlist("generic-350.txt"))
    assert set(overridden[2:]) <= generic


def test_personal_span_is_where_her_words_end_in_the_topped_up_deck():
    # The boundary the 'personal-first' card order splits on. It has to be the
    # same dedup topup itself does, or the split lands one word off and a filler
    # word opens the deck (or one of hers closes the filler).
    for personal in (
        ["שירה", "ריקוד", "חוף"],
        ["שירה", "שירה ", " שירה"],          # exact repeats, collapsed to one
        ["a", "A"],                            # same word, different case
        ["ריקוד", "", "   ", "חוף"],          # blanks are not words
        [],
    ):
        words = topup.topup(personal, "bachelorette")
        n = topup.personal_span(personal)
        assert words[:n] == list(dict.fromkeys(
            w for w in (re.sub(r"\s+", " ", str(x).strip()) for x in personal) if w
        ))[:n]
        assert len(set(words[:n])) == n
        # …and everything after it came from a pool, not from her.
        assert n <= len(words)
