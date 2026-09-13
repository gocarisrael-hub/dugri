#!/usr/bin/env python3
"""THE PRODUCTION CHAIN, end to end, for the pawn-card split.

This is the test that was missing, and its absence is why a 16-player order
printed 107 cards instead of 104. Reverting generator/order_to_pdf.py in its
ENTIRETY used to red nothing: 138 tests across test_card_order, test_word_demand,
test_photo_view, test_pack and test_chrome all passed with the file gone. Every
link in the chain that turns a stored player count into a deck —
``topup.target_for``, ``pawn_cards=`` into ``pack.pack``, ``min_cards=word_cards``,
the ``--pawn-cards`` flag — was unpinned, and the 104-card invariant was only ever
asserted against an input somebody had already sized correctly (test_pack:456,
test_build_deck:1365 both feed exactly ``pack.deck_words(pawn_cards)`` words in).
That is precisely the assumption production violated.

So this drives the REAL chain, in the real order, from the real inputs:

    the owner closes the collection
      -> the freeze runs topup.py with the collection's own deck size
      -> wordsForProduction hands the frozen bank to order_to_pdf
      -> order_to_pdf tops it up (no-op — it is already full) and packs it
      -> 104 cards / 208 pages

...at 4, 8, 12 and 16 players. The freeze is reproduced by invoking topup.py the
way server/word-bank.js invokes it (same argv, same subprocess), because that is
the part of the chain that was wrong: it shelled out with NO --target and so
always filled to 412, the standard deck's number, whatever the buyer had chosen.
The JavaScript half — that word-bank.js actually puts the collection's
db.deckWordsFor on that command line — is pinned in tests/unit/word-bank.test.js.

Chrome never runs: build_deck is stubbed and the assertions are made on the CSV
order_to_pdf wrote, which IS the deck's structure (build.deck_document counts its
rows).

Run: python3 -m pytest generator/test_order_to_pdf.py   (from generator/)
"""
import os
import subprocess
import sys

import pytest

import config
import order_to_pdf
import pack
import topup as topupmod

from test_build_deck import Store

HERE = os.path.dirname(os.path.abspath(__file__))
# Enough of her own that the shipped generic pool can always reach a full deck
# (generic-350 is ~350 entries, and the demo theme names no pool of its own).
PERSONAL = ["מילה%d" % i for i in range(1, 121)]


def _freeze(personal, theme, out_dir, deck_words):
    """The real freeze: server/word-bank.js's subprocess, argv for argv.

    ``deck_words`` is the collection's db.deckWordsFor — 412 at four players,
    400 at sixteen. Passing it is the whole fix; omitting it is the bug.
    """
    src = os.path.join(out_dir, "in.txt")
    out = os.path.join(out_dir, "out.txt")
    with open(src, "w", encoding="utf-8") as f:
        f.write("\n".join(personal) + "\n")
    args = [sys.executable, os.path.join(HERE, "topup.py"), src, theme, out]
    if deck_words is not None:
        args.append("--target=%d" % deck_words)
    r = subprocess.run(args, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    with open(out, encoding="utf-8") as f:
        return [w.strip() for w in f if w.strip()]


def _render(tmp, words, pawn_cards, theme="demo", **kw):
    """order_to_pdf with the renderer stubbed — returns the deck CSV's cards."""
    seen = {}

    def _keep(csv_path):
        # Copy it out: order_to_pdf deletes its own scratch dir on the way home.
        kept = os.path.join(tmp, "deck-%d.csv" % pawn_cards)
        with open(csv_path, encoding="utf-8-sig") as fin:
            with open(kept, "w", encoding="utf-8") as fout:
                fout.write(fin.read())
        seen["kept"] = kept

    # build_deck(theme, csv, name, out_pdf, ...) -> (pdf, pages, board)
    def fake_build_deck(theme_key, csv_path, name, out_pdf, **k):
        _keep(csv_path)
        return out_pdf, 0, None

    # build_pdf(theme, fronts, board, csv, name, out_pdf, ...) -> (pdf, pages)
    def fake_build_pdf(theme_key, fronts, board, csv_path, name, out_pdf, **k):
        _keep(csv_path)
        return out_pdf, 0

    real_deck, real_pdf = order_to_pdf.buildmod.build_deck, order_to_pdf.buildmod.build_pdf
    order_to_pdf.buildmod.build_deck = fake_build_deck
    order_to_pdf.buildmod.build_pdf = fake_build_pdf
    try:
        order_to_pdf.order_to_pdf(theme, "שירה", {}, words,
                                  out_pdf=os.path.join(tmp, "out.pdf"),
                                  pawn_cards=pawn_cards, **kw)
    finally:
        order_to_pdf.buildmod.build_deck = real_deck
        order_to_pdf.buildmod.build_pdf = real_pdf
    return pack.load_cards(seen["kept"])


def _shape(cards):
    photos = sum(1 for c in cards if c["kind"] == "photo")
    return len(cards), photos, len(cards) - photos


# --- the chain --------------------------------------------------------------

@pytest.mark.parametrize("players,pawn_cards", [(4, 1), (8, 2), (12, 3), (16, 4)])
def test_a_frozen_bank_prints_104_cards_at_every_player_count(players, pawn_cards):
    # db.deckWordsFor: the ceiling the buyer collected under, and the size the
    # bank has to be frozen at.
    deck_words = pack.deck_words(pawn_cards)
    assert deck_words == (104 - pawn_cards) * 4
    with Store() as tmp:
        bank = _freeze(PERSONAL, "demo", tmp, deck_words)
        assert len(bank) == deck_words, "the freeze is sized for THIS deck"
        # ...and production prints the bank, exactly as the server hands it over.
        cards = _render(tmp, bank, pawn_cards,
                        personal_count=len(PERSONAL), order=pack.ORDER_PERSONAL_FIRST)
        assert _shape(cards) == (104, pawn_cards, 104 - pawn_cards)
        assert len(cards) * 2 == 208
        # The pawn cards LEAD the deck.
        assert [c["kind"] for c in cards[:pawn_cards]] == ["photo"] * pawn_cards
        assert all(c["kind"] == "word" for c in cards[pawn_cards:])
        # Every one of her words is on a card — none pushed off the shorter deck.
        printed = {w for c in cards for w in c["words"] if w}
        assert set(PERSONAL) <= printed


def test_the_bug_that_shipped_a_107_card_deck():
    # The old freeze: topup.py with NO --target, so it filled to its module
    # default (412, the STANDARD deck) whatever the buyer chose. topup only ever
    # tops UP — it never trims — so that oversized bank walked through
    # order_to_pdf untouched and pack dealt 412 words into ceil(412/4) = 103 word
    # cards ON TOP OF four pawn cards: 107 cards, 214 pages, against a price, a
    # box, a paper order and a print run all pinned to 104.
    #
    # Two independent guards now stop it, and this asserts BOTH — either alone
    # closes the hole, and the point of having two is that neither has to be the
    # only one that is right.
    with Store() as tmp:
        untargeted = _freeze(PERSONAL, "demo", tmp, None)
        # 1) The old freeze really did produce the standard deck's 412...
        assert len(untargeted) == topupmod.TARGET == 412
        # ...which is twelve more than a 16-player deck holds.
        assert len(untargeted) > pack.deck_words(4)
        # 2) ...and packing it for four pawn cards is now REFUSED, loudly, with
        #    the numbers — rather than quietly printing 107 cards.
        with pytest.raises(ValueError) as e:
            _render(tmp, untargeted, 4)
        assert "104" not in str(e.value) or "100" in str(e.value)
        assert "100" in str(e.value)


def test_the_targeted_freeze_keeps_every_personal_word():
    # The trade costs WORDS, and the words it may cost are ours, never hers. A
    # 16-player deck holds 400; she wrote 120; the filler shrinks, not her list.
    with Store() as tmp:
        big = _freeze(PERSONAL, "demo", tmp, pack.deck_words(4))
        small = _freeze(PERSONAL, "demo", tmp, pack.deck_words(1))
        assert big[:len(PERSONAL)] == PERSONAL
        assert small[:len(PERSONAL)] == PERSONAL
        assert len(small) - len(big) == 12  # three pawn cards' worth of filler


# --- the flags the chain is made of -----------------------------------------

def test_no_topup_pads_to_this_decks_word_cards_not_the_standard_one():
    # The other production path: she asked us not to fill her deck, so the
    # shortfall becomes EMPTY cards. The number of them is this deck's, not 103.
    with Store() as tmp:
        for pawn_cards in (1, 2, 3, 4):
            cards = _render(tmp, PERSONAL, pawn_cards, no_topup=True)
            assert _shape(cards) == (104, pawn_cards, 104 - pawn_cards)


def test_a_v1_sheet_template_ignores_the_count_entirely():
    # 7 of the 8 repo-shipped themes are v1 (8-up sheets). They have no photo card
    # at all — only the v2 branch passes `pawn_cards` to pack — so a count above
    # the default bought them nothing and cost them words: the top-up target was
    # reduced for EVERY template, so a 16-player order produced onto a v1 theme
    # came out 400 words and 101 cards, three cards and twelve words lighter for a
    # pawn card that was never going to print. order_to_pdf normalises the count
    # away for them, so the target is the standard deck's again.
    with Store(card_layout=None) as tmp:
        assert not config.is_single_card(config.theme("demo"))
        # Her collection says sixteen players, so the bank was frozen at 400.
        bank = _freeze(PERSONAL, "demo", tmp, pack.deck_words(pack.PAWN_CARDS_MAX))
        assert len(bank) == 400
        cards = _render(tmp, bank, pack.PAWN_CARDS_MAX)
        # Topped back up to the standard deck, because that is the deck this
        # template prints. Nothing was traded away.
        printed = [w for c in cards for w in c["words"] if w]
        assert len(printed) == topupmod.TARGET == 412
        # And it gets pack's own default — one photo row, which build_pdf ignores
        # — not the four the collection asked for.
        assert _shape(cards)[1] == pack.PAWN_CARDS_MIN


def test_the_cli_flag_reaches_the_deck():
    # --pawn-cards is the server's only way to say this (server/index.js
    # orderArgs), and it is clamped independently of the store, because a
    # hand-typed 40 must not produce a deck of 64 word cards.
    with Store() as tmp:
        bank = _freeze(PERSONAL, "demo", tmp, pack.deck_words(pack.PAWN_CARDS_MAX))
        cards = _render(tmp, bank, 40)  # clamped to PAWN_CARDS_MAX
        assert _shape(cards) == (104, pack.PAWN_CARDS_MAX, 100)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
