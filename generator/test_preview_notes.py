#!/usr/bin/env python3
"""Tests for what the PREVIEW says about itself.

The preview is the approval step before a deck is printed, so anything it
leaves out silently is a promise it cannot keep. Two things used to vanish:

  * a back that FAILED to render — swallowed by a bare ``except: pass``, leaving
    a two-panel preview that looked complete;
  * a surface rendered with NO personalized name on it, because nothing is
    calibrated for it. Bare artwork looks like a finished design, so the owner
    approves it and finds out on the printed cards.

Neither is an error — a title-less back is genuinely what the deck would print,
and a partial preview beats no preview — so both are REPORTED alongside the
images rather than raised.

These also pin the trap that made מרקאנה's back look wrong to the owner: the
theme's ``back`` slot can be filled in and the back STILL print bare, because
the recipe's explicit ``"back": null`` outranks it. Setting the slot and saving
does not fix it, so the preview has to keep saying so.

Run: python3 generator/test_preview_notes.py   (or via pytest)
"""
import json
import os
import shutil

import config
import preview as pv
import render_page as rp
import test_build_deck as tb


def _chrome():
    exe = os.environ.get("CHROME", "")
    if exe and os.path.exists(exe):
        return exe
    return (shutil.which("google-chrome") or shutil.which("chromium")
            or shutil.which("chromium-browser"))


def _store_path(*parts):
    return os.path.join(os.environ["DATA_DIR"], "templates", *parts)


def _patch_theme(**changes):
    """Mutate the throwaway store's demo theme entry in place."""
    path = _store_path("themes.json")
    with open(path, encoding="utf-8") as f:
        themes = json.load(f)
    themes["demo"].update(changes)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(themes, f)
    config.clear_preview_overrides()


def _patch_recipe(**changes):
    path = _store_path("recipes", "demo.json")
    with open(path, encoding="utf-8") as f:
        recipe = json.load(f)
    recipe.update(changes)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(recipe, f)
    config.clear_preview_overrides()


def _run(tmp, name="שירה"):
    return pv.preview("demo", name, workdir=os.path.join(tmp, "prev"))


def _notes_for(out, surface):
    return [n for n in out.get("notes", []) if n["surface"] == surface]


# --- pure: the report is the RENDERER's answer, not a second copy of the rule --

def test_back_draws_title_agrees_with_the_overlay_that_draws_it():
    # The three-way rule (detected boxes / an explicit "no text here" / nothing
    # calibrated) is subtle enough that a second copy would drift, and a report
    # that drifts is worse than none: it would promise a title the deck prints
    # bare. So the helper must BE the overlay's own answer, in every state.
    with tb.Store():
        back = config.card_path("demo", config.back_indices(config.theme("demo"))[0])
        recipe = config.recipe_or_empty(config.theme("demo"))

        def overlay_drawn():
            return bool(rp.back_overlay("demo", config.recipe_or_empty(
                config.theme("demo")), ["X"], back_index=1).strip())

        assert recipe.get("back"), "fixture should start with a detected back slot"
        assert rp.back_draws_title("demo", back, back_index=1) is overlay_drawn() is True

        _patch_recipe(back=None)
        assert rp.back_draws_title("demo", back, back_index=1) is overlay_drawn() is False

        _patch_theme(back=None)
        assert rp.back_draws_title("demo", back, back_index=1) is overlay_drawn() is False


# --- with Chrome ------------------------------------------------------------

def test_a_fully_calibrated_deck_reports_nothing():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    with tb.Store() as tmp:
        out = _run(tmp)
        assert out["card"] and out["board"] and out["back"]
        # No key at all rather than an empty list: a note means "read me".
        assert "notes" not in out, out.get("notes")


def test_a_board_with_no_title_slot_says_so():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    with tb.Store() as tmp:
        _patch_theme(board=None)
        out = _run(tmp)
        # The board still renders — a clean board is what production prints too.
        assert out["board"]
        notes = _notes_for(out, "board")
        assert len(notes) == 1 and notes[0]["code"] == pv.NOTE_NO_TITLE, out.get("notes")
        # ...and it is only the board that is called out.
        assert not _notes_for(out, "back"), out["notes"]


def test_a_back_with_no_title_slot_says_so():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    with tb.Store() as tmp:
        _patch_theme(back=None)
        _patch_recipe(back=None)
        out = _run(tmp)
        assert out["back"], "the artwork still renders; only the name is absent"
        notes = _notes_for(out, "back")
        assert len(notes) == 1 and notes[0]["code"] == pv.NOTE_NO_TITLE, out.get("notes")


def test_a_filled_back_slot_the_recipe_overrules_is_still_reported():
    # מרקאנה's exact shape: the theme carries a back slot, but the recipe says
    # "this back has no text on it" and wins. Filling the slot in the admin form
    # therefore changes NOTHING about what prints — so the preview must keep
    # reporting it, or the owner saves and believes the back is fixed.
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    with tb.Store() as tmp:
        _patch_recipe(back=None)
        cfg = config.theme("demo")
        assert cfg.get("back"), "the theme slot stays filled — that is the trap"
        out = _run(tmp)
        notes = _notes_for(out, "back")
        assert len(notes) == 1 and notes[0]["code"] == pv.NOTE_NO_TITLE, out.get("notes")


def test_a_back_that_cannot_render_is_reported_not_swallowed():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    with tb.Store() as tmp:
        # Remove the back artwork so its render genuinely fails.
        os.remove(_store_path("demo", "clean", "1.svg"))
        out = _run(tmp)
        # Degrading is still right: the buyer keeps their card and board.
        assert out["card"] and out["board"]
        assert "back" not in out
        notes = _notes_for(out, "back")
        assert len(notes) == 1 and notes[0]["code"] == pv.NOTE_FAILED, out.get("notes")
        assert notes[0]["detail"], "a failure with no detail is still a silence"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            print(name)
            fn()
    print("ok")


# --- the title's own font cannot draw the title -----------------------------
#
# An ORDER refuses this outright (test_build_deck). A preview does not: this is
# the screen the owner is on when she notices something is wrong with her
# design, and a 500 tells her less than the broken picture does. So she gets the
# picture AND the reason — which is the pair she needs, because the picture
# alone is exactly what fooled her. אואזיס's title font had been set to League
# Spartan Bold, which carries not one Hebrew letter, and the preview came back
# reading "ווקות לט" for "רווקות לטל" — right typeface-ish, right colour, right
# position, first and last letter gone, nothing anywhere saying so.


def _latin_title_font():
    shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "MrDafoe-Regular.ttf"),
                _store_path("demo", "fonts", "MrDafoe-Regular.ttf"))
    _patch_theme(title_font="MrDafoe-Regular.ttf")


def test_a_title_font_that_cannot_draw_the_title_says_so():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    with tb.Store() as tmp:
        _latin_title_font()
        out = _run(tmp)
        assert out["card"], "the card still renders; the owner needs to SEE it"
        notes = _notes_for(out, "title")
        assert len(notes) == 1 and notes[0]["code"] == pv.NOTE_FONT_GAPS, \
            out.get("notes")
        detail = notes[0]["detail"]
        assert "MrDafoe-Regular.ttf" in detail
        for ch in "שירה":
            assert ch in detail, detail
        # FIRST in the list: it invalidates everything else the preview shows.
        assert out["notes"][0]["code"] == pv.NOTE_FONT_GAPS


def test_the_font_gap_note_comes_first_even_beside_other_notes():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    with tb.Store() as tmp:
        _latin_title_font()
        _patch_theme(board=None)
        out = _run(tmp)
        codes = [n["code"] for n in out["notes"]]
        assert codes[0] == pv.NOTE_FONT_GAPS, codes
        assert pv.NOTE_NO_TITLE in codes, codes


def test_a_theme_whose_font_draws_its_title_gets_no_such_note():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    with tb.Store() as tmp:
        out = _run(tmp)
        assert not _notes_for(out, "title"), out.get("notes")
