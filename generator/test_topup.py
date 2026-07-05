#!/usr/bin/env python3
"""Tests for generator/topup.py — the word-list top-up to a full deck.

Run: python3 generator/test_topup.py   (or via pytest)
"""
import topup


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


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
