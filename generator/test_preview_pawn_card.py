#!/usr/bin/env python3
"""Tests for the buyer's PHOTO-CARD preview (preview.pawn_card).

The collection page showed the pawn photos as a strip of thumbnails, which
answers "which files did I send?" — while what the buyer is actually deciding is
"what will my guests hold?". The pawn card is a card like any other: it prints on
the front card's paper, cut to the deck's frame, with her photos in its four
slots. So the preview renders the real thing.

These pin the two things that would make it a lie:

  * it is composed through the SAME path the deck uses, so the picture cannot
    drift from the print;
  * the four slots are filled the way the deck fills them — her photos first,
    then the shipped Dugri pawns for the ones she left empty — so a buyer who
    sent two photos previews two photos and two pawns, exactly as it prints.

…and the two that would make it expensive or fragile: it renders ONE card (no
front, no back, no board), and a caller-supplied workdir is left for the caller
to clean.

Run: python3 generator/test_preview_pawn_card.py   (or via pytest)
"""
import inspect
import os

import build as buildmod
import config
import preview
import test_build_deck as tb


def _chrome():
    # chrome.binary() is the resolution the renderer itself uses, so this skips
    # exactly when a real render would fail — and runs on a Mac, where the
    # browser is an .app and not on PATH.
    try:
        import chrome
        return chrome.binary()
    except Exception:
        return None


# --- pure ------------------------------------------------------------------

def test_the_card_is_composed_by_the_deck_s_own_helper():
    # kind="photo" routes build_single_card_svg at render_page.photo_card_svg,
    # which is the one place a pawn card is composed. If this preview ever grew
    # its own composition, the buyer would be approving a different card from the
    # one that prints.
    src = inspect.getsource(preview.pawn_card)
    assert 'kind="photo"' in src
    assert "config.photo_card_path(theme)" in src


def test_nothing_but_the_card_is_rendered():
    # The board is the heaviest image the preview module can make and the back is
    # a second Chrome page; neither belongs on a screen about photos.
    src = inspect.getsource(preview.pawn_card)
    for absent in ("render_board", "board", "back"):
        assert absent not in src.replace("no board, no back", ""), absent


def test_the_slots_are_filled_the_way_the_deck_fills_them():
    src = inspect.getsource(preview.pawn_card)
    assert "buildmod.resolve_photos" in src, (
        "top-up must come from build.resolve_photos, or a buyer who sent two "
        "photos previews a half-empty card and prints a full one"
    )


def test_a_short_list_is_topped_up_to_four():
    # The behaviour resolve_photos gives us, asserted here because it is what the
    # preview promises: four slots, always.
    with tb.Store() as tmp:
        out = buildmod.resolve_photos("demo", [], workdir=tmp)
        assert len(out) == 4, out
        assert all(os.path.exists(p) for p in out)


# --- the LIVE base card ----------------------------------------------------
# `--no-photos` renders the card the collection page draws the buyer's photos
# onto itself. "Without her photos" is not "with four empty discs": the printed
# card tops a short list up from the shipped pawns, so a base card with four bare
# discs promised her an empty circle where a pawn prints — under a caption
# reading "this is exactly how the card will be printed". Only the slots the
# caller says it will cover are left bare.

def test_the_top_up_is_one_rule_both_paths_read():
    # If these ever diverge, the preview and the print disagree about slot 3 —
    # which is precisely the bug, and it is invisible until a card comes back.
    src = inspect.getsource(buildmod.resolve_photos)
    assert "fallback_photos" in src


def test_the_base_card_carries_the_pawns_the_caller_will_not_draw():
    with tb.Store() as tmp:
        fallbacks = list(config.photo_fallback_paths("demo"))
        # Nothing drawn by the caller: the whole generic set, i.e. the card an
        # order with no photos at all prints.
        assert buildmod.fallback_photos("demo", 0) == fallbacks[:4]
        # Two of her own: two pawns, and they are the FIRST two, exactly as
        # resolve_photos appends them (the card an order with two photos prints).
        assert buildmod.fallback_photos("demo", 2) == fallbacks[:2]
        assert buildmod.fallback_photos("demo", 4) == []
        # …and it agrees with the PRINTED card of an order with two photos, slot
        # for slot, which is the only thing that makes the preview true. Note
        # which pawns those are: the top-up takes the fallbacks in their own
        # order, so slot 3 of a two-photo order gets pawn 1 — not pawn 3. Deriving
        # the base card from anything but resolve_photos' own rule would put a
        # different pawn on the preview than on the card.
        src = tb._portrait(os.path.join(tmp, "hers.png"))
        printed = buildmod.resolve_photos("demo", [src, src],
                                          workdir=os.path.join(tmp, "sq"))
        assert printed[2:] == buildmod.fallback_photos("demo", 2)


def test_the_slots_the_caller_draws_are_left_bare():
    # The CLI's own arithmetic: `drawn` slots empty, the rest topped up, and the
    # list always four long so nothing shifts a pawn onto the wrong disc.
    src = inspect.getsource(preview.main)
    assert "[None] * drawn + buildmod.fallback_photos" in src, (
        "the base card's empty slots must be exactly the ones the caller covers"
    )
    with tb.Store():
        for drawn in range(5):
            photos = [None] * drawn + buildmod.fallback_photos("demo", drawn)
            assert len(photos) == 4, photos
            assert photos[:drawn] == [None] * drawn
            assert all(p for p in photos[drawn:])


# --- with Chrome -----------------------------------------------------------

def test_it_renders_a_card_shaped_png():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    from PIL import Image
    with tb.Store() as tmp:
        out = preview.pawn_card("demo", [], workdir=os.path.join(tmp, "pawns"))
        assert "pawns" in out
        img = Image.open(out["pawns"])
        # Portrait, and no wider than the delivered cap. (A card read at its
        # stroke-width instead of its canvas came back an 8px sliver once — see
        # render_page.dims — so the shape is worth asserting.)
        assert img.height > img.width, (img.width, img.height)
        assert img.width <= preview.CARD_MAX_W


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
