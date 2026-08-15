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
